// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） ルートページ
//
// GM・開発者向けの統合テスト画面（本番の会社画面ではない）。すべての状態
// （設定下書き・実行中のラボ状態・プレイヤー編集中の意思決定下書き・表示四半期・
// 自社/GM表示切替）をここで保持し、下位の表示・編集コンポーネントへ渡すだけに
// する。計算ロジックは一切持たず、app/lib/v2/companyLab の純粋関数のみを呼び出す
// （initializeCompanyLab・advanceCompanyLabQuarter・buildCompanyOwnState・
// buildPublicMarketInfo・generateAutoPolicyDecision）。
//
// 意思決定のルーティング規約（実装指示の重要事項）:
//   - 「1四半期進める」: プレイヤー操作会社は編集済みドラフトを使い、他4社は
//     各社自身のfixture/ownStateから生成した自動方針を使う（他社へプレイヤーの
//     編集を漏らさない・プレイヤーへ他社の非公開計画を渡さない）。
//   - 「8/32ターン一括実行」: 仕様どおり、プレイヤー操作会社を含む全5社を
//     暫定自動方針で動かす（この操作ではプレイヤー編集は使わない）。
//
// Redis・API Route・process.env・localStorage/sessionStorageは一切使用しない
// （すべてReactのuseStateのみで保持する、ブラウザ内のみの決定論的計算）。

"use client";

import { useCallback, useMemo, useState } from "react";
import { ALL_SCENARIO_DEFINITIONS } from "../../lib/v2/scenario";
import { ScenarioMode } from "../../lib/v2/scenario/types";
import { INITIAL_PERIOD_V2 } from "../../lib/v2/core/period";
import {
  CompanyDecisionInput,
  CompanyFixture,
  CompanyLabConfig,
  CompanyLabError,
  CompanyLabState,
  advanceCompanyLabQuarter,
  buildCompanyFixtures,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  generateAutoPolicyDecision,
  initializeCompanyLab,
} from "../../lib/v2/companyLab";
import { buildDecisionInputFromDraft, buildInitialDraft, CompanyDecisionDraft } from "./decisionDraft";
import LabBanner from "./components/LabBanner";
import ScenarioControls, { CompanyOption, ScenarioOption } from "./components/ScenarioControls";
import DecisionEditor from "./components/DecisionEditor";
import ResultsPanel from "./components/ResultsPanel";
import MarketPanel from "./components/MarketPanel";
import ComparisonPanel from "./components/ComparisonPanel";
import QualityDashboardPanel from "./components/QualityDashboardPanel";

const DEFAULT_SEED = "company-lab-seed-001";
const MAX_TURNS = 40;

const SCENARIO_OPTIONS: readonly ScenarioOption[] = ALL_SCENARIO_DEFINITIONS.map((d) => ({
  scenarioId: d.scenarioId,
  title: d.title,
  durationTurns: d.durationTurns,
}));

// プレイヤー操作会社選択肢用の表示名は、実際のfixture生成関数（buildCompanyFixtures）を
// そのまま呼び出して取得する（displayName文言を画面側で重複定義しない）。Period値は
// 初期原料在庫の記録用にしか使わないため、ここでは仮のINITIAL_PERIOD_V2で構わない
// （初期化ボタン押下時にinitializeCompanyLabが実際の開始Periodでfixturesを作り直す）。
const COMPANY_OPTIONS: readonly CompanyOption[] = buildCompanyFixtures(INITIAL_PERIOD_V2).map((f) => ({
  companyId: f.companyId,
  displayName: f.displayName,
}));

type ActiveTab = "decision" | "results" | "comparison" | "quality";
type ViewMode = "self" | "gm";

function describeError(e: unknown): string {
  if (e instanceof CompanyLabError) return e.message;
  if (e instanceof Error) return `予期しないエラー: ${e.message}`;
  return "予期しないエラーが発生しました。";
}

/** プレイヤー操作会社の当四半期ドラフトを、自動方針の出力から再構築する（完了済みならnull）。 */
function buildDraftForState(state: CompanyLabState, fixtures: readonly CompanyFixture[], playerCompanyId: string): CompanyDecisionDraft | null {
  if (state.isComplete) return null;
  const fixture = fixtures.find((f) => f.companyId === playerCompanyId);
  if (!fixture) return null;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  return buildInitialDraft(fixture, autoDecision);
}

export default function CompanyLabPage() {
  // --- 設定下書き（初期化前のみ編集可能） ---
  const [draftScenarioId, setDraftScenarioId] = useState(SCENARIO_OPTIONS[0].scenarioId);
  const [draftMode, setDraftMode] = useState<ScenarioMode>("canonical");
  const [draftSeed, setDraftSeed] = useState(DEFAULT_SEED);
  const [draftPlayerCompanyId, setDraftPlayerCompanyId] = useState(COMPANY_OPTIONS[0].companyId);

  // --- 実行中のラボ状態 ---
  const [labState, setLabState] = useState<CompanyLabState | null>(null);
  const [fixtures, setFixtures] = useState<readonly CompanyFixture[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null); // null = 最新に追従

  // --- プレイヤー操作会社の当四半期・編集中ドラフト ---
  const [playerDraft, setPlayerDraft] = useState<CompanyDecisionDraft | null>(null);

  // --- 表示切替 ---
  const [viewMode, setViewMode] = useState<ViewMode>("self");
  const [activeTab, setActiveTab] = useState<ActiveTab>("decision");
  // --- 品質ダッシュボード（Phase 7B）が表示対象とする会社。GM表示時のみ切替可能（自社表示時は常にプレイヤー操作会社）。 ---
  const [dashboardCompanyId, setDashboardCompanyId] = useState(COMPANY_OPTIONS[0].companyId);

  const handleInit = useCallback(() => {
    const definition = SCENARIO_OPTIONS.find((o) => o.scenarioId === draftScenarioId);
    const turns = Math.min(MAX_TURNS, definition?.durationTurns ?? MAX_TURNS);
    const config: CompanyLabConfig = {
      scenarioId: draftScenarioId,
      mode: draftMode,
      seed: draftSeed.trim().length > 0 ? draftSeed.trim() : DEFAULT_SEED,
      turns,
    };
    try {
      const { state, fixtures: builtFixtures } = initializeCompanyLab(config);
      setLabState(state);
      setFixtures(builtFixtures);
      setRunError(null);
      setSelectedTurn(null);
      setViewMode("self");
      setActiveTab("decision");
      setPlayerDraft(buildDraftForState(state, builtFixtures, draftPlayerCompanyId));
      setDashboardCompanyId(draftPlayerCompanyId);
    } catch (e) {
      setRunError(describeError(e));
    }
  }, [draftScenarioId, draftMode, draftSeed, draftPlayerCompanyId]);

  const handleStepOnce = useCallback(() => {
    if (!labState || !fixtures || labState.isComplete || !playerDraft) return;
    try {
      const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
      const publicInfo = buildPublicMarketInfo(labState);
      for (const f of fixtures) {
        if (f.companyId === draftPlayerCompanyId) {
          decisionsByCompanyId[f.companyId] = buildDecisionInputFromDraft(playerDraft, f, labState.currentPeriod);
        } else {
          const ownState = buildCompanyOwnState(labState, f);
          decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, labState.currentPeriod, labState.scenarioState.currentTurn);
        }
      }
      const nextState = advanceCompanyLabQuarter(labState, fixtures, decisionsByCompanyId);
      setLabState(nextState);
      setSelectedTurn(null);
      setRunError(null);
      setPlayerDraft(buildDraftForState(nextState, fixtures, draftPlayerCompanyId));
    } catch (e) {
      setRunError(describeError(e));
    }
  }, [labState, fixtures, playerDraft, draftPlayerCompanyId]);

  const handleBulkRun = useCallback(
    (turnsToRun: number) => {
      if (!labState || !fixtures) return;
      try {
        let state = labState;
        for (let i = 0; i < turnsToRun && !state.isComplete; i++) {
          const publicInfo = buildPublicMarketInfo(state);
          const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
          for (const f of fixtures) {
            const ownState = buildCompanyOwnState(state, f);
            decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
          }
          state = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
        }
        setLabState(state);
        setSelectedTurn(null);
        setRunError(null);
        setPlayerDraft(buildDraftForState(state, fixtures, draftPlayerCompanyId));
      } catch (e) {
        setRunError(describeError(e));
      }
    },
    [labState, fixtures, draftPlayerCompanyId]
  );

  const handleReset = useCallback(() => {
    setLabState(null);
    setFixtures(null);
    setRunError(null);
    setSelectedTurn(null);
    setPlayerDraft(null);
    setViewMode("self");
    setActiveTab("decision");
    setDashboardCompanyId(COMPANY_OPTIONS[0].companyId);
  }, []);

  const scenarioTitle = SCENARIO_OPTIONS.find((o) => o.scenarioId === labState?.config.scenarioId)?.title ?? "—";

  const displayedRecord = useMemo(() => {
    if (!labState || labState.history.length === 0) return undefined;
    if (selectedTurn !== null) return labState.history.find((r) => r.turn === selectedTurn);
    return labState.history[labState.history.length - 1];
  }, [labState, selectedTurn]);

  const nameById = useMemo(() => new Map((fixtures ?? []).map((f) => [f.companyId, f.displayName])), [fixtures]);

  // 品質ダッシュボード（Phase 7B）が表示対象とする会社。自社表示時は常にプレイヤー操作会社
  // （実プレイヤーは他社の非公開結果を見られないという既存の規約を踏襲）、GM表示時のみ選択可能。
  const effectiveDashboardCompanyId = viewMode === "self" ? draftPlayerCompanyId : dashboardCompanyId;
  const previousRecordForDashboard = useMemo(() => {
    if (!labState || !displayedRecord) return undefined;
    return labState.history.find((r) => r.turn === displayedRecord.turn - 1);
  }, [labState, displayedRecord]);

  const playerFixture = fixtures?.find((f) => f.companyId === draftPlayerCompanyId);
  const ownStateForEditor = labState && playerFixture ? buildCompanyOwnState(labState, playerFixture) : undefined;
  const playerSummary = displayedRecord?.companySummaries.find((s) => s.companyId === draftPlayerCompanyId);

  const progressLabel = labState ? `${labState.history.length} / ${labState.config.turns} 四半期` : "—";

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <LabBanner />

      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        {runError && (
          <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-4 py-3 text-sm text-red-200">エラー: {runError}</div>
        )}

        <ScenarioControls
          scenarioOptions={SCENARIO_OPTIONS}
          companyOptions={COMPANY_OPTIONS}
          draftScenarioId={draftScenarioId}
          draftMode={draftMode}
          draftSeed={draftSeed}
          draftPlayerCompanyId={draftPlayerCompanyId}
          onChangeScenarioId={setDraftScenarioId}
          onChangeMode={setDraftMode}
          onChangeSeed={setDraftSeed}
          onChangePlayerCompanyId={setDraftPlayerCompanyId}
          onInit={handleInit}
          onStepOnce={handleStepOnce}
          onBulkRun={handleBulkRun}
          onReset={handleReset}
          canEditSetup={labState === null}
          canStepOnce={labState !== null && !labState.isComplete && playerDraft !== null}
          canBulkRun={labState !== null && !labState.isComplete}
          hasRun={labState !== null}
          progressLabel={progressLabel}
        />

        {!labState || !fixtures ? (
          <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">
            まだ初期化されていません。上の設定を確認し「初期化」を押してください。
          </div>
        ) : (
          <div className="space-y-5">
            {labState.history.length === 0 && (
              <div className="bg-gray-800 rounded-2xl p-4 text-sm text-gray-400">
                初期化しました（0 / {labState.config.turns} 四半期）。「1四半期進める」または一括実行ボタンを押してください。
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-gray-400">
                表示する四半期:
                <select
                  value={selectedTurn ?? ""}
                  onChange={(e) => setSelectedTurn(e.target.value === "" ? null : Number(e.target.value))}
                  className="bg-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100"
                  disabled={labState.history.length === 0}
                >
                  <option value="">最新に追従</option>
                  {labState.history.map((r) => (
                    <option key={r.turn} value={r.turn}>
                      turn {r.turn}（{r.period}）
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-1 text-xs">
                <span className="text-gray-400 mr-1">表示モード:</span>
                <button
                  onClick={() => setViewMode("self")}
                  className={`px-3 py-1.5 rounded-lg font-semibold ${viewMode === "self" ? "bg-teal-600 text-white" : "bg-gray-700 text-gray-300"}`}
                >
                  自社表示（{draftPlayerCompanyId}）
                </button>
                <button
                  onClick={() => setViewMode("gm")}
                  className={`px-3 py-1.5 rounded-lg font-semibold ${viewMode === "gm" ? "bg-amber-600 text-white" : "bg-gray-700 text-gray-300"}`}
                >
                  GM全社表示
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-1 border-b border-gray-700">
              {(["decision", "results", "quality", "comparison"] as const).map((tab) => {
                const label = tab === "decision" ? "意思決定" : tab === "results" ? "結果" : tab === "quality" ? "品質ダッシュボード" : "全社比較";
                const disabled = tab === "comparison" && viewMode !== "gm";
                return (
                  <button
                    key={tab}
                    onClick={() => !disabled && setActiveTab(tab)}
                    disabled={disabled}
                    className={`px-4 py-2 text-sm font-semibold rounded-t-lg disabled:opacity-30 disabled:cursor-not-allowed ${
                      activeTab === tab ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {activeTab === "decision" && (
              <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
                <h2 className="text-base font-semibold text-gray-100 mb-3">
                  意思決定編集（{draftPlayerCompanyId} — {nameById.get(draftPlayerCompanyId) ?? draftPlayerCompanyId}）
                </h2>
                {playerFixture && ownStateForEditor && playerDraft ? (
                  <DecisionEditor
                    fixture={playerFixture}
                    ownState={ownStateForEditor}
                    draft={playerDraft}
                    onChange={setPlayerDraft}
                    disabled={labState.isComplete}
                  />
                ) : (
                  <div className="text-sm text-gray-400">このシナリオはすでに完了しています。</div>
                )}
              </div>
            )}

            {activeTab === "results" && (
              <div className="space-y-5">
                {!displayedRecord ? (
                  <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">
                    まだ四半期の結果がありません。「1四半期進める」または一括実行を行ってください。
                  </div>
                ) : viewMode === "self" ? (
                  <>
                    <MarketPanel marketResult={displayedRecord.marketResult} globalReasonCodes={displayedRecord.globalReasonCodes} />
                    {playerSummary && <ResultsPanel summary={playerSummary} displayName={nameById.get(draftPlayerCompanyId) ?? draftPlayerCompanyId} />}
                  </>
                ) : (
                  <>
                    <MarketPanel marketResult={displayedRecord.marketResult} globalReasonCodes={displayedRecord.globalReasonCodes} />
                    <div className="text-[11px] bg-amber-900/60 border border-amber-600/50 text-amber-200 rounded-lg px-3 py-2 inline-block">
                      GM全社表示 — 実際のプレイヤーには見えない他社の結果を含みます
                    </div>
                    {displayedRecord.companySummaries.map((s) => (
                      <ResultsPanel key={s.companyId} summary={s} displayName={nameById.get(s.companyId) ?? s.companyId} />
                    ))}
                  </>
                )}
              </div>
            )}

            {activeTab === "quality" && (
              <div className="space-y-5" data-testid="quality-tab-panel">
                {!displayedRecord || !fixtures ? (
                  <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">
                    まだ四半期の結果がありません。「1四半期進める」または一括実行を行ってください。
                  </div>
                ) : (
                  <>
                    {viewMode === "gm" && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] bg-amber-900/60 border border-amber-600/50 text-amber-200 rounded-full px-2 py-0.5">
                          GM表示 — 表示会社を切り替えられます
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-gray-400">
                          表示会社:
                          <select
                            value={dashboardCompanyId}
                            onChange={(e) => setDashboardCompanyId(e.target.value)}
                            className="bg-gray-700 rounded px-2 py-1 text-gray-100"
                          >
                            {COMPANY_OPTIONS.map((c) => (
                              <option key={c.companyId} value={c.companyId}>
                                {c.companyId}（{c.displayName}）
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    <QualityDashboardPanel
                      record={displayedRecord}
                      previousRecord={previousRecordForDashboard}
                      history={labState.history}
                      fixtures={fixtures}
                      companyId={effectiveDashboardCompanyId}
                      displayName={nameById.get(effectiveDashboardCompanyId) ?? effectiveDashboardCompanyId}
                      showCompanyComparison={viewMode === "gm"}
                    />
                  </>
                )}
              </div>
            )}

            {activeTab === "comparison" && viewMode === "gm" && (
              <div className="space-y-5">
                {!displayedRecord ? (
                  <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">まだ四半期の結果がありません。</div>
                ) : (
                  <ComparisonPanel summaries={displayedRecord.companySummaries} nameById={nameById} />
                )}
              </div>
            )}

            <div className="text-[11px] text-gray-500">
              シナリオ: {scenarioTitle}（{labState.config.scenarioId}） / モード: {labState.config.mode} / シード: {labState.config.seed}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
