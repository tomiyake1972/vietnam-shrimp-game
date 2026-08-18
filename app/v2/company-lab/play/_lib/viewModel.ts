// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） サーバー専用ビューモデル
//
// Server Component（page.tsx）だけが呼ぶ、フレームワーク非依存の純粋な非同期関数群。
// ここで初めて「巨大な内部状態（currentState.runtime・履歴エントリ全体）を読み、
// 画面表示に必要な最小限（プレイヤー会社1社ぶんのownState・公開市場情報・軽量な
// 履歴要約）だけに絞り込んでクライアント（React Server Componentのpropsとして
// ブラウザへ送られるツリー）へ渡す」という、指示§8.2「巨大なsnapshotを通常画面で
// 取得・表示しない」の実際の絞り込み地点になる。
//
// 【turn 2以降の復元についての重要事項】stored.currentState.runtime
// （CompanyLabRuntimeSnapshot）は、それ単体ではbuildCompanyOwnState/
// buildPublicMarketInfoへ渡せる完全なCompanyLabStateではない。turn 2以降は
// 直近確定履歴のrecordを注入して復元しないと、前四半期の市場価格・工場負荷等が
// シナリオのprehistory値へ静かにフォールバックしてしまう（Phase 8C-2 companyLab
// QuarterFlowService.tsのprocessQuarter内の復元ロジックと全く同じ理由・同じ手順。
// 重複実装せず、restoreCompanyLabStateFromRuntimeSnapshotをそのまま再利用する）。

import { CompanyDecisionDraft, buildInitialDraft } from "../../decisionDraft";
import { CompanyFixture, CompanyLabState, CompanyOwnState, CompanyQuarterSummary, CompanyReasonEntry, PublicMarketInfo } from "../../../../lib/v2/companyLab/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../../lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../lib/v2/companyLab/standardAi/policy";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../../../lib/v2/companyLab/persistence/snapshot";
import { CompanyLabPersistedStateV1, CompanyLabDraftEnvelope } from "../../../../lib/v2/companyLab/persistence/types";
import { DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterResult } from "../../../../lib/v2/market/types";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { getScenarioTurnInput } from "../../../../lib/v2/scenario/scenarioEngine";
import { computeDomesticReferencePrice } from "../../../../lib/v2/companyLab/domesticReferencePrice";
import {
  OpeningInfoViewModel,
  buildDepreciableAssets,
  buildOpeningBalanceSheet,
  buildOpeningMarketInfo,
} from "./openingInfoViewModel";
import { ConsumerMarketQuarterRecord } from "../../../../lib/v2/market/consumerInventory";
import { CapexProjectQuarterEvent, CapexQuarterResult, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { computeCurrentDividendValueUsd } from "../../../../lib/v2/companyLab/evaluation/evaluationSemantics";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CompanyLabApiDependencies } from "../../../../api/v2/company-labs/_lib/dependencies";
import { toHistoryEntrySummaryDto, CompanyLabHistoryEntrySummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import { isPlausibleCompanyDecisionDraft } from "../../../../api/v2/company-labs/_lib/decisionsProvider";
import { extractCompanyCapexResult, extractCompanyDividendResult, extractCompanyFinancialResult, extractCompanyFinancingResult } from "./financialViewSelectors";

export type PlayerScreenPhase = "editing" | "submitted" | "completed";

export interface PlayerLastQuarterResult {
  readonly turn: number;
  readonly turnId: string;
  readonly period: string;
  readonly processedAt: string;
  readonly marketResult: MarketQuarterResult;
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
  readonly playerSummary: CompanyQuarterSummary | null;
  /**
   * 【Phase 8C-3C想定・財務表示追加】当期のプレイヤー会社ぶんのPL/BS/CF結果。
   * finance/quarterClose.tsが既に計算・永続化済みの値をcompanyIdで抽出するだけで、
   * ここでは一切再計算しない。該当データがなければnull（=「未作成」として画面側で表示）。
   */
  readonly financialResult: CompanyFinancialQuarterResult | null;
  /** 当期のプレイヤー会社ぶんの資金繰り結果（信用スコア・借入審査・延滞等）。抽出のみ、再計算なし。 */
  readonly financingResult: FinancingQuarterResult | null;
  /** 当期のプレイヤー会社ぶんの設備投資結果（全体。既存のlastQuarterCapexEvents等はDecisionEditor向けに従来通り残す）。 */
  readonly capexResult: CapexQuarterResult | null;
  /**
   * 【Phase 8F-1】当期の消費国別・在庫循環（消費／在庫／購買）確定結果。全社共通・公開情報であり、
   * 個社の非公開計画は含まない。CompanyQuarterRecord.consumerMarketRecordsが未設定
   * （Phase 8F-1導入前の古い保存データ）の場合はundefinedのままとし、画面側は
   * 「データなし」として捏造せず表示する。
   */
  readonly consumerMarketRecords: readonly ConsumerMarketQuarterRecord[] | undefined;
}

/**
 * 前期（turn-1）ぶんの、財務・資金・設備投資の比較用データ。
 * 【当期・前期・増減表示のための最小限のデータ】重い内部snapshotは一切含めず、
 * companyId抽出後のPL/BS/CF・資金繰り・設備投資結果だけをクライアントへ渡す。
 * 初回四半期（turn===1）や取得に失敗した場合はnull（画面側は「データなし」として
 * 正常表示する。捏造しない）。
 */
export interface PlayerPreviousQuarterFinancials {
  readonly turn: number;
  readonly period: string;
  readonly financialResult: CompanyFinancialQuarterResult | null;
  readonly financingResult: FinancingQuarterResult | null;
  readonly capexResult: CapexQuarterResult | null;
}

/**
 * 前期（turn-1）ぶんの公開市場結果（市場情報パネルの前四半期比表示用）。
 * 会社別の非公開情報は一切含まない（marketResultは全社共通・公開情報）。
 * 前期が存在しない（初回四半期）・取得に失敗した場合はnullとし、画面側は
 * 前期比を「-」と表示する（0で埋めない・値を捏造しない）。
 */
export interface PlayerPreviousQuarterMarket {
  readonly turn: number;
  readonly period: string;
  readonly marketResult: MarketQuarterResult;
}

export interface PlayerScreenViewModel {
  readonly labId: string;
  readonly playerCompanyId: string;
  readonly playerDisplayName: string;
  readonly scenarioId: string;
  readonly mode: string;
  readonly totalTurns: number;
  readonly currentTurn: number;
  readonly revision: number;
  readonly isComplete: boolean;
  readonly phase: PlayerScreenPhase;
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly period: CompanyLabState["currentPeriod"];
  /** 編集対象のdraft本体（未保存ならStandard AIの提案から組み立てた初期値。完了済みならnull）。 */
  readonly draft: CompanyDecisionDraft | null;
  /**
   * 【test/sai6-manual-observation-2026-08-01 で追加】draftをStandard AIの提案から
   * 新規生成した場合のみ設定される診断情報（判断理由コード・圧力値・希望値）。
   * 既存の保存済みdraftをそのまま表示している場合、および提出済み／完了済みの
   * 場合は常にnull（保存済みdraftはプレイヤーが既に編集している可能性があり、
   * その場合に「これはAIの提案です」という診断情報を出すと誤解を招くため）。
   */
  readonly aiProposalDiagnostics: StandardAiQuarterDiagnostics | null;
  readonly draftSubmittedAt: string | null;
  readonly draftUpdatedAt: string | null;
  readonly lastQuarterResult: PlayerLastQuarterResult | null;
  readonly lastQuarterCapexEvents: readonly CapexProjectQuarterEvent[] | undefined;
  readonly lastQuarterRejectedCapexProposals: readonly CapexRejectedProposal[] | undefined;
  /** 【DIV-1新設】直近確定四半期の配当結果（累積配当・加重配当価値・却下理由の表示用）。 */
  readonly lastQuarterDividendResult: CompanyDividendQuarterResult | null;
  /** 【TSV正式化】現在Turn基準・年率15%複利のDividend Value（Leaderboardと同一関数）。 */
  readonly currentDividendValueUsd: number;
  /** 前期（turn-1）ぶんの財務・資金・設備投資（当期・前期・増減表示用）。前期が存在しなければnull。 */
  readonly previousQuarterFinancials: PlayerPreviousQuarterFinancials | null;
  /** 前期（turn-1）ぶんの公開市場結果（市場情報パネルの前四半期比表示用）。前期が存在しなければnull。 */
  readonly previousQuarterMarket: PlayerPreviousQuarterMarket | null;
  /**
   * 【Test15】期初情報（BS・償却資産明細・市場情報）。turn1でも必ず値が入る
   * （前四半期の実績には依存しない）。Company Lab / Test15画面専用の表示用データで、
   * 通常プレイヤー画面には出さない。
   */
  readonly openingInfo: OpeningInfoViewModel;
  /** 履歴要約（診断用のhistory/[turn]は使わない。§6.6・§8.2）。最新10件まで。 */
  readonly recentHistory: readonly CompanyLabHistoryEntrySummaryDto[];
}

export type PlayerScreenLoadResult = { readonly kind: "ok"; readonly viewModel: PlayerScreenViewModel } | { readonly kind: "notFound" };

/** coerceDraftOrRebuildの戻り値。draftはUIへの表示・編集対象、diagnosticsは新規生成時のみStandard AIの診断情報を持つ。 */
interface CoercedDraftResult {
  readonly draft: CompanyDecisionDraft;
  /**
   * 【test/sai6-manual-observation-2026-08-01 で追加】この四半期分としてStandard AIの
   * 提案をその場で新規生成した場合のみ設定される（＝draftが既存の保存済みdraftを
   * そのまま返した場合はnull。保存済みdraftは既に編集されている可能性があり、
   * その場合に「これはAIの提案です」という診断情報を出すと誤解を招くため）。
   */
  readonly diagnostics: StandardAiQuarterDiagnostics | null;
}

/** 提出済みでない既存draftが、現在のプレイヤー会社向けとして解釈可能な形かどうか（壊れていれば安全側で再生成する）。 */
function coerceDraftOrRebuild(
  envelope: CompanyLabDraftEnvelope | null,
  fixture: CompanyFixture,
  restoredState: CompanyLabState,
  publicInfo: PublicMarketInfo,
  turn: number
): CoercedDraftResult {
  if (envelope !== null && isPlausibleCompanyDecisionDraft(envelope.draft, fixture.companyId)) {
    return { draft: envelope.draft, diagnostics: null };
  }
  // draftが無い（新しいturn）か、保存済みだが構造上解釈できない場合は、既存の仮UI
  // （page.tsx）と同じ手順でStandard AIの提案から初期値を組み立てる
  // （test/sai6-manual-observation-2026-08-01：手動観察テストのため、プレイヤー
  // 自身の会社についても「四半期実行前に確認できるStandard AIの提案」として
  // Standard AIの出力を初期表示する。プレイヤーはこれをそのまま提出することも、
  // 編集してから提出することもできる＝既存の「提出」操作が変更されるわけではない）。
  const ownState = buildCompanyOwnState(restoredState, fixture);
  const { decision: aiDecision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    restoredState.currentPeriod,
    turn
  );
  // 【Phase 8D-4】ワーカー人数の出発点は、fixtureの初期値ではなく会社状態として
  // 保持されている前期末の総人数。これを渡さないと、四半期をまたぐたびに人数が
  // 初期値へ戻るというテストプレイで見つかった不具合が再発する。
  // 【Test15・develop/v2統合（Required fix 2）】生産計画・ワーカー配置の入力行は
  // ownState.effectiveFactories（稼働開始済みの新設Factoryを含む実効Factory[]）を
  // 基準に生成する。
  return { draft: buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories), diagnostics };
}

export async function loadPlayerScreenViewModel(deps: CompanyLabApiDependencies, labId: string): Promise<PlayerScreenLoadResult> {
  let stored: CompanyLabPersistedStateV1;
  try {
    stored = await deps.repository.loadCurrentState(labId);
  } catch {
    return { kind: "notFound" };
  }

  const fixture = stored.fixtures.find((f) => f.companyId === stored.playerCompanyId);
  if (!fixture) {
    // createLab側でplayerCompanyIdがfixturesに含まれることを保証済みのため、通常到達しない
    // （保存データの破損等、防御的なケース）。画面へは「見つからない」として扱う。
    return { kind: "notFound" };
  }

  const [draftEnvelope, latestEntry] = await Promise.all([deps.repository.loadDraft(labId), deps.repository.loadLatestHistoryEntry(labId)]);

  // 【重要】turn 2以降の直近履歴注入。processQuarterの復元ロジックと同じ手順。
  const historyRecords = latestEntry !== null ? [latestEntry.record] : [];
  const restoredState = restoreCompanyLabStateFromRuntimeSnapshot(stored.config, stored.currentState.runtime, historyRecords);
  const turn = restoredState.scenarioState.currentTurn;

  const ownState = buildCompanyOwnState(restoredState, fixture);
  const publicInfo = buildPublicMarketInfo(restoredState);
  const isComplete = restoredState.isComplete;

  let phase: PlayerScreenPhase;
  let draft: CompanyDecisionDraft | null;
  let aiProposalDiagnostics: StandardAiQuarterDiagnostics | null = null;
  if (isComplete) {
    phase = "completed";
    draft = null;
  } else if (draftEnvelope !== null && draftEnvelope.submittedAt !== null) {
    phase = "submitted";
    draft = isPlausibleCompanyDecisionDraft(draftEnvelope.draft, fixture.companyId) ? draftEnvelope.draft : null;
  } else {
    phase = "editing";
    const coerced = coerceDraftOrRebuild(draftEnvelope, fixture, restoredState, publicInfo, turn);
    draft = coerced.draft;
    aiProposalDiagnostics = coerced.diagnostics;
  }

  const lastQuarterCapexResult = latestEntry !== null ? extractCompanyCapexResult(latestEntry.record, stored.playerCompanyId) : null;
  const lastQuarterDividendResult = latestEntry !== null ? extractCompanyDividendResult(latestEntry.record, stored.playerCompanyId) : null;
  const currentDividendValueUsd = computeCurrentDividendValueUsd(restoredState.history, stored.playerCompanyId, turn);

  const lastQuarterResult: PlayerLastQuarterResult | null =
    latestEntry !== null
      ? {
          turn: latestEntry.turn,
          turnId: latestEntry.turnId,
          period: String(latestEntry.record.period),
          processedAt: latestEntry.processedAt,
          marketResult: latestEntry.record.marketResult,
          globalReasonCodes: latestEntry.record.globalReasonCodes,
          playerSummary: latestEntry.record.companySummaries.find((s) => s.companyId === stored.playerCompanyId) ?? null,
          financialResult: extractCompanyFinancialResult(latestEntry.record, stored.playerCompanyId),
          financingResult: extractCompanyFinancingResult(latestEntry.record, stored.playerCompanyId),
          capexResult: lastQuarterCapexResult,
          consumerMarketRecords: latestEntry.record.consumerMarketRecords,
        }
      : null;

  // 【前期（turn-1）ぶんの財務・資金・設備投資を、当期・前期・増減表示のために取得する】
  // loadHistoryEntryは単一turn分のみの取得であり、全履歴を読むloadFullHistory
  // （診断用・数十MB規模）とは性質が異なるため、Repository契約上「通常の
  // Application Service層から使ってよい」対象（§9）。取得できない・存在しない
  // （初回四半期turn===1、または何らかの理由で前期データが欠落）場合はnullとし、
  // 値を捏造せず「データなし」として画面側で正常表示する。
  //
  // 【市場情報パネルの前四半期比についても同じ1回の取得を使い回す】前期の公開市場結果
  // （marketResult）は同じ履歴エントリに含まれているため、追加のRepositoryアクセスは
  // 発生させない（前期比のために履歴を二度読まない）。
  let previousQuarterFinancials: PlayerPreviousQuarterFinancials | null = null;
  let previousQuarterMarket: PlayerPreviousQuarterMarket | null = null;
  if (latestEntry !== null && latestEntry.turn > 1) {
    try {
      const previousEntry = await deps.repository.loadHistoryEntry(labId, latestEntry.turn - 1);
      previousQuarterFinancials = {
        turn: previousEntry.turn,
        period: String(previousEntry.period),
        financialResult: extractCompanyFinancialResult(previousEntry.record, stored.playerCompanyId),
        financingResult: extractCompanyFinancingResult(previousEntry.record, stored.playerCompanyId),
        capexResult: extractCompanyCapexResult(previousEntry.record, stored.playerCompanyId),
      };
      previousQuarterMarket = {
        turn: previousEntry.turn,
        period: String(previousEntry.period),
        marketResult: previousEntry.record.marketResult,
      };
    } catch {
      previousQuarterFinancials = null;
      previousQuarterMarket = null;
    }
  }

  const historyPage = await deps.repository.loadHistoryPage(labId, { limit: 10 });

  return {
    kind: "ok",
    viewModel: {
      labId: stored.labId,
      playerCompanyId: stored.playerCompanyId,
      playerDisplayName: fixture.displayName,
      scenarioId: stored.config.scenarioId,
      mode: stored.config.mode,
      totalTurns: stored.config.turns,
      currentTurn: turn,
      revision: stored.currentState.revision,
      isComplete,
      phase,
      fixture,
      ownState,
      publicInfo,
      period: restoredState.currentPeriod,
      draft,
      aiProposalDiagnostics,
      draftSubmittedAt: draftEnvelope?.submittedAt ?? null,
      draftUpdatedAt: draftEnvelope?.updatedAt ?? null,
      lastQuarterResult,
      lastQuarterCapexEvents: lastQuarterCapexResult?.events,
      lastQuarterDividendResult,
      currentDividendValueUsd,
      lastQuarterRejectedCapexProposals: lastQuarterCapexResult?.rejectedProposals,
      previousQuarterFinancials,
      previousQuarterMarket,
      openingInfo: buildOpeningInfo(ownState, publicInfo, restoredState, turn),
      recentHistory: historyPage.entries.map(toHistoryEntrySummaryDto),
    },
  };
}

/**
 * 【Test15】期初情報（BS・償却資産明細・市場情報）を組み立てる。
 *
 * turn1でも必ず値が出ることがこの機能の目的なので、前四半期の実績（lastMarketResult）には
 * 依存させない。市場別の前期消費量はシナリオ定義が当該turnぶんを持っているため、
 * getScenarioTurnInput（純粋関数）から読み出す。シナリオ側で取得に失敗した場合でも
 * 画面全体を壊さないよう、その項目だけundefinedにして続行する（0で埋めない）。
 */
function buildOpeningInfo(
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  restoredState: CompanyLabState,
  turn: number
): OpeningInfoViewModel {
  let priorByMarket:
    | Partial<Record<DemandMarketId, { priorPeriodConsumption: number; economicIndex: number; populationGrowthRate: number }>>
    | undefined;
  try {
    const scenarioTurnInput = getScenarioTurnInput(restoredState.scenarioState, turn);
    priorByMarket = {};
    for (const market of DEMAND_MARKET_IDS) {
      const m = scenarioTurnInput.demandMarkets[market];
      priorByMarket[market] = {
        priorPeriodConsumption: unwrapUnit(m.priorPeriodConsumption),
        economicIndex: m.economicIndex,
        populationGrowthRate: m.populationGrowthRate,
      };
    }
  } catch {
    priorByMarket = undefined;
  }

  return {
    period: restoredState.currentPeriod,
    turn,
    domesticReferencePrice: computeDomesticReferencePrice(restoredState, turn),
    balanceSheet: buildOpeningBalanceSheet(ownState),
    depreciableAssets: buildDepreciableAssets(ownState, turn),
    observedMarketDemand: publicInfo.observedMarketDemand,
    marketInfo: buildOpeningMarketInfo(publicInfo.vietnamDomesticPriorPrice, priorByMarket),
  };
}
