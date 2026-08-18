// AMM-OPS-1..10（AMM-M2.4・実装指示§11）— Operational KPI Semantic Grounding / Forward
// Obligation Risk。
//
// 【背景】Test26 BAL Turn4「現在の当社業績を分析して」で、equipmentUtilization(47.44%)と
// laborUtilization(95.32%)の混同、company-wide equipment utilizationだけでは見えない
// PDの局所的equipment shortage(1,015t)、rawMaterial/equipment/laborのshortfall優先順位
// 不明確、在庫種別の混同、regular/temporary worker混同、interest-bearing debtと
// total liabilitiesの混同が残っていた。本テストはoperationalSemantics.ts・briefing.ts・
// prompt.tsがこれらを構造的に分離することを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBottleneckPacket,
  buildInventoryPacket,
  buildUtilizationPacket,
  buildWorkforcePacket,
  computeBottleneckHierarchy,
} from "../operationalSemantics";
import { CompanyQuarterSummary } from "../../types";
import { ProductionAllocationEntry, WorkerAssignment } from "../../../production/types";
import { ratio, hosoEqTons } from "../../../core/units";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { buildExecutiveBriefingPacket, RULE_SEMANTICS } from "../briefing";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";

function summary(overrides: Partial<CompanyQuarterSummary> = {}): CompanyQuarterSummary {
  return {
    companyId: "BAL",
    period: "2015Q4",
    newContractedQuantity: hosoEqTons(0),
    newContractedAveragePrice: 0,
    fulfilledQuantity: hosoEqTons(0),
    outstandingQuantity: hosoEqTons(0),
    overdueQuantity: hosoEqTons(0),
    domesticPurchaseQuantity: hosoEqTons(0),
    domesticPurchasePrice: 0,
    importInTransitQuantity: hosoEqTons(0),
    importArrivedQuantity: hosoEqTons(0),
    aquacultureGrowingQuantity: hosoEqTons(0),
    aquacultureHarvestedQuantity: hosoEqTons(0),
    rawMaterialInventory: hosoEqTons(0),
    hosoProduced: hosoEqTons(0),
    pdProduced: hosoEqTons(0),
    vapProduced: hosoEqTons(0),
    finishedGoodsInventory: hosoEqTons(0),
    rawMaterialShortfall: hosoEqTons(0),
    equipmentShortfall: hosoEqTons(0),
    laborShortfall: hosoEqTons(0),
    equipmentUtilizationRate: ratio(0),
    laborUtilizationRate: ratio(0),
    overtimeRate: ratio(0),
    temporaryWorkerShare: ratio(0),
    qualityScoreByProduct: {},
    operationalRiskByProduct: {},
    downgradeQuantity: hosoEqTons(0),
    reworkQuantity: hosoEqTons(0),
    discardQuantity: hosoEqTons(0),
    majorIncidentCount: 0,
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    rampWarnings: [],
    reasonCodes: [],
    ...overrides,
  } as unknown as CompanyQuarterSummary;
}

function workerAssignment(overrides: Partial<WorkerAssignment>): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "BAL",
    regularHeadcount: 0,
    temporaryHeadcount: 0,
    skills: [],
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
    ...overrides,
  } as unknown as WorkerAssignment;
}

function productionEntry(overrides: Partial<ProductionAllocationEntry>): ProductionAllocationEntry {
  return {
    companyId: "BAL",
    factoryId: "F1",
    product: "hoso",
    priority: 1,
    desiredQuantity: hosoEqTons(0),
    allocatedQuantity: hosoEqTons(0),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    requiredRawMaterialQuantity: hosoEqTons(0),
    stages: {
      rawMaterialLimited: hosoEqTons(0),
      commonCapacityLimited: hosoEqTons(0),
      freezingPackagingLimited: hosoEqTons(0),
      productCapacityLimited: hosoEqTons(0),
      laborLimited: hosoEqTons(0),
    },
    labor: { assignedRegularHeadcount: 0, assignedTemporaryHeadcount: 0 },
    ...overrides,
  } as unknown as ProductionAllocationEntry;
}

test("AMM-OPS-1: equipmentUtilization != laborUtilizationが別フィールドとして保持される", () => {
  const s = summary({ equipmentUtilizationRate: ratio(0.4744), laborUtilizationRate: ratio(0.9532) });
  const packet = buildUtilizationPacket(s, "2015年Q4");
  assert.ok(Math.abs(packet.equipmentUtilizationRate - 0.4744) < 1e-9);
  assert.ok(Math.abs(packet.laborUtilizationRate - 0.9532) < 1e-9);
  assert.notEqual(packet.equipmentUtilizationRate, packet.laborUtilizationRate);
  // promptにも「utilization」への一括表現禁止が明記されている。
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /「utilization」と一括して表現してはいけません/);
});

test("AMM-OPS-2: overtimeRateがexact groundingされる", () => {
  const s = summary({ overtimeRate: ratio(0.0821) });
  const packet = buildUtilizationPacket(s, "2015年Q4");
  assert.ok(Math.abs(packet.overtimeRate - 0.0821) < 1e-9);
});

test("AMM-OPS-3: ending raw material inventoryがexact groundingされる（0tのケースを含む）", () => {
  const s = summary({ rawMaterialInventory: hosoEqTons(0) });
  const packet = buildInventoryPacket(s, null, "2015年Q4");
  assert.equal(packet.endingRawMaterialInventoryTons, 0);
  assert.equal(packet.openingRawMaterialInventoryTons, null);
});

test("AMM-OPS-4: regular/temporary workerが別項目として保持される（存在しない人数を作らない）", () => {
  const assignments: WorkerAssignment[] = [
    workerAssignment({ factoryId: "F1", regularHeadcount: 2500, temporaryHeadcount: 300 }),
    workerAssignment({ factoryId: "F2", regularHeadcount: 1640, temporaryHeadcount: 275 }),
  ];
  const s = summary({ overtimeRate: ratio(0.0821) });
  const packet = buildWorkforcePacket(assignments, s, "2015年Q4");
  assert.equal(packet.regularWorkers, 4140);
  assert.equal(packet.temporaryWorkers, 575);
  assert.notEqual(packet.regularWorkers, packet.regularWorkers + packet.temporaryWorkers);
});

test("AMM-OPS-5: primary bottleneckはlost production（shortfall量）の最大値で判定される", () => {
  const h = computeBottleneckHierarchy(3074.72, 1015, 0);
  assert.equal(h.primary, "RAW_MATERIAL");
  assert.equal(h.secondary, "EQUIPMENT");

  const s = summary({ rawMaterialShortfall: hosoEqTons(3074.72), equipmentShortfall: hosoEqTons(1015), laborShortfall: hosoEqTons(0) });
  const packet = buildBottleneckPacket(s, [], "2015年Q4");
  assert.equal(packet.primaryBottleneck, "RAW_MATERIAL");
  assert.equal(packet.secondaryBottleneck, "EQUIPMENT");
  // laborShortageTons=0の場合は「稼働率は高いがlost productionは無い」と表現できるよう、labor自体はNONEに含まれない別フィールドとして残る。
  assert.equal(packet.laborShortageTons, 0);
});

test("AMM-OPS-6: 商品別equipment bottleneckがcompany-wide utilizationとは別に区別される", () => {
  const entries: ProductionAllocationEntry[] = [
    productionEntry({ product: "pd", shortfallQuantity: hosoEqTons(1015), shortfallReasons: ["productCapacityShortage"] as never }),
    productionEntry({ product: "hoso", shortfallQuantity: hosoEqTons(0), shortfallReasons: [] }),
  ];
  const s = summary({ equipmentShortfall: hosoEqTons(1015) });
  const packet = buildBottleneckPacket(s, entries, "2015年Q4");
  const pd = packet.productBottlenecks.find((p) => p.product === "pd");
  assert.ok(pd);
  assert.equal(pd?.equipmentShortageTons, 1015);
  const hoso = packet.productBottlenecks.find((p) => p.product === "hoso");
  assert.equal(hoso, undefined); // shortfall=0のentryはbottleneckとして計上されない
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /PDラインには局所的な能力制約/);
});

test("AMM-OPS-7: forward backlog(healthy)とoverdueは別概念として明示される", () => {
  assert.match(RULE_SEMANTICS.futureDeliveryObligation, /overdueTonsが0/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /納期遅延[\s\S]*履行遅延[\s\S]*納期未達[\s\S]*契約違反が既に発生[\s\S]*Trustを既に毀損/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /future delivery obligation/);
});

test("AMM-OPS-8: future obligation riskはFACT→JUDGMENTの順序で、現在の遅延と主張せずに述べられる", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /US PD 4,000tが来期納期[\s\S]*fulfillment riskが/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /FACTとJUDGMENTを混ぜて、リスクをあたかも/);
});

test("AMM-OPS-9: interest-bearing debtとtotal liabilitiesが別フィールドとして保持される", () => {
  const context = minimalContext();
  const packet = buildExecutiveBriefingPacket({
    context,
    previousQuarter: null,
    playerDraft: null,
    contracts: [],
    receivables: [],
    payables: [],
    loans: [],
    capexProjects: [],
    borrowingHeadroom: null,
    crisis: null,
    financialHistory: { reportingPeriod: null, priorPeriod: null },
    operationalHistory: { reportingPeriod: null, priorPeriod: null },
  });
  assert.ok(Math.abs(packet.cfo.interestBearingDebtUsd - 49_046_000) < 1);
  assert.ok(Math.abs(packet.cfo.totalLiabilitiesUsd - 64_000_000) < 1);
  assert.notEqual(packet.cfo.interestBearingDebtUsd, packet.cfo.totalLiabilitiesUsd);
  assert.match(RULE_SEMANTICS.interestBearingDebt, /totalLiabilities.*とは別/);
});

test("AMM-OPS-10: Test26 BAL Turn4 fixture — 実データによるutilization/bottleneck/inventory/workforceの再現", () => {
  const s = summary({
    equipmentUtilizationRate: ratio(0.4744),
    laborUtilizationRate: ratio(0.9532),
    overtimeRate: ratio(0.0821),
    rawMaterialShortfall: hosoEqTons(3074.72),
    equipmentShortfall: hosoEqTons(1015),
    laborShortfall: hosoEqTons(0),
    rawMaterialInventory: hosoEqTons(0),
  });
  const assignments: WorkerAssignment[] = [workerAssignment({ regularHeadcount: 4140, temporaryHeadcount: 575 })];
  const entries: ProductionAllocationEntry[] = [
    productionEntry({ product: "pd", shortfallQuantity: hosoEqTons(1015), shortfallReasons: ["productCapacityShortage"] as never }),
  ];

  const utilization = buildUtilizationPacket(s, "2015年Q4");
  const bottleneck = buildBottleneckPacket(s, entries, "2015年Q4");
  const inventory = buildInventoryPacket(s, null, "2015年Q4");
  const workforce = buildWorkforcePacket(assignments, s, "2015年Q4");

  assert.ok(Math.abs(utilization.equipmentUtilizationRate - 0.4744) < 1e-9);
  assert.ok(Math.abs(utilization.laborUtilizationRate - 0.9532) < 1e-9);
  assert.equal(bottleneck.primaryBottleneck, "RAW_MATERIAL");
  assert.equal(bottleneck.secondaryBottleneck, "EQUIPMENT");
  assert.equal(bottleneck.productBottlenecks[0]?.product, "pd");
  assert.equal(bottleneck.productBottlenecks[0]?.equipmentShortageTons, 1015);
  assert.equal(inventory.endingRawMaterialInventoryTons, 0);
  assert.equal(workforce.regularWorkers, 4140);
  assert.equal(workforce.temporaryWorkers, 575);
});

function minimalContext(): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "BAL",
      turn: 5,
      year: 2015,
      quarter: 4,
      scenarioId: "baseline",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v5",
      contextSchemaVersion: 2,
    },
    ownState: {
      balanceSheet: {
        cashUsd: 41_196_000,
        totalAssetsUsd: 150_000_000,
        totalLiabilitiesUsd: 64_000_000,
        totalEquityUsd: 86_000_000,
        receivablesUsd: 60_000_000,
        receivablesCount: 4,
        payablesUsd: 5_000_000,
        payablesCount: 3,
        shortTermLoansUsd: 25_046_000,
        longTermLoansUsd: 24_000_000,
        accruedInterestPayableUsd: 0,
        activeLoanCount: 2,
      },
      contractBacklog: [],
      rawMaterialInventory: { totalTons: 0, groups: [] },
      finishedGoodsInventoryUsd: 40_000,
      factoryCapacity: [],
      productionCapacitySummary: { nominalTotalTons: 8000, effectiveTotalTons: 6700, bindingTotalTons: 6700, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [],
      workforce: { totalRegularHeadcount: 4140, byFactory: [] },
      salesForce: { headcountTotal: 20, coverageScore: 0.7, currentProcessingCapacityTons: 5000 },
      qualityScoreByProduct: { hoso: 76.99, pd: 77.1, vap: 77.26 },
      customerTrustByMarket: { US: 56.5, EU: 56.5, JP: 56.5, OTHER: 56.5 },
      deliveryReliabilityByMarket: { US: 90, EU: 90, JP: 90, OTHER: 90 },
    },
    marketInfo: {
      hasPriorMarketData: false,
      dataLimitationNote: null,
      vietnamDomesticPriorPriceUsd: null,
      vietnamDomesticPriorMarket: null,
      lifecycleTrends: null,
      supplyPressure: [],
    },
    standardAi: { decision: {} as never, diagnosticEntries: [] as never },
  };
}
