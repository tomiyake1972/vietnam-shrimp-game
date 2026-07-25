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
// 【v1.2（Phase 8C-3B）での出力範囲拡大】
// 経営判断に必要な明細（契約ロールフォワード・市場別×商品別の販売明細・市場結果の
// 全項目・品質／生産／原料の明細・意思決定内容）は、いずれもゲームエンジンや
// 確定履歴には保存済みであり、このファイルが出力対象から除外していただけだった。
// v1.2では以下5系統を `./dto/` 配下の個別モジュールとして許可項目化し、本ファイルが
// import して re-export する（利用側のimportパスは従来どおり本ファイルのままで良い）。
//   §2 契約ロールフォワード         → ./dto/contractDto.ts
//   §3 市場別×商品別の販売明細      → ./dto/salesDto.ts
//   §4 市場結果（全17項目）         → ./dto/marketDto.ts
//   §5 品質・生産・原料の明細       → ./dto/operationsDto.ts
//   §6 意思決定内容                 → ./dto/decisionDto.ts
// 各モジュールも本ファイルと同じ方針（内部型をそのままspreadせず、許可フィールドを
// 1つずつ列挙して組み立てる）を守っている。
//
// 【スコープ隔離（三宅さんの指示 §6・§8）】
// 会社スコープ（CompanyExportPayload）は「対象会社の自社情報＋公開市場情報」だけを
// 収録し、他社の非公開意思決定・他社の提示価格・他社の競争力内訳・他社の財務結果を
// 一切含めない。全社スコープ（AllCompaniesExportPayload、GMのみ）は全社の詳細・
// 意思決定・処理結果・市場全体を収録する。両者を混在させない。
//
// 【intentionally NOT included（保存データには存在するが出力しない）】
//   - CompanyFinancialQuarterResult.manufacturingCost（ManufacturingCostBreakdown）
//   - CompanyFinancialQuarterResult.qualityLoss（QualityLossBreakdown）
//   - CompanyFinancialQuarterResult.costRecords（readonly CostRecord[]）
//   - CompanyFinancialQuarterResult.contributionMargin（ContributionMarginReport）
//   - CompanyFinancialQuarterResult.absorptionVariableReconciliation
//     （以上は製造原価計算書・限界利益計算書として将来の拡張候補）
//   - CompanyLabQuarterHistoryEntry.preProcessingStateSnapshot / postProcessingStateSnapshot
//     を丸ごと出すことはしない（ランタイム内部スナップショット全体を出すと、財務・資金・
//     設備投資の確定結果が二重に出てしまう上、内部専用フィールドが自動的に漏れる）。
//     必要な部分（contracts・rawMaterialLots・productionState.finishedGoodsLots）は
//     ./dto/ 配下で個別に許可項目化し、期首／期末の対比として出力している。
//   - CompanyQuarterRecord.marketInput（国別生産量・経済指数等の市場入力パラメータ。
//     §4は市場「結果」を対象としているため今回は出力しない）
// 【保存されていないことを確認した項目（完了報告で型名・フィールド名・処理地点を明示）】
//   - CompanyLabQuarterHistoryEntry.aiProposal / diffFromAiProposal
//     → 型定義は存在するが四半期確定処理が代入していないため既存履歴では未保存。
//       詳細は ./dto/decisionDto.ts の AI_PROPOSAL_UNAVAILABLE_REASON を参照。
//   - RawMaterialsQuarterRecord.harvestResults（AquacultureHarvestResult。疾病圧力・
//     生残率・実収穫量・単位原価）が CompanyQuarterRecord へ引き継がれていないため、
//     養殖結果の個別内訳は出力できない（会社サマリーの集計値と原料ロットの
//     pendingAquaculture* からの部分的な再構成のみ可能）。

import {
  BalanceSheet,
  CashFlowStatement,
  CompanyFinancialQuarterResult,
  ProfitAndLossStatement,
} from "../../../../lib/v2/finance/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CapexQuarterResult } from "../../../../lib/v2/capex";
import { CompanyQuarterSummary } from "../../../../lib/v2/companyLab/types";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../../../lib/v2/market/types";
import { CompanyLabQuarterHistoryEntry, CompanyLabPersistedStateV1 } from "../../../../lib/v2/companyLab/persistence/types";
import { CompanyId } from "../../../../lib/v2/sales/types";
import { PeriodV2 } from "../../../../lib/v2/core/period";
import {
  extractCompanyCapexResult,
  extractCompanyFinancialResult,
  extractCompanyFinancingResult,
} from "../../../../v2/company-lab/play/_lib/financialViewSelectors";

// --- §2〜§6の許可項目DTO（./dto/ 配下の個別モジュール） ---
import {
  ExportContractFulfillmentUsage,
  ExportSalesContract,
  buildExportContractFulfillmentUsageAllCompanies,
  buildExportContractFulfillmentUsageForCompany,
  buildExportSalesContractRollforward,
} from "./dto/contractDto";
import {
  ExportMarketProductAllocation,
  ExportSalesPlanEntry,
  buildExportMarketProductAllocations,
  buildExportSalesPlansAllCompanies,
  buildExportSalesPlansForCompany,
} from "./dto/salesDto";
import { ExportMarketResult, buildExportMarketResult } from "./dto/marketDto";
import {
  ExportBatchQualityAdjustment,
  ExportCompanyLoadMetrics,
  ExportDeliveryObservation,
  ExportDomesticPurchaseAllocation,
  ExportFactoryLoadMetrics,
  ExportFinishedGoodsLotStates,
  ExportProductionAllocation,
  ExportProductionBatch,
  ExportQualityState,
  ExportRawMaterialLotStates,
  ExportRawMaterialRequirement,
  buildExportCompanyLoadMetricsList,
  buildExportDeliveryObservations,
  buildExportDomesticPurchaseAllocation,
  buildExportFactoryLoadMetricsList,
  buildExportFinishedGoodsLotStates,
  buildExportProductionAllocation,
  buildExportProductionBatches,
  buildExportQualityAdjustments,
  buildExportQualityState,
  buildExportRawMaterialLotStates,
  buildExportRawMaterialRequirements,
} from "./dto/operationsDto";
import { CompanyFixture } from "../../../../lib/v2/companyLab/types";
import { ExportProcessingCapacity, buildExportProcessingCapacity } from "./dto/processingCapacityDto";
import {
  ExportAllCompaniesDecisionInfo,
  ExportCompanyDecisionInfo,
  buildExportAllCompaniesDecisionInfo,
  buildExportCompanyDecisionInfo,
} from "./dto/decisionDto";

// 利用側（Excelビルダー・ZIPビルダー・APIルート・テスト）のimportパスを
// `app/api/v2/exports/_lib/exportDto` のまま維持するため、./dto/ 配下の型と
// builderをすべて本ファイルから再公開する。
export * from "./dto/contractDto";
export * from "./dto/salesDto";
export * from "./dto/marketDto";
export * from "./dto/operationsDto";
export * from "./dto/decisionDto";
export * from "./dto/processingCapacityDto";

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

/**
 * 商品区分（hoso/pd/vap）の固定出力順。
 * CompanyQuarterSummary の商品別フィールドは Readonly<Partial<Record<Product, ...>>> で
 * あり、JSONのキー順序が保存順に依存するため、配列へ変換して固定順で出力する
 * （同じ確定履歴から再生成して結果が一致すること＝完了条件）。
 */
const EXPORT_PRODUCT_ORDER: readonly Product[] = ["hoso", "pd", "vap"];

/** 商品別の単一指標（未設定の商品は value: null）。 */
export interface ExportProductValue {
  readonly product: string;
  readonly value: number | null;
}

/** 市場別の単一指標（未設定の市場は value: null）。 */
export interface ExportMarketValue {
  readonly market: string;
  readonly value: number | null;
}

/** 無理な増産の警告（工場×商品単位）。 */
export interface ExportRampWarning {
  readonly factoryId: string;
  readonly product: string;
  /** 増産ストレス（0〜1目安。高いほど直前四半期比の増産幅が大きい）。 */
  readonly productionRampStress: number;
}

function buildExportProductValues(record: Readonly<Partial<Record<Product, number>>>): readonly ExportProductValue[] {
  return EXPORT_PRODUCT_ORDER.map((product) => ({ product, value: record[product] ?? null }));
}

function buildExportMarketValues(record: Readonly<Partial<Record<DemandMarketId, number>>>): readonly ExportMarketValue[] {
  return DEMAND_MARKET_IDS.map((market) => ({ market, value: record[market] ?? null }));
}

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
  /** 【Phase 7A】当期末時点（更新後）の商品別品質スコア（0〜100）。 */
  readonly qualityScoreByProduct: readonly ExportProductValue[];
  /** 【Phase 7A】当期の商品別操業リスク（複数工場ある場合は数量加重平均）。 */
  readonly operationalRiskByProduct: readonly ExportProductValue[];
  /** 【Phase 7A】当期末時点（更新後）の市場別顧客信頼（0〜100）。 */
  readonly customerTrustByMarket: readonly ExportMarketValue[];
  /** 【Phase 7A】当期末時点（更新後）の市場別納期信頼性（0〜100）。 */
  readonly deliveryReliabilityByMarket: readonly ExportMarketValue[];
  /** 【Phase 7A】無理な増産の警告（工場×商品、factoryId→product順）。 */
  readonly rampWarnings: readonly ExportRampWarning[];
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
    qualityScoreByProduct: buildExportProductValues(summary.qualityScoreByProduct),
    operationalRiskByProduct: buildExportProductValues(summary.operationalRiskByProduct),
    customerTrustByMarket: buildExportMarketValues(summary.customerTrustByMarket),
    deliveryReliabilityByMarket: buildExportMarketValues(summary.deliveryReliabilityByMarket),
    rampWarnings: summary.rampWarnings
      .map((w) => ({ factoryId: w.factoryId, product: w.product, productionRampStress: w.productionRampStress }))
      .sort((a, b) => (a.factoryId !== b.factoryId ? a.factoryId.localeCompare(b.factoryId) : a.product.localeCompare(b.product))),
    reasonCodes: summary.reasonCodes.map((r) => ({ code: r.code, companyId: r.companyId, message: r.message })),
  };
}

// ---------------------------------------------------------------------
// 5.5 §5 品質・生産・原料の明細（operationsDto.ts の各builderの集約）
// ---------------------------------------------------------------------
//
// §2 契約ロールフォワードは ./dto/contractDto.ts、§3 販売明細は ./dto/salesDto.ts、
// §4 市場結果は ./dto/marketDto.ts、§6 意思決定は ./dto/decisionDto.ts に定義され、
// 本ファイル冒頭で re-export している。本セクションは §5（12項目）の各builderを
// 1つのサブオブジェクトへ集約し、会社スコープ／GMスコープの両ペイロードから
// 同じ形で使えるようにするだけで、値の再計算は一切行わない。

export interface ExportOperationsSection {
  /** §5-1〜5: 当期末時点の品質・顧客信頼・納期信頼性・ランプ履歴。 */
  readonly qualityState: ExportQualityState;
  /** §5-1,2,5: バッチ単位の操業リスクと品質結果（重大事故の抽選結果を含む）。 */
  readonly qualityAdjustments: readonly ExportBatchQualityAdjustment[];
  /** §5-4: 市場別の納期観測（当期到来量・期限内履行量・新規／継続延滞量）。 */
  readonly deliveryObservations: readonly ExportDeliveryObservation[];
  /** §5-6: 生産バッチ明細（投入原料ロット・産出量・不足理由）。 */
  readonly productionBatches: readonly ExportProductionBatch[];
  /** §5-7: 工場別・商品別の生産配分と工場別の人員サマリー。 */
  readonly productionAllocation: ExportProductionAllocation;
  /** §5-8: 工場別稼働実績。 */
  readonly factoryLoadMetrics: readonly ExportFactoryLoadMetrics[];
  /** §5-8: 会社別稼働実績。 */
  readonly companyLoadMetrics: readonly ExportCompanyLoadMetrics[];
  /** §5-9: 納期別・商品別の原料要求量。 */
  readonly rawMaterialRequirements: readonly ExportRawMaterialRequirement[];
  /** §5-10: 国内買付の市場清算結果と会社別配分（希望量は意思決定側に含まれる）。 */
  readonly domesticPurchaseAllocation: ExportDomesticPurchaseAllocation;
  /** §5-11: 原料ロットの期首・期末状態。 */
  readonly rawMaterialLots: ExportRawMaterialLotStates;
  /** §5-12: 完成品ロットの期首・当期生産・期末状態（消費は契約履行内訳側）。 */
  readonly finishedGoodsLots: ExportFinishedGoodsLotStates;
}

/**
 * §5の12項目を組み立てる。scopedCompanyId を渡すと会社別の行を対象会社のみへ
 * 絞り込み、市場レベルの公開情報（国内買付の市場価格・供給量・未配分供給量）は
 * そのまま保持する。GMスコープでは undefined を渡して全社ぶんを得る。
 */
export function buildExportOperationsSection(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportOperationsSection {
  return {
    qualityState: buildExportQualityState(entry, scopedCompanyId),
    qualityAdjustments: buildExportQualityAdjustments(entry, scopedCompanyId),
    deliveryObservations: buildExportDeliveryObservations(entry, scopedCompanyId),
    productionBatches: buildExportProductionBatches(entry, scopedCompanyId),
    productionAllocation: buildExportProductionAllocation(entry, scopedCompanyId),
    factoryLoadMetrics: buildExportFactoryLoadMetricsList(entry, scopedCompanyId),
    companyLoadMetrics: buildExportCompanyLoadMetricsList(entry, scopedCompanyId),
    rawMaterialRequirements: buildExportRawMaterialRequirements(entry, scopedCompanyId),
    domesticPurchaseAllocation: buildExportDomesticPurchaseAllocation(entry, scopedCompanyId),
    rawMaterialLots: buildExportRawMaterialLotStates(entry, scopedCompanyId),
    finishedGoodsLots: buildExportFinishedGoodsLotStates(entry, scopedCompanyId),
  };
}

// ---------------------------------------------------------------------
// 7. 会社スコープ／全社スコープ ペイロード
// ---------------------------------------------------------------------

/**
 * 会社スコープのペイロード。「対象会社の自社情報＋公開市場情報」のみを収録し、
 * 他社の非公開情報（意思決定・提示価格・競争力内訳・財務結果）を一切含まない
 * （三宅さんの指示 §6・§8）。GM向けの情報は AllCompaniesExportPayload 側に置く。
 */
export interface CompanyExportPayload {
  readonly meta: ExportMeta;
  readonly financialResult: ExportFinancialResult | null;
  readonly financingResult: ExportFinancingResult | null;
  readonly capexResult: ExportCapexResult | null;
  readonly companySummary: ExportCompanySummary | null;
  /** §2 この会社の契約ロールフォワード明細（期首・新規・履行・期末）。 */
  readonly salesContracts: readonly ExportSalesContract[];
  /**
   * 工場の加工能力（当期末時点の各能力＋現在追加中の能力）。
   * fixtures（ラボ作成時に確定した静的な工場能力）が取得できない呼び出し経路では
   * nullになる。値が無いことを0や推測値で埋めない方針のためnullを許容する。
   */
  readonly processingCapacity: ExportProcessingCapacity | null;
  /** §2 この会社の契約×完成品ロット単位の履行内訳。 */
  readonly contractFulfillmentUsage: readonly ExportContractFulfillmentUsage[];
  /** §3 この会社の市場別×商品別の販売計画。 */
  readonly salesPlans: readonly ExportSalesPlanEntry[];
  /**
   * §3 市場別×商品別の成約配分。市場レベルの公開情報（基準価格・対象需要・
   * 外部流出量）は全件収録し、companies[] はこの会社1件のみへ絞り込む。
   */
  readonly marketProductAllocations: readonly ExportMarketProductAllocation[];
  /** §4 公開市場情報（全社共通、17項目）。 */
  readonly market: ExportMarketResult;
  /** §5 この会社の品質・生産・原料の明細。 */
  readonly operations: ExportOperationsSection;
  /** §6 この会社の提出意思決定とAI提案（他社の意思決定は含まない）。 */
  readonly decisionInfo: ExportCompanyDecisionInfo;
}

export interface BuildCompanyExportPayloadInput {
  readonly labId: string;
  readonly companyId: CompanyId;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly generatedAt: string;
  /**
   * ラボ作成時に確定・永続化された会社fixture（工場の当初能力の唯一の出所）。
   * 履歴エントリーには含まれないため、呼び出し元がloadCurrentStateから渡す。
   * 省略された場合 processingCapacity は null になる。
   */
  readonly fixtures?: readonly CompanyFixture[];
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
    salesContracts: buildExportSalesContractRollforward(entry, companyId),
    processingCapacity:
      input.fixtures === undefined
        ? null
        : buildExportProcessingCapacity({
            companyId,
            fixtures: input.fixtures,
            capexState: entry.postProcessingStateSnapshot.capexState,
            asOfPeriod: entry.postProcessingStateSnapshot.currentPeriod,
          }),
    contractFulfillmentUsage: buildExportContractFulfillmentUsageForCompany(entry, companyId),
    salesPlans: buildExportSalesPlansForCompany(entry, companyId),
    marketProductAllocations: buildExportMarketProductAllocations(entry, companyId),
    market: buildExportMarketResult(entry.record.marketResult),
    operations: buildExportOperationsSection(entry, companyId),
    decisionInfo: buildExportCompanyDecisionInfo(entry, companyId),
  };
}

/** 全社スコープの、1社ぶんの財務・サマリー・契約明細。 */
export interface AllCompaniesExportCompanyEntry {
  readonly companyId: CompanyId;
  readonly financialResult: ExportFinancialResult | null;
  readonly financingResult: ExportFinancingResult | null;
  readonly capexResult: ExportCapexResult | null;
  readonly companySummary: ExportCompanySummary | null;
  /** §2 この会社の契約ロールフォワード明細（期首・新規・履行・期末）。 */
  readonly salesContracts: readonly ExportSalesContract[];
  /** 工場の加工能力（当期末時点の各能力＋現在追加中の能力）。fixtures未指定時はnull。 */
  readonly processingCapacity: ExportProcessingCapacity | null;
}

/**
 * 全社スコープ（GM専用）のペイロード。全5社の詳細・意思決定・処理結果・市場全体を
 * 収録する（三宅さんの指示 §6・§8）。会社スコープのペイロードとは混在させない。
 */
export interface AllCompaniesExportPayload {
  readonly meta: ExportMeta;
  readonly companies: readonly AllCompaniesExportCompanyEntry[];
  /** §2 全社の契約×完成品ロット単位の履行内訳。 */
  readonly contractFulfillmentUsage: readonly ExportContractFulfillmentUsage[];
  /** §3 全社の市場別×商品別の販売計画。 */
  readonly salesPlans: readonly ExportSalesPlanEntry[];
  /** §3 市場別×商品別の成約配分（全社の提示価格・競争力内訳を含む）。 */
  readonly marketProductAllocations: readonly ExportMarketProductAllocation[];
  /** §4 公開市場情報（17項目）。 */
  readonly market: ExportMarketResult;
  /** §5 全社の品質・生産・原料の明細。 */
  readonly operations: ExportOperationsSection;
  /** §6 全社の提出意思決定・他社意思決定・AI提案・全社の警告。 */
  readonly decisionInfo: ExportAllCompaniesDecisionInfo;
}

export interface BuildAllCompaniesExportPayloadInput {
  readonly labId: string;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly companyIds: readonly CompanyId[];
  readonly generatedAt: string;
  /** ラボ作成時に確定・永続化された会社fixture。省略時 processingCapacity は null。 */
  readonly fixtures?: readonly CompanyFixture[];
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
        salesContracts: buildExportSalesContractRollforward(entry, companyId),
        processingCapacity:
          input.fixtures === undefined
            ? null
            : buildExportProcessingCapacity({
                companyId,
                fixtures: input.fixtures,
                capexState: entry.postProcessingStateSnapshot.capexState,
                asOfPeriod: entry.postProcessingStateSnapshot.currentPeriod,
              }),
      };
    }),
    contractFulfillmentUsage: buildExportContractFulfillmentUsageAllCompanies(entry),
    salesPlans: buildExportSalesPlansAllCompanies(entry),
    marketProductAllocations: buildExportMarketProductAllocations(entry),
    market: buildExportMarketResult(entry.record.marketResult),
    operations: buildExportOperationsSection(entry),
    decisionInfo: buildExportAllCompaniesDecisionInfo(entry),
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
