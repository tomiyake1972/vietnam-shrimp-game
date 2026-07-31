// ShrimpX V2 — Phase SAI-3A: 標準AI自動テストプレイ・判断記録基盤 ログスキーマ
//
// 【目的】標準AI（standardAi/）を「テストプレイヤー」として5社×複数seedで自動運転し、
// 「四半期開始時の状態→標準AIの事前希望案→各種制約による調整→最終意思決定→
// 四半期結果」を、再利用可能な構造化ログとして保存する。SAI-3B（Excel分析ブック）・
// 将来のVercel自動運転機能の双方が、この同じスキーマ・同じ実行基盤を再利用する
// （スクリプト固有の一時データにしない）。
//
// 【既存計算の再利用】ここに定義する型は、既存のCompanyLab/StandardAiの計算結果
// （CompanyQuarterRecord・StandardAiQuarterDiagnostics・FinancingQuarterResult・
// MarketSalesEffortAdjustment・CompanyQuarterSummary等）を「読み替えて詰め直す」
// ためのものであり、新しい判定ロジック・新しい乱数・新しい計算は一切持たない。
//
// 【schema version】将来項目を追加する場合は、既存フィールドの意味を変えずに
// 追加すること（optionalフィールドとして追加し、SCHEMA_VERSIONは意味的な破壊的
// 変更（既存フィールドの削除・意味変更・型変更）があった場合のみ上げる）。

export const SAI3A_LOG_SCHEMA_VERSION = "1.0.0";

export type SaiCompanyId = "BAL" | "MASS" | "JPQ" | "VAP" | "CONSV";

// ---------------------------------------------------------------------
// 0. 実行条件（再現性のための実行マニフェスト）
// ---------------------------------------------------------------------

/** 1回の自動運転run全体の実行条件。日時以外は同一条件で同一結果を再現できる。 */
export interface AutoplayRunManifest {
  readonly schemaVersion: string;
  /** このrunを実行したcommit ID（gitが利用できない環境ではundefined）。 */
  readonly appCommitId?: string;
  /** 実行日時（ISO8601）。再現性の対象外（参考情報）。 */
  readonly executedAtIso?: string;
  readonly runId: string;
  readonly scenarioId: string;
  /** 標準初期条件の候補ID（standardBaseline.tsのStandardBaselineCandidate.id）。 */
  readonly standardBaselineId: string;
  readonly seeds: readonly string[];
  readonly quarters: number;
  readonly companyIds: readonly SaiCompanyId[];
  /** AI policyのバージョン（standardAi/parameters.tsのSTANDARD_AI_PARAMETERS_V1に
   *  相当。将来複数バージョンが並立した場合の識別用。現状は固定文字列。） */
  readonly aiPolicyVersion: string;
  /** 標準営業人数（候補のsalesForceHeadcountTotalの既定値。overrideで上書きした
   *  場合はoverride後の値をここに記録する）。 */
  readonly salesForceHeadcountTotal: number;
  /** 主要パラメータの一覧（キー・値のペア。将来項目が増えてもrunManifestの型を
   *  壊さずに追加できるよう、構造化オブジェクトではなくレコードにしている）。 */
  readonly keyParameters: Readonly<Record<string, number | string | boolean>>;
  readonly outputFormats: readonly ("json" | "csv")[];
}

// ---------------------------------------------------------------------
// A. 四半期開始時の状態
// ---------------------------------------------------------------------

export interface QuarterStartState {
  readonly companyId: SaiCompanyId;
  readonly turn: number;
  readonly period: string;

  readonly cashUsd: number;
  readonly accountsReceivableUsd: number;
  readonly accountsPayableUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly availableAdditionalCapacityUsd: number;
  readonly creditTier: string;
  readonly creditScore0to100: number;
  readonly financialHealthTier: string;
  readonly paymentDefault: boolean;
  readonly underwritingFrozen: boolean;
  readonly consecutiveArrearsQuarters: number;

  readonly rawMaterialInventoryHosoEqTons: number;
  readonly finishedGoodsInventoryHosoEqTons: number;

  readonly totalFactoryCapacityHosoEqTons: number;
  readonly regularWorkerCount: number;
  readonly salesForceHeadcountTotal: number;
  /** 参考値: 会社の総営業人員をすべて単一市場に集中投入したと仮定した場合の
   *  営業工数換算能力（sales/marketEffort.tsのprocessingCapacity(全人員)）。
   *  四半期開始（意思決定生成）時点では、実際の市場別人員配分はまだ決まって
   *  いない（配分自体がAIの意思決定の一部）ため、真の「今期使える能力」は
   *  一意に定まらない。実際に使われた市場別配分に基づく正確な能力・使用量は
   *  結果側（セクションE、QuarterResultLog.salesEffortCapacityHosoEqTons/
   *  salesEffortUsedHosoEqTons）を参照する（各市場の基礎能力フロアが
   *  独立に積み上がるため、本フィールドより大きくなるのが通常）。 */
  readonly salesEffortCapacityHosoEqTons: number;

  readonly qualityScoreByProduct: Readonly<Record<string, number | undefined>>;
  readonly customerTrustByMarket: Readonly<Record<string, number | undefined>>;
  readonly deliveryReliabilityByMarket: Readonly<Record<string, number | undefined>>;

  /** 当四半期開始時点で計算された圧力スコア一式（standardAi/pressures.tsの
   *  PressureScoresをそのままJSON化したもの）。ネストした値（商品別比率・
   *  市場優先順位配列等）を含むため、CSV出力時は主要スカラー値のみ列展開する。 */
  readonly pressures: Readonly<Record<string, unknown>>;

  /** 前四半期からの主要な変化（現金・信用区分・underwritingFrozenの遷移等）。
   *  turn=1（前四半期が存在しない）ではnull。 */
  readonly changeFromPreviousQuarter: QuarterStateDelta | null;
}

export interface QuarterStateDelta {
  readonly cashUsdDelta: number;
  readonly creditTierChanged: boolean;
  readonly underwritingFrozenChanged: boolean;
  readonly financialHealthTierChanged: boolean;
}

// ---------------------------------------------------------------------
// B. 標準AIの事前希望案 / D. 最終意思決定
// ---------------------------------------------------------------------

/** 市場×商品ぶんの販売数量トレース（希望→営業工数調整後→実際の成約）。 */
export interface SalesQuantityTraceEntry {
  readonly companyId: SaiCompanyId;
  readonly turn: number;
  readonly market: string;
  readonly product: string;
  /** 営業工数制約を適用する前の、標準AIの希望販売数量。 */
  readonly desiredQuantityBeforeEffortConstraint: number;
  /** 営業工数制約適用後、標準AIが最終的に提出した販売計画数量
   *  （= quarter runnerへ渡された値。エンジン側の営業工数チェックは
   *  scaleFactor≈1で通過することが多いが、まれに微小な追加縮小がありうる）。 */
  readonly salesForceHeadcount: number;
  readonly finalPlannedQuantity: number;
  /** エンジン側(sales/marketEffort.ts)が実際に適用した営業工数制約の
   *  scaleFactor（該当市場が制約されなかった場合は1）。 */
  readonly engineEffortScaleFactor: number;
  /** 実際に成約・履行した数量は市場×商品単位では分解されないため
   *  会社単位のfulfilledQuantity/newContractedQuantityのみ四半期結果側で保持する
   *  （存在しない粒度を無理に作らない）。 */
}

export interface QuarterDecisionLog {
  readonly companyId: SaiCompanyId;
  readonly turn: number;
  readonly period: string;

  /** B: 標準AIの事前希望案（制約適用後にAIが実際に提出した意思決定。sales
   *  ドメインのみ、営業工数制約適用「前」の希望はsalesQuantityTraceで別途保持）。 */
  readonly wish: {
    readonly domesticPurchaseDesiredQuantity: number;
    readonly importOrdersDesiredQuantity: number;
    readonly aquacultureStockingDesiredQuantity: number;
    readonly productionDesiredQuantityByProduct: Readonly<Record<string, number>>;
    readonly workerRegularHeadcountTotal: number;
    readonly workerTemporaryHeadcountTotal: number;
    readonly workerOvertimeRateAvg: number;
    readonly financingRequestDesiredAmountUsd: number;
    readonly financingRequestDesiredPrepaymentUsd: number;
    readonly capexNewProposalCount: number;
    readonly capexCancelCount: number;
    readonly capexResumeCount: number;
    /** 【SAI-5F・optional追加】提案した設備投資のprojectType一覧（カンマ区切り。
     *  提案なしは省略。バージョン規約どおりoptional追加のみ＝既存パーサーへの影響なし）。 */
    readonly capexProposalProjectTypes?: string;
  };

  /** D: quarter runnerへ実際に渡された最終意思決定値（procurementConstraint
   *  適用後の国内買付・輸入・養殖池入れを含む。runner.tsのconstrainedDecisions
   *  に相当。sales/production/labor/financing/capexはAIの提出値がそのまま
   *  runnerへ渡るため、wishと同じ値になる）。 */
  readonly final: {
    readonly domesticPurchaseFinalQuantity: number;
    readonly importOrdersBlocked: boolean;
    readonly importOrdersFinalQuantity: number;
    readonly aquacultureStockingFinalQuantity: number;
    /** 【SAI-5F・optional追加】capexのwish→executed対比: エンジン側で承認された
     *  提案数・却下された提案数（capexResults由来。SAI-5F以前のログには無い）。 */
    readonly capexApprovedProposalCount?: number;
    readonly capexRejectedProposalCount?: number;
  };
}

// ---------------------------------------------------------------------
// C. 調整過程（希望→最終決定までの各種制約）
// ---------------------------------------------------------------------

export type AdjustmentCategory =
  | "sales_effort_capacity"
  | "production_capacity"
  | "raw_material"
  | "labor"
  | "inventory"
  | "cash_constraint"
  | "borrowing_capacity"
  | "underwriting"
  | "market_demand_or_contract"
  | "rounding_or_unit_conversion"
  | "other";

/** 1件の調整（before/after/delta/reason code）。reason codeは既存registry
 *  （standardAi/reasonCodes.ts の StandardAiReasonCode、companyLab/types.ts の
 *  CompanyReasonCode）をそのまま再利用し、新しいコード体系は作らない。 */
export interface AdjustmentTraceEntry {
  readonly companyId: SaiCompanyId;
  readonly turn: number;
  readonly period: string;
  readonly category: AdjustmentCategory;
  /** どの既存reason code registryに由来するか。 */
  readonly source: "standardAi" | "companyLab";
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

// ---------------------------------------------------------------------
// E. 四半期結果
// ---------------------------------------------------------------------

export interface QuarterResultLog {
  readonly companyId: SaiCompanyId;
  readonly turn: number;
  readonly period: string;

  readonly netRevenueUsd: number;
  readonly grossProfitUsd: number;
  readonly operatingProfitUsd: number;
  readonly netIncomeUsd: number;
  readonly operatingCashFlowUsd: number;
  readonly investingCashFlowUsd: number;
  readonly financingCashFlowUsd: number;
  readonly closingCashUsd: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly availableAdditionalCapacityUsd: number;

  readonly salesQuantityByProduct: Readonly<Record<string, number>>;
  readonly productionQuantityByProduct: Readonly<Record<string, number>>;
  readonly rawMaterialInventoryHosoEqTons: number;
  readonly finishedGoodsInventoryHosoEqTons: number;
  readonly discardQuantityHosoEqTons: number;
  readonly downgradeQuantityHosoEqTons: number;

  /** 当四半期に実際に使われた市場別営業人員配分から積み上げた、会社単位の
   *  営業工数換算能力の合計（salesEffortCapacityHosoEqTons）・営業工数換算
   *  使用量の合計（salesEffortUsedHosoEqTons、係数: HOSO=1.0/PD=1.2/VAP=3.0を
   *  乗じた換算値であり、物理数量の単純合計ではない点に注意）。
   *  salesReductionFromEffortConstraintHosoEqTonsのみ、市場×商品別の物理数量
   *  ベース（希望-最終の物理トン差の合計、salesQuantityTrace由来）。 */
  readonly salesEffortCapacityHosoEqTons: number;
  readonly salesEffortUsedHosoEqTons: number;
  readonly salesReductionFromEffortConstraintHosoEqTons: number;

  readonly newContractedQuantityHosoEqTons: number;
  readonly fulfilledQuantityHosoEqTons: number;
  readonly outstandingQuantityHosoEqTons: number;
  readonly overdueQuantityHosoEqTons: number;

  readonly customerTrustByMarket: Readonly<Record<string, number | undefined>>;
  readonly qualityScoreByProduct: Readonly<Record<string, number | undefined>>;
  readonly deliveryReliabilityByMarket: Readonly<Record<string, number | undefined>>;

  readonly paymentDefault: boolean;
  readonly paymentDefaultNewlyTriggered: boolean;
  readonly underwritingFrozen: boolean;
  readonly underwritingFrozenNewlyTriggered: boolean;

  /** 当四半期に発火した主要pressure（standardAi/pressures.tsのキー名。
   *  次四半期の意思決定に使われた値であり、当四半期の「結果」欄では
   *  参考として次期分を再掲する）。 */
  readonly reasonCodes: readonly { readonly code: string; readonly source: "standardAi" | "companyLab"; readonly severity: string; readonly message: string }[];
  readonly warningCount: number;
}

// ---------------------------------------------------------------------
// F（SAI-3B-2で追加）. 市場×商品×会社ぶんの販売配分トレース
// ---------------------------------------------------------------------

/**
 * 四半期ごとの市場×商品×会社ぶんの需要・配分結果（record.salesRecord.allocationsを
 * そのまま読み替えたもの。新しい計算・新しい判定は一切行わない）。
 *
 * 【会社横断の1レコードである点に注意】CompanyQuarterRecordは5社共通の
 * 単一オブジェクトであり、市場×商品ぶんの配分（targetDemand/externalOptionQuantity/
 * basePrice等）も会社をまたいだ共通値である。buildLog.ts側では、この節のみ
 * 会社ごとの外側ループではなく、turnごとに一度だけ組み立てる
 * （5社分の重複を避けるため）。
 *
 * 【用途】SAI-3B-2の市場別シェア推移（§3-C）・売上総利益要因分解等で、
 * 「その市場・その商品・その四半期に、全社合計でどれだけ需要があり、
 * 自社がいくら配分を得たか」を会社別売上・数量とは独立に検証できるようにする。
 */
export interface MarketAllocationTraceEntry {
  readonly turn: number;
  readonly period: string;
  readonly market: string;
  readonly product: string;
  readonly companyId: SaiCompanyId;
  /** その市場×商品の当四半期需要量（全社共通、会社をまたいだ値）。 */
  readonly targetDemandHosoEqTons: number;
  /** 需要のうち、いずれの会社にも配分されず外部オプションに流れた数量
   *  （全社共通）。 */
  readonly externalOptionQuantityHosoEqTons: number;
  /** 自社の提示価格（USD/HOSO換算kg）。 */
  readonly askPriceUsdPerHosoEqKg: number;
  /** 市場の基準価格（USD/HOSO換算kg、全社共通）。 */
  readonly basePriceUsdPerHosoEqKg: number;
  /** 自社が実際に配分を得た数量（=市場清算後、当四半期の実質販売数量に相当）。 */
  readonly allocatedQuantityHosoEqTons: number;
  readonly coverageScore: number;
  readonly competitivenessWeight: number;
}

// ---------------------------------------------------------------------
// ケース（=1 seed の5社同時実行）・run全体の集計
// ---------------------------------------------------------------------

export interface CaseError {
  readonly seed: string;
  readonly companyIds: readonly SaiCompanyId[];
  readonly failedAtTurn?: number;
  readonly errorMessage: string;
  readonly errorStack?: string;
}

/**
 * 1ケース（1 seed × 指定会社群 × 指定クォーター数）ぶんの、A〜Eすべての節を
 * 組み立て済みの構造化ログ一式（buildLog.tsのbuildAutoplayCaseLogsが生成する）。
 * runBatch.ts はこれをケースごとに積み上げ、output.tsがファイル群へ変換する。
 */
export interface AutoplayCaseLog {
  readonly seed: string;
  readonly companyIds: readonly SaiCompanyId[];
  readonly quarterStartStates: readonly QuarterStartState[];
  readonly decisionLogs: readonly QuarterDecisionLog[];
  readonly adjustmentTrace: readonly AdjustmentTraceEntry[];
  readonly salesQuantityTrace: readonly SalesQuantityTraceEntry[];
  readonly quarterResults: readonly QuarterResultLog[];
  readonly caseSummaryRows: readonly CaseSummaryRow[];
  /** SAI-3B-2で追加。turnごとに1回だけ組み立てる（会社をまたいだ共通データの
   *  ため、5社分重複させない。buildAutoplayCaseLogsのコメント参照）。 */
  readonly marketAllocationTrace: readonly MarketAllocationTraceEntry[];
}

/** 1社×1seedぶんの最終サマリー（=ケース単位の集計行。5社×12seed runなら60行）。 */
export interface CaseSummaryRow {
  readonly seed: string;
  readonly companyId: SaiCompanyId;
  readonly completedTurns: number;
  readonly requestedTurns: number;
  readonly completed: boolean;
  readonly cumulativeRevenueUsd: number;
  readonly cumulativeGrossProfitUsd: number;
  readonly cumulativeOperatingProfitUsd: number;
  readonly cumulativeSalesForceCostUsd: number;
  readonly finalCashUsd: number;
  readonly finalLoansUsd: number;
  readonly finalAvailableAdditionalCapacityUsd: number;
  readonly paymentDefaultEverByRequestedTurns: boolean;
  readonly paymentDefaultFirstTurn?: number;
  readonly underwritingFrozenEverByRequestedTurns: boolean;
  readonly underwritingFrozenFirstTurn?: number;
  readonly topReasonCodes: readonly string[];
  readonly warningCount: number;
}

export interface RunSummary {
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
}
