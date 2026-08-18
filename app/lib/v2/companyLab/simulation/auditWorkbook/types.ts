// ShrimpX V2 — Standard AI 32Q Audit Workbook: 行の型定義
//
// 【このモジュールの唯一の役割】保存済み Simulation Run（StoredSimulationRun）から、
// Excelの1シート＝1行1事実の long-format 行を **転記** する。
//
// 【絶対に守る規約（実装指示§2・§40）】
//  1. ゲームの計算をやり直さない。Engine / stored run data / Standard AI diagnostics /
//     financial results が既に確定させた値を取り出すだけ。
//  2. 取得できない値は null のままにする（0 で埋めない・推測値を作らない）。
//     Excel側では null を空セルとして書き、0 と構造的に区別する（実装指示§29）。
//  3. Standard AI の提案値（decision input）と、Engineが実際に確定させた実績値を
//     別フィールドとして保持する（実装指示§9）。
//  4. 一つの値に数字と単位文字列を混ぜない（実装指示§26）。単位はフィールド名の
//     接尾辞とData Dictionaryで表す。

import { DemandMarketId, Product } from "../../../market/types";

/** 数値が取得できたときだけ数値を返す（NaN/Infinityは「取得できなかった」と同じ扱い）。 */
export function finiteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** branded unit（HosoEqTons/Usd/Ratio等）はランタイムでは number。単位を剥がして数値化する。 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return finiteOrNull(value);
}

export type AuditCellValue = string | number | null;

/** 契約の納期状態（実装指示§18。backlog = overdue という解釈を構造的に禁じるための区分）。 */
export type BacklogDueStatus = "OVERDUE" | "DUE_THIS_TURN" | "FUTURE_DUE";

/** 意思決定の領域（実装指示§8）。 */
export type AuditDecisionDomain =
  | "SALES"
  | "PRODUCTION"
  | "PROCUREMENT"
  | "WORKFORCE"
  | "FINANCE"
  | "CAPEX"
  | "DIVIDEND"
  | "VAP_PRODUCT_DEVELOPMENT";

export interface AuditRunSummaryRow {
  readonly field: string;
  readonly value: AuditCellValue;
}

export interface AuditCompanyProfileRow {
  readonly companyId: string;
  readonly displayName: string;
  readonly archetype: string;
  readonly country: string;
  readonly managementProfileId: string | null;
  readonly orientationProfileId: string | null;
  readonly decisionOwner: string | null;
  readonly visionId: string | null;
  readonly visionGrowthAmbition: string | null;
  readonly visionTargetScaleTonsPerQuarterAtQ32: number | null;
  readonly visionStrategicPosture: string | null;
  readonly visionSource: string | null;
  readonly standardAiProfileMode: string | null;
}

export interface AuditCompanySummaryRow {
  readonly companyId: string;
  readonly displayName: string;
  readonly asOfTurn: number;
  readonly cumulativeRevenueUsd: number | null;
  readonly cumulativeOperatingProfitUsd: number | null;
  readonly averageOperatingMarginRatio: number | null;
  readonly cumulativeSalesVolumeHosoEqTons: number | null;
  readonly endingCashUsd: number | null;
  readonly endingDebtUsd: number | null;
  readonly endingEquityUsd: number | null;
  readonly distressTurnCount: number | null;
  readonly cumulativeDividendUsd: number | null;
  readonly revenueGrowthRatio: number | null;
  readonly profitGrowthRatio: number | null;
  readonly currentCompanyValueUsd: number | null;
  readonly currentDividendValueUsd: number | null;
  readonly totalShareholderValueUsd: number | null;
  readonly factoryCount: number | null;
  readonly finalRegularWorkers: number | null;
  readonly finalSalesForceHeadcount: number | null;
  readonly finalBacklogHosoEqTons: number | null;
  readonly finalOverdueHosoEqTons: number | null;
  readonly visionId: string | null;
  readonly visionStrategicPosture: string | null;
  readonly managementProfileId: string | null;
}

export interface AuditTurnKpiRow {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly decisionOwner: string | null;

  readonly revenueUsd: number | null;
  readonly grossProfitUsd: number | null;
  readonly operatingProfitUsd: number | null;
  readonly operatingMarginRatio: number | null;
  readonly netIncomeUsd: number | null;

  readonly cashUsd: number | null;
  readonly accountsReceivableUsd: number | null;
  readonly accountsPayableUsd: number | null;
  readonly shortTermDebtUsd: number | null;
  readonly longTermDebtUsd: number | null;
  readonly interestBearingDebtUsd: number | null;
  readonly totalLiabilitiesUsd: number | null;
  readonly equityUsd: number | null;

  readonly deliveredVolumeHosoEqTons: number | null;
  readonly newOrdersHosoEqTons: number | null;
  readonly totalBacklogHosoEqTons: number | null;
  readonly overdueBacklogHosoEqTons: number | null;
  readonly healthyForwardBacklogHosoEqTons: number | null;

  readonly productionVolumeHosoEqTons: number | null;
  readonly hosoProducedHosoEqTons: number | null;
  readonly pdProducedHosoEqTons: number | null;
  readonly vapProducedHosoEqTons: number | null;
  readonly finishedGoodsInventoryHosoEqTons: number | null;
  readonly rawMaterialInventoryHosoEqTons: number | null;

  readonly rawMaterialShortageHosoEqTons: number | null;
  readonly equipmentShortageHosoEqTons: number | null;
  readonly laborShortageHosoEqTons: number | null;

  readonly equipmentUtilizationRatio: number | null;
  readonly laborUtilizationRatio: number | null;
  readonly overtimeRatio: number | null;

  readonly regularWorkersHeadcount: number | null;
  readonly temporaryWorkersHeadcount: number | null;
  readonly salesForceHeadcount: number | null;

  readonly averageCustomerTrustScore: number | null;
  readonly averageQualityScore: number | null;
  readonly onTimeDeliveryRatePercent: number | null;

  readonly financialHealthPrimary: string | null;
  readonly dividendPaidUsd: number | null;

  readonly companyValueUsd: number | null;
  readonly dividendValueUsd: number | null;
  readonly totalShareholderValueUsd: number | null;
}

export interface AuditDecisionRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly decisionOwner: string | null;
  readonly decisionDomain: AuditDecisionDomain;
  readonly decisionType: string;
  readonly market: DemandMarketId | "" ;
  readonly product: Product | "";
  readonly factoryId: string;
  readonly proposedValue: number | null;
  readonly proposedUnit: string;
  readonly actualAppliedValue: number | null;
  readonly actualAppliedUnit: string;
  readonly wasApplied: string;
  readonly wasModified: string;
  readonly reasonCode: string;
  readonly primaryReason: string;
  readonly profileInfluence: string;
  readonly visionInfluence: string;
  readonly crisisInfluence: string;
}

export interface AuditDiagnosticRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly source: string;
  readonly stage: string;
  readonly domain: string;
  readonly reasonCode: string;
  readonly severity: string;
  readonly label: string;
  readonly observedValue: number | null;
  readonly unit: string;
  readonly message: string;
}

export interface AuditSalesRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly desiredSalesBeforeEffortHosoEqTons: number | null;
  readonly proposedSalesHosoEqTons: number | null;
  readonly actualContractsHosoEqTons: number | null;
  readonly offeredPriceAdjustmentUsdPerKg: number | null;
  readonly realizedPriceUsdPerKg: number | null;
  readonly marketBasePriceUsdPerKg: number | null;
  readonly targetDemandHosoEqTons: number | null;
  readonly salesForceAllocationHeadcount: number | null;
  readonly customerTrustScore: number | null;
  readonly qualityScore: number | null;
  readonly newContractCount: number | null;
}

export interface AuditProductionRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly factoryId: string;
  readonly product: Product;
  readonly productionPriority: number | null;
  readonly plannedProductionHosoEqTons: number | null;
  readonly actualProductionHosoEqTons: number | null;
  readonly shortfallHosoEqTons: number | null;
  readonly shortfallReasons: string;
  readonly requiredRawMaterialHosoEqTons: number | null;
  readonly rawMaterialLimitedHosoEqTons: number | null;
  readonly commonCapacityLimitedHosoEqTons: number | null;
  readonly freezingPackagingLimitedHosoEqTons: number | null;
  readonly productCapacityLimitedHosoEqTons: number | null;
  readonly laborLimitedHosoEqTons: number | null;
  readonly assignedRegularHeadcount: number | null;
  readonly assignedTemporaryHeadcount: number | null;
  readonly appliedOvertimeRatio: number | null;
}

export interface AuditProcurementRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly source: "DOMESTIC" | "IMPORT" | "AQUACULTURE";
  readonly originCountry: string;
  readonly plannedHosoEqTons: number | null;
  readonly actualHosoEqTons: number | null;
  readonly priceUsdPerKg: number | null;
  readonly marketPriceUsdPerKg: number | null;
  readonly arrivalPeriod: string;
  readonly inTransitHosoEqTons: number | null;
  readonly rawMaterialEndingInventoryHosoEqTons: number | null;
  readonly coverageScore: number | null;
  readonly competitivenessWeight: number | null;
}

export interface AuditWorkforceRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly factoryId: string;
  readonly regularWorkersHeadcount: number | null;
  readonly temporaryWorkersHeadcount: number | null;
  readonly overtimeRatio: number | null;
  readonly attendanceRatio: number | null;
  readonly equipmentUtilizationRatio: number | null;
  readonly laborUtilizationRatio: number | null;
  readonly temporaryWorkerShareRatio: number | null;
  readonly productionShortfallRatio: number | null;
  readonly companyLaborCostUsd: number | null;
  readonly companyIdleLaborCostUsd: number | null;
  readonly companySalesForceHireCount: number | null;
  readonly companySalesForceLayoffCount: number | null;
}

export interface AuditCapexRow {
  readonly companyId: string;
  readonly projectId: string;
  readonly projectType: string;
  readonly targetFactoryId: string;
  readonly status: string;
  readonly firstSeenTurn: number | null;
  readonly proposalTurn: number | null;
  readonly approvalTurn: number | null;
  readonly constructionStartTurn: number | null;
  readonly completionTurn: number | null;
  readonly approvedBudgetUsd: number | null;
  readonly cumulativePaidUsd: number | null;
  readonly requiredConstructionQuarters: number | null;
  readonly elapsedConstructionQuartersWithPayment: number | null;
  readonly completedYear: number | null;
  readonly completedQuarter: number | null;
  readonly standardAiReasonCodes: string;
}

export interface AuditFinanceRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly grossRevenueUsd: number | null;
  readonly netRevenueUsd: number | null;
  readonly rawMaterialCostUsd: number | null;
  readonly processingCostUsd: number | null;
  readonly laborCostUsd: number | null;
  readonly factoryFixedCostUsd: number | null;
  readonly idleLaborCostUsd: number | null;
  readonly unabsorbedFixedManufacturingCostUsd: number | null;
  readonly reworkCostUsd: number | null;
  readonly discardLossUsd: number | null;
  readonly totalCostOfSalesUsd: number | null;
  readonly grossProfitUsd: number | null;
  readonly sellingGeneralAdminUsd: number | null;
  readonly operatingProfitUsd: number | null;
  readonly interestExpenseUsd: number | null;
  readonly profitBeforeTaxUsd: number | null;
  readonly incomeTaxUsd: number | null;
  readonly netIncomeUsd: number | null;
  readonly cashUsd: number | null;
  readonly accountsReceivableUsd: number | null;
  readonly rawMaterialInventoryUsd: number | null;
  readonly finishedGoodsInventoryUsd: number | null;
  readonly fixedAssetsNetUsd: number | null;
  readonly constructionInProgressUsd: number | null;
  readonly totalAssetsUsd: number | null;
  readonly accountsPayableUsd: number | null;
  readonly shortTermLoansUsd: number | null;
  readonly longTermLoansUsd: number | null;
  readonly totalLiabilitiesUsd: number | null;
  readonly equityUsd: number | null;
  readonly operatingCashFlowUsd: number | null;
  readonly investingCashFlowUsd: number | null;
  readonly financingCashFlowUsd: number | null;
  readonly netCashChangeUsd: number | null;
  readonly financialHealthPrimary: string | null;
  readonly creditScore: number | null;
}

export interface AuditBacklogRow {
  readonly companyId: string;
  readonly asOfTurn: number;
  readonly asOfPeriod: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueStatus: BacklogDueStatus;
  readonly outstandingHosoEqTons: number | null;
  readonly contractCount: number;
  readonly earliestDuePeriod: string;
  readonly latestDuePeriod: string;
  readonly averageUnitPriceUsdPerKg: number | null;
}

export interface AuditMarketRow {
  readonly turn: number;
  readonly period: string;
  readonly scope: string;
  readonly key: string;
  readonly product: string;
  readonly priceUsdPerKg: number | null;
  readonly priorPriceUsdPerKg: number | null;
  readonly priceChangeRatio: number | null;
  readonly demandHosoEqTons: number | null;
  readonly supplyHosoEqTons: number | null;
  readonly utilizationRatio: number | null;
  readonly shockApplied: number | null;
  readonly localPressure: number | null;
  readonly worldPressure: number | null;
  readonly consumerEndingInventoryHosoEqTons: number | null;
  readonly consumerInventoryCoverageMonths: number | null;
  readonly marketPhase: string;
}

export interface AuditDividendRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly isAnnualEvaluationPeriod: string;
  readonly financialHealthPrimary: string | null;
  readonly newCapexProposalCount: number | null;
  readonly netIncomeSourcePeriod: string;
  readonly netIncomeUsd: number | null;
  readonly distributableEarningsAfterUsd: number | null;
  readonly basePayoutRatio: number | null;
  readonly profileBiasRatio: number | null;
  readonly effectivePayoutRatio: number | null;
  readonly maxDividendUsd: number | null;
  readonly requestedDividendUsd: number | null;
  readonly appliedDividendUsd: number | null;
  readonly rejected: string;
  readonly rejectionReason: string;
  readonly cumulativeDividendUsd: number | null;
  readonly diagnosticReasonCodes: string;
}

export interface AuditFactoryCapacityRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly factoryId: string;
  readonly factoryStatus: string;
  readonly factorySource: string;
  readonly commonProcessingCapacityHosoEqTons: number | null;
  readonly freezingPackagingCapacityHosoEqTons: number | null;
  readonly hosoCapacityHosoEqTons: number | null;
  readonly pdCapacityHosoEqTons: number | null;
  readonly vapCapacityHosoEqTons: number | null;
  readonly equipmentUtilizationRatio: number | null;
  readonly laborUtilizationRatio: number | null;
  readonly companyEffectiveHosoCapacityHosoEqTons: number | null;
  readonly companyEffectivePdCapacityHosoEqTons: number | null;
  readonly companyEffectiveVapCapacityHosoEqTons: number | null;
  readonly companyEffectiveCommonCapacityHosoEqTons: number | null;
}

export interface AuditFinalResultRow {
  readonly rank: number | null;
  readonly companyId: string;
  readonly displayName: string;
  readonly asOfTurn: number;
  readonly totalShareholderValueUsd: number | null;
  readonly currentCompanyValueUsd: number | null;
  readonly currentDividendValueUsd: number | null;
  readonly enterpriseValueUsd: number | null;
  readonly normalizedQuarterlyCashFlowUsd: number | null;
  readonly cashUsd: number | null;
  readonly debtUsd: number | null;
  readonly cumulativeRevenueUsd: number | null;
  readonly cumulativeOperatingProfitUsd: number | null;
  readonly cumulativeSalesVolumeHosoEqTons: number | null;
  readonly averageOperatingMarginRatio: number | null;
  readonly revenueGrowthRatio: number | null;
  readonly profitGrowthRatio: number | null;
  readonly distressTurnCount: number | null;
  readonly cumulativeDividendUsd: number | null;
  readonly shareholderValueModelVersion: string;
  readonly finalSnapshotSource: string;
}

export interface AuditEventRow {
  readonly turn: number;
  readonly period: string;
  readonly companyId: string;
  readonly eventCategory: string;
  readonly eventCode: string;
  readonly detail: string;
  readonly valueUsd: number | null;
}

export interface AuditProfileVisionRow {
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly managementProfileId: string | null;
  readonly orientationProfileId: string | null;
  readonly visionId: string | null;
  readonly visionSource: string | null;
  readonly visionStrategicPosture: string | null;
  readonly visionTargetScaleAtCurrentTurnTons: number | null;
  readonly currentSustainableScaleTons: number | null;
  readonly strategicScaleGapTons: number | null;
  readonly strategicScaleGapRatio: number | null;
  readonly growthPressure: string | null;
  readonly newFactoryStatus: string | null;
  readonly newFactoryReasonCodes: string;
  readonly commercialAmbitionTons: number | null;
  readonly commercialCommitmentTons: number | null;
  readonly submittedSalesTons: number | null;
  readonly contractedSalesTons: number | null;
  readonly deliveredSalesTons: number | null;
  readonly primaryGrowthConstraint: string | null;
  readonly commitmentLimiter: string | null;
  readonly salesForceCurrentHeadcount: number | null;
  readonly salesForceRequiredHeadcount: number | null;
  readonly salesForceConstraintReason: string | null;
}

/** Workbook 1冊ぶんの全行（Excel書き出しはこの構造だけを読む）。 */
export interface StandardAiAuditWorkbookData {
  readonly meta: {
    readonly simulationRunId: string;
    readonly scenarioId: string;
    readonly seed: string;
    readonly status: "COMPLETE" | "PARTIAL";
    readonly asOfTurn: number;
    readonly requestedTurns: number;
    readonly completedTurns: number;
    readonly gameEndTurn: number | null;
    readonly generatedAt: string;
    readonly companyIds: readonly string[];
    /** 取得できなかったデータの理由（READMEへそのまま書く。実装指示§29・§35）。 */
    readonly missingDataNotes: readonly string[];
  };
  readonly runSummary: readonly AuditRunSummaryRow[];
  readonly companyProfiles: readonly AuditCompanyProfileRow[];
  readonly companySummary: readonly AuditCompanySummaryRow[];
  readonly turnKpi: readonly AuditTurnKpiRow[];
  readonly decisions: readonly AuditDecisionRow[];
  readonly diagnostics: readonly AuditDiagnosticRow[];
  readonly sales: readonly AuditSalesRow[];
  readonly production: readonly AuditProductionRow[];
  readonly procurement: readonly AuditProcurementRow[];
  readonly workforce: readonly AuditWorkforceRow[];
  readonly capex: readonly AuditCapexRow[];
  readonly finance: readonly AuditFinanceRow[];
  readonly backlog: readonly AuditBacklogRow[];
  readonly market: readonly AuditMarketRow[];
  readonly dividend: readonly AuditDividendRow[];
  readonly factoryCapacity: readonly AuditFactoryCapacityRow[];
  readonly finalResults: readonly AuditFinalResultRow[];
  readonly events: readonly AuditEventRow[];
  readonly profileVision: readonly AuditProfileVisionRow[];
}
