// ShrimpX V2 — 読み取り専用エクスポートAPI（/api/v2/exports/**） 出力DTO
//
// 【設計方針】内部の永続化型（CompanyFinancialQuarterResult・FinancingQuarterResult・
// CapexQuarterResult・CompanyQuarterSummary・MarketQuarterResult・
// CompanyLabQuarterHistoryEntry等）を、そのままJSON化して返さない。
// 将来これらの内部型へフィールドが追加されても、このファイルのbuilder関数を
// 変更しない限り、追加分は自動的にはAPIレスポンスへ出てこない
// （三宅さんの指示：「許可した項目だけを明示的に組み立て、内部型への項目追加が
// 自動露出しないようにする」）。
//
// 【intentionally NOT included in v1 scope（保存データには存在するが今回は出力しない）】
//   - CompanyFinancialQuarterResult.manufacturingCost（ManufacturingCostBreakdown）
//   - CompanyFinancialQuarterResult.qualityLoss（QualityLossBreakdown）
//   - CompanyFinancialQuarterResult.costRecords（readonly CostRecord[]）
//   - CompanyFinancialQuarterResult.contributionMargin（ContributionMarginReport）
//   - CompanyFinancialQuarterResult.absorptionVariableReconciliation
//   - CompanyLabQuarterHistoryEntry.preProcessingStateSnapshot / postProcessingStateSnapshot
//     （ランタイム内部スナップショット。財務・資金・設備投資の確定結果は
//     record側から個別に抽出するため、スナップショット自体を丸ごと出す必要がない）
//   - CompanyLabQuarterHistoryEntry.otherCompaniesDecisions（他社の非公開意思決定。
//     会社スコープAPIにも全社スコープAPIにも一切含めない＝設計上の理由で永久に対象外）
//   - CompanyLabQuarterHistoryEntry.aiProposal / diffFromAiProposal（AI提案案との差分。
//     今回のスコープ外）
// これらは完了報告の「保存データに存在するが出力できなかった項目」としてそのまま列挙する。

import {
  BalanceSheet,
  CashFlowStatement,
  CompanyFinancialQuarterResult,
  ProfitAndLossStatement,
} from "../../../../lib/v2/finance/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CapexQuarterResult } from "../../../../lib/v2/capex";
import { CompanyQuarterSummary } from "../../../../lib/v2/companyLab/types";
import { MarketQuarterResult } from "../../../../lib/v2/market/types";
import { CompanyLabQuarterHistoryEntry, CompanyLabPersistedStateV1 } from "../../../../lib/v2/companyLab/persistence/types";
import { CompanyId } from "../../../../lib/v2/sales/types";
import { PeriodV2 } from "../../../../lib/v2/core/period";
import {
  extractCompanyCapexResult,
  extractCompanyFinancialResult,
  extractCompanyFinancingResult,
} from "../../../../v2/company-lab/play/_lib/financialViewSelectors";

/** 現在サポートしているExport DTOのスキーマバージョン。破壊的変更時のみ増分する。 */
export const EXPORT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------
// 1. 共通メタ情報・スコープ
// ---------------------------------------------------------------------

export type ExportScope = { readonly kind: "company"; readonly companyId: CompanyId } | { readonly kind: "allCompanies" };

export interface ExportMeta {
  readonly schemaVersion: number;
  /** レスポンス生成時刻（ISO8601）。同一データの複数回取得でもこの値だけは毎回変わる。 */
  readonly generatedAt: string;
  readonly labId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly engineVersion: string;
  /** このAPIは常に確定済み（processedAt以降・不変）の永続化データのみを返す。未確定データは扱わない。 */
  readonly dataStatus: "confirmed";
  readonly scope: ExportScope;
}

export interface BuildExportMetaInput {
  readonly labId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly engineVersion: string;
  readonly scope: ExportScope;
  readonly generatedAt: string;
}

export function buildExportMeta(input: BuildExportMetaInput): ExportMeta {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    labId: input.labId,
    turn: input.turn,
    period: input.period,
    engineVersion: input.engineVersion,
    dataStatus: "confirmed",
    scope: input.scope,
  };
}

// ---------------------------------------------------------------------
// 2. PL / BS / CF
// ---------------------------------------------------------------------

export interface ExportProfitAndLoss {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly grossRevenue: number;
  readonly qualitySalesDeduction: number;
  readonly netRevenue: number;
  readonly costOfSales: {
    readonly rawMaterialCost: number;
    readonly processingCost: number;
    readonly laborCost: number;
    readonly factoryFixedCost: number;
    readonly reworkCost: number;
    readonly discardLoss: number;
    readonly unabsorbedFixedManufacturingCost: number;
    readonly idleLaborCost: number;
    readonly capexMaintenanceCost: number;
  };
  readonly totalCostOfSales: number;
  readonly grossProfit: number;
  readonly sellingGeneralAdmin: number;
  readonly operatingProfit: number;
  readonly interestExpense: number;
  readonly profitBeforeTax: number;
  readonly incomeTax: number;
  readonly netIncome: number;
}

export function buildExportProfitAndLoss(pl: ProfitAndLossStatement): ExportProfitAndLoss {
  return {
    companyId: pl.companyId,
    period: pl.period,
    grossRevenue: pl.grossRevenue,
    qualitySalesDeduction: pl.qualitySalesDeduction,
    netRevenue: pl.netRevenue,
    costOfSales: {
      rawMaterialCost: pl.costOfSales.rawMaterialCost,
      processingCost: pl.costOfSales.processingCost,
      laborCost: pl.costOfSales.laborCost,
      factoryFixedCost: pl.costOfSales.factoryFixedCost,
      reworkCost: pl.costOfSales.reworkCost,
      discardLoss: pl.costOfSales.discardLoss,
      unabsorbedFixedManufacturingCost: pl.costOfSales.unabsorbedFixedManufacturingCost,
      idleLaborCost: pl.costOfSales.idleLaborCost,
      capexMaintenanceCost: pl.costOfSales.capexMaintenanceCost,
    },
    totalCostOfSales: pl.totalCostOfSales,
    grossProfit: pl.grossProfit,
    sellingGeneralAdmin: pl.sellingGeneralAdmin,
    operatingProfit: pl.operatingProfit,
    interestExpense: pl.interestExpense,
    profitBeforeTax: pl.profitBeforeTax,
    incomeTax: pl.incomeTax,
    netIncome: pl.netIncome,
  };
}

export interface ExportBalanceSheet {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly cash: number;
  readonly accountsReceivable: number;
  readonly rawMaterialInventory: number;
  readonly finishedGoodsInventory: number;
  readonly otherCurrentAssets: number;
  readonly fixedAssetsNet: number;
  readonly constructionInProgress: number;
  readonly totalAssets: number;
  readonly accountsPayable: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly accruedInterestPayable: number;
  readonly otherLiabilities: number;
  readonly totalLiabilities: number;
  readonly capitalStock: number;
  readonly retainedEarnings: number;
  readonly totalEquity: number;
  readonly totalLiabilitiesAndEquity: number;
  /** 貸借差額（0近傍であること。整合性チェックはこの値を使う）。 */
  readonly balanceDifference: number;
}

export function buildExportBalanceSheet(bs: BalanceSheet): ExportBalanceSheet {
  return {
    companyId: bs.companyId,
    period: bs.period,
    cash: bs.cash,
    accountsReceivable: bs.accountsReceivable,
    rawMaterialInventory: bs.rawMaterialInventory,
    finishedGoodsInventory: bs.finishedGoodsInventory,
    otherCurrentAssets: bs.otherCurrentAssets,
    fixedAssetsNet: bs.fixedAssetsNet,
    constructionInProgress: bs.constructionInProgress,
    totalAssets: bs.totalAssets,
    accountsPayable: bs.accountsPayable,
    shortTermLoans: bs.shortTermLoans,
    longTermLoans: bs.longTermLoans,
    accruedInterestPayable: bs.accruedInterestPayable,
    otherLiabilities: bs.otherLiabilities,
    totalLiabilities: bs.totalLiabilities,
    capitalStock: bs.capitalStock,
    retainedEarnings: bs.retainedEarnings,
    totalEquity: bs.totalEquity,
    totalLiabilitiesAndEquity: bs.totalLiabilitiesAndEquity,
    balanceDifference: bs.balanceDifference,
  };
}

export interface ExportCashFlow {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly operatingDirect: {
    readonly receiptsFromCustomers: number;
    readonly paymentsForRawMaterials: number;
    readonly paymentsForManufacturing: number;
    readonly paymentsForSellingGeneralAdmin: number;
    readonly interestPaid: number;
    readonly incomeTaxPaid: number;
  };
  readonly operatingCashFlow: number;
  readonly investingCashFlow: number;
  readonly financingCashFlow: number;
  readonly netCashChange: number;
  readonly openingCash: number;
  readonly closingCash: number;
  readonly indirectReconciliation: {
    readonly netIncome: number;
    readonly depreciationAddback: number;
    readonly increaseInReceivables: number;
    readonly increaseInPayables: number;
    readonly increaseInInventory: number;
    readonly increaseInAccruedInterestPayable: number;
    readonly operatingCashFlowIndirect: number;
  };
  /** 直接法CFOと間接法CFOの差（0近傍であること）。 */
  readonly directIndirectDifference: number;
}

export function buildExportCashFlow(cf: CashFlowStatement): ExportCashFlow {
  return {
    companyId: cf.companyId,
    period: cf.period,
    operatingDirect: {
      receiptsFromCustomers: cf.operatingDirect.receiptsFromCustomers,
      paymentsForRawMaterials: cf.operatingDirect.paymentsForRawMaterials,
      paymentsForManufacturing: cf.operatingDirect.paymentsForManufacturing,
      paymentsForSellingGeneralAdmin: cf.operatingDirect.paymentsForSellingGeneralAdmin,
      interestPaid: cf.operatingDirect.interestPaid,
      incomeTaxPaid: cf.operatingDirect.incomeTaxPaid,
    },
    operatingCashFlow: cf.operatingCashFlow,
    investingCashFlow: cf.investingCashFlow,
    financingCashFlow: cf.financingCashFlow,
    netCashChange: cf.netCashChange,
    openingCash: cf.openingCash,
    closingCash: cf.closingCash,
    indirectReconciliation: {
      netIncome: cf.indirectReconciliation.netIncome,
      depreciationAddback: cf.indirectReconciliation.depreciationAddback,
      increaseInReceivables: cf.indirectReconciliation.increaseInReceivables,
      increaseInPayables: cf.indirectReconciliation.increaseInPayables,
      increaseInInventory: cf.indirectReconciliation.increaseInInventory,
      increaseInAccruedInterestPayable: cf.indirectReconciliation.increaseInAccruedInterestPayable,
      operatingCashFlowIndirect: cf.indirectReconciliation.operatingCashFlowIndirect,
    },
    directIndirectDifference: cf.directIndirectDifference,
  };
}

export interface ExportFinancialResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly profitAndLoss: ExportProfitAndLoss;
  readonly balanceSheet: ExportBalanceSheet;
  readonly cashFlow: ExportCashFlow;
  readonly cashShortfall: boolean;
  readonly cashShortfallAmount: number;
  readonly negativeEquity: boolean;
}

export function buildExportFinancialResult(result: CompanyFinancialQuarterResult): ExportFinancialResult {
  return {
    companyId: result.companyId,
    period: result.period,
    profitAndLoss: buildExportProfitAndLoss(result.profitAndLoss),
    balanceSheet: buildExportBalanceSheet(result.balanceSheet),
    cashFlow: buildExportCashFlow(result.cashFlow),
    cashShortfall: result.cashShortfall,
    cashShortfallAmount: result.cashShortfallAmount,
    negativeEquity: result.negativeEquity,
  };
}

// ---------------------------------------------------------------------
// 3. 資金調達・信用力
// ---------------------------------------------------------------------

export interface ExportFinancingResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly creditScore: {
    readonly score0to100: number;
    readonly tier: string;
    readonly breakdown: readonly {
      readonly factor: string;
      readonly weight: number;
      readonly normalizedScore0to100: number;
      readonly weightedContribution: number;
      readonly note: string;
    }[];
    readonly reasons: readonly string[];
  };
  readonly borrowingCapacity: {
    readonly collateralBasedLimitUsd: number;
    readonly earningsBasedLimitUsd: number;
    readonly creditTierCapUsd: number;
    readonly grossLimitUsd: number;
    readonly existingLoanBalanceUsd: number;
    readonly availableAdditionalCapacityUsd: number;
    readonly underwritingFrozen: boolean;
    readonly constraints: readonly { readonly name: string; readonly limitUsd: number }[];
    readonly bindingConstraint: string;
  };
  /** 申請額(requestedAmountUsd)と承認額(approvedAmountUsd)・否決額(deniedAmountUsd)を明確に分離する。 */
  readonly underwriting: {
    readonly requestedAmountUsd: number;
    readonly approvedAmountUsd: number;
    readonly deniedAmountUsd: number;
    readonly appliedAnnualRate: number;
    readonly maturityPeriod: PeriodV2 | null;
    readonly repaymentMethod: string;
    readonly approvedLoanId: string | null;
    readonly reasons: readonly string[];
  };
  readonly covenant: {
    readonly checks: readonly { readonly name: string; readonly requiredValue: number; readonly actualValue: number; readonly breached: boolean }[];
    readonly anyBreach: boolean;
  };
  readonly procurementConstraint: {
    readonly originalDomesticPurchaseQuantityTons: number;
    readonly plannedCashNeedUsd: number;
    readonly availableLiquidityUsd: number;
    readonly scaleRatio: number;
    readonly constrainedDomesticPurchaseQuantityTons: number;
    readonly unmetDemandUsd: number;
    readonly importOrdersBlocked: boolean;
    readonly reason: string;
  } | null;
  readonly emergencyLoan: {
    readonly requestedUsd: number;
    readonly approvedUsd: number;
    readonly annualRate: number;
    readonly capUsd: number;
    readonly reason: string;
  } | null;
  readonly interestAccrualUsd: number;
  readonly interestPaidCashUsd: number;
  readonly scheduledPrincipalDueUsd: number;
  readonly principalPaidCashUsd: number;
  readonly arrearsEvents: readonly { readonly loanId: string; readonly kind: string; readonly amountUsd: number }[];
  readonly financialHealth: {
    readonly primary: string;
    readonly insolvent: boolean;
    readonly covenantBreach: boolean;
    readonly paymentArrears: boolean;
    readonly paymentDefault: boolean;
    readonly usedEmergencyLoanThisPeriod: boolean;
    readonly consecutiveArrearsQuarters: number;
    readonly consecutiveCovenantBreachQuarters: number;
  };
  readonly loanDrawUsd: number;
  readonly refinancedLoanIds: readonly string[];
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  readonly endingAccruedInterestPayableUsd: number;
}

export function buildExportFinancingResult(result: FinancingQuarterResult): ExportFinancingResult {
  return {
    companyId: result.companyId,
    period: result.period,
    creditScore: {
      score0to100: result.creditScore.score0to100,
      tier: result.creditScore.tier,
      breakdown: result.creditScore.breakdown.map((item) => ({
        factor: item.factor,
        weight: item.weight,
        normalizedScore0to100: item.normalizedScore0to100,
        weightedContribution: item.weightedContribution,
        note: item.note,
      })),
      reasons: result.creditScore.reasons,
    },
    borrowingCapacity: {
      collateralBasedLimitUsd: result.borrowingCapacity.collateralBasedLimitUsd,
      earningsBasedLimitUsd: result.borrowingCapacity.earningsBasedLimitUsd,
      creditTierCapUsd: result.borrowingCapacity.creditTierCapUsd,
      grossLimitUsd: result.borrowingCapacity.grossLimitUsd,
      existingLoanBalanceUsd: result.borrowingCapacity.existingLoanBalanceUsd,
      availableAdditionalCapacityUsd: result.borrowingCapacity.availableAdditionalCapacityUsd,
      underwritingFrozen: result.borrowingCapacity.underwritingFrozen,
      constraints: result.borrowingCapacity.constraints.map((c) => ({ name: c.name, limitUsd: c.limitUsd })),
      bindingConstraint: result.borrowingCapacity.bindingConstraint,
    },
    underwriting: {
      requestedAmountUsd: result.underwriting.requestedAmountUsd,
      approvedAmountUsd: result.underwriting.approvedAmountUsd,
      deniedAmountUsd: result.underwriting.deniedAmountUsd,
      appliedAnnualRate: result.underwriting.appliedAnnualRate,
      maturityPeriod: result.underwriting.maturityPeriod ?? null,
      repaymentMethod: result.underwriting.repaymentMethod,
      approvedLoanId: result.underwriting.approvedLoanId ?? null,
      reasons: result.underwriting.reasons,
    },
    covenant: {
      checks: result.covenant.checks.map((c) => ({
        name: c.name,
        requiredValue: c.requiredValue,
        actualValue: c.actualValue,
        breached: c.breached,
      })),
      anyBreach: result.covenant.anyBreach,
    },
    procurementConstraint: result.procurementConstraint
      ? {
          originalDomesticPurchaseQuantityTons: result.procurementConstraint.originalDomesticPurchaseQuantityTons,
          plannedCashNeedUsd: result.procurementConstraint.plannedCashNeedUsd,
          availableLiquidityUsd: result.procurementConstraint.availableLiquidityUsd,
          scaleRatio: result.procurementConstraint.scaleRatio,
          constrainedDomesticPurchaseQuantityTons: result.procurementConstraint.constrainedDomesticPurchaseQuantityTons,
          unmetDemandUsd: result.procurementConstraint.unmetDemandUsd,
          importOrdersBlocked: result.procurementConstraint.importOrdersBlocked,
          reason: result.procurementConstraint.reason,
        }
      : null,
    emergencyLoan: result.emergencyLoan
      ? {
          requestedUsd: result.emergencyLoan.requestedUsd,
          approvedUsd: result.emergencyLoan.approvedUsd,
          annualRate: result.emergencyLoan.annualRate,
          capUsd: result.emergencyLoan.capUsd,
          reason: result.emergencyLoan.reason,
        }
      : null,
    interestAccrualUsd: result.interestAccrualUsd,
    interestPaidCashUsd: result.interestPaidCashUsd,
    scheduledPrincipalDueUsd: result.scheduledPrincipalDueUsd,
    principalPaidCashUsd: result.principalPaidCashUsd,
    arrearsEvents: result.arrearsEvents.map((e) => ({ loanId: e.loanId, kind: e.kind, amountUsd: e.amountUsd })),
    financialHealth: {
      primary: result.financialHealth.primary,
      insolvent: result.financialHealth.insolvent,
      covenantBreach: result.financialHealth.covenantBreach,
      paymentArrears: result.financialHealth.paymentArrears,
      paymentDefault: result.financialHealth.paymentDefault,
      usedEmergencyLoanThisPeriod: result.financialHealth.usedEmergencyLoanThisPeriod,
      consecutiveArrearsQuarters: result.financialHealth.consecutiveArrearsQuarters,
      consecutiveCovenantBreachQuarters: result.financialHealth.consecutiveCovenantBreachQuarters,
    },
    loanDrawUsd: result.loanDrawUsd,
    refinancedLoanIds: result.refinancedLoanIds,
    endingShortTermLoansUsd: result.endingShortTermLoansUsd,
    endingLongTermLoansUsd: result.endingLongTermLoansUsd,
    endingAccruedInterestPayableUsd: result.endingAccruedInterestPayableUsd,
  };
}

// ---------------------------------------------------------------------
// 4. 設備投資結果
// ---------------------------------------------------------------------

export interface ExportCapexResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly rejectedProposals: readonly {
    readonly projectType: string;
    readonly requestedBudgetUsd: number;
    readonly reasons: readonly string[];
  }[];
  readonly events: readonly {
    readonly projectId: string;
    readonly projectType: string;
    readonly statusBefore: string;
    readonly statusAfter: string;
    readonly paymentAttempted: boolean;
    readonly paymentSucceededUsd: number;
    readonly reasons: readonly string[];
  }[];
  readonly cashAvailableForCapexUsd: number;
  readonly totalPaidThisQuarterUsd: number;
  readonly completedProjectsTransferUsd: number;
  readonly endingConstructionInProgressUsd: number;
}

export function buildExportCapexResult(result: CapexQuarterResult): ExportCapexResult {
  return {
    companyId: result.companyId,
    period: result.period,
    rejectedProposals: result.rejectedProposals.map((p) => ({
      projectType: p.projectType,
      requestedBudgetUsd: p.requestedBudgetUsd,
      reasons: p.reasons,
    })),
    events: result.events.map((e) => ({
      projectId: e.projectId,
      projectType: e.projectType,
      statusBefore: e.statusBefore,
      statusAfter: e.statusAfter,
      paymentAttempted: e.paymentAttempted,
      paymentSucceededUsd: e.paymentSucceededUsd,
      reasons: e.reasons,
    })),
    cashAvailableForCapexUsd: result.cashAvailableForCapexUsd,
    totalPaidThisQuarterUsd: result.totalPaidThisQuarterUsd,
    completedProjectsTransferUsd: result.completedProjectsTransferUsd,
    endingConstructionInProgressUsd: result.endingConstructionInProgressUsd,
  };
}

// ---------------------------------------------------------------------
// 5. 会社サマリー（生産・販売・品質等の事前集計）
// ---------------------------------------------------------------------

export interface ExportCompanySummary {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly newContractedQuantity: number;
  readonly newContractedAveragePrice: number;
  readonly fulfilledQuantity: number;
  readonly outstandingQuantity: number;
  readonly overdueQuantity: number;
  readonly domesticPurchaseQuantity: number;
  readonly domesticPurchasePrice: number;
  readonly importInTransitQuantity: number;
  readonly importArrivedQuantity: number;
  readonly aquacultureGrowingQuantity: number;
  readonly aquacultureHarvestedQuantity: number;
  readonly rawMaterialInventory: number;
  readonly hosoProduced: number;
  readonly pdProduced: number;
  readonly vapProduced: number;
  readonly finishedGoodsInventory: number;
  readonly rawMaterialShortfall: number;
  readonly equipmentShortfall: number;
  readonly laborShortfall: number;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly overtimeRate: number;
  readonly temporaryWorkerShare: number;
  readonly downgradeQuantity: number;
  readonly reworkQuantity: number;
  readonly discardQuantity: number;
  readonly majorIncidentCount: number;
  readonly onTimeDeliveryRate: number | null;
  readonly reasonCodes: readonly { readonly code: string; readonly companyId: CompanyId; readonly message: string }[];
}

export function buildExportCompanySummary(summary: CompanyQuarterSummary): ExportCompanySummary {
  return {
    companyId: summary.companyId,
    period: summary.period,
    newContractedQuantity: summary.newContractedQuantity,
    newContractedAveragePrice: summary.newContractedAveragePrice,
    fulfilledQuantity: summary.fulfilledQuantity,
    outstandingQuantity: summary.outstandingQuantity,
    overdueQuantity: summary.overdueQuantity,
    domesticPurchaseQuantity: summary.domesticPurchaseQuantity,
    domesticPurchasePrice: summary.domesticPurchasePrice,
    importInTransitQuantity: summary.importInTransitQuantity,
    importArrivedQuantity: summary.importArrivedQuantity,
    aquacultureGrowingQuantity: summary.aquacultureGrowingQuantity,
    aquacultureHarvestedQuantity: summary.aquacultureHarvestedQuantity,
    rawMaterialInventory: summary.rawMaterialInventory,
    hosoProduced: summary.hosoProduced,
    pdProduced: summary.pdProduced,
    vapProduced: summary.vapProduced,
    finishedGoodsInventory: summary.finishedGoodsInventory,
    rawMaterialShortfall: summary.rawMaterialShortfall,
    equipmentShortfall: summary.equipmentShortfall,
    laborShortfall: summary.laborShortfall,
    equipmentUtilizationRate: summary.equipmentUtilizationRate,
    laborUtilizationRate: summary.laborUtilizationRate,
    overtimeRate: summary.overtimeRate,
    temporaryWorkerShare: summary.temporaryWorkerShare,
    downgradeQuantity: summary.downgradeQuantity,
    reworkQuantity: summary.reworkQuantity,
    discardQuantity: summary.discardQuantity,
    majorIncidentCount: summary.majorIncidentCount,
    onTimeDeliveryRate: summary.onTimeDeliveryRate ?? null,
    reasonCodes: summary.reasonCodes.map((r) => ({ code: r.code, companyId: r.companyId, message: r.message })),
  };
}

// ---------------------------------------------------------------------
// 6. 市場結果（会社非公開情報を含まない公開データ）
// ---------------------------------------------------------------------

export interface ExportMarketResult {
  readonly period: PeriodV2;
  readonly parametersVersion: string;
  readonly worldSupply: number;
  readonly worldDemand: number;
  readonly worldSupplyDemandBalance: number;
}

export function buildExportMarketResult(market: MarketQuarterResult): ExportMarketResult {
  return {
    period: market.period,
    parametersVersion: market.parametersVersion,
    worldSupply: market.worldSupply,
    worldDemand: market.worldDemand,
    worldSupplyDemandBalance: market.worldSupplyDemandBalance,
  };
}

// ---------------------------------------------------------------------
// 7. 会社スコープ／全社スコープ ペイロード
// ---------------------------------------------------------------------

export interface CompanyExportPayload {
  readonly meta: ExportMeta;
  readonly financialResult: ExportFinancialResult | null;
  readonly financingResult: ExportFinancingResult | null;
  readonly capexResult: ExportCapexResult | null;
  readonly companySummary: ExportCompanySummary | null;
}

export interface BuildCompanyExportPayloadInput {
  readonly labId: string;
  readonly companyId: CompanyId;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly generatedAt: string;
}

export function buildCompanyExportPayload(input: BuildCompanyExportPayloadInput): CompanyExportPayload {
  const { labId, companyId, entry, generatedAt } = input;
  const financial = extractCompanyFinancialResult(entry.record, companyId);
  const financing = extractCompanyFinancingResult(entry.record, companyId);
  const capex = extractCompanyCapexResult(entry.record, companyId);
  const summary = entry.record.companySummaries.find((s) => s.companyId === companyId) ?? null;
  return {
    meta: buildExportMeta({
      labId,
      turn: entry.turn,
      period: entry.period,
      engineVersion: entry.engineVersion,
      scope: { kind: "company", companyId },
      generatedAt,
    }),
    financialResult: financial ? buildExportFinancialResult(financial) : null,
    financingResult: financing ? buildExportFinancingResult(financing) : null,
    capexResult: capex ? buildExportCapexResult(capex) : null,
    companySummary: summary ? buildExportCompanySummary(summary) : null,
  };
}

export interface AllCompaniesExportPayload {
  readonly meta: ExportMeta;
  readonly companies: readonly {
    readonly companyId: CompanyId;
    readonly financialResult: ExportFinancialResult | null;
    readonly financingResult: ExportFinancingResult | null;
    readonly capexResult: ExportCapexResult | null;
    readonly companySummary: ExportCompanySummary | null;
  }[];
  readonly market: ExportMarketResult;
}

export interface BuildAllCompaniesExportPayloadInput {
  readonly labId: string;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly companyIds: readonly CompanyId[];
  readonly generatedAt: string;
}

/**
 * GMフルスコープからのみ呼び出してよい（withExportApiContext.ts側でスコープ判定を
 * 一元化する。本関数自体はスコープ判定を行わず、呼び出し元が既に許可済みで
 * あることを前提とする）。
 */
export function buildAllCompaniesExportPayload(input: BuildAllCompaniesExportPayloadInput): AllCompaniesExportPayload {
  const { labId, entry, companyIds, generatedAt } = input;
  return {
    meta: buildExportMeta({
      labId,
      turn: entry.turn,
      period: entry.period,
      engineVersion: entry.engineVersion,
      scope: { kind: "allCompanies" },
      generatedAt,
    }),
    companies: companyIds.map((companyId) => {
      const financial = extractCompanyFinancialResult(entry.record, companyId);
      const financing = extractCompanyFinancingResult(entry.record, companyId);
      const capex = extractCompanyCapexResult(entry.record, companyId);
      const summary = entry.record.companySummaries.find((s) => s.companyId === companyId) ?? null;
      return {
        companyId,
        financialResult: financial ? buildExportFinancialResult(financial) : null,
        financingResult: financing ? buildExportFinancingResult(financing) : null,
        capexResult: capex ? buildExportCapexResult(capex) : null,
        companySummary: summary ? buildExportCompanySummary(summary) : null,
      };
    }),
    market: buildExportMarketResult(entry.record.marketResult),
  };
}

export interface MarketExportPayload {
  readonly meta: ExportMeta;
  readonly market: ExportMarketResult;
}

export interface BuildMarketExportPayloadInput {
  readonly labId: string;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly generatedAt: string;
}

export function buildMarketExportPayload(input: BuildMarketExportPayloadInput): MarketExportPayload {
  const { labId, entry, generatedAt } = input;
  return {
    meta: buildExportMeta({
      labId,
      turn: entry.turn,
      period: entry.period,
      engineVersion: entry.engineVersion,
      scope: { kind: "allCompanies" },
      generatedAt,
    }),
    market: buildExportMarketResult(entry.record.marketResult),
  };
}

// ---------------------------------------------------------------------
// 8. ラボ index（作成済みturn一覧・完了状態）
// ---------------------------------------------------------------------

export interface LabIndexExportPayload {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly labId: string;
  readonly engineVersion: string;
  readonly dataStatus: "confirmed";
  readonly playerCompanyId: CompanyId;
  readonly availableTurns: readonly number[];
  readonly latestProcessedTurn: number | null;
}

export interface BuildLabIndexExportPayloadInput {
  readonly labId: string;
  readonly state: CompanyLabPersistedStateV1;
  readonly historyIndex: readonly number[];
  readonly generatedAt: string;
}

export function buildLabIndexExportPayload(input: BuildLabIndexExportPayloadInput): LabIndexExportPayload {
  const { labId, state, historyIndex, generatedAt } = input;
  const sorted = [...historyIndex].sort((a, b) => a - b);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt,
    labId,
    engineVersion: state.engineVersion,
    dataStatus: "confirmed",
    playerCompanyId: state.playerCompanyId,
    availableTurns: sorted,
    latestProcessedTurn: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}
