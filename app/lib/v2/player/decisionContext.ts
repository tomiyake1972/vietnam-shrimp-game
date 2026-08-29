// ShrimpX V2 — Independent Player Flow: Player Decision Context（サーバー側で作る、Playerへ返してよい形だけの視界）
//
// 【最重要】ここがPlayerの競合秘匿情報を守る唯一の場所。resumePayload/StoredSimulationRun
// はGM向けの全知state（5社の真の内部状態を丸ごと持つ）であり、これをそのままPlayerの
// ブラウザへ返すと「Player cannot inspect competitor private state」という指示に反する。
// このモジュールはサーバー側（Route Handler）でだけ実行し、既に他画面で確立している
// 「自社視点への絞り込み」関数（buildCompanyOwnState・buildPublicMarketInfo）を
// そのまま再利用して、Playerのブラウザへ返してよい最小限の形だけを組み立てる。
//
// 【新しいGame Engineを作らない】ここでは一切の意思決定計算・確定処理を行わない。
// 既存のrunner.ts（buildCompanyOwnState/buildPublicMarketInfo）・
// standardAi/policy.ts（初期draft用のAI提案生成）をそのまま呼ぶだけ。

import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../companyLab/types";
import { PeriodV2 } from "../core/period";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../companyLab/standardAi/orientationProfile";
import { buildInitialDraft, CompanyDecisionDraft } from "../../../v2/company-lab/decisionDraft";
import { extractCompanyCapexResult, extractCompanyDividendResult, extractCompanyFinancialResult } from "../../../v2/company-lab/play/_lib/financialViewSelectors";
import { restoreSessionFromResumePayload } from "../companyLab/simulation/persistence/resume";
import { StoredSimulationRun } from "../companyLab/simulation/persistence/types";
import { CompanyEvaluationSnapshot, computeAllCompaniesEvaluationSnapshot } from "../companyLab/evaluation/evaluationSemantics";
import { EvaluationHistoryRecord, resolveEvaluationHistory } from "../companyLab/evaluation/evaluationHistory";
import { CompanyId, MarketProductAllocationResult } from "../sales/types";
import { CompanyFinancialQuarterResult } from "../finance/types";
import { CompanyDividendQuarterResult } from "../finance/dividend";
import { CapexProjectQuarterEvent, CapexRejectedProposal } from "../capex";
import { buildDatasetFromSession } from "../companyLab/simulation/analytics/dataset";
import { SimulationAnalyticsDataset } from "../companyLab/simulation/analytics/types";
import { SimulationSession } from "../companyLab/simulation/types";

export class PlayerDecisionContextError extends Error {
  constructor(
    message: string,
    readonly code: "RUN_NOT_FOUND" | "NOT_RESUMABLE" | "COMPANY_NOT_FOUND"
  ) {
    super(message);
    this.name = "PlayerDecisionContextError";
  }
}

/** Player Workspace（新Independent Player Flow）が必要とする最小限。GM向け全知stateは一切含まない。 */
export interface PlayerDecisionContext {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly companyId: CompanyId;
  readonly fixture: CompanyFixture;
  readonly companyDisplayName: string;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly period: PeriodV2;
  readonly turn: number;
  readonly draftSeed: CompanyDecisionDraft;
  readonly lastQuarterCapexEvents: readonly CapexProjectQuarterEvent[] | undefined;
  readonly lastQuarterRejectedCapexProposals: readonly CapexRejectedProposal[] | undefined;
  readonly lastQuarterFinancialResult: CompanyFinancialQuarterResult | null;
  readonly lastQuarterDividendResult: CompanyDividendQuarterResult | null;
  /**
   * 【SALES基準価格参考表示・新設】直近確定四半期の市場×商品別配分結果（全社共通・公開情報）。
   * 新しい価格計算は行わず、確定済みhistoryの値をそのまま返す。turn===1等で前四半期が
   * 存在しない場合はundefined。
   */
  readonly lastQuarterSalesAllocations: readonly MarketProductAllocationResult[] | undefined;
  /** resumePayload.confirmedPlayerDecisions[companyId]が既に埋まっているか（=このTurnは提出済み）。GMの提出済み判定と同じ信号。 */
  readonly hasSubmittedThisTurn: boolean;
  /** この会社が現在companyControlModesでPLAYERとして扱われているか。falseならGMがStandard AIへ戻した後。 */
  readonly isPlayerControlled: boolean;
  readonly gameEndedAt: string | null;
  readonly gameEndTurn: number | null;
  /** 【指示§8/§17】Final Results用。既存finalEvaluationSnapshotをそのまま返す（自社・公開範囲は既存FinalResultsSummary等が担保する）。 */
  readonly finalEvaluationSnapshot: readonly CompanyEvaluationSnapshot[] | null;
  /**
   * 【指示§17・ゲーム終了後だけ】既存FinalResultsCharts/FinalDataDownloadButtonが
   * 要求する形（5社ぶんのdataset・evaluationHistory・sessionそのもの）。
   * これらは既にGame End機能でGM承認済みの「終了後は5社比較を公開してよい」
   * 範囲（売上高・営業利益・PAT・配当・TSVの5社比較チャート、AI Analysis Pack）
   * であり、ゲーム進行中（gameEndedAt未設定）は絶対に含めない
   * （進行中の他社Revenue/Profit等は、このIndependent Player Flowでは
   * TsvLeaderboardPanel同様「自社のみ」を維持し、新たに公開しない）。
   */
  readonly finishedView: {
    readonly dataset: SimulationAnalyticsDataset;
    readonly evaluationHistory: readonly EvaluationHistoryRecord[];
    readonly session: SimulationSession;
  } | null;
}

/**
 * 保存済みRunとcompanyIdから、Playerへ返してよい最小限のcontextを組み立てる。
 * resumePayloadが無い（続きからプレイできない旧形式のRun）場合はPlayerDecisionContextError
 * （NOT_RESUMABLE）を投げる。捏造した状態は絶対に返さない。
 */
export function buildPlayerDecisionContext(stored: StoredSimulationRun, companyId: CompanyId): PlayerDecisionContext {
  if (!stored.resumePayload) {
    throw new PlayerDecisionContextError(
      "この Simulation Run は続きからプレイできる保存形式ではありません（resumePayloadがありません）。GMに新しいRunでの参加を依頼してください。",
      "NOT_RESUMABLE"
    );
  }

  const session = restoreSessionFromResumePayload(stored.run, stored.resumePayload, stored.packCapture, stored.dataset);
  const fixture = session.fixtures.find((f) => f.companyId === companyId);
  if (!fixture) {
    throw new PlayerDecisionContextError(`会社 ${companyId} はこのRunに存在しません。`, "COMPANY_NOT_FOUND");
  }

  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const turn = session.state.scenarioState.currentTurn;

  const controlModes = session.run.companyControlModes ?? {};
  const isPlayerControlled = (controlModes[companyId] ?? "STANDARD_AI") === "PLAYER";
  const confirmedPlayerDecisions = stored.resumePayload.confirmedPlayerDecisions ?? {};
  const hasSubmittedThisTurn = confirmedPlayerDecisions[companyId] !== undefined;

  // 初期draft値：既存Standard AI提案（PlayerWorkspace.tsxが既に使っている経路と同一）から作る。
  // 未確定の下書き編集内容（liveSessionRegistry.pendingDrafts相当）はサーバー側に一切持たない
  // （指示: 新しいDecision contractを作らない・既存resumePayloadを最大限再利用する。
  // confirmedPlayerDecisionsは既に確定済みTurnの決定を持つが、編集中の下書きは元々
  // サーバー保存の対象になっていない既存仕様のまま）。
  const params = resolveStandardAiProfileForMode(fixture.companyId, session.state.config.standardAiProfileMode).params;
  const aiDecision = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, turn, params).decision;
  const draftSeed = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);

  const lastRecord = session.state.history[session.state.history.length - 1] ?? null;
  const lastQuarterCapexResult = lastRecord ? extractCompanyCapexResult(lastRecord, companyId) : null;
  const lastQuarterFinancialResult = lastRecord ? extractCompanyFinancialResult(lastRecord, companyId) : null;
  const lastQuarterDividendResult = lastRecord ? extractCompanyDividendResult(lastRecord, companyId) : null;

  const gameEndedAt = session.run.gameEndedAt ?? null;
  const gameEndTurn = session.run.gameEndTurn ?? null;
  // 【指示§4/§17】保存済みFinal Snapshotを優先する。無ければ（旧形式Run等）その場で
  // 既存evaluation serviceを呼ぶだけ（新しい計算式は持たない。Game End機能と同じ方針）。
  const finalEvaluationSnapshot =
    session.run.finalEvaluationSnapshot ??
    (gameEndedAt ? computeAllCompaniesEvaluationSnapshot(session.state.history, session.fixtures.map((f) => f.companyId), session.run.completedTurns) : null);

  const finishedView = gameEndedAt
    ? {
        dataset: buildDatasetFromSession(session),
        evaluationHistory: resolveEvaluationHistory({ evaluationHistory: session.evaluationHistory, stateHistory: session.state.history }),
        session,
      }
    : null;

  return {
    simulationRunId: session.run.simulationRunId,
    scenarioId: session.run.scenarioId,
    seed: session.run.seed,
    companyId,
    fixture,
    companyDisplayName: fixture.displayName,
    ownState,
    publicInfo,
    period: session.state.currentPeriod,
    turn,
    draftSeed,
    lastQuarterCapexEvents: lastQuarterCapexResult?.events,
    lastQuarterRejectedCapexProposals: lastQuarterCapexResult?.rejectedProposals,
    lastQuarterFinancialResult,
    lastQuarterDividendResult,
    lastQuarterSalesAllocations: lastRecord?.salesRecord.allocations,
    hasSubmittedThisTurn,
    isPlayerControlled,
    gameEndedAt,
    gameEndTurn,
    finalEvaluationSnapshot,
    finishedView,
  };
}
