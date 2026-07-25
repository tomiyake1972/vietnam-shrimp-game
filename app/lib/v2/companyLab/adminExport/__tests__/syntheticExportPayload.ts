// ShrimpX V2 — 管理者Export（Excel/ZIP）テスト用の合成CompanyExportPayload（Phase 8C-3B）
//
// テスト専用。本ファイル自体は"*.test.ts"ではないため、npm testのファイル探索パターン
// （tsx --test "app/lib/**/__tests__/**/*.test.ts" ...）には含まれず、各テストファイルから
// importされるだけの純粋なヘルパーとして扱われる。
//
// 【なぜ合成データで組み立てるのか】
// companyLabAdminExcelBuilder.ts / companyLabAdminExportZip.ts の唯一の入力が
// 「Export APIのJSON（CompanyExportPayload）」であることをテスト側でも担保するため、
// ゲームエンジン・Repository・Redisを一切importせず、JSON形状のオブジェクトを
// 手で組み立てる。DTO builder（buildExportMarketResult等）も呼ばない。
//
// 【Phase 8C-3Bでの必須フィールド追加】
// 三宅さんの指示 §2〜§6 に対応して CompanyExportPayload へ以下が追加されたため、
// 2つのテストファイルで同じ長い literal を重複させないよう、この共有ヘルパーへ集約する。
//   contractFulfillmentUsage / salesPlans / marketProductAllocations /
//   market / operations / decisionInfo
//
// 【値の性質】financialResult は既存テストのアサーション（grossRevenue=1000 等）を
// そのまま維持する。新規フィールドは「Excelが正しい行・列へ転記するか」を確かめられる
// 最小限の実データ形状（1市場×1商品、1工場、1ロット）とし、配列が空でも落ちないことは
// 各テスト側で override して確認する。

import type { CompanyExportPayload } from "../../../../../api/v2/exports/_lib/exportDto";
import type {
  ExportCompanyDecision,
  ExportCompanyDecisionInfo,
  ExportContractFulfillmentUsage,
  ExportMarketProductAllocation,
  ExportMarketResult,
  ExportOperationsSection,
  ExportSalesContract,
  ExportSalesPlanEntry,
} from "../../../../../api/v2/exports/_lib/exportDto";
import { COUNTRY_IDS } from "../../../market/types";
import type { PeriodV2 } from "../../../core/period";

export const SYNTHETIC_PERIOD: PeriodV2 = "2015Q1" as PeriodV2;

/** §2 契約ロールフォワード1件（期首300 + 新規200 - 履行300 = 期末200）。 */
export const SYNTHETIC_CONTRACT: ExportSalesContract = {
  contractId: "BAL-2015Q1-CN-hoso-001",
  companyId: "BAL",
  market: "CN",
  product: "hoso",
  contractedPeriod: SYNTHETIC_PERIOD,
  dueDate: SYNTHETIC_PERIOD,
  originalQuantity: 500,
  unitPrice: 5.5,
  beginningOutstandingQuantity: 300,
  newContractedQuantity: 200,
  fulfilledQuantity: 300,
  endingOutstandingQuantity: 200,
  status: "partiallyFulfilled",
  statusAtBeginning: "open",
  existsAtBeginning: true,
  existsAtEnd: true,
  isNewThisQuarter: false,
  isOverdueAtEnd: false,
  costSnapshot: {
    expectedRawMaterialPriceUsdPerHosoEqKg: 4.2,
    expectedProcessingCostUsdPerHosoEqKg: 0.6,
    minimumAcceptablePriceUsdPerHosoEqKg: 5.0,
    expectedContributionMarginUsdPerHosoEqKg: 0.7,
  },
};

const SYNTHETIC_FULFILLMENT_USAGE: readonly ExportContractFulfillmentUsage[] = [
  { contractId: "BAL-2015Q1-CN-hoso-001", companyId: "BAL", product: "hoso", lotId: "BAL-FG-2015Q1-001", quantity: 300 },
];

const SYNTHETIC_SALES_PLANS: readonly ExportSalesPlanEntry[] = [
  {
    companyId: "BAL",
    market: "CN",
    product: "hoso",
    desiredQuantity: 400,
    priceAdjustmentUsdPerHosoEqKg: 0.1,
    salesForceHeadcount: 6,
    desiredLeadTimeTurns: 1,
    customerRelationship: 50,
    qualityReputation: 60,
    deliveryReliability: 70,
    approvedAllocationCap: null,
    costExpectation: {
      expectedRawMaterialPriceUsdPerHosoEqKg: 4.2,
      expectedProcessingCostUsdPerHosoEqKg: 0.6,
      minimumAcceptablePriceUsdPerHosoEqKg: 5.0,
    },
  },
];

const SYNTHETIC_MARKET_PRODUCT_ALLOCATIONS: readonly ExportMarketProductAllocation[] = [
  {
    market: "CN",
    product: "hoso",
    period: SYNTHETIC_PERIOD,
    basePrice: 5.4,
    targetDemand: 12000,
    externalOptionQuantity: 1500,
    companies: [
      {
        companyId: "BAL",
        askPrice: 5.5,
        coverageScore: 0.6,
        processingCapacity: 3000,
        competitivenessWeight: 0.32,
        competitivenessBreakdown: {
          priceContribution: 0.1,
          coverageContribution: 0.12,
          relationshipContribution: 0.04,
          qualityContribution: 0.04,
          deliveryReliabilityContribution: 0.02,
          rawPriceScore: 0.55,
          clampedPriceScore: 0.55,
          isPriceScoreAtCeiling: false,
          isPriceScoreAtFloor: false,
        },
        allocatedQuantity: 200,
      },
    ],
  },
];

/** §4 市場結果（17項目）。国別の値は COUNTRY_IDS の順で機械的に生成する。 */
const SYNTHETIC_MARKET: ExportMarketResult = {
  period: SYNTHETIC_PERIOD,
  parametersVersion: "test-market-params",
  worldSupply: 100000,
  worldDemand: 104000,
  worldSupplyDemandBalance: 0.04,
  hosoPricesByCountry: COUNTRY_IDS.map((country, index) => ({
    country,
    price: 5.0 + index * 0.1,
    priorPrice: 4.9 + index * 0.1,
    changeRatio: 0.02,
    localPressure: 0.01 + index * 0.001,
    worldPressure: 0.03,
    shockApplied: 0,
    exportableSupply: 20000 + index * 1000,
    allocatedDemand: 21000 + index * 1000,
    utilizationRatio: 1.05,
    drivers: ["WORLD_DEMAND_UP"],
  })),
  vietnamDomestic: {
    price: 4.2,
    buyingCeiling: 4.6,
    farmerReservationPrice: 3.8,
    supply: 30000,
    effectiveDemand: 28000,
    transactedVolume: 28000,
    unsoldSupply: 2000,
    imbalance: -0.0667,
    minimumOfftakeApplied: false,
    reservationPriceApplied: false,
    quantityRationed: false,
    drivers: ["DOMESTIC_SUPPLY_SURPLUS"],
  },
  pdPremium: {
    product: "pd",
    globalDemand: 30000,
    globalCapacity: 32000,
    globalUtilization: 0.9375,
    basePremium: 1.2,
    byCountry: COUNTRY_IDS.map((country, index) => ({
      country,
      premium: 1.2,
      finalPrice: 6.2 + index * 0.1,
      qualityAdjustment: 0,
      capacityUtilization: 0.9,
    })),
    drivers: ["PD_CAPACITY_TIGHT"],
  },
  vapPremium: {
    product: "vap",
    globalDemand: 12000,
    globalCapacity: 15000,
    globalUtilization: 0.8,
    basePremium: 2.4,
    byCountry: COUNTRY_IDS.map((country, index) => ({
      country,
      premium: 2.4,
      finalPrice: 7.4 + index * 0.1,
      qualityAdjustment: 0,
      capacityUtilization: 0.8,
    })),
    drivers: ["VAP_CAPACITY_SLACK"],
  },
  globalDrivers: ["WORLD_BALANCE_TIGHT"],
};

/** §5 品質・生産・原料の明細（1社1工場1商品1ロットの最小構成）。 */
const SYNTHETIC_OPERATIONS: ExportOperationsSection = {
  qualityState: {
    qualityByCompanyProduct: [{ companyId: "BAL", product: "hoso", qualityScore: 62.5 }],
    trustByCompanyMarket: [{ companyId: "BAL", market: "CN", customerTrustScore: 55, deliveryReliabilityScore: 70 }],
    rampHistory: [{ companyId: "BAL", factoryId: "BAL-F1", product: "hoso", lastQuarterProductionQuantity: 1800 }],
  },
  qualityAdjustments: [
    {
      batchId: "BAL-F1-2015Q1-hoso",
      companyId: "BAL",
      factoryId: "BAL-F1",
      product: "hoso",
      period: SYNTHETIC_PERIOD,
      risk: {
        utilizationStress: 0.1,
        overtimeStress: 0.09,
        temporaryWorkerStress: 0,
        complexityStress: 0.2,
        rawMaterialAgeStress: 0,
        productionRampStress: 0,
        operationalRisk: 0.12,
      },
      outcome: {
        nonConformanceRatio: 0.04,
        downgradeRatio: 0.018,
        reworkRatio: 0.01,
        discardRatio: 0.012,
        saleableRecoveryRatio: 0.988,
        observedQualityScore: 61.2,
        majorIncident: { occurred: false, severity: 0, probability: 0.01, seed: "synthetic-seed" },
      },
      originalFinishedGoodsQuantity: 2000,
      adjustedFinishedGoodsQuantity: 1976,
      downgradeQuantity: 36,
      reworkQuantity: 20,
      discardQuantity: 24,
    },
  ],
  deliveryObservations: [
    { companyId: "BAL", market: "CN", dueQuantity: 500, onTimeQuantity: 300, newlyOverdueQuantity: 200, continuingOverdueQuantity: 0 },
  ],
  productionBatches: [
    {
      batchId: "BAL-F1-2015Q1-hoso",
      companyId: "BAL",
      factoryId: "BAL-F1",
      product: "hoso",
      period: SYNTHETIC_PERIOD,
      rawMaterialConsumed: [{ lotId: "BAL-RM-INIT", quantity: 2100, unitCost: 4.2, originCountry: "VN" }],
      rawMaterialConsumedTotal: 2100,
      finishedGoodsQuantity: 2000,
      processingLoss: 100,
      rawMaterialCost: 8820000,
      baseProcessingCost: 1200000,
      capacityUtilizationIndex: 0.16,
      shortfallQuantity: 0,
      shortfallReasons: [],
    },
  ],
  productionAllocation: {
    period: SYNTHETIC_PERIOD,
    entries: [
      {
        companyId: "BAL",
        factoryId: "BAL-F1",
        product: "hoso",
        priority: 1,
        desiredQuantity: 2000,
        allocatedQuantity: 2000,
        shortfallQuantity: 0,
        shortfallReasons: [],
        requiredRawMaterialQuantity: 2100,
        stageRawMaterialLimited: 2000,
        stageCommonCapacityLimited: 2000,
        stageFreezingPackagingLimited: 2000,
        stageProductCapacityLimited: 2000,
        stageLaborLimited: 2000,
        assignedRegularHeadcount: 120,
        assignedTemporaryHeadcount: 0,
        appliedOvertimeRate: 0.09,
      },
    ],
    factoryWorkerSummaries: [
      { factoryId: "BAL-F1", companyId: "BAL", unassignedRegularHeadcount: 0, unassignedTemporaryHeadcount: 0 },
    ],
  },
  factoryLoadMetrics: [
    {
      factoryId: "BAL-F1",
      companyId: "BAL",
      period: SYNTHETIC_PERIOD,
      equipmentUtilizationRate: 0.1595,
      laborUtilizationRate: 1,
      overtimeRate: 0.09,
      temporaryWorkerShare: 0,
      productMixComplexity: 0.2,
      averageRawMaterialAgeQuarters: 0,
      productionShortfallRate: 0,
      processingLossRate: 0.0476,
    },
  ],
  companyLoadMetrics: [
    {
      companyId: "BAL",
      period: SYNTHETIC_PERIOD,
      equipmentUtilizationRate: 0.1595,
      laborUtilizationRate: 1,
      overtimeRate: 0.09,
      temporaryWorkerShare: 0,
      productMixComplexity: 0.2,
      averageRawMaterialAgeQuarters: 0,
      productionShortfallRate: 0,
      processingLossRate: 0.0476,
    },
  ],
  rawMaterialRequirements: [{ companyId: "BAL", dueDate: SYNTHETIC_PERIOD, product: "hoso", requiredQuantity: 2100 }],
  domesticPurchaseAllocation: {
    period: SYNTHETIC_PERIOD,
    marketPrice: 4.2,
    availableSupply: 30000,
    companies: [{ companyId: "BAL", bidPrice: 4.3, coverageScore: 0.5, competitivenessWeight: 0.25, allocatedQuantity: 3000 }],
    unallocatedSupply: 2000,
  },
  rawMaterialLots: {
    beginning: [
      {
        lotId: "BAL-RM-INIT",
        companyId: "BAL",
        source: "domestic",
        originCountry: "VN",
        inboundPeriod: SYNTHETIC_PERIOD,
        originalQuantity: 3000,
        remainingQuantity: 3000,
        unitCost: 4.2,
        availableFromPeriod: SYNTHETIC_PERIOD,
        expiryPeriod: null,
        status: "available",
        pendingAquacultureIntensity: null,
        pendingBioSecurityLevel: null,
        pendingPlannedStockingQuantity: null,
      },
    ],
    ending: [
      {
        lotId: "BAL-RM-INIT",
        companyId: "BAL",
        source: "domestic",
        originCountry: "VN",
        inboundPeriod: SYNTHETIC_PERIOD,
        originalQuantity: 3000,
        remainingQuantity: 900,
        unitCost: 4.2,
        availableFromPeriod: SYNTHETIC_PERIOD,
        expiryPeriod: null,
        status: "available",
        pendingAquacultureIntensity: null,
        pendingBioSecurityLevel: null,
        pendingPlannedStockingQuantity: null,
      },
    ],
  },
  finishedGoodsLots: {
    beginning: [],
    produced: [
      {
        lotId: "BAL-FG-2015Q1-001",
        companyId: "BAL",
        factoryId: "BAL-F1",
        product: "hoso",
        producedPeriod: SYNTHETIC_PERIOD,
        originalQuantity: 1976,
        remainingQuantity: 1676,
        sourceRawMaterialLots: [{ lotId: "BAL-RM-INIT", quantity: 2100, unitCost: 4.2, originCountry: "VN" }],
        rawMaterialOriginCountries: ["VN"],
        rawMaterialUnitCost: 4.2,
        baseProcessingCost: 1200000,
        availableFromPeriod: SYNTHETIC_PERIOD,
        expiryPeriod: null,
        status: "available",
        qualityInfo: {
          qualityScore: 61.2,
          downgradeRatio: 0.018,
          majorIncidentId: null,
          majorIncidentSeverity: null,
          producedPeriod: SYNTHETIC_PERIOD,
        },
      },
    ],
    ending: [
      {
        lotId: "BAL-FG-2015Q1-001",
        companyId: "BAL",
        factoryId: "BAL-F1",
        product: "hoso",
        producedPeriod: SYNTHETIC_PERIOD,
        originalQuantity: 1976,
        remainingQuantity: 1676,
        sourceRawMaterialLots: [{ lotId: "BAL-RM-INIT", quantity: 2100, unitCost: 4.2, originCountry: "VN" }],
        rawMaterialOriginCountries: ["VN"],
        rawMaterialUnitCost: 4.2,
        baseProcessingCost: 1200000,
        availableFromPeriod: SYNTHETIC_PERIOD,
        expiryPeriod: null,
        status: "available",
        qualityInfo: {
          qualityScore: 61.2,
          downgradeRatio: 0.018,
          majorIncidentId: null,
          majorIncidentSeverity: null,
          producedPeriod: SYNTHETIC_PERIOD,
        },
      },
    ],
  },
};

const SYNTHETIC_BAL_DECISION: ExportCompanyDecision = {
  companyId: "BAL",
  salesPlans: SYNTHETIC_SALES_PLANS,
  domesticPurchasePlan: {
    companyId: "BAL",
    desiredQuantity: 3000,
    priceAdjustmentUsdPerHosoEqKg: 0.1,
    procurementHeadcount: 4,
    factoryCommonProcessingCapacityTons: 18810,
    farmerRelationship: 50,
    paymentReliability: 60,
    approvedPurchaseCap: null,
  },
  importOrders: [
    {
      companyId: "BAL",
      originCountry: "IN",
      orderedQuantity: 3000,
      orderedPeriod: SYNTHETIC_PERIOD,
      leadTimeTurns: null,
      maxLandedPriceUsdPerHosoEqKg: null,
    },
  ],
  aquacultureStockingPlans: [],
  productionPlans: [],
  workerAssignments: [],
  financingRequest: {
    desiredAmountUsd: 10000000,
    desiredLoanType: "longTerm",
    desiredTermQuarters: 8,
    desiredRepaymentMethod: "equalPrincipal",
    desiredPrepaymentUsd: 0,
    emergencyAcceptable: false,
  },
  capexDecision: { companyId: "BAL", newProjectProposals: [], cancelProjectIds: [], resumeProjectIds: [] },
};

/**
 * §6 会社スコープの意思決定情報。他社の非公開意思決定を一切含まない形（対象会社1社ぶんのみ）。
 * aiProposal は確定履歴に未保存のため null＋理由文という実際のDTO出力形状を再現する。
 */
const SYNTHETIC_DECISION_INFO: ExportCompanyDecisionInfo = {
  isPlayerCompany: true,
  submission: SYNTHETIC_BAL_DECISION,
  aiProposal: null,
  diffFromAiProposal: null,
  aiProposalUnavailableReason: "テスト用の理由文（確定履歴に未保存）",
  reasonCodes: [{ code: "SALES_FORCE_SHORTAGE", companyId: "BAL", message: "営業人員が不足しています" }],
};

/**
 * 合成CompanyExportPayloadを組み立てる。overridesで任意のフィールドを差し替えられる
 * （例: salesContracts: [] で0件時の表示を確認する）。
 */
export function buildSyntheticCompanyExportPayload(
  overrides: Partial<CompanyExportPayload> = {},
): CompanyExportPayload {
  const base: CompanyExportPayload = {
    meta: {
      schemaVersion: 1,
      generatedAt: "2026-07-26T00:00:00.000Z",
      labId: "synthetic-lab",
      turn: 1,
      period: SYNTHETIC_PERIOD,
      engineVersion: "test-engine",
      dataStatus: "confirmed",
      scope: { kind: "company", companyId: "BAL" },
    },
    financialResult: {
      companyId: "BAL",
      period: SYNTHETIC_PERIOD,
      profitAndLoss: {
        companyId: "BAL",
        period: SYNTHETIC_PERIOD,
        grossRevenue: 1000,
        qualitySalesDeduction: 10,
        netRevenue: 990,
        costOfSales: {
          rawMaterialCost: 300,
          processingCost: 100,
          laborCost: 80,
          factoryFixedCost: 60,
          reworkCost: 5,
          discardLoss: 3,
          unabsorbedFixedManufacturingCost: 0,
          idleLaborCost: 2,
          capexMaintenanceCost: 0,
        },
        totalCostOfSales: 550,
        grossProfit: 440,
        sellingGeneralAdmin: 100,
        operatingProfit: 340,
        interestExpense: 10,
        profitBeforeTax: 330,
        incomeTax: 30,
        netIncome: 300,
      },
      balanceSheet: {
        companyId: "BAL",
        period: SYNTHETIC_PERIOD,
        cash: 500,
        accountsReceivable: 200,
        rawMaterialInventory: 100,
        finishedGoodsInventory: 100,
        otherCurrentAssets: 50,
        fixedAssetsNet: 800,
        constructionInProgress: 0,
        totalAssets: 1750,
        accountsPayable: 150,
        shortTermLoans: 100,
        longTermLoans: 200,
        accruedInterestPayable: 0,
        otherLiabilities: 50,
        totalLiabilities: 500,
        capitalStock: 900,
        retainedEarnings: 350,
        totalEquity: 1250,
        totalLiabilitiesAndEquity: 1750,
        balanceDifference: 0,
      },
      cashFlow: {
        companyId: "BAL",
        period: SYNTHETIC_PERIOD,
        operatingDirect: {
          receiptsFromCustomers: 900,
          paymentsForRawMaterials: -300,
          paymentsForManufacturing: -180,
          paymentsForSellingGeneralAdmin: -100,
          interestPaid: -10,
          incomeTaxPaid: -30,
        },
        operatingCashFlow: 280,
        investingCashFlow: -50,
        financingCashFlow: 20,
        netCashChange: 250,
        openingCash: 250,
        closingCash: 500,
        indirectReconciliation: {
          netIncome: 300,
          depreciationAddback: 50,
          increaseInReceivables: -20,
          increaseInPayables: 10,
          increaseInInventory: -60,
          increaseInAccruedInterestPayable: 0,
          operatingCashFlowIndirect: 280,
        },
        directIndirectDifference: 0,
      },
      cashShortfall: false,
      cashShortfallAmount: 0,
      negativeEquity: false,
    },
    financingResult: null,
    capexResult: null,
    companySummary: null,
    salesContracts: [],
    contractFulfillmentUsage: SYNTHETIC_FULFILLMENT_USAGE,
    salesPlans: SYNTHETIC_SALES_PLANS,
    marketProductAllocations: SYNTHETIC_MARKET_PRODUCT_ALLOCATIONS,
    market: SYNTHETIC_MARKET,
    operations: SYNTHETIC_OPERATIONS,
    decisionInfo: SYNTHETIC_DECISION_INFO,
  };
  return { ...base, ...overrides };
}
