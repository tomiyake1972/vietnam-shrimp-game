"use client";

// ShrimpX V2 — PLAYER Company Workspace（Phase 8）
//
// 【別Game Engineではない】ここは会社状態を見るための画面であり、意思決定の
// 計算ロジックを新しく持たない。Decisionタブは通常プレイと同じ DecisionEditor
// コンポーネント・buildInitialDraft・buildDecisionInputFromDraft をそのまま使う
// （旧 PlayerTurnPanel modal のロジックをこのページへ移設したもの）。
//
// 【別Labを作らない】通常プレイのPlayer routeはRedis上のLabを要求するが、
// ここはそれを使わない。Management ConsoleのSimulation Runが持つ、その場の
// CompanyLabState（../lib/liveSessionRegistry 経由）をSource of Truthとする。
// レジストリに無い（別タブ・ハードリロード等でこのタブのライブ状態を持たない）
// 場合は、状態を捏造せず「経営管制室から操作してください」と案内する。
//
// 【draftはタブ移動・別タブでのAnalysis参照をまたいで保持する】
// 下書き（未確定のCompanyDecisionDraft）はliveSessionRegistryのpendingDraftsへ
// 都度書き込む。これによりOverview/Market/Inventory/Decisionタブを行き来しても、
// また別タブでAnalysisを開いてこのタブへ戻ってきても消えない。

import { useCallback, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import DecisionEditor from "../../company-lab/components/DecisionEditor";
import { buildDecisionInputFromDraft, buildInitialDraft, CompanyDecisionDraft } from "../../company-lab/decisionDraft";
import { extractCompanyCapexResult, extractCompanyFinancialResult } from "../../company-lab/play/_lib/financialViewSelectors";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { CompanyFixture, CompanyOwnState } from "../../../lib/v2/companyLab/types";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { createEmptyStrategyDocument, CompanyStrategyDocument } from "../../../lib/v2/companyLab/strategyProfile/types";
import { getLiveSession, LiveSessionEntry, upsertLiveSession } from "../lib/liveSessionRegistry";
import { persistResumableRun } from "../lib/persistRun";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyInspector } from "../components/CompanyInspector";
import { MarketSummary } from "../components/MarketSummary";
import { ExportPackButton } from "../components/ExportPackButton";
import { CompanyDatabookButton } from "./CompanyDatabookButton";
import { QUICK_NAVIGATION } from "../analysis/catalog";

type WorkspaceTab = "overview" | "market" | "inventory" | "decision";

const TABS: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
  { id: "overview", label: "Overview（財務・販売・生産・投資）" },
  { id: "market", label: "Market（市場情報）" },
  { id: "inventory", label: "Inventory（在庫）" },
  { id: "decision", label: "Decision（意思決定）" },
];

const DASH = "－";
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()}t`);
const percent = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${(v * 100).toFixed(0)}%`);

export function PlayerWorkspace() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("run");
  const companyId = searchParams.get("company");
  const consoleHref = runId ? `/v2/management?run=${encodeURIComponent(runId)}` : "/v2/management";

  if (!runId || !companyId) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <p className="text-sm text-rose-400">run・companyのいずれかが指定されていません。</p>
        <Link href="/v2/management" className="mt-3 inline-block text-sm text-sky-300 underline">
          経営管制室へ戻る
        </Link>
      </div>
    );
  }

  const entry = getLiveSession(runId);
  const session = entry?.session ?? null;
  const fixture = session ? session.fixtures.find((f) => f.companyId === companyId) : null;

  if (!session || !fixture || !entry) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <div className="mx-auto max-w-lg rounded-lg border border-amber-700 bg-amber-950/30 p-4">
          <p className="text-sm font-semibold text-amber-300">この会社の状態を、今このタブでは確認できません。</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-300">
            PLAYER Company Workspaceは、経営管制室（Management Console）で実際に進行中のSimulation
            Runの状態をそのまま使う画面です。別のタブで開いた・ページを再読み込みした等の理由で、
            このタブがそのRunの進行状態を持っていない可能性があります。経営管制室から「この会社を操作」を
            押して開き直してください。
          </p>
          <Link
            href={consoleHref}
            data-testid="workspace-back-to-console-fallback"
            className="mt-3 inline-block rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600"
          >
            経営管制室へ戻る
          </Link>
        </div>
      </div>
    );
  }

  // 【指示§9/§10】runId/companyIdが変わったら、下書き編集状態は自然に作り直したい
  // （syncのためのuseEffect+setStateではなく、keyによる再マウントで済ませる）。
  return <PlayerWorkspaceReady key={`${runId}:${companyId}`} runId={runId} companyId={companyId} session={session} fixture={fixture} entry={entry} consoleHref={consoleHref} />;
}

interface PlayerWorkspaceReadyProps {
  readonly runId: string;
  readonly companyId: string;
  readonly session: SimulationSession;
  readonly fixture: CompanyFixture;
  readonly entry: LiveSessionEntry;
  readonly consoleHref: string;
}

function PlayerWorkspaceReady({ runId, companyId, session, fixture, entry, consoleHref }: PlayerWorkspaceReadyProps) {
  const [tab, setTab] = useState<WorkspaceTab>("overview");

  const [strategyDocs] = useState<Readonly<Record<string, CompanyStrategyDocument>>>(() => ({
    [companyId]: createEmptyStrategyDocument(companyId),
  }));

  const [{ ownState, aiDecision }] = useState<{
    readonly ownState: CompanyOwnState;
    readonly aiDecision: ReturnType<typeof generateStandardAiDecision>;
  }>(() => {
    const publicInfo = buildPublicMarketInfo(session.state);
    const ownState = buildCompanyOwnState(session.state, fixture);
    const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
    return { ownState, aiDecision };
  });

  // 下書きの初期値：レジストリに残っている未確定下書き（pendingDrafts）があればそれを、
  // 無ければ確定済みPLAYER決定（confirmedPlayerDrafts）、それも無ければAI決定から作った初期値を使う。
  const [draft, setDraftState] = useState<CompanyDecisionDraft>(() => {
    const pending = entry.pendingDrafts[companyId];
    if (pending) return pending;
    const confirmedDraft = entry.confirmedPlayerDrafts[companyId];
    if (confirmedDraft && entry.confirmedPlayerDecisions[companyId]) return confirmedDraft;
    return buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  });
  const [confirmed, setConfirmed] = useState<boolean>(() => Boolean(entry.pendingDrafts[companyId] === undefined && entry.confirmedPlayerDecisions[companyId]));

  // 【Phase 9・§21根本原因】以前はここで setRevision を毎回bumpし、DecisionEditorを
  // key={revision} で毎回remountしていた。draftはcontrolled propとして渡しているため
  // remountは本来不要で、むしろ入力のたびに<input>のDOMノードごと壊して作り直す結果、
  // spinnerクリック・直接入力が「反応しない/戻る」ように見える不具合を引き起こしていた
  // （新工場のように大量の増員を続けて入力する操作で特に顕著だった）。
  // draft state自体の更新だけで再描画は十分行われるため、remountを廃止した。
  const setDraft = useCallback(
    (next: CompanyDecisionDraft) => {
      setDraftState(next);
      setConfirmed(false);
      upsertLiveSession(session.run.simulationRunId, {
        session,
        pendingDrafts: { ...(getLiveSession(session.run.simulationRunId)?.pendingDrafts ?? {}), [companyId]: next },
      });
    },
    [session, companyId]
  );

  const handleConfirm = useCallback(() => {
    const decision = buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
    const current = getLiveSession(session.run.simulationRunId);
    const nextPendingDrafts = { ...(current?.pendingDrafts ?? {}) };
    delete nextPendingDrafts[companyId];
    const nextConfirmedPlayerDecisions = { ...(current?.confirmedPlayerDecisions ?? {}), [companyId]: decision };
    upsertLiveSession(session.run.simulationRunId, {
      session,
      confirmedPlayerDecisions: nextConfirmedPlayerDecisions,
      confirmedPlayerDrafts: { ...(current?.confirmedPlayerDrafts ?? {}), [companyId]: draft },
      pendingDrafts: nextPendingDrafts,
    });
    setConfirmed(true);
    // 【指示§15】PLAYER意思決定の確定は保存タイミングの1つ（WAITING_FOR_PLAYER状態を
    // ハードリロード後も再現できるように、確定した瞬間に resumePayload ごと保存する）。
    void persistResumableRun(session, current?.companyControlModes ?? entry.companyControlModes, nextConfirmedPlayerDecisions);
  }, [session, fixture, draft, companyId, entry.companyControlModes]);

  const dataset = buildDatasetFromSession(session);
  const turn = session.state.scenarioState.currentTurn;
  const lastRecord = session.state.history[session.state.history.length - 1] ?? null;
  const summary = lastRecord?.companySummaries.find((c) => c.companyId === companyId) ?? null;
  const lastQuarterCapexResult = lastRecord ? extractCompanyCapexResult(lastRecord, companyId) : null;
  const lastQuarterFinancialResult = lastRecord ? extractCompanyFinancialResult(lastRecord, companyId) : null;
  const controlMode = entry.companyControlModes[companyId] ?? "STANDARD_AI";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-bold tracking-tight" data-testid="workspace-heading">
              {fixture.displayName}（{companyId}）— PLAYER Company Workspace
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Turn {turn} / Scenario {session.run.scenarioId} / Seed {session.run.seed} / Run ID {session.run.simulationRunId}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {controlMode !== "PLAYER" ? (
              <span className="rounded border border-amber-600 px-2 py-1 text-[11px] text-amber-300" data-testid="workspace-not-player-note">
                この会社は現在 Standard AI です（経営モードでPLAYERへ切り替えてください）
              </span>
            ) : null}
            <span
              className={`rounded px-2 py-1 text-[11px] font-medium ${confirmed ? "bg-emerald-900/60 text-emerald-300" : "bg-amber-900/60 text-amber-300"}`}
              data-testid="workspace-decision-status"
            >
              {confirmed ? `Turn ${turn} 意思決定済み` : `Turn ${turn} 意思決定はまだ確定していません`}
            </span>
            <Link
              href={consoleHref}
              data-testid="workspace-back-to-console"
              className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              経営管制室へ戻る
            </Link>
          </div>
        </div>

        {/* 【指示§14】タブで情報閲覧⇄意思決定入力を切り替える。draftはタブ間で消えない。 */}
        <nav className="mt-2 flex flex-wrap gap-1" aria-label="Workspace タブ">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              data-testid={`workspace-tab-${t.id}`}
              aria-pressed={tab === t.id}
              className={`rounded px-2.5 py-1.5 text-xs font-semibold ${tab === t.id ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* 【指示§21】Analysisはrun/companyの両方をquery付きで。新しいタブで開いてもdraftは消えない。 */}
        <nav className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="Analysisへのリンク">
          <span className="text-[11px] text-slate-400">Analysis（別タブで開けます）:</span>
          {QUICK_NAVIGATION.map((q) => (
            <a
              key={q.testId}
              href={`${q.path}?run=${encodeURIComponent(runId)}&company=${encodeURIComponent(companyId)}`}
              target="_blank"
              rel="noreferrer"
              data-testid={`workspace-${q.testId}`}
              className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-slate-800"
            >
              {q.label} ↗
            </a>
          ))}
        </nav>
      </header>

      <div className="p-3">
        {tab === "overview" ? (
          <div className="mx-auto max-w-3xl">
            {/* 【指示§10】新しい表示ロジックを作らず、既存のCompanyInspectorをそのまま埋め込む
                （財務・販売・生産・在庫の一部・市場ボトルネック・投資状況を一括カバーする）。 */}
            <CompanyInspector
              dataset={dataset}
              fixtures={[fixture]}
              selectedCompanyId={companyId}
              onSelect={() => {}}
              strategyDocs={strategyDocs}
              strategyTurns={session.packCompanyTurns}
            />
          </div>
        ) : null}

        {tab === "market" ? (
          <div className="mx-auto max-w-4xl">
            <MarketSummary dataset={dataset} />
          </div>
        ) : null}

        {tab === "inventory" ? (
          <div className="mx-auto max-w-2xl rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="workspace-inventory">
            <h2 className="mb-2 text-sm font-semibold">在庫（直近確定Turn）</h2>
            {summary === null ? (
              <p className="text-xs text-slate-400">まだ確定した実績がありません。</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-400">完成品在庫</dt>
                <dd className="text-right tabular-nums">{tons(unwrapUnit(summary.finishedGoodsInventory))}</dd>
                <dt className="text-slate-400">原料在庫</dt>
                <dd className="text-right tabular-nums">{tons(unwrapUnit(summary.rawMaterialInventory))}</dd>
                <dt className="text-slate-400">未履行残高（backlog）</dt>
                <dd className="text-right tabular-nums">{tons(unwrapUnit(summary.outstandingQuantity))}</dd>
                <dt className="text-slate-400">納期超過</dt>
                <dd className="text-right tabular-nums">{tons(unwrapUnit(summary.overdueQuantity))}</dd>
                <dt className="text-slate-400">設備稼働率</dt>
                <dd className="text-right tabular-nums">{percent(summary.equipmentUtilizationRate)}</dd>
                <dt className="text-slate-400">労働稼働率</dt>
                <dd className="text-right tabular-nums">{percent(summary.laborUtilizationRate)}</dd>
              </dl>
            )}
          </div>
        ) : null}

        {tab === "decision" ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                onClick={handleConfirm}
                data-testid="workspace-confirm-decision"
                className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold hover:bg-emerald-600"
              >
                この内容で意思決定を確定
              </button>
            </div>
            <DecisionEditor
              fixture={fixture}
              ownState={ownState}
              draft={draft}
              onChange={setDraft}
              disabled={false}
              period={session.state.currentPeriod}
              lastQuarterCapexEvents={lastQuarterCapexResult?.events}
              lastQuarterRejectedCapexProposals={lastQuarterCapexResult?.rejectedProposals}
              lastQuarterFinancialResult={lastQuarterFinancialResult}
            />
          </div>
        ) : null}

        {/* 【指示B】この会社1社だけのDatabook（意思決定用・通常プレイと同じ内容）。 */}
        <div className="mx-auto mt-4 max-w-5xl rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-3">
          <h2 className="mb-1 text-sm font-semibold text-emerald-300">会社Databook（{companyId}だけの意思決定用データ）</h2>
          <p className="mb-2 text-[11px] text-slate-400">
            PL・BS・CF・契約・在庫・工場・借入等、通常プレイと同じ内容をこの会社ぶんだけ出力します。他社の非公開情報は含みません。
          </p>
          <CompanyDatabookButton session={session} companyId={companyId} />
        </div>

        {/* 【指示§18/§19/§20】AI Analysis Pack export。Run全体のPackであることを明記し、上の会社Databookとは別物と分かるようにする。 */}
        <div className="mx-auto mt-3 max-w-5xl">
          <p className="mb-1 text-[11px] text-slate-500">
            ⓘ 以下はこのRun全体（5社ぶん）の、研究用AI Analysis Packです（上の会社Databookとは別物）。この会社（{companyId}）だけの出力ではありません。
          </p>
          <ExportPackButton
            simulationRunId={session.run.simulationRunId}
            scenarioId={session.run.scenarioId}
            seed={session.run.seed}
            completedTurns={session.run.completedTurns}
            compact
          />
        </div>
      </div>
    </div>
  );
}
