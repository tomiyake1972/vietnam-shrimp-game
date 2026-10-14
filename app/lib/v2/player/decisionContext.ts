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
import { StandardAiCostProjection, toStandardAiCostProjection } from "../companyLab/standardAi/costProjection";
import { buildTurnEconomicsProjection } from "../companyLab/turnEconomicsProjection";
import { resolveStandardAiProfileForMode } from "../companyLab/standardAi/orientationProfile";
import { buildInitialDraft, CompanyDecisionDraft } from "../../../v2/company-lab/decisionDraft";
import { extractCompanyCapexResult, extractCompanyDividendResult, extractCompanyFinancialResult, extractCompanyFinancingResult } from "../../../v2/company-lab/play/_lib/financialViewSelectors";
// 【PLAYER-SURFACE-1】受講者が実際に使う /v2/play/workspace には Overview / Market /
// Inventory が無く、意思決定タブしか無かった。GM コンソール側の PlayerWorkspace は
// GM のブラウザタブ内キャッシュを正本にしているため受講者の端末からは開けない。
// そこで「受講者へ返してよい値だけ」をここで組み立てて返す。
import { buildLastTurnReview, LastTurnReview } from "../../../v2/company-lab/lastTurnReviewViewModel";
import { buildPlayerInventoryView, buildPlayerMarketView, PlayerInventoryView, PlayerMarketView } from "./workspaceViews";
import {
  buildCompanyFactoryCounts,
  buildGameStartCompetitorSnapshot,
  buildPublicCompetitorSnapshot,
  buildAnnualDividendNewsInput,
  buildCompetitorSignals,
  buildPublicInvestmentAnnouncements,
  projectPublicSnapshotForViewer,
  PublicCompetitorSnapshot,
} from "../companyLab/publicCompetitorSnapshot";
import { buildCompetitorNews, CompetitorNewsItem } from "../companyLab/competitorNews";
import { CAPEX_PARAMETERS_V1 } from "../capex/parameters";
import { restoreSessionFromResumePayload } from "../companyLab/simulation/persistence/resume";
import { StoredSimulationRun } from "../companyLab/simulation/persistence/types";
import { CompanyEvaluationSnapshot, computeAllCompaniesEvaluationSnapshot } from "../companyLab/evaluation/evaluationSemantics";
import { EvaluationHistoryRecord, resolveEvaluationHistory } from "../companyLab/evaluation/evaluationHistory";
import { CompanyId } from "../sales/types";
import { MarketProductBasePriceReference, resolveMarketBasePriceReferences } from "../sales/marketBasePriceReference";
import { Product } from "../market/types";
import { unwrapUnit } from "../core/units";
import { CompanyFinancialQuarterResult } from "../finance/types";
import { FinancingQuarterResult } from "../financing/types";
import { CompanyDividendQuarterResult, computeMaxDividendUsd } from "../finance/dividend";
import { AnnualDividendGuidance } from "../finance/annualDividendGuidance";
import { buildAnnualDividendGuidanceView } from "../companyLab/annualDividendGuidanceView";
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
  /**
   * 【管理会計是正・Player費用表示接続】当Turnの費用前提（PROCUREMENT画面の
   * Pre-Financing Liquidity 表示用）。保存済みRunのScenario snapshotを正本とし、
   * 当Turnの実効financeParametersと案件別必要工事費だけを持つ。
   * 指数そのもの・将来Turnの曲線・将来費用値は含まない。
   */
  readonly costProjection: StandardAiCostProjection;
  readonly draftSeed: CompanyDecisionDraft;
  readonly lastQuarterCapexEvents: readonly CapexProjectQuarterEvent[] | undefined;
  readonly lastQuarterRejectedCapexProposals: readonly CapexRejectedProposal[] | undefined;
  readonly lastQuarterFinancialResult: CompanyFinancialQuarterResult | null;
  /**
   * 【INT-1 §2B】前Turnの資金繰り結果（借入審査・緊急融資の確定記録）。
   * 借入の申請額・実行額・減額/否認理由・緊急融資の実行有無と適用金利は
   * すべてこの記録に入っている。記録が無いRun（この機能より前の保存物）では null
   * となり、画面は「未取得」と表示する。借入残高の差から推測しない。
   */
  readonly lastQuarterFinancingResult: FinancingQuarterResult | null;
  readonly lastQuarterDividendResult: CompanyDividendQuarterResult | null;
  /**
   * 【D1 §8】年度中の配当参考表示。管理者がバランス調整で配当性向を明示指定している場合、
   * この会社はQ4決算直後に年間純利益ベースで自動精算される（Playerの追加操作は不要）。
   *
   * 【なぜサーバーで作るか】Independent Playerのブラウザへは全知stateを返さないため、
   * Manual Balanceの設定も年初来の確定実績もclientには無い。ここで確定実績と
   * 現在残高だけから参考値を組み立てて渡す。将来の利益・市場真値は一切含まない。
   */
  readonly annualDividendGuidance: AnnualDividendGuidance;
  /**
   * 【SALES基準価格参考表示・セキュリティ修正】直近確定四半期の市場×商品別「基準価格」だけの
   * 最小DTO（market・product・basePriceのみ）。
   *
   * 【重要】元データのMarketProductAllocationResultには各社のaskPrice・allocatedQuantity・
   * processingCapacity・competitivenessWeight等の非公開情報を含むcompanies配列があるため、
   * それを絶対にそのまま渡してはならない（このcontextは/api/v2/play/session経由でPlayerの
   * ブラウザへ返る）。必ずresolveMarketBasePriceReferences経由で射影済みの値だけを保持する。
   * 新しい価格計算は行わない。turn===1等で前四半期が存在しない場合はundefined。
   */
  readonly lastQuarterSalesAllocations: readonly MarketProductBasePriceReference[] | undefined;
  /** resumePayload.confirmedPlayerDecisions[companyId]が既に埋まっているか（=このTurnは提出済み）。GMの提出済み判定と同じ信号。 */
  /**
   * 【PLAYER-SURFACE-1】Overview タブ（前Turnに出した指示 → その結果）。
   * 自社ぶんのみ。確定記録からの転記だけで新しい計算はしない。
   * 1Turnも確定していなければ null。
   */
  readonly lastTurnReview: LastTurnReview | null;
  /** 【PLAYER-SURFACE-1】Inventory タブ。自社ぶんのみ。 */
  readonly inventoryView: PlayerInventoryView | null;
  /**
   * 【PLAYER-SURFACE-1】Market タブ。公開情報のみ。
   * GM 向け MarketSummary が読む trueWorld 系の値は含まない。
   */
  readonly marketView: PlayerMarketView;
  /**
   * 【PUBLIC-COMPETITOR-1】公開競合情報（前四半期の結果を帯・概数へ丸めたもの）。
   * 他社の正確な数値は含まない。自社の行にだけ正確なシェアが付く。
   */
  readonly competitorSnapshot: PublicCompetitorSnapshot;
  /**
   * 【PUBLIC-COMPETITOR-2】前Turnの競合ニュース（最大3本＋年間配当の別枠）。
   * 「観測・噂」の一部は意図的に事実と食い違う（isMisleading は画面へ出さない）。
   */
  readonly competitorNews: readonly CompetitorNewsItem[];
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
  // 【#05 費用Projection接続／Player費用表示接続】保存済みRunのScenario snapshotを正本にする。
  // Standard AI の意思決定と Player 表示の両方がこの同一値を参照する。
  const costProjection = toStandardAiCostProjection(
    buildTurnEconomicsProjection({ definition: session.state.scenarioState.definition, turn })
  );
  const aiDecision = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    session.state.currentPeriod,
    turn,
    params,
    undefined,
    undefined,
    // 【#05 費用Projection接続】保存済みRunのScenario snapshotを正本にする。
    costProjection
  ).decision;
  const draftSeed = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);

  const lastRecord = session.state.history[session.state.history.length - 1] ?? null;
  const lastQuarterCapexResult = lastRecord ? extractCompanyCapexResult(lastRecord, companyId) : null;
  const lastQuarterFinancialResult = lastRecord ? extractCompanyFinancialResult(lastRecord, companyId) : null;
  // 【INT-1 §2B】既存の確定記録をそのまま渡すだけ（新しい計算・推測はしない）。
  const lastQuarterFinancingResult = lastRecord ? extractCompanyFinancingResult(lastRecord, companyId) : null;
  const lastQuarterDividendResult = lastRecord ? extractCompanyDividendResult(lastRecord, companyId) : null;

  // 【PLAYER-SURFACE-1】Overview / Inventory / Market の3タブぶんのビューを
  // サーバー側で組み立てる。クライアントへ session や dataset をそのまま渡すと
  // 他社の非公開値まで届いてしまうため、ここで公開してよい値だけに絞る。
  const previousRecord = session.state.history[session.state.history.length - 2] ?? null;
  // 【UI-CLARITY-1 A-8】Turn1ではゲーム開始時点の既知市場情報へフォールバックする。
  // Market タブと SALES 画面が必ず同じ値を見るよう、解決は1箇所だけで行う。
  const basePriceReferences = resolveMarketBasePriceReferences(lastRecord?.salesRecord.allocations);
  const finishedGoodsTonsByProduct = ownState.finishedGoodsLots.reduce<Partial<Record<Product, number>>>((acc, lot) => {
    if (lot.status !== "available") return acc;
    acc[lot.product] = (acc[lot.product] ?? 0) + (unwrapUnit(lot.remainingQuantity) as number);
    return acc;
  }, {});
  const lastTurnReview = buildLastTurnReview({
    companyId,
    record: lastRecord ?? undefined,
    ...(previousRecord ? { previousRecord } : {}),
    finishedGoodsTonsByProduct,
  });
  const inventoryView = buildPlayerInventoryView(lastRecord, previousRecord, companyId);

  // 【PUBLIC-COMPETITOR-1】公開してよい粒度に丸めた競合情報。
  // Turn 1 は前四半期が無いので、開始時点の受注残を勢力図として使う。
  const allCompanyIds = session.fixtures.map((f) => f.companyId);
  const salesForceHeadcountByCompanyId = new Map(
    (session.state.salesForceHiringState?.companies ?? []).map((c) => [c.companyId, c.headcount])
  );
  // 工場数は、capex で増えた新工場も反映された実効 Factory 一覧から数える
  // （fixture.factories は作成時点の静的な初期一覧なので、新工場が反映されない）。
  const allEffectiveFactories = session.fixtures.flatMap((f) => buildCompanyOwnState(session.state, f).effectiveFactories);
  const factoryCounts = buildCompanyFactoryCounts({
    factories: allEffectiveFactories,
    capexProjectsByCompanyId: new Map(
      (session.state.capexState?.companies ?? []).map((c) => [c.companyId, c.portfolio.projects])
    ),
    companyIds: allCompanyIds,
  });
  // 【PUBLIC-COMPETITOR-4】凍結済みの公開情報があればそれを使う。
  // 保存されていない場合（この機能より前に作られた Run）だけ、確定記録から
  // 再構築する。再構築は「同じコードで同じ記録を読む限り同じ結果」であって、
  // パラメータを変えれば過去Turnの内容も変わる。凍結済みを優先するのはそのため。
  const frozenTurn = (session.publicCompetitorTurns ?? []).find((t) => t.viewedAtTurn === turn);

  const competitorSnapshot =
    frozenTurn !== undefined
      ? projectPublicSnapshotForViewer(frozenTurn.snapshot, companyId)
      : lastRecord !== null
        ? buildPublicCompetitorSnapshot({
            record: lastRecord,
            previousRecord,
            companyIds: allCompanyIds,
            ownCompanyId: companyId,
            salesForceHeadcountByCompanyId,
            investments: buildPublicInvestmentAnnouncements({
              record: lastRecord,
              templatesByType: CAPEX_PARAMETERS_V1.templatesByType,
            }),
            factoryCounts,
          })
        : buildGameStartCompetitorSnapshot({
            factoryCounts,
            contracts: session.state.contracts,
            companyIds: allCompanyIds,
            ownCompanyId: companyId,
            salesForceHeadcountByCompanyId:
              salesForceHeadcountByCompanyId.size > 0
                ? salesForceHeadcountByCompanyId
                : new Map(session.fixtures.map((f) => [f.companyId, f.salesForceHeadcountTotal])),
          });

  // 【PUBLIC-COMPETITOR-2】競合ニュース。確定記録から決定論的に生成する
  // （LLM も Math.random() も使わない。同じ Run を再表示しても内容が変わらない）。
  const marketView = buildPlayerMarketView({
    publicInfo,
    evaluationSnapshots: computeAllCompaniesEvaluationSnapshot(
      session.state.history,
      session.fixtures.map((f) => f.companyId),
      turn
    ),
    displayNameByCompanyId: new Map(session.fixtures.map((f) => [f.companyId, f.displayName])),
    companyId,
    basePriceReferences,
    turn,
  });

  const competitorNews =
    frozenTurn !== undefined
      ? frozenTurn.news
      : lastRecord === null
        ? []
        : buildCompetitorNews({
            runId: stored.run.simulationRunId,
            turn,
            snapshot: competitorSnapshot,
            signals: buildCompetitorSignals(lastRecord, competitorSnapshot, allCompanyIds),
            displayNameByCompanyId: new Map(session.fixtures.map((f) => [f.companyId, f.displayName])),
            ...(() => {
              const annual = buildAnnualDividendNewsInput(session.state.history, allCompanyIds);
              return annual ? { annualDividend: annual } : {};
            })(),
          });

  // 【D1 §8】管理者指定配当の年度中参考表示。率の解決はengineと同じresolverを通す。
  const annualDividendGuidance = buildAnnualDividendGuidanceView({
    history: session.state.history,
    currentPeriod: session.state.currentPeriod,
    turn,
    companyId,
    manualBalanceOverrides: session.state.config.manualBalanceOverrides,
    currentCashUsd: ownState.financeState.cash as number,
    dividendCapacityUsd: computeMaxDividendUsd(ownState.financeState),
  });

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
    costProjection,
    draftSeed,
    lastQuarterCapexEvents: lastQuarterCapexResult?.events,
    lastQuarterRejectedCapexProposals: lastQuarterCapexResult?.rejectedProposals,
    lastQuarterFinancingResult,
    lastQuarterFinancialResult,
    lastQuarterDividendResult,
    annualDividendGuidance,
    lastQuarterSalesAllocations: basePriceReferences,
    lastTurnReview,
    inventoryView,
    marketView,
    competitorSnapshot,
    competitorNews,
    hasSubmittedThisTurn,
    isPlayerControlled,
    gameEndedAt,
    gameEndTurn,
    finalEvaluationSnapshot,
    finishedView,
  };
}
