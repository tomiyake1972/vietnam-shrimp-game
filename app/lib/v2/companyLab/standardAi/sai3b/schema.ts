// ShrimpX V2 — Phase SAI-3B-1: Excel経営分析ブック第1版 — 内部データモデル
//
// 【方針】本モジュールは、SAI-3Aが出力した既存ログ（manifest.json・
// case-summary.csv・quarter-summary.csv・decision-trace.jsonl・
// adjustment-trace.csv・warnings.csv・run-summary.json）を読み込む、独立した
// 分析・表示層である。ゲームエンジン・standard AIの判断ロジックは一切変更せず、
// 財務・販売・生産等の結果をここで再計算して別の結果を作らない
// （三宅さんの指示§2「基本方針」）。既存のAutoplay系スキーマ型
// （../schema.ts, ../output.ts）をそのまま再利用し、SAI-3B固有の型は
// 「複数runを横断した集計結果の行」としてのみ追加する。

import {
  AdjustmentCategory,
  AutoplayRunManifest,
  CaseSummaryRow,
  SaiCompanyId,
} from "../autoplay/schema";
import type { DecisionTraceLine } from "../autoplay/output";

export type { SaiCompanyId };

export const SAI3B_VERSION = "1.0.0";

/** SAI-3Bが対応するSAI-3Aログschema versionの一覧（現状は1.0.0のみ）。
 *  将来、schemaVersionが上がった場合はここに追加する（既存互換のバージョンを
 *  削除しない限り、後方互換を維持する）。 */
export const SUPPORTED_SAI3A_SCHEMA_VERSIONS: readonly string[] = ["1.0.0"];

// ---------------------------------------------------------------------
// 入力エラー
// ---------------------------------------------------------------------

/** SAI-3Aログの読み込み・検証で発生したエラー（存在しない値の捏造はせず、
 *  読み込み不能な場合は明示的に失敗させる）。 */
export class Sai3bInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Sai3bInputError";
  }
}

// ---------------------------------------------------------------------
// SAI-3Aのrunディレクトリ1件ぶんの読み込み結果
// ---------------------------------------------------------------------

/** quarter-summary.csvの1行（output.tsのQUARTER_SUMMARY_CSV_HEADERと1対1対応）。
 *  値が存在しない場合は明示的にundefinedとし、0として扱わない。 */
export interface Sai3bQuarterSummaryRow {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly startCashUsd?: number;
  readonly startShortTermLoansUsd?: number;
  readonly startLongTermLoansUsd?: number;
  readonly startAvailableAdditionalCapacityUsd?: number;
  readonly startCreditTier?: string;
  readonly startCreditScore0to100?: number;
  readonly startFinancialHealthTier?: string;
  readonly startPaymentDefault?: boolean;
  readonly startUnderwritingFrozen?: boolean;
  readonly startRawMaterialInventoryHosoEqTons?: number;
  readonly startFinishedGoodsInventoryHosoEqTons?: number;
  readonly startSalesForceHeadcountTotal?: number;
  readonly startSalesEffortCapacityHosoEqTonsReference?: number;
  readonly netRevenueUsd: number;
  readonly grossProfitUsd: number;
  readonly operatingProfitUsd: number;
  readonly netIncomeUsd: number;
  readonly closingCashUsd: number;
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  readonly endingAvailableAdditionalCapacityUsd?: number;
  readonly salesEffortCapacityHosoEqTonsActual: number;
  readonly salesEffortUsedHosoEqTons: number;
  readonly salesEffortUtilizationRate?: number;
  readonly salesReductionFromEffortConstraintHosoEqTons: number;
  readonly rawMaterialInventoryHosoEqTons: number;
  readonly finishedGoodsInventoryHosoEqTons: number;
  readonly discardQuantityHosoEqTons: number;
  // --- SAI-3B-2で追加（output.tsのQUARTER_SUMMARY_CSV_HEADER拡張と1対1対応）。
  //     いずれもSAI-3A側で既に計算済みだった値がファイル出力から漏れていた
  //     ものであり、値の意味・単位は既存フィールドと同じ方針
  //     （実績・欠損=undefined、0との混同禁止）。 ---
  readonly operatingCashFlowUsd?: number;
  readonly investingCashFlowUsd?: number;
  readonly financingCashFlowUsd?: number;
  readonly downgradeQuantityHosoEqTons?: number;
  readonly newContractedQuantityHosoEqTons?: number;
  readonly fulfilledQuantityHosoEqTons?: number;
  readonly outstandingQuantityHosoEqTons?: number;
  readonly overdueQuantityHosoEqTons?: number;
  /** 当四半期の生産数量（商品別、hoso/pd/vap）。 */
  readonly productionQuantityHosoEqTonsByProduct?: Readonly<Record<string, number | undefined>>;
  /** 当四半期に市場清算で自社が実際に獲得した販売数量（商品別、hoso/pd/vap）。
   *  生産数量とは異なるデータ源（既存SAI-3Aバグの是正。autoplay/buildLog.tsの
   *  computeSalesQuantityByProductのコメント参照）。 */
  readonly salesQuantityHosoEqTonsByProduct?: Readonly<Record<string, number | undefined>>;
  /** 当四半期末時点（更新後）の市場別顧客信頼（CN/US/EU/JP/OTHER）。 */
  readonly customerTrustAtEndByMarket?: Readonly<Record<string, number | undefined>>;
  /** 当四半期末時点（更新後）の商品別品質スコア（hoso/pd/vap）。 */
  readonly qualityScoreAtEndByProduct?: Readonly<Record<string, number | undefined>>;
  /** 当四半期末時点（更新後）の市場別納期信頼性（CN/US/EU/JP/OTHER）。 */
  readonly deliveryReliabilityAtEndByMarket?: Readonly<Record<string, number | undefined>>;
  readonly paymentDefault: boolean;
  readonly paymentDefaultNewlyTriggered: boolean;
  readonly underwritingFrozen: boolean;
  readonly underwritingFrozenNewlyTriggered: boolean;
  readonly warningCount: number;
}

/** market-allocation-trace.csvの1行（schema.tsのMarketAllocationTraceEntry + seed）。
 *  SAI-3B-2で追加。既存run（このファイルを含まない）との後方互換のため、
 *  LoadedSai3aRunでは任意（存在しなければ空配列）として扱う。 */
export interface Sai3bMarketAllocationTraceRow {
  readonly seed: string;
  readonly turn: number;
  readonly period: string;
  readonly market: string;
  readonly product: string;
  readonly companyId: string;
  readonly targetDemandHosoEqTons: number;
  readonly externalOptionQuantityHosoEqTons: number;
  readonly askPriceUsdPerHosoEqKg: number;
  readonly basePriceUsdPerHosoEqKg: number;
  readonly allocatedQuantityHosoEqTons: number;
  readonly coverageScore: number;
  readonly competitivenessWeight: number;
}

/** adjustment-trace.csvの1行（schema.tsのAdjustmentTraceEntry + seed）。 */
export interface Sai3bAdjustmentTraceRow {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly category: AdjustmentCategory | string;
  readonly source: "standardAi" | "companyLab" | string;
  readonly code: string;
  readonly severity: string;
  readonly affectedDecision: string;
  readonly affectedMarketOrProduct?: string;
  readonly before?: number;
  readonly after?: number;
  readonly delta?: number;
  readonly message: string;
  readonly threshold?: number;
  readonly relevantMetric?: string;
}

/** warnings.csvの1行。 */
export interface Sai3bWarningRow {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly code: string;
  readonly source: string;
  readonly severity: string;
  readonly message: string;
}

/** run-summary.jsonの中身（output.tsのRunSummaryJsonと同一構造）。 */
export interface Sai3bRunSummaryJson {
  readonly runSummary: {
    readonly runId: string;
    readonly totalCases: number;
    readonly completedCases: number;
    readonly errorCases: number;
    readonly paymentDefaultRate: number;
    readonly underwritingFrozenRate: number;
    readonly averageCumulativeRevenueUsd: number;
    readonly averageCumulativeGrossProfitUsd: number;
    readonly averageCumulativeOperatingProfitUsd: number;
    readonly averageFinalCashUsd: number;
    readonly topReasonCodeCounts: readonly { readonly code: string; readonly count: number }[];
    readonly totalWarningCount: number;
  };
  readonly errors: readonly {
    readonly seed: string;
    readonly companyIds: readonly string[];
    readonly failedAtTurn?: number;
    readonly errorMessage: string;
    readonly errorStack?: string;
  }[];
}

/** 1個のSAI-3A runディレクトリを読み込んだ結果（このrunのすべてのファイルを
 *  検証・パース済みの状態で保持する）。runLabelは複数run比較時の識別子
 *  （既定ではmanifest.runIdを使うが、CLI引数で別名を指定できる）。 */
export interface LoadedSai3aRun {
  readonly runLabel: string;
  readonly sourceDir: string;
  readonly manifest: AutoplayRunManifest;
  readonly caseSummaryRows: readonly CaseSummaryRow[];
  readonly quarterSummaryRows: readonly Sai3bQuarterSummaryRow[];
  readonly decisionTraceLines: readonly DecisionTraceLine[];
  readonly adjustmentTraceRows: readonly Sai3bAdjustmentTraceRow[];
  readonly warningRows: readonly Sai3bWarningRow[];
  /** market-allocation-trace.csv（SAI-3B-2で追加、任意ファイル）。存在しない
   *  run（既存run・後方互換）の場合は空配列。 */
  readonly marketAllocationTraceRows: readonly Sai3bMarketAllocationTraceRow[];
  readonly runSummary: Sai3bRunSummaryJson;
  /** 読み込み時に検出した、致命的ではないが利用者に報告すべき事項
   *  （例: run-summary.jsonのerrorsに記録されたケース単位のエラー）。 */
  readonly loadWarnings: readonly string[];
}

// ---------------------------------------------------------------------
// 複数run比較時の整合性検証
// ---------------------------------------------------------------------

export interface Sai3bComparisonValidation {
  readonly comparable: boolean;
  /** 致命的ではない差異（例: headcountの違いはむしろ比較対象そのものなので
   *  issueにはしない）。 */
  readonly issues: readonly string[];
  readonly commonSeeds: readonly string[];
  readonly commonCompanyIds: readonly SaiCompanyId[];
  readonly commonQuarters: number;
}

// ---------------------------------------------------------------------
// 集計行（シート別）。すべて元ログの値をそのまま転記・単純集計したものであり、
// 元データに存在しない値を推測・捏造しない。取得できない項目はundefined。
// ---------------------------------------------------------------------

export interface DashboardSummaryRow {
  readonly runLabel: string;
  readonly runId: string;
  readonly salesForceHeadcountTotal: number;
  readonly totalCases: number;
  readonly completedCases: number;
  readonly errorCases: number;
  readonly paymentDefaultCaseCount: number;
  /** ケース単位のdefault発生率（分母=completedCases、三宅さんの指示§6により
   *  分母・分子・単位を明示する）。 */
  readonly paymentDefaultRateByCase: number;
  readonly underwritingFrozenCaseCount: number;
  readonly underwritingFrozenRateByCase: number;
  readonly criticalWarningCount: number;
  readonly totalRevenueUsd: number;
  readonly totalGrossProfitUsd: number;
  readonly totalOperatingProfitUsd: number;
  readonly averageFinalCashUsd: number;
  readonly averageFinalLoansUsd: number;
  readonly totalFinalSalesQuantityHosoEqTons: number;
  readonly totalReductionFromEffortConstraintHosoEqTons: number;
  readonly totalDesiredBeforeEffortConstraintHosoEqTons: number;
  /** 希望量に対する最終計画量の削減率（= 削減量 / 希望量。希望量が0の場合はundefined）。 */
  readonly effortConstraintReductionRate?: number;
  /** 営業能力使用率の単純平均（quarter-summary.csvのsalesEffortUtilizationRateの
   *  平均。値が存在しない四半期は分母から除外する）。 */
  readonly averageSalesEffortUtilizationRate?: number;
  readonly topReasonCode?: string;
  readonly topReasonCodeCount?: number;
}

export interface CompanyPerformanceRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly completed: boolean;
  readonly completedTurns: number;
  readonly requestedTurns: number;
  readonly paymentDefaultEver: boolean;
  readonly paymentDefaultFirstTurn?: number;
  readonly underwritingFrozenEver: boolean;
  readonly underwritingFrozenFirstTurn?: number;
  readonly cumulativeRevenueUsd: number;
  readonly cumulativeGrossProfitUsd: number;
  readonly cumulativeOperatingProfitUsd: number;
  readonly finalCashUsd: number;
  readonly finalLoansUsd: number;
  readonly finalFinishedGoodsInventoryHosoEqTons?: number;
  readonly cumulativeSalesQuantityHosoEqTons?: number;
  readonly warningCount: number;
}

export interface QuarterPerformanceRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly period: string;
  readonly netRevenueUsd: number;
  readonly grossProfitUsd: number;
  readonly operatingProfitUsd: number;
  readonly netIncomeUsd: number;
  readonly closingCashUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  /** 四半期"開始時点"の売掛金・買掛金（QuarterStartState由来。四半期末残高は
   *  SAI-3Aのいずれの出力にも含まれていないため取得できない。シート側では
   *  「期首」であることを明示する）。 */
  readonly accountsReceivableUsdAtStart?: number;
  readonly accountsPayableUsdAtStart?: number;
  readonly rawMaterialInventoryHosoEqTons: number;
  readonly finishedGoodsInventoryHosoEqTons: number;
  /** AI提出の生産計画数量合計（decision.wish.productionDesiredQuantityByProductの
   *  商品別合計）。四半期結果側の実際の生産実績（生産能力制約後の値）はSAI-3Aの
   *  いずれの出力ファイルにも含まれていないため取得できない（missingFieldReports
   *  参照）。実績ではなく計画である点に注意（三宅さんの指示11.3）。 */
  readonly productionPlanQuantityTotal?: number;
  /** 市場×商品別salesQuantityTraceのfinalPlannedQuantity合計（営業工数制約後、
   *  quarter runnerへ渡された最終計画数量）。実際に成約・履行された数量
   *  （newContractedQuantityHosoEqTons等）はSAI-3Aの出力ファイルに含まれていない
   *  ため取得できない（missingFieldReports参照）。 */
  readonly finalPlannedSalesQuantityTotal?: number;
  // --- SAI-3B-2で追加（quarter-summary.csvの拡張列に対応。§1監査で
  //     「作成不能」としていたF（キャッシュフロー3区分）が、SAI-3A出力層の
  //     追記により作成可能になった）。 ---
  readonly operatingCashFlowUsd?: number;
  readonly investingCashFlowUsd?: number;
  readonly financingCashFlowUsd?: number;
  readonly endingAvailableAdditionalCapacityUsd?: number;
  /** market-allocation-trace.csv由来。市場清算で実際に配分を得た（=売れた）
   *  数量の合計（商品・市場を問わず会社単位で合算）。finalPlannedSalesQuantityTotal
   *  （営業工数制約後にengineへ提出された計画数量）とは異なるデータ源であり、
   *  市場清算後の実際の結果に近い（「実績」に相当）。market-allocation-trace.csv
   *  が存在しない古いrunでは取得できずundefinedのまま（0にしない）。 */
  readonly actualSalesQuantityHosoEqTons?: number;
  readonly newContractedQuantityHosoEqTons?: number;
  readonly fulfilledQuantityHosoEqTons?: number;
  readonly outstandingQuantityHosoEqTons?: number;
  readonly overdueQuantityHosoEqTons?: number;
  readonly paymentDefault: boolean;
  readonly underwritingFrozen: boolean;
  readonly startCreditTier?: string;
  readonly topWarningCodes: string;
}

/**
 * 市場別シェア推移（SAI-3B-2 §3-C）。market-allocation-trace.csv由来。
 * 【分母の定義】quantityShare = 自社のallocatedQuantity（当該run×seed×turn×市場で
 * 商品を問わず合算） ÷ 同一run×seed×turn×市場で実際に配分エントリに登場した
 * 全社のallocatedQuantity合計（三宅さんの指示どおり「全社合計」であり、
 * externalOptionQuantityは含まない）。会社が1社でも欠けている場合（=その
 * 市場に対して配分エントリ自体が無い）は、companyCountInMarketで会社数が
 * わかるようにし、5社に満たない場合は「比較対象外」として扱えるようにする
 * （三宅さんの指示：欠けている会社を無理に100%へ補正しない）。
 * 【revenueShareについて】市場別の実現収益（価格×数量）はSAI-3Aのいずれの
 * 出力にも含まれておらず、askPrice（自社の提示価格。市場清算価格そのものでは
 * ない）から逆算すると捏造になるため、revenueShareは意図的に持たない
 * （quantityShareのみ提供。README/シート注記で明記する）。
 */
export interface MarketShareRow {
  readonly runLabel: string;
  readonly seed: string;
  readonly turn: number;
  readonly period: string;
  readonly market: string;
  readonly companyId: string;
  readonly allocatedQuantityHosoEqTons: number;
  readonly totalAllocatedQuantityHosoEqTonsAcrossCompanies: number;
  readonly quantityShare: number;
  /** この市場×turn×seedに実際に配分エントリを持っていた会社数（5社中）。 */
  readonly companyCountInMarket: number;
}

/** MarketShareRow（seed単位）を、run×市場×会社×turnで横断集計した中央値
 *  （ダッシュボードの市場別シェア推移チャート用。Layer1見出し値）。 */
export interface MarketShareStatRow {
  readonly runLabel: string;
  readonly market: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly quantityShareMedian?: number;
  /** シェアを計算できたseed数。 */
  readonly seedCount: number;
}

/**
 * 80/85/90人比較における「最初に乖離が始まった四半期」の追跡（SAI-3B-2 §6）。
 * 原因の特定・断定は行わない（三宅さんの指示どおり「乖離開始点の可視化」のみ）。
 * 乖離判定は、比較対象headcountのうちその四半期時点でまだデータが存在する
 * （=defaultでログが途切れていない）headcount間の相対乖離率
 * （(最大-最小)/max(|最大|,ε)）が閾値を超えた最初のturnを機械的に検出する
 * ヒューリスティックであり、統計的因果推論ではない。
 */
/**
 * 会社×seedを横断した分布要約（SAI-3B-2 §5「3層構造」のLayer1見出しグラフ用）。
 * average/medianの両方を保持し、default等の外れ値が多いKPIではmedianを
 * 見出し線として採用できるようにする（三宅さんの指示§5）。値が1件も無い
 * （n=0）場合はaverage/median/min/maxすべてundefinedのまま（0にしない）。
 */
export interface StatSummary {
  readonly average?: number;
  readonly median?: number;
  readonly min?: number;
  readonly max?: number;
  /** 標本標準偏差（n-1で割る、不偏分散の平方根）。n<2の場合はundefined
   *  （1件だけのデータからばらつきを語ることはできないため。三宅さんの
   *  ご指摘（受入レビュー2回目）§1で追加）。 */
  readonly stddev?: number;
  readonly n: number;
}

/**
 * run×会社×turn単位で、その会社×turnに該当する全seedの値を分布要約した行
 * （SAI-3B-2 §5 Layer1：経営ダッシュボード見出しグラフ用のデータ源）。
 * Layer2（会社/seed比較統計）はこの行のStatSummaryそのもの、Layer3（個別run
 * 詳細）は既存の四半期業績シート（QuarterPerformanceRow、seed単位）を参照する
 * 設計とし、同じ値を二重に持たない。
 */
export interface CompanyQuarterStatRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  /** この会社×turnにデータが存在したseed数（全seed中）。 */
  readonly seedCount: number;
  /** 上記のうちpaymentDefault=trueだったseed数。 */
  readonly defaultedSeedCount: number;
  readonly netRevenueUsd: StatSummary;
  readonly grossProfitUsd: StatSummary;
  /** 粗利益率（粗利益÷売上）。売上が0のseedはこのKPIの分布から除外する。 */
  readonly grossMarginRate: StatSummary;
  readonly operatingProfitUsd: StatSummary;
  readonly netIncomeUsd: StatSummary;
  readonly closingCashUsd: StatSummary;
  readonly operatingCashFlowUsd: StatSummary;
  readonly investingCashFlowUsd: StatSummary;
  readonly financingCashFlowUsd: StatSummary;
  readonly shortTermLoansUsd: StatSummary;
  readonly longTermLoansUsd: StatSummary;
  readonly availableAdditionalCapacityUsd: StatSummary;
  readonly rawMaterialInventoryHosoEqTons: StatSummary;
  readonly finishedGoodsInventoryHosoEqTons: StatSummary;
  /** 期首（四半期開始時点）の値。期末残高はSAI-3Aの出力に含まれていない。 */
  readonly accountsReceivableUsdAtStart: StatSummary;
  readonly accountsPayableUsdAtStart: StatSummary;
  /** market-allocation-trace.csv由来の実際の獲得数量。ファイルが無い古いrunでは
   *  n=0のまま。 */
  readonly actualSalesQuantityHosoEqTons: StatSummary;
  /** 営業工数制約適用後にengineへ提出された「最終計画数量」（実績ではない）。 */
  readonly finalPlannedSalesQuantityHosoEqTons: StatSummary;
}

export interface HeadcountDivergenceRow {
  readonly companyId: string;
  readonly seed: string;
  readonly headcounts: readonly number[];
  /** 乖離が最初に検出されたturn（どのKPIでも乖離が見つからなければundefined）。 */
  readonly firstDivergingTurn?: number;
  /** 上記turnで最初に乖離を検出したKPI名（複数KPIが同一turnで同時に乖離した
   *  場合は、候補リストの先頭にあるものを採用。厳密な「真の最初の原因」の
   *  特定ではない）。 */
  readonly firstDivergingKpi?: string;
  /** 検出に用いた相対乖離率の閾値（ヒューリスティックのパラメータをシート上で
   *  明示するため）。 */
  readonly divergenceThreshold: number;
}

export interface SalesAnalysisRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly market: string;
  readonly product: string;
  readonly desiredQuantityBeforeEffortConstraint: number;
  readonly finalPlannedQuantity: number;
  readonly engineEffortScaleFactor: number;
  /** 営業工数制約による削減量（希望量－最終計画量。物理数量ベース）。 */
  readonly reductionFromEffortConstraint: number;
  readonly reductionRate?: number;
}

export interface ProcurementProductionRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly domesticPurchaseDesiredQuantity: number;
  readonly domesticPurchaseFinalQuantity: number;
  readonly importOrdersDesiredQuantity: number;
  readonly importOrdersFinalQuantity: number;
  readonly importOrdersBlocked: boolean;
  readonly aquacultureStockingDesiredQuantity: number;
  readonly aquacultureStockingFinalQuantity: number;
  readonly productionDesiredQuantityByProduct: Readonly<Record<string, number>>;
  readonly rawMaterialInventoryHosoEqTons: number;
  readonly finishedGoodsInventoryHosoEqTons: number;
  readonly discardQuantityHosoEqTons: number;
}

export interface SalesCapacityRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly salesForceHeadcountTotal?: number;
  readonly capacityHosoEqTonsActual: number;
  readonly usedHosoEqTons: number;
  readonly utilizationRate?: number;
  readonly reductionFromEffortConstraintHosoEqTons: number;
}

/** 市場別の営業配分・削減内訳（salesQuantityTraceを市場単位に集約）。
 *  【注意】ここでの数量はすべて物理数量（トン、HOSO換算前の商品別実数の合計）で
 *  あり、営業工数換算値（HOSO×1.0+PD×1.2+VAP×3.0）ではない。市場別の営業工数換算
 *  能力・使用量はsales/marketEffort.tsの係数を用いた再計算が必要になるため、
 *  「結果をExcel側で再計算しない」という方針に沿い、本シートでは物理数量の
 *  希望量・最終計画量・削減量のみを示す（会社全体の営業工数換算能力・使用率は
 *  営業能力分析シートのSalesCapacityRowを参照）。 */
export interface SalesCapacityMarketBreakdownRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly market: string;
  /** その市場に配分された営業人員数（salesQuantityTrace.salesForceHeadcountを
   *  そのまま転記。同一市場内の全商品で同一値）。 */
  readonly headcount?: number;
  readonly desiredPhysicalQuantityTotal: number;
  readonly finalPlannedPhysicalQuantityTotal: number;
  readonly reductionPhysicalQuantityTotal: number;
  readonly reductionRate?: number;
}

export interface AdjustmentAnalysisRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly domainGroup: "sales" | "procurement" | "production_labor_finance" | "standardAiDiagnostic" | "other";
  readonly market?: string;
  readonly product?: string;
  readonly adjustmentStage: string;
  readonly before?: number;
  readonly after?: number;
  readonly delta?: number;
  readonly deltaRate?: number;
  readonly code: string;
  readonly threshold?: number;
  readonly relevantMetric?: string;
  /** decision-trace.jsonl側の対応行を参照するための識別子（seed::companyId::turn）。 */
  readonly logRefKey: string;
}

export interface DefaultWarningEventRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly eventType: "paymentDefault" | "underwritingFrozen";
  readonly turn: number;
  readonly period: string;
  readonly cashUsd: number;
  readonly loansUsd: number;
  readonly availableAdditionalCapacityUsd?: number;
  readonly revenueUsd: number;
  readonly grossProfitUsd: number;
  readonly operatingProfitUsd: number;
  readonly inventoryHosoEqTons: number;
  readonly cashUsdDeltaFromPriorQuarter?: number;
  readonly warningCodes: string;
  readonly isPriorQuarter: boolean;
}

/** reason code集計は、読み込んだ全run（単一run時は1件のみ）を横断した合算値。
 *  「営業人数別件数」という要件上、run（＝headcount条件）をまたいだ集計が本質的に
 *  必要なため、run単位ではなくコード単位で1行とする。 */
export interface ReasonCodeTallyRow {
  readonly code: string;
  readonly source: "standardAi" | "companyLab" | string;
  readonly domain: AdjustmentCategory | string;
  readonly description: string;
  readonly totalOccurrences: number;
  readonly caseCount: number;
  readonly occurrencesInDefaultCases: number;
  readonly occurrencesInNonDefaultCases: number;
  /** 会社ID -> 出現件数。 */
  readonly companyBreakdown: Readonly<Record<string, number>>;
  /** 営業人数（runのsalesForceHeadcountTotal）-> 出現件数。 */
  readonly headcountBreakdown: Readonly<Record<number, number>>;
  /** turn -> 出現件数（表示は「T1:件数」のような圧縮文字列でシート側に出す）。 */
  readonly quarterBreakdown: Readonly<Record<number, number>>;
}

export interface HeadcountComparisonRow {
  readonly companyId: string;
  readonly seed: string;
  readonly headcounts: readonly number[];
  readonly paymentDefaultByHeadcount: Readonly<Record<number, boolean>>;
  readonly paymentDefaultFirstTurnByHeadcount: Readonly<Record<number, number | undefined>>;
  readonly revenueByHeadcount: Readonly<Record<number, number>>;
  readonly grossProfitByHeadcount: Readonly<Record<number, number>>;
  readonly operatingProfitByHeadcount: Readonly<Record<number, number>>;
  readonly finalCashByHeadcount: Readonly<Record<number, number>>;
  readonly finalLoansByHeadcount: Readonly<Record<number, number>>;
  /** 営業人件費（累計、USD）。三宅さんのご指摘（受入レビュー2回目）§2で追加。
   *  従来はRaw_Caseシートの生データダンプにしか存在せず、80/85/90人比較の
   *  正式KPI（§6で必須指定）としては未実装だった。case-summary.csvの
   *  cumulativeSalesForceCostUsdをそのまま引き写す（新規計算は行わない）。 */
  readonly salesForceCostByHeadcount: Readonly<Record<number, number>>;
  /** 85人（または比較対象の中間値）だけがdefaultし、他はしないケースの識別フラグ。
   *  85人という値をハードコードせず、比較headcountの「中間・その他」との相対関係
   *  から機械的に判定する（headcountComparison.tsのロジック参照）。 */
  readonly middleHeadcountOnlyDefaultFlag: boolean;
}

export interface DecisionTraceRow {
  readonly runLabel: string;
  readonly companyId: string;
  readonly seed: string;
  readonly turn: number;
  readonly period: string;
  readonly stage: "start_state" | "ai_wish" | "constraint_adjustment" | "final_decision" | "quarter_result" | "warning_reason_code";
  readonly stageOrder: number;
  readonly summary: string;
}

export interface Sai3bAnalysis {
  readonly generatedAtIso: string;
  readonly sai3bVersion: string;
  readonly loadedRuns: readonly LoadedSai3aRun[];
  readonly comparison: Sai3bComparisonValidation;
  readonly dashboard: readonly DashboardSummaryRow[];
  readonly companyPerformance: readonly CompanyPerformanceRow[];
  readonly quarterPerformance: readonly QuarterPerformanceRow[];
  readonly salesAnalysis: readonly SalesAnalysisRow[];
  readonly procurementProduction: readonly ProcurementProductionRow[];
  readonly salesCapacity: readonly SalesCapacityRow[];
  readonly salesCapacityMarketBreakdown: readonly SalesCapacityMarketBreakdownRow[];
  readonly adjustmentAnalysis: readonly AdjustmentAnalysisRow[];
  readonly defaultWarningEvents: readonly DefaultWarningEventRow[];
  readonly reasonCodeTally: readonly ReasonCodeTallyRow[];
  readonly headcountComparison: readonly HeadcountComparisonRow[];
  /** SAI-3B-2で追加。ダッシュボードの見出しグラフ（§5 Layer1）用の会社×turn分布要約。 */
  readonly companyQuarterStats: readonly CompanyQuarterStatRow[];
  /** SAI-3B-2で追加。market-allocation-trace.csvが存在しないrunのみで構成
   *  された場合は空配列（「現時点の出力データでは作成不能」の扱い）。 */
  readonly marketShare: readonly MarketShareRow[];
  /** SAI-3B-2で追加。marketShareをseed横断で中央値集計したもの（ダッシュボード
   *  グラフ用のLayer1見出し値。marketShare自体はseed単位の生データ）。 */
  readonly marketShareStats: readonly MarketShareStatRow[];
  /** SAI-3B-2で追加。複数run（headcount比較）入力時のみ意味を持つ（単一run
   *  入力時は空配列）。 */
  readonly headcountDivergence: readonly HeadcountDivergenceRow[];
  readonly decisionTrace: readonly DecisionTraceRow[];
  readonly missingFieldReports: readonly string[];
}
