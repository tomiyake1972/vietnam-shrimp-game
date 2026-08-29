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
import { resolveStandardAiProfileForMode } from "../../../../lib/v2/companyLab/standardAi/orientationProfile";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../../../lib/v2/companyLab/persistence/snapshot";
import { CompanyLabPersistedStateV1, CompanyLabDraftEnvelope } from "../../../../lib/v2/companyLab/persistence/types";
import { DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterResult } from "../../../../lib/v2/market/types";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { getScenarioTurnInput } from "../../../../lib/v2/scenario/scenarioEngine";
import { getAvailableInformation } from "../../../../lib/v2/scenario/informationEngine";
import { resolveScenarioProductLifecycleParameters } from "../../../../lib/v2/scenario/lifecycle";
import { computeDomesticReferencePrice } from "../../../../lib/v2/companyLab/domesticReferencePrice";
import {
  OpeningInfoViewModel,
  buildDepreciableAssets,
  buildOpeningBalanceSheet,
  buildOpeningMarketInfo,
  toScenarioNewsItems,
} from "./openingInfoViewModel";
import { ConsumerMarketQuarterRecord } from "../../../../lib/v2/market/consumerInventory";
import { CapexProjectQuarterEvent, CapexQuarterResult, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { MarketProductBasePriceReference, projectMarketBasePriceReferences } from "../../../../lib/v2/sales/marketBasePriceReference";
import { computeCurrentDividendValueUsd } from "../../../../lib/v2/companyLab/evaluation/evaluationSemantics";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CompanyLabApiDependencies } from "../../../../api/v2/company-labs/_lib/dependencies";
import { toHistoryEntrySummaryDto, CompanyLabHistoryEntrySummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import { isPlausibleCompanyDecisionDraft } from "../../../../api/v2/company-labs/_lib/decisionsProvider";
import { extractCompanyCapexResult, extractCompanyDividendResult, extractCompanyFinancialResult, extractCompanyFinancingResult } from "./financialViewSelectors";
import { SalesModelId } from "../../../../lib/v2/sales/salesModels";
import {
  CompanyLabNotFoundError,
  CompanyLabPersistedStateParseError,
  CompanyLabPersistedStateValidationError,
  CompanyLabRepositoryError,
  CompanyLabSerializationError,
  UnsupportedCompanyLabPersistedStateVersionError,
} from "../../../../lib/v2/companyLab/persistence/errors";

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
  /**
   * 【UI-SALES-MODEL-SELECT-1】この Lab の販売市場モデルID（未指定=legacy相当）。
   * stored.config.salesModelIdをそのまま転記するだけ（新しい計算・新しい販売モデルは
   * ここでは一切作らない）。resumeしてもstored.configから同じ値が復元される。
   */
  readonly salesModelId: SalesModelId | undefined;
  /**
   * 【Phase SAI-5B】このLabのStandard AI profile mode（未記録=OFF相当）。
   * AI経営説明・AI経営会議のhandlerが、AI4社と同じ会社別paramsで診断を作り直すために使う。
   */
  readonly standardAiProfileMode: "OFF" | "ON" | undefined;
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
  /**
   * 【SALES基準価格参考表示・セキュリティ修正】直近確定四半期の市場×商品別「基準価格」だけの
   * 最小DTO（market・product・basePriceのみ）。元のMarketProductAllocationResultが持つ
   * 各社askPrice等の内訳（companies配列）は含めない（decisionContext.ts・
   * PlayerWorkspace.tsxと同一のprojectMarketBasePriceReferencesを使う）。
   * 前四半期が存在しない（turn===1）場合はundefinedのままとし、画面側は「－」表示にする。
   */
  readonly lastQuarterSalesAllocations: readonly MarketProductBasePriceReference[] | undefined;
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

/**
 * 【COMPANYLAB-DETAIL-LOAD-404-1】画面ロード結果の分類。
 *
 * 【修正前の欠陥】loadCurrentState の**あらゆる例外**を kind:"notFound" へ潰していたため、
 * schema / decode / version / environment などの内部エラーが「ラボが見つかりません」という
 * 404 表示の裏に完全に隠れ、サーバーログにも何も残らなかった。実 Redis 環境で
 * 「一覧には出るのに詳細だけ Not Found」という事象が起きたとき、原因の切り分けが
 * 構造的に不可能だった（Vercel runtime log にも error レベルの記録が1件も出ない）。
 *
 * 【修正方針】「本当に存在しない」＝ CompanyLabNotFoundError のときだけ notFound とし、
 * それ以外は kind:"error" として区別する。画面には内部情報・stack trace を出さず、
 * 一般的な案内と分類コードだけを見せる。詳細はサーバー側 console.error にのみ記録し、
 * Vercel runtime log で追跡できるようにする。
 */
export type PlayerScreenLoadErrorReason =
  /** 保存データの decode / schema 検証に失敗した（保存形式の不整合）。 */
  | "persistedStateInvalid"
  /** Redis 等の読み取り自体に失敗した（接続・環境変数など）。 */
  | "repositoryUnavailable"
  /** 保存データは読めたが、playerCompanyId に対応する fixture が無い（データ整合性）。 */
  | "playerFixtureMissing"
  /** 上記のいずれにも分類できない想定外の失敗。 */
  | "unexpected";

export type PlayerScreenLoadResult =
  | { readonly kind: "ok"; readonly viewModel: PlayerScreenViewModel }
  | { readonly kind: "notFound" }
  | { readonly kind: "error"; readonly reason: PlayerScreenLoadErrorReason };

/**
 * 例外を表示用の分類コードへ落とす。**メッセージ本文は返さない**
 * （画面へ内部情報・stack trace を出さないため）。
 */
export function classifyPlayerScreenLoadError(error: unknown): PlayerScreenLoadErrorReason {
  if (error instanceof CompanyLabPersistedStateParseError) return "persistedStateInvalid";
  if (error instanceof CompanyLabPersistedStateValidationError) return "persistedStateInvalid";
  if (error instanceof UnsupportedCompanyLabPersistedStateVersionError) return "persistedStateInvalid";
  if (error instanceof CompanyLabSerializationError) return "persistedStateInvalid";
  if (error instanceof CompanyLabRepositoryError) return "repositoryUnavailable";
  return "unexpected";
}

/**
 * サーバー側にだけ原因を残す（応答には含めない）。
 * Vercel runtime log の error レベルへ出すことで、Preview 実機での切り分けを可能にする。
 */
function logPlayerScreenLoadFailure(labId: string, reason: PlayerScreenLoadErrorReason, error: unknown): void {
  console.error(`[company-lab detail] ラボ詳細の読み込みに失敗しました（labId=${JSON.stringify(labId)}, reason=${reason}）:`, error);
}

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
  // 【Phase SAI-5B】decisionsProvider.ts（AI4社）と同じ会社別paramsで生成する。
  // ここだけ会社差ゼロのparamsを使うと、同じLabの中で「AI4社の判断」と
  // 「PLAYERへ提示される提案」が別物になってしまう。
  const params = resolveStandardAiProfileForMode(fixture.companyId, restoredState.config.standardAiProfileMode).params;
  const { decision: aiDecision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    restoredState.currentPeriod,
    turn,
    params
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
  } catch (e) {
    // 【COMPANYLAB-DETAIL-LOAD-404-1】「本当に存在しない」ときだけ notFound。
    // decode / schema / version / repository の失敗を 404 の裏へ隠さない。
    if (e instanceof CompanyLabNotFoundError) return { kind: "notFound" };
    const reason = classifyPlayerScreenLoadError(e);
    logPlayerScreenLoadFailure(labId, reason, e);
    return { kind: "error", reason };
  }

  const fixture = stored.fixtures.find((f) => f.companyId === stored.playerCompanyId);
  if (!fixture) {
    // createLab側でplayerCompanyIdがfixturesに含まれることを保証済みのため、通常到達しない。
    // 【COMPANYLAB-DETAIL-LOAD-404-1】ここは「ラボが無い」のではなく**保存データの整合性の
    // 問題**であり、以前のように notFound へ潰すと原因が 404 表示の裏に隠れる。
    const reason: PlayerScreenLoadErrorReason = "playerFixtureMissing";
    logPlayerScreenLoadFailure(
      labId,
      reason,
      new Error(
        `playerCompanyId=${JSON.stringify(stored.playerCompanyId)} に対応する fixture がありません` +
          `（fixtures=${JSON.stringify(stored.fixtures.map((f) => f.companyId))}）`
      )
    );
    return { kind: "error", reason };
  }

  let draftEnvelope: Awaited<ReturnType<CompanyLabApiDependencies["repository"]["loadDraft"]>>;
  let latestEntry: Awaited<ReturnType<CompanyLabApiDependencies["repository"]["loadLatestHistoryEntry"]>>;
  try {
    // 【COMPANYLAB-DETAIL-LOAD-404-1】draft / 直近履歴の読み取り失敗も、以前は未捕捉のまま
    // 画面全体のクラッシュになっていた。currentState と同じ分類で扱う（404 へは潰さない）。
    [draftEnvelope, latestEntry] = await Promise.all([deps.repository.loadDraft(labId), deps.repository.loadLatestHistoryEntry(labId)]);
  } catch (e) {
    const reason = classifyPlayerScreenLoadError(e);
    logPlayerScreenLoadFailure(labId, reason, e);
    return { kind: "error", reason };
  }

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
      salesModelId: stored.config.salesModelId,
      standardAiProfileMode: stored.config.standardAiProfileMode,
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
      lastQuarterSalesAllocations: projectMarketBasePriceReferences(latestEntry?.record.salesRecord.allocations),
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

  // 【Dynamic Scenario 1】シナリオNews（世界情勢）。プレイヤーが実際に遊ぶ画面へ
  // 情報を届けるための唯一の配線であり、絞り込みは informationEngine が行う
  // （未来のイベント・GM専用情報・終了後の真実は構造的に返らない）。
  // "standard" は「噂＋公開情報」までを含むレベル。
  const definition = restoredState.scenarioState.definition;
  const scenarioNews = toScenarioNewsItems(getAvailableInformation(definition.informationReleases, turn, "standard"));

  return {
    period: restoredState.currentPeriod,
    turn,
    domesticReferencePrice: computeDomesticReferencePrice(restoredState, turn),
    balanceSheet: buildOpeningBalanceSheet(ownState),
    depreciableAssets: buildDepreciableAssets(ownState, turn),
    observedMarketDemand: publicInfo.observedMarketDemand,
    marketInfo: buildOpeningMarketInfo(
      publicInfo.vietnamDomesticPriorPrice,
      priorByMarket,
      resolveScenarioProductLifecycleParameters(definition)
    ),
    scenarioNews,
  };
}
