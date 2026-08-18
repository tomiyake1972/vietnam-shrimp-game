// ShrimpX V2 — AI Management Meeting API ハンドラー本体（Simulation Run 経路）
//
// 【なぜ Company Lab を作らないか】Management Console の PLAYER Company Workspace は
// 設計上 Redis 上の Lab を持たず、Simulation Run（simulationRunId）の中に会社状態を持つ。
// AI会議のためだけに裏で Lab を生成すると「別のゲームの初期状態」を相手に会議することに
// なり、成立しない。そこで保存済み Simulation Run の resumePayload（CompanyLabState と
// fixtures をそのまま持つ）から会社状態を読み、Company Lab 経路と同じ
// AiMeetingCompanySnapshot へ詰め替える。
//
// 【会議ロジックはここに持たない】Company Lab 経路の handlers.ts と同じく、
// aiManagementMeeting/session.ts の runAiMeetingTurn を呼ぶだけ。prompt・役員role・
// proposal schema・validation・Claude呼び出し方針はどちらの経路でも同一の実装を通る。
//
// 【client から会社状態を受け取らない】リクエストが運ぶのは simulationRunId /
// companyId / turn / 発言テキストだけで、会社の数値は必ずサーバー側が Redis から読む。
// turn が保存済み状態のターンと一致しない場合は 404 にして、古い状態のまま会議が
// 成立してしまうことを構造的に防ぐ。
//
// 【ゲーム状態を一切変更しない】保存済み Simulation Run へ書き戻す経路を持たない。
// 書き込むのは会話artifact（conversation.ts の Redis 名前空間）だけ。

import { SimulationRunRepository } from "../../../../../../../../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CompanyLabRedisClient } from "../../../../../../../../../../../lib/v2/redis/companyLabTypes";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../../../../../../../../../lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../../../../../../../../../../../lib/v2/companyLab/standardAi/orientationProfile";
import { CompanyDecisionInput, CompanyQuarterRecord } from "../../../../../../../../../../../lib/v2/companyLab/types";
import { BorrowingHeadroomFact, CrisisFact, PlayerDraftSummary } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { buildAiMeetingScenarioNews } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/scenarioNews";
import {
  AiMeetingApiResult,
  AiMeetingCompanySnapshot,
  loadAiMeetingConversation,
  runAiMeetingTurn,
  simulationRunContextId,
} from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/session";
import { AnthropicMessagesClient } from "../../../../../../../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { resolveScenarioDefinition } from "../../../../../../../../../../../lib/v2/industryLab/cli/scenarioAliases";
import { toYearQuarter } from "../../../../../../../../../../../lib/v2/core/period";

function notFound(message: string): AiMeetingApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

export interface PostRunAiMeetingRequestBody {
  readonly meetingId?: string;
  readonly playerMessage: string;
}

export interface RunAiMeetingDependencies {
  readonly repository: SimulationRunRepository;
  readonly redisClient: CompanyLabRedisClient;
}

/**
 * 確定済みPLAYER意思決定から draft 要約を作る。
 *
 * 【編集中の下書きは含まれない】PLAYER Workspace の未確定 draft はブラウザ内
 * （liveSessionRegistry）にしか無く、サーバーからは見えない。会議には「まだ確定して
 * いない」（hasDraft:false）として渡す。client から draft を送らせて偽装できる経路を
 * 作らないことを優先した。
 */
function buildPlayerDraftSummary(decision: CompanyDecisionInput | undefined): PlayerDraftSummary {
  if (!decision) return { hasDraft: false, totalDesiredSalesQuantityTons: 0, capexProposalCount: 0, financingRequestedUsd: 0 };
  return {
    hasDraft: true,
    totalDesiredSalesQuantityTons: decision.salesPlans.reduce((sum, p) => sum + p.desiredQuantity, 0),
    capexProposalCount: decision.capexDecision.newProjectProposals.length,
    financingRequestedUsd: decision.financingRequest.desiredAmountUsd,
  };
}

/**
 * state.history（turn昇順・欠番無し）から、指定turnの確定四半期スナップショットを
 * 会議briefing向けの形へ整形する。company-labs handler.tsのloadQuarterSnapshotと
 * 同じ項目・同じ既存フィールドの転記のみ（新しい会計・生産計算はしない）。
 * 該当turnの実績が無い場合（turn1・turn2等）はnull（捏造しない）。
 */
function buildQuarterSnapshot(history: readonly CompanyQuarterRecord[], companyId: string, targetTurn: number) {
  if (targetTurn < 1) return null;
  const entry = history.find((r) => r.turn === targetTurn);
  if (!entry) return null;
  const financialResult = entry.financialResults.find((f) => f.companyId === companyId);
  const summary = entry.companySummaries.find((s) => s.companyId === companyId);
  if (!financialResult || !summary) return null;
  const yq = toYearQuarter(entry.period);
  const decision = entry.decisions.find((d) => d.companyId === companyId);
  return {
    pnl: financialResult.profitAndLoss,
    cashFlow: financialResult.cashFlow,
    balanceSheet: financialResult.balanceSheet,
    periodLabel: `${yq.year}年Q${yq.quarter}`,
    fulfilledQuantityTons: Number(summary.fulfilledQuantity),
    summary,
    workerAssignments: decision?.workerAssignments ?? [],
    productionEntries: entry.productionAllocation.entries.filter((e) => e.companyId === companyId),
  };
}

/**
 * 保存済み Simulation Run から AiMeetingCompanySnapshot を組み立てる。
 * 見つからない・resumePayload が無い・会社が居ない場合は 404 相当の失敗を返す。
 */
export async function buildSnapshotFromSimulationRun(
  repository: SimulationRunRepository,
  simulationRunId: string,
  companyId: string
): Promise<{ readonly ok: true; readonly snapshot: AiMeetingCompanySnapshot } | { readonly ok: false; readonly result: AiMeetingApiResult }> {
  const stored = await repository.loadRun(simulationRunId);
  if (!stored) {
    return { ok: false, result: notFound(`Simulation Run "${simulationRunId}" が見つかりません。`) };
  }
  const resume = stored.resumePayload;
  if (!resume) {
    return {
      ok: false,
      result: notFound(
        `Simulation Run "${simulationRunId}" には、AI Management Meetingに必要な会社状態（resumePayload）が保存されていません。経営管制室でターンを進めるか意思決定を確定すると保存されます。`
      ),
    };
  }
  const fixture = resume.fixtures.find((f) => f.companyId === companyId);
  if (!fixture) {
    return { ok: false, result: notFound(`会社 "${companyId}" は、このSimulation Runに存在しません。`) };
  }

  // PLAYER Workspace（PlayerWorkspace.tsx）がブラウザ側で行っているのと同じ導出を、
  // 同じ pure function で行う。新しい計算式はここに一切書かない。
  const state = resume.state;
  const publicInfo = buildPublicMarketInfo(state);
  const ownState = buildCompanyOwnState(state, fixture);
  const currentTurn = state.scenarioState.currentTurn;
  // 【Phase SAI-5B】PlayerWorkspace.tsx・simulation/engine.ts と同じ会社別params
  // （ManagementProfile+CompanyOrientationProfile）で診断を作る。AI経営会議へ渡す
  // 診断が会社差ゼロのparams由来だと、会議の説明と実際のAI判断が食い違うため。
  const aiParams = resolveStandardAiProfileForMode(fixture.companyId, state.config.standardAiProfileMode).params;
  const diagnostics = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, currentTurn, aiParams).diagnostics;

  const lastRecord = state.history[state.history.length - 1] ?? null;
  const previousFinancialResult = lastRecord?.financialResults.find((r) => r.companyId === companyId) ?? null;
  const previousQuarter =
    previousFinancialResult && lastRecord
      ? {
          cashUsd: Number(previousFinancialResult.balanceSheet.cash),
          netRevenueUsd: Number(previousFinancialResult.profitAndLoss.netRevenue),
          operatingProfitUsd: Number(previousFinancialResult.profitAndLoss.operatingProfit),
          periodLabel: (() => {
            const yq = toYearQuarter(lastRecord.period);
            return `${yq.year}年Q${yq.quarter}`;
          })(),
        }
      : null;

  // 【M2.2追加分をSimulation Run経路へも配線】company-labs handler.tsと同じ既存
  // ownState/diagnosticsの転記のみ（新しい財務・危機判定ロジックは作らない）。
  const lastBorrowingCapacity = ownState.lastFinancingResult?.borrowingCapacity ?? null;
  const borrowingHeadroom: BorrowingHeadroomFact | null = lastBorrowingCapacity
    ? {
        availableAdditionalCapacityUsd: lastBorrowingCapacity.availableAdditionalCapacityUsd,
        asOfLabel: (() => {
          const yq = toYearQuarter(lastBorrowingCapacity.period);
          return `${yq.year}年Q${yq.quarter}`;
        })(),
      }
    : null;
  const crisis: CrisisFact | null = diagnostics.crisis ? { state: diagnostics.crisis.state, summary: diagnostics.crisis.summary } : null;

  // 【M2.3/M2.4追加分をSimulation Run経路へも配線】state.historyは既にRun全体ぶん
  // メモリ上に確定済みのため、company-labs handler.tsのような非同期repository読込は
  // 不要（同じ既存フィールドをその場で転記するだけ）。
  const reportingPeriodSnapshot = buildQuarterSnapshot(state.history, companyId, currentTurn - 1);
  const priorPeriodSnapshot = buildQuarterSnapshot(state.history, companyId, currentTurn - 2);

  const snapshot: AiMeetingCompanySnapshot = {
    contextId: simulationRunContextId(simulationRunId),
    companyId,
    currentTurn,
    scenarioId: stored.run.scenarioId,
    period: state.currentPeriod,
    fixture,
    ownState,
    publicInfo,
    diagnostics,
    previousQuarter,
    playerDraft: buildPlayerDraftSummary(resume.confirmedPlayerDecisions[companyId]),
    // Player が読める News と同じ集合（getAvailableInformation 経由）。
    // シナリオIDでの分岐は無く、informationReleases が無いシナリオでは空配列になる。
    scenarioNews: buildAiMeetingScenarioNews(resolveScenarioDefinition(stored.run.scenarioId), currentTurn),
    contracts: ownState.contracts,
    receivables: ownState.financeState.receivables,
    payables: ownState.financeState.payables,
    loans: ownState.financingState.loanPortfolio.loans,
    capexProjects: ownState.capexState.portfolio.projects,
    borrowingHeadroom,
    crisis,
    financialHistory: {
      reportingPeriod: reportingPeriodSnapshot,
      priorPeriod: priorPeriodSnapshot
        ? { pnl: priorPeriodSnapshot.pnl, periodLabel: priorPeriodSnapshot.periodLabel, fulfilledQuantityTons: priorPeriodSnapshot.fulfilledQuantityTons }
        : null,
    },
    operationalHistory: {
      reportingPeriod: reportingPeriodSnapshot
        ? {
            summary: reportingPeriodSnapshot.summary,
            workerAssignments: reportingPeriodSnapshot.workerAssignments,
            productionEntries: reportingPeriodSnapshot.productionEntries,
            periodLabel: reportingPeriodSnapshot.periodLabel,
          }
        : null,
      priorPeriod: priorPeriodSnapshot ? { summary: priorPeriodSnapshot.summary } : null,
    },
  };
  return { ok: true, snapshot };
}

/** POST: プレイヤー発言を受け取り、Simulation Run の現在状態から会議1回ぶんを実行する。 */
export async function handlePostRunAiMeetingMessage(
  deps: RunAiMeetingDependencies,
  simulationRunId: string,
  companyId: string,
  turnParam: string,
  body: PostRunAiMeetingRequestBody,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiMeetingApiResult> {
  const built = await buildSnapshotFromSimulationRun(deps.repository, simulationRunId, companyId);
  if (!built.ok) return built.result;

  return runAiMeetingTurn({
    redisClient: deps.redisClient,
    snapshot: built.snapshot,
    requestedTurn: Number(turnParam),
    playerMessage: body.playerMessage,
    meetingId: body.meetingId,
    anthropicClient,
  });
}

/** GET: 読み取り専用。既存の会話状態（meetingId指定）を返す。副作用なし。 */
export async function handleGetRunAiMeetingConversation(
  deps: RunAiMeetingDependencies,
  simulationRunId: string,
  companyId: string,
  meetingIdParam: string
): Promise<AiMeetingApiResult> {
  return loadAiMeetingConversation(deps.redisClient, simulationRunContextId(simulationRunId), companyId, meetingIdParam);
}
