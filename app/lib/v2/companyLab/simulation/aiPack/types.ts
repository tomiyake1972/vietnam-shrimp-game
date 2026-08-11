// ShrimpX V2 — AI Analysis Pack: 記録スキーマ
//
// 【このスキーマの目的】
// 32Q＝8年間の Simulation Run を、ChatGPT / Claude が
//
//   World → Company State → Available Information → Standard AI Diagnosis
//   → Desired Action → Constraints → Actual Decision → Execution
//   → Financial Result → Ending State
//
// という因果として Turn 単位で再構成できる形で記録する。
//
// 【絶対規約】
//  1. TRUE WORLD と「Standard AI が実際に見られた情報」を**絶対に混ぜない**。
//  2. 存在しないデータを空想で埋めない。`availability` で不在を明示する。
//  3. 生成AIを一切呼ばない。すべて決定論的な記録である。
//  4. CompanyLabState を丸ごと複製しない。経営を理解するために意味のある値へ正規化する。
//  5. 秘密情報（トークン・認証情報・接続情報）は一切含めない。

import { DemandMarketId, Product } from "../../../market/types";

/** Pack スキーマ版。ゲーム構造が変わっても、どの版の export か分かるようにする。 */
export const AI_ANALYSIS_PACK_SCHEMA_VERSION = "shrimpX-ai-analysis-pack-v1";

/**
 * データの入手可能性。
 *  AVAILABLE     … ゲームエンジンが実際に記録している値
 *  DERIVED       … 記録値から決定論的に導いた値（新しい推定式は使っていない）
 *  NOT_RECORDED  … 概念は存在するが、この実行では記録されていない
 *  NOT_AVAILABLE … ゲームエンジンにその概念自体が存在しない
 */
export type PackAvailability = "AVAILABLE" | "DERIVED" | "NOT_RECORDED" | "NOT_AVAILABLE";

/** 値の出所。AI が「どの数字がどこから来たか」を理解できるようにする。 */
export type PackSourceType =
  | "COMPANY_QUARTER_RECORD"
  | "STANDARD_AI_DIAGNOSTICS"
  | "FINANCE_QUARTER_CLOSE"
  | "FINANCING_QUARTER_CLOSE"
  | "CAPEX_QUARTER_CLOSE"
  | "MARKET_QUARTER_RESULT"
  | "SCENARIO_STATE"
  | "COMPANY_FIXTURE"
  | "SIMULATION_RUN_METADATA"
  | "DERIVED_FROM_RECORDED_VALUES";

// ---------------------------------------------------------------------
// 1. 世界（TRUE WORLD と OBSERVABLE を分ける）
// ---------------------------------------------------------------------

export interface PackMarketProductTrue {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** その四半期にベトナム産5社が獲得対象にできた需要（HOSO換算トン）。 */
  readonly trueDemandTons: number | null;
  /** 配分計算が実際に使った基準価格（USD / HOSO換算kg）。 */
  readonly priceUsdPerKg: number | null;
  /** 5社が実際に成約した合計（HOSO換算トン）。 */
  readonly contractedTons: number | null;
  /** 5社以外（他産地・非購入）へ流れた量（HOSO換算トン）。 */
  readonly externalOptionTons: number | null;
}

export interface PackMarketProductObservable {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** プレイヤー・Standard AI が実際に見られた需要（既定で2四半期遅行）。 */
  readonly observableDemandTons: number | null;
  /** この観測値が何ターンの実績か（開始時の既知情報なら null）。 */
  readonly sourceTurn: number | null;
}

export interface PackProducerCountry {
  readonly country: string;
  readonly productionTons: number | null;
  readonly exportableSupplyTons: number | null;
  readonly allocatedDemandTons: number | null;
  /** 配分需要 ÷ 輸出可能供給。 */
  readonly utilizationRatio: number | null;
  readonly hosoFobPriceUsdPerKg: number | null;
  readonly aquacultureCostIndex: number | null;
  readonly qualityScore: number | null;
  readonly reliabilityScore: number | null;
}

export interface PackWorldTurn {
  readonly turn: number;
  readonly year: number;
  readonly quarter: number;
  readonly trueWorld: {
    readonly marketProducts: readonly PackMarketProductTrue[];
    readonly vietnamDomesticRawMaterial: {
      readonly priceUsdPerKg: number | null;
      readonly supplyTons: number | null;
      readonly effectiveDemandTons: number | null;
      readonly transactedTons: number | null;
      readonly buyingCeilingUsdPerKg: number | null;
      readonly farmerReservationPriceUsdPerKg: number | null;
    };
    readonly producerCountries: readonly PackProducerCountry[];
  };
  readonly standardAiObservable: {
    readonly marketProducts: readonly PackMarketProductObservable[];
    readonly observationLagQuarters: number | null;
    readonly vietnamDomesticPriorPriceUsdPerKg: number | null;
  };
  /** そのターンに有効だったシナリオイベント（記録から取り出すだけ）。 */
  readonly scenarioEvents: readonly {
    readonly eventId: string;
    readonly title: string;
    readonly startTurn: number;
    readonly durationTurns: number;
    readonly magnitudeScale: number;
  }[];
}

// ---------------------------------------------------------------------
// 2. 会社×ターン（因果の中心）
// ---------------------------------------------------------------------

/** 期首・期末で同じ形にする（Beginning → Decision → Result → Ending を追えるようにするため）。 */
export interface PackCompanyStateSnapshot {
  readonly cashUsd: number | null;
  readonly debtUsd: number | null;
  readonly equityUsd: number | null;
  readonly salesHeadcount: number | null;
  readonly rawMaterialInventoryTons: number | null;
  readonly finishedGoodsInventoryTons: number | null;
  readonly backlogTons: number | null;
  readonly factoryCount: number | null;
  readonly capacityTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly commonProcessingCapacityTons: number | null;
  readonly factorySpaceTotalUnits: number | null;
  readonly factorySpaceUsedUnits: number | null;
  readonly factorySpaceRemainingUnits: number | null;
}

export interface PackObserved {
  /** Standard AI が観測した自社・市場の値（診断が実際に使った値）。 */
  readonly items: readonly PackTraceItem[];
}

export interface PackTraceItem {
  readonly label: string;
  readonly value?: number;
  readonly unit?: string;
  readonly text?: string;
}

export interface PackDiagnosis {
  readonly primaryConstraint: string | null;
  readonly secondaryConstraint: string | null;
  /** 生産を実際に律速した要因（確定実績の不足量の大小比較。生成AI分類ではない）。 */
  readonly commercialBottleneck: string | null;
  readonly shortfallTons: {
    readonly rawMaterial: number | null;
    readonly equipment: number | null;
    readonly labor: number | null;
  };
  readonly ratios: readonly PackTraceItem[];
  readonly reasonCodes: readonly PackReasonCode[];
}

export interface PackReasonCode {
  readonly code: string;
  readonly domain: string;
  readonly severity: string;
  readonly message: string;
  readonly keyValues?: Readonly<Record<string, number>>;
  readonly threshold?: number;
  readonly decisionSummary?: string;
}

/** 制約適用**前**に Standard AI が何をしたかったか。 */
export interface PackWanted {
  readonly items: readonly PackTraceItem[];
  readonly desiredSalesByMarketProduct: readonly {
    readonly market: DemandMarketId;
    readonly product: Product;
    /** 営業工数制約を適用する前の希望量（HOSO換算トン）。 */
    readonly desiredTonsBeforeEffortConstraint: number | null;
  }[];
}

/** 何がその希望を止めたか。商業上の律速（bottleneck）とは別概念。 */
export interface PackConstraints {
  readonly items: readonly PackTraceItem[];
  /** 行動を止めた制約（reason code 由来。無ければ空）。 */
  readonly actionConstraintCodes: readonly string[];
}

export interface PackDecision {
  readonly salesHireCount: number;
  readonly salesLayoffCount: number;
  readonly salesAllocationByMarket: readonly { readonly market: DemandMarketId | "UNALLOCATED"; readonly headcount: number }[];
  readonly salesPlanByMarketProduct: readonly {
    readonly market: DemandMarketId;
    readonly product: Product;
    readonly desiredTons: number | null;
    readonly priceAdjustmentUsdPerKg: number | null;
  }[];
  readonly productionPlanTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly domesticPurchaseDesiredTons: number | null;
  readonly importOrderCount: number;
  readonly workerRegularHeadcount: number | null;
  readonly workerTemporaryHeadcount: number | null;
  readonly financingRequestUsd: number | null;
  readonly capexProposals: readonly string[];
  readonly vapProductDevelopmentSpendUsd: number | null;
}

export interface PackExecution {
  readonly producedTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly newContractedTons: number | null;
  readonly deliveredTons: number | null;
  readonly outstandingTons: number | null;
  readonly domesticPurchasedTons: number | null;
  readonly equipmentUtilizationRate: number | null;
  readonly laborUtilizationRate: number | null;
  readonly overtimeRate: number | null;
  readonly contractedTonsByMarketProduct: readonly {
    readonly market: DemandMarketId;
    readonly product: Product;
    readonly contractedTons: number | null;
  }[];
  readonly capexEvents: readonly {
    readonly projectId: string;
    readonly projectType: string;
    readonly statusBefore: string;
    readonly statusAfter: string;
    readonly paidUsd: number | null;
    readonly reasons: readonly string[];
  }[];
  readonly capexRejectedProposals: readonly {
    readonly projectType: string;
    readonly requestedBudgetUsd: number | null;
    readonly reasons: readonly string[];
  }[];
}

export interface PackFinancialResult {
  readonly netRevenueUsd: number | null;
  readonly costOfSalesUsd: number | null;
  readonly grossProfitUsd: number | null;
  readonly grossMarginRatio: number | null;
  readonly sellingGeneralAdminUsd: number | null;
  readonly operatingProfitUsd: number | null;
  readonly operatingMarginRatio: number | null;
  readonly interestExpenseUsd: number | null;
  readonly incomeTaxUsd: number | null;
  readonly netIncomeUsd: number | null;
  readonly contributionMarginUsd: number | null;
  readonly contributionMarginRatio: number | null;
  readonly totalFixedCostUsd: number | null;
  readonly fixedManufacturingCostUsd: number | null;
  readonly fixedPersonnelCostUsd: number | null;
  readonly fixedSellingAdminCostUsd: number | null;
  readonly operatingCashFlowUsd: number | null;
  readonly investingCashFlowUsd: number | null;
  readonly financingCashFlowUsd: number | null;
  readonly borrowingCapacityUsd: number | null;
  readonly approvedLoanUsd: number | null;
  readonly deniedLoanUsd: number | null;
  readonly financialHealth: string | null;
  readonly productEconomics: readonly PackProductEconomics[];
}

export interface PackProductEconomics {
  readonly product: Product;
  readonly productionTons: number | null;
  readonly salesTons: number | null;
  readonly netRevenueUsd: number | null;
  readonly variableCostUsd: number | null;
  readonly contributionUsd: number | null;
  readonly contributionMarginRatio: number | null;
  readonly directFixedCostUsd: number | null;
}

/**
 * 【2026-08-09新設】その四半期の経営の「志」と、志に対する現在地。
 *
 * ここは AI が「なぜ建てたのか／なぜ建てなかったのか」を再構成するための中心である。
 * Vision は**外から与えられたもの**であり、Standard AI が発明した目標ではない。
 */
export interface PackStrategy {
  readonly vision: {
    readonly visionId: string;
    readonly effectiveFromTurn: number;
    readonly growthAmbition: string;
    readonly targetScaleTonsPerQuarterAtQ32: number;
    readonly preferredEndState: string;
    readonly willingnessToBuildFactories: string;
    readonly financialRiskTolerance: string;
    readonly desiredProductEvolution: string;
    /** 人間向けの説明。数値判断には一切使われていない。 */
    readonly longTermNarrative: string;
    /** 参考成長軌道（REFERENCE PATH。達成義務ではない）。 */
    readonly referenceGrowthPath: readonly { readonly turn: number; readonly scaleTonsPerQuarter: number }[];
  } | null;
  readonly visionTargetScaleAtCurrentTurn: number | null;
  readonly currentSustainableScaleTons: number | null;
  readonly strategicScaleGapTons: number | null;
  readonly strategicScaleGapRatio: number | null;
  /** LOW / MODERATE / HIGH / URGENT。 */
  readonly growthPressure: string | null;
  /** 新工場の検討結果。**提案しなかった四半期も必ず記録される。** */
  readonly newFactory: {
    readonly status: string;
    readonly reasonCodes: readonly string[];
    readonly gates: readonly {
      readonly gate: string;
      readonly passed: boolean;
      readonly note: string;
      readonly keyValues: Readonly<Record<string, number>>;
    }[];
    readonly projectCostUsd: number;
    readonly firstPaymentUsd: number;
    /**
     * 【Strategic Posture・Phase E】この判断がどちらの経路を通ったか。
     * NONE ＝ 提案しなかった（reactiveも strategic も READY_TO_BUILD に届かなかった）。
     */
    readonly decisionRoute: "REACTIVE" | "STRATEGIC_FORWARD_CAPACITY" | "NONE" | null;
    readonly strategicPosture: string | null;
    /** Forward Capacity Gap（新工場完成予定ターン時点の能力不足見込み）。AGGRESSIVE_EARLY_CAPACITY以外では null。 */
    readonly forwardCapacityGap: {
      readonly constructionLeadTimeQuarters: number;
      readonly forecastCompletionTurn: number;
      readonly visionReferenceScaleAtCompletion: number;
      readonly observedGrowthRatioPerQuarter: number;
      readonly trendAdjustedScaleAtCompletion: number;
      readonly projectedCommercialScaleAtCompletion: number;
      readonly projectedRequiredProductionAtCompletion: number;
      readonly existingCapacityAtCompletion: number;
      readonly forwardCapacityGapTons: number;
      readonly forwardCapacityGapRatio: number;
    } | null;
    readonly marketGrowthEvidence: {
      readonly recentOwnContractGrowthRatio: number | null;
      readonly observedMarketGrowthRatio: number | null;
    } | null;
    readonly existingExpansionAlternativeSufficientTons: number | null;
    readonly postConstructionActivationFeasible: boolean | null;
  } | null;
  readonly availability: PackAvailability;
}

/**
 * 【Phase 6C・#05 §14〜§16】商業成長の因果1本ぶん（1社・1四半期）。
 *
 * 「売りたい量」「市場へ取りに行った量」「実際に売れた量」「作る量」を
 * **別々のフィールド**として保存する。AIも人間もこれらを混同しないことが目的であり、
 * 1つの "sales" にまとめてはならない（Data Dictionary 参照）。
 *
 * ここに新しい計算は無い。Standard AI とエンジンが既に確定させた値の写しである。
 */
export interface PackCommercialGrowth {
  /** Vision の参考成長軌道におけるその四半期の規模（達成義務ではない）。 */
  readonly visionReferenceScaleTons: number | null;
  /** 志として、どこまで売りたいか。 */
  readonly commercialAmbitionTons: number | null;
  /** 今期、実際に市場へ取りに行くと決めた量（提出量の上限）。 */
  readonly commercialCommitmentTons: number | null;
  /** 実際に市場へ提出した販売計画の合計。 */
  readonly submittedSalesTons: number;
  /** 市場が実際に応じた量（新規成約）。 */
  readonly contractedSalesTons: number;
  /** 当期に実際に納品した量。 */
  readonly deliveredSalesTons: number;
  /** 生産必要量（確定受注残＋未成約計画×期待成約率＋在庫目標−期首在庫）。 */
  readonly productionRequirementTons: number | null;
  /** 実際の生産量。 */
  readonly actualProductionTons: number;
  /** 観測できる採算つき獲得可能需要。 */
  readonly profitableOpportunityTons: number | null;
  /** そのうち取れなかった量。 */
  readonly unservedProfitableOpportunityTons: number | null;
  /** 成長を止めている主因（SALES_CAPACITY / PRODUCTION_CAPACITY / LABOR / RAW_MATERIAL / INVENTORY_POLICY / OTHER / NONE）。 */
  readonly primaryGrowthConstraint: string | null;
  /** 制約別の未充足量の内訳（同じトン数を二重に数えない分解）。 */
  readonly constraintBreakdownTons: Readonly<Record<string, number>>;
  /** 【§16】転換率。TRUE WORLD ではなく、自社の観測にもとづく値である。 */
  readonly observedConversionRatio: number | null;
  readonly submissionTargetConversionRatio: number | null;
  readonly productionExpectedConversionRatio: number | null;
  readonly submissionToContractRatio: number | null;
  readonly contractToDeliveryRatio: number | null;
  /** 提出量を実際に縛った要因。 */
  readonly commitmentLimiter: string | null;
  readonly availability: PackAvailability;
}

/**
 * 【Phase 6C・#05 §15】営業組織の状態（1社・1四半期）。
 *
 * 「人が足りない」と「増やしたくない」を区別できるように、必要人数・経済的に
 * 欲しい人数・組織上許される人数・資金上許される人数を別々に保存する。
 */
export interface PackSalesOrganization {
  readonly currentHeadcount: number;
  readonly requiredHeadcount: number | null;
  readonly unconstrainedEconomicDesiredHeadcount: number | null;
  readonly organizationallyAllowedHeadcount: number | null;
  readonly financiallyAllowedHeadcount: number | null;
  readonly actualTargetHeadcount: number | null;
  readonly actualHireCount: number;
  readonly actualLayoffCount: number;
  readonly salesCapacityTons: number | null;
  readonly usedSalesCapacityTons: number | null;
  readonly unusedSalesCapacityTons: number | null;
  readonly utilization: number | null;
  /** 採用0だった場合の理由コード（0でなければ null）。 */
  readonly constraintReason: string | null;
  readonly availability: PackAvailability;
}

export interface PackCompanyTurn {
  readonly turn: number;
  readonly beginningState: PackCompanyStateSnapshot;
  readonly observed: PackObserved;
  readonly diagnosis: PackDiagnosis;
  readonly wanted: PackWanted;
  readonly constraints: PackConstraints;
  readonly decision: PackDecision;
  readonly execution: PackExecution;
  readonly financialResult: PackFinancialResult;
  readonly endingState: PackCompanyStateSnapshot;
  /** 期末時点の進行中・完成済み設備投資案件。 */
  readonly capitalProjects: readonly PackCapitalProject[];
  /** その四半期の Vision・戦略ギャップ・新工場判断。 */
  readonly strategy: PackStrategy;
  /** 【Phase 6C】Vision → Ambition → Commitment → Contracts → Production の因果。 */
  readonly commercialGrowth: PackCommercialGrowth;
  /** 【Phase 6C】営業組織（人が足りないのか、増やしたくないのか）。 */
  readonly salesOrganization: PackSalesOrganization;
  /**
   * 【Phase 7・Manual Override】この四半期の意思決定が実際に誰由来だったか
   * （STANDARD_AI or PLAYER）。Phase 7 より前に保存された Simulation Run には
   * この記録が無いため、その場合は STANDARD_AI として扱う（当時は全社AIだったため）。
   */
  readonly decisionOwner: "STANDARD_AI" | "PLAYER";
}

export interface PackCapitalProject {
  readonly projectId: string;
  readonly projectType: string;
  readonly status: string;
  readonly approvedBudgetUsd: number | null;
  readonly cumulativePaidUsd: number | null;
  readonly requiredConstructionQuarters: number | null;
  readonly elapsedConstructionQuartersWithPayment: number | null;
  readonly completedYear: number | null;
  readonly completedQuarter: number | null;
}

// ---------------------------------------------------------------------
// 3. Pack 全体
// ---------------------------------------------------------------------

export interface PackRunMetadata {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly gameParameterVersion: string;
  readonly standardAiVersion: string;
  readonly strategyProfileVersion: string;
  readonly startingTurn: number;
  readonly completedTurns: number;
  readonly requestedTurns: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly stopReason: string;
  /**
   * 【途中実行の明示】completedTurns < requestedTurns なら true。
   * 途中実行の Pack も出力できるが、**8年ぶんの結論として読まれてはならない**ため、
   * JSON・Markdown・Excel のいずれからも一目で分かるようにする。
   */
  readonly isPartialRun: boolean;
  /** 例: "PARTIAL RUN — 17 / 32 quarters"。完走時は "COMPLETE RUN — 32 / 32 quarters"。 */
  readonly runCompletenessLabel: string;
  readonly exportedAt: string;
  /** 判明しない場合は "UNKNOWN"（捏造しない）。 */
  readonly sourceBranch: string;
  readonly sourceCommit: string;
}

export interface PackCompanySummary {
  readonly companyId: string;
  readonly displayName: string;
  readonly archetype: string | null;
  readonly startingRevenueUsd: number | null;
  readonly endingRevenueUsd: number | null;
  readonly cumulativeRevenueUsd: number | null;
  readonly startingOperatingProfitUsd: number | null;
  readonly endingOperatingProfitUsd: number | null;
  readonly cumulativeOperatingProfitUsd: number | null;
  readonly cumulativeNetIncomeUsd: number | null;
  readonly startingCashUsd: number | null;
  readonly endingCashUsd: number | null;
  readonly startingDebtUsd: number | null;
  readonly endingDebtUsd: number | null;
  readonly startingEquityUsd: number | null;
  readonly endingEquityUsd: number | null;
  readonly startingSalesHeadcount: number | null;
  readonly endingSalesHeadcount: number | null;
  readonly startingCapacityTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly endingCapacityTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly majorInvestments: readonly { readonly turn: number; readonly projectType: string; readonly event: string }[];
  readonly finalPrimaryBottleneck: string | null;
  readonly operatingProfitNegativeQuarters: number;
}

/** 前ターンとの差分から決定論的に作る変化ログ（生成AIによる要約ではない）。 */
export interface PackMajorChange {
  readonly turn: number;
  /** 会社ID、または世界全体を表す "WORLD"。 */
  readonly scope: string;
  readonly metric: string;
  readonly from: string;
  readonly to: string;
  readonly changeType: "INCREASE" | "DECREASE" | "TRANSITION" | "EVENT";
}

export interface PackDataAvailabilityNote {
  readonly field: string;
  readonly availability: PackAvailability;
  readonly reason: string;
}

/**
 * 【Phase 7・Manual Override受入】このRun全体で、誰がどれだけの四半期を決めたか。
 * companies[].turns[].decisionOwner を1回だけ集計した値であり、
 * ここに新しい計算・推測は無い（会社×ターンの実測を数えるだけ）。
 */
export interface PackDecisionOwnership {
  readonly standardAiTurnCount: number;
  readonly playerTurnCount: number;
  /** 1回でもPLAYERとして意思決定した会社のcompanyId一覧（登場順）。 */
  readonly playerCompanyIds: readonly string[];
}

export interface AiAnalysisPackContext {
  readonly schemaVersion: string;
  readonly readingGuide: readonly string[];
  readonly run: PackRunMetadata;
  readonly companySummaries: readonly PackCompanySummary[];
  readonly world: { readonly turns: readonly PackWorldTurn[] };
  readonly companies: Readonly<Record<string, { readonly companyId: string; readonly displayName: string; readonly turns: readonly PackCompanyTurn[] }>>;
  /** 【Phase 7・Manual Override受入】このRun全体の意思決定者集計。 */
  readonly decisionOwnership: PackDecisionOwnership;
  readonly majorChanges: readonly PackMajorChange[];
  /**
   * Standard AI が提案しうる設備投資の種類（コード上の事実）。
   * ここに無い種類は、この Standard AI では**構造的に提案されない**。
   */
  readonly standardAiProposableCapexTypes: readonly string[];
  /** ゲームエンジンに存在する設備投資の種類（全体）。 */
  readonly gameCapexTypes: readonly string[];
  readonly dataAvailability: readonly PackDataAvailabilityNote[];
  readonly sourceMap: Readonly<Record<string, PackSourceType>>;
}
