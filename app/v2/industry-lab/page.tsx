// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） ルートページ
//
// 実装指示 §6〜§11 に対応するClient Component。すべての状態（フォーム下書き・
// 実行中のシミュレーション状態・表示ターン・情報レベル・比較対象）をここで
// 保持し、下位の表示コンポーネントへ渡すだけにする（計算ロジックは一切
// 持たず、app/lib/v2/industryLab の純粋関数のみを呼び出す）。
//
// Redis・API Route・process.env は一切使用しない（実装指示 §11）。
// フォームの下書き値（draft*）を変更しても、すでに実行中のシミュレーション
// （labState）の表示には影響しない。labStateは「開始」を押した時点の
// 設定のスナップショットから作られるため、「入力を変えたら古い結果に新しい
// 設定が混ざる」ことは構造的に起こらない（実装指示 §6）。

"use client";

import { useCallback, useMemo, useState } from "react";
import { ALL_SCENARIO_DEFINITIONS } from "../../lib/v2/scenario";
import { ScenarioMode } from "../../lib/v2/scenario/types";
import {
  IndustrySimulationConfig,
  IndustrySimulationState,
  IndustrySimulationError,
  DisplayInformationLevel,
  initializeIndustrySimulation,
  advanceIndustrySimulation,
  runIndustrySimulation,
  compareIndustrySimulations,
  selectQuarterByTurn,
  selectLatestQuarter,
  buildHosoPriceSeries,
  buildVietnamDomesticPriceSeries,
  buildPremiumSeries,
  buildSupplyDemandSeries,
} from "../../lib/v2/industryLab";
import { COUNTRY_IDS } from "../../lib/v2/market/types";
import { COUNTRY_COLORS, COUNTRY_NAMES } from "./components/chartColors";
import LabBanner from "./components/LabBanner";
import AssumptionsNotice from "./components/AssumptionsNotice";
import ScenarioControls, { ScenarioOption } from "./components/ScenarioControls";
import SummaryPanel from "./components/SummaryPanel";
import LineChart, { LineChartSeries } from "./components/LineChart";
import EventsPanel from "./components/EventsPanel";
import PriceDriversPanel from "./components/PriceDriversPanel";
import InformationPanel from "./components/InformationPanel";
import ComparisonPanel, { ComparisonScenarioOption } from "./components/ComparisonPanel";

const DEFAULT_SEED = "lab-seed-001";
const DEFAULT_TURNS = 32;
const MIN_TURNS_INPUT = 20;

const SCENARIO_OPTIONS: readonly ScenarioOption[] = ALL_SCENARIO_DEFINITIONS.map((d) => ({
  scenarioId: d.scenarioId,
  title: d.title,
  durationTurns: d.durationTurns,
}));

function clampTurns(value: number, maxTurns: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : MIN_TURNS_INPUT;
  return Math.min(Math.max(rounded, MIN_TURNS_INPUT), Math.max(MIN_TURNS_INPUT, Math.min(40, maxTurns)));
}

export default function IndustryLabPage() {
  // --- フォーム下書き（「開始」を押すまでlabStateには影響しない） ---
  const [draftScenarioId, setDraftScenarioId] = useState(SCENARIO_OPTIONS[0].scenarioId);
  const [draftMode, setDraftMode] = useState<ScenarioMode>("canonical");
  const [draftSeed, setDraftSeed] = useState(DEFAULT_SEED);
  const [draftTurns, setDraftTurns] = useState(
    Math.min(DEFAULT_TURNS, SCENARIO_OPTIONS[0].durationTurns)
  );

  // --- 実行中のシミュレーション状態 ---
  const [labState, setLabState] = useState<IndustrySimulationState | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null); // null = 最新に追従
  const [infoLevel, setInfoLevel] = useState<DisplayInformationLevel>("public");

  // --- シナリオ比較 ---
  const [comparisonScenarioId, setComparisonScenarioId] = useState<string | null>(null);

  const maxTurnsForDraftScenario =
    SCENARIO_OPTIONS.find((o) => o.scenarioId === draftScenarioId)?.durationTurns ?? 40;

  const handleChangeScenarioId = useCallback((id: string) => {
    setDraftScenarioId(id);
    const def = SCENARIO_OPTIONS.find((o) => o.scenarioId === id);
    if (def) {
      setDraftTurns((t) => clampTurns(t, def.durationTurns));
    }
  }, []);

  const handleChangeTurns = useCallback(
    (value: number) => {
      setDraftTurns(clampTurns(value, maxTurnsForDraftScenario));
    },
    [maxTurnsForDraftScenario]
  );

  function describeError(e: unknown): string {
    if (e instanceof IndustrySimulationError) return e.message;
    if (e instanceof Error) return `予期しないエラー: ${e.message}`;
    return "予期しないエラーが発生しました。";
  }

  const handleStart = useCallback(() => {
    const config: IndustrySimulationConfig = {
      scenarioId: draftScenarioId,
      mode: draftMode,
      seed: draftSeed.trim().length > 0 ? draftSeed.trim() : DEFAULT_SEED,
      turns: draftTurns,
    };
    try {
      const nextState = initializeIndustrySimulation(config);
      setLabState(nextState);
      setRunError(null);
      setSelectedTurn(null);
      setComparisonScenarioId(null);
    } catch (e) {
      setRunError(describeError(e));
    }
  }, [draftScenarioId, draftMode, draftSeed, draftTurns]);

  const handleStepOnce = useCallback(() => {
    setLabState((current) => {
      if (!current || current.isComplete) return current;
      try {
        const next = advanceIndustrySimulation(current);
        setRunError(null);
        return next;
      } catch (e) {
        setRunError(describeError(e));
        return current;
      }
    });
    setSelectedTurn(null); // 最新へ追従
  }, []);

  const handleRunToEnd = useCallback(() => {
    setLabState((current) => {
      if (!current) return current;
      let state = current;
      try {
        while (!state.isComplete) {
          state = advanceIndustrySimulation(state);
        }
        setRunError(null);
        return state;
      } catch (e) {
        setRunError(describeError(e));
        return state;
      }
    });
    setSelectedTurn(null);
  }, []);

  const handleReset = useCallback(() => {
    setLabState(null);
    setRunError(null);
    setSelectedTurn(null);
    setComparisonScenarioId(null);
  }, []);

  const displayedQuarter = labState
    ? selectedTurn !== null
      ? selectQuarterByTurn(labState.quarters, selectedTurn)
      : selectLatestQuarter(labState.quarters)
    : undefined;

  const scenarioTitle =
    SCENARIO_OPTIONS.find((o) => o.scenarioId === labState?.config.scenarioId)?.title ?? "—";

  // --- グラフ用系列（すでに計算済みの結果を並べるだけ） ---
  const hosoSeries = useMemo(() => (labState ? buildHosoPriceSeries(labState.quarters) : []), [labState]);
  const vnDomesticSeries = useMemo(
    () => (labState ? buildVietnamDomesticPriceSeries(labState.quarters) : []),
    [labState]
  );
  const premiumSeries = useMemo(() => (labState ? buildPremiumSeries(labState.quarters) : []), [labState]);
  const supplyDemandSeries = useMemo(
    () => (labState ? buildSupplyDemandSeries(labState.quarters) : []),
    [labState]
  );

  const periodLabels = hosoSeries.map((p) => p.periodLabel);

  const hosoChartSeries: readonly LineChartSeries[] = COUNTRY_IDS.map((c) => ({
    key: c,
    label: COUNTRY_NAMES[c],
    color: COUNTRY_COLORS[c],
    values: hosoSeries.map((p) => p[c]),
  }));

  const vnDomesticChartSeries: readonly LineChartSeries[] = [
    { key: "vn_domestic", label: "ベトナム国内原料価格", color: "#ef4444", values: vnDomesticSeries.map((p) => p.price) },
  ];

  const premiumChartSeries: readonly LineChartSeries[] = [
    { key: "pd", label: "PDプレミアム", color: "#f59e0b", values: premiumSeries.map((p) => p.pdPremium) },
    { key: "vap", label: "VAPプレミアム", color: "#8b5cf6", values: premiumSeries.map((p) => p.vapPremium) },
  ];

  const supplyDemandChartSeries: readonly LineChartSeries[] = [
    { key: "supply", label: "世界供給", color: "#3b82f6", values: supplyDemandSeries.map((p) => p.worldSupply) },
    { key: "demand", label: "世界需要", color: "#a855f7", values: supplyDemandSeries.map((p) => p.worldDemand) },
  ];

  // --- シナリオ比較 ---
  const comparisonScenarioOptions: readonly ComparisonScenarioOption[] = useMemo(
    () =>
      SCENARIO_OPTIONS.filter((o) => o.scenarioId !== labState?.config.scenarioId).map((o) => ({
        scenarioId: o.scenarioId,
        title: o.title,
      })),
    [labState?.config.scenarioId]
  );

  const comparisonOutcome = useMemo(() => {
    if (!labState || !comparisonScenarioId) {
      return { result: null as ReturnType<typeof compareIndustrySimulations> | null, error: null as string | null };
    }
    try {
      const baseResult = runIndustrySimulation(labState.config);
      const otherResult = runIndustrySimulation({ ...labState.config, scenarioId: comparisonScenarioId });
      const diff = compareIndustrySimulations(baseResult, otherResult);
      return { result: diff, error: null as string | null };
    } catch (e) {
      return { result: null, error: describeError(e) };
    }
  }, [labState, comparisonScenarioId]);

  const comparisonScenarioTitle =
    SCENARIO_OPTIONS.find((o) => o.scenarioId === comparisonScenarioId)?.title ?? null;

  const comparisonDisabledReason = !labState
    ? "シミュレーションを開始してください。"
    : comparisonOutcome.error;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <LabBanner />

      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <AssumptionsNotice />

        {runError && (
          <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-4 py-3 text-sm text-red-200">
            エラー: {runError}
          </div>
        )}

        <ScenarioControls
          scenarioOptions={SCENARIO_OPTIONS}
          draftScenarioId={draftScenarioId}
          draftMode={draftMode}
          draftSeed={draftSeed}
          draftTurns={draftTurns}
          maxTurnsForDraftScenario={maxTurnsForDraftScenario}
          onChangeScenarioId={handleChangeScenarioId}
          onChangeMode={setDraftMode}
          onChangeSeed={setDraftSeed}
          onChangeTurns={handleChangeTurns}
          onStart={handleStart}
          onStepOnce={handleStepOnce}
          onRunToEnd={handleRunToEnd}
          onReset={handleReset}
          canStepOnce={labState !== null && !labState.isComplete}
          canRunToEnd={labState !== null && !labState.isComplete}
          hasRun={labState !== null}
          progressLabel={labState ? `${labState.quarters.length} / ${labState.config.turns} 四半期` : "—"}
        />

        {!labState ? (
          <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">
            まだシミュレーションが実行されていません。上の設定を確認し「シミュレーション開始」を押してください。
          </div>
        ) : (
          <div className="space-y-5">
            {labState.quarters.length === 0 && (
              <div className="bg-gray-800 rounded-2xl p-4 text-sm text-gray-400">
                シミュレーションを初期化しました（0 / {labState.config.turns} 四半期）。「1四半期進める」または
                「最後まで一括実行」をクリックしてください。
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <label className="flex items-center gap-2">
                表示する四半期:
                <select
                  value={selectedTurn ?? ""}
                  onChange={(e) => setSelectedTurn(e.target.value === "" ? null : Number(e.target.value))}
                  className="bg-gray-700 rounded-lg px-2 py-1 text-sm text-gray-100"
                  disabled={labState.quarters.length === 0}
                >
                  <option value="">最新に追従</option>
                  {labState.quarters.map((q) => (
                    <option key={q.turn} value={q.turn}>
                      turn {q.turn}（{q.periodLabel}）
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <SummaryPanel
              scenarioTitle={scenarioTitle}
              mode={labState.config.mode}
              seed={labState.config.seed}
              currentTurn={displayedQuarter?.turn ?? 0}
              totalTurns={labState.config.turns}
              quarter={displayedQuarter}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
                <LineChart title="国際HOSO価格トレンド（国別FOB）" xLabels={periodLabels} series={hosoChartSeries} unit="USD/kg" />
              </div>
              <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
                <LineChart title="ベトナム国内原料価格トレンド" xLabels={periodLabels} series={vnDomesticChartSeries} unit="USD/kg" />
              </div>
              <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
                <LineChart title="世界供給・需要トレンド" xLabels={periodLabels} series={supplyDemandChartSeries} unit="HOSO換算トン" />
              </div>
              <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
                <LineChart title="PD/VAPプレミアムトレンド" xLabels={periodLabels} series={premiumChartSeries} unit="USD/kg" />
              </div>
            </div>

            <PriceDriversPanel quarter={displayedQuarter} />

            <EventsPanel quarter={displayedQuarter} />

            <InformationPanel quarter={displayedQuarter} level={infoLevel} onChangeLevel={setInfoLevel} />

            <ComparisonPanel
              scenarioOptions={comparisonScenarioOptions}
              baseScenarioTitle={scenarioTitle}
              comparisonScenarioId={comparisonScenarioId}
              onChangeComparisonScenarioId={setComparisonScenarioId}
              comparison={comparisonOutcome.result}
              comparisonScenarioTitle={comparisonScenarioTitle}
              disabledReason={comparisonDisabledReason}
            />
          </div>
        )}
      </div>
    </div>
  );
}
