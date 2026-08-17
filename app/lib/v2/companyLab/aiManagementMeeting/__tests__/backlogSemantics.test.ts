// AMM-M2.1: Backlog Semantics / Fact Grounding tests
//
// AMM-BL-1: backlog > 0 / overdue = 0 → delayed/overdueとして扱うfactを生成しない
// AMM-BL-2: healthy forward backlogの数量が正しい
// AMM-BL-3: overdue > 0の場合のみoverdue fact生成
// AMM-BL-4: dueTurnを保持
// AMM-BL-5: market/product別合計 = total backlog
// AMM-BL-6: Trust deteriorationをbacklogだけから断定しない（構造・prompt双方を検証）
// AMM-BL-7: Test26 BAL Turn1 fixture相当
// AMM-BL-8: supplyPressureCount semantics（humanMeaning付与、生countの除去）
// AMM-BL-9: turn/quarter label正確性

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBacklogSemantics } from "../backlogSemantics";
import { buildExecutiveBriefingPacket } from "../briefing";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";
import { SalesContract } from "../../../sales/types";

function contract(overrides: Partial<SalesContract>): SalesContract {
  return {
    contractId: "c1",
    companyId: "BAL",
    market: "JP",
    product: "hoso",
    contractedPeriod: "2015Q1" as never,
    dueDate: "2015Q2" as never,
    originalQuantity: 100 as never,
    outstandingQuantity: 100 as never,
    unitPrice: 3.5 as never,
    status: "active" as never,
    ...overrides,
  };
}

function minimalContext(overrides: Partial<ExplanationContext["identity"]> = {}): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "BAL",
      turn: 1,
      year: 2015,
      quarter: 1,
      scenarioId: "baseline",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v3",
      contextSchemaVersion: 2,
      ...overrides,
    },
    ownState: {
      balanceSheet: {
        cashUsd: 500_000,
        totalAssetsUsd: 2_000_000,
        totalLiabilitiesUsd: 800_000,
        totalEquityUsd: 1_200_000,
        receivablesUsd: 100_000,
        receivablesCount: 3,
        payablesUsd: 50_000,
        payablesCount: 2,
        shortTermLoansUsd: 200_000,
        longTermLoansUsd: 300_000,
        accruedInterestPayableUsd: 1_000,
        activeLoanCount: 2,
      },
      contractBacklog: [],
      rawMaterialInventory: { totalTons: 300, groups: [] },
      finishedGoodsInventoryUsd: 40_000,
      factoryCapacity: [],
      productionCapacitySummary: { nominalTotalTons: 8000, effectiveTotalTons: 6700, bindingTotalTons: 6700, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [],
      workforce: { totalRegularHeadcount: 200, byFactory: [] },
      salesForce: { headcountTotal: 20, coverageScore: 0.7, currentProcessingCapacityTons: 5000 },
      qualityScoreByProduct: { hoso: 80, pd: 75, vap: 90 },
      customerTrustByMarket: { JP: 70, US: 60 },
      deliveryReliabilityByMarket: { JP: 95, US: 88 },
    },
    marketInfo: {
      hasPriorMarketData: false,
      dataLimitationNote: null,
      vietnamDomesticPriorPriceUsd: null,
      vietnamDomesticPriorMarket: null,
      lifecycleTrends: null,
      supplyPressure: [
        { product: "pd", value: 0.02, label: "balanced" },
        { product: "vap", value: 0.15, label: "oversupply" },
      ] as never,
    },
    standardAi: { decision: {} as never, diagnosticEntries: [] as never },
  };
}

test("AMM-BL-1: backlog > 0 / overdue = 0 → overdueTons=0で、遅延を示すfactは生成されない", () => {
  const contracts = [contract({ market: "JP", product: "hoso", outstandingQuantity: 500 as never, dueDate: "2015Q2" as never })];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.equal(semantics.totalTons, 500);
  assert.equal(semantics.overdueTons, 0);
  assert.equal(semantics.healthyForwardTons, 500);
});

test("AMM-BL-2: healthy forward backlogの数量が正しい（納期未到来分の合計と一致）", () => {
  const contracts = [
    contract({ market: "JP", product: "hoso", outstandingQuantity: 300 as never, dueDate: "2015Q2" as never }),
    contract({ market: "US", product: "pd", outstandingQuantity: 200 as never, dueDate: "2015Q3" as never }),
  ];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.equal(semantics.healthyForwardTons, 500);
  assert.equal(semantics.overdueTons, 0);
  assert.equal(semantics.dueThisTurnTons, 0);
});

test("AMM-BL-3: overdue > 0の場合のみoverdueが計上される（納期超過分だけを分離）", () => {
  const contracts = [
    contract({ market: "JP", product: "hoso", outstandingQuantity: 100 as never, dueDate: "2014Q4" as never }), // overdue（currentは2015Q1）
    contract({ market: "US", product: "pd", outstandingQuantity: 200 as never, dueDate: "2015Q2" as never }), // healthy forward
    contract({ market: "EU", product: "vap", outstandingQuantity: 50 as never, dueDate: "2015Q1" as never }), // due this turn
  ];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.equal(semantics.overdueTons, 100);
  assert.equal(semantics.dueThisTurnTons, 50);
  assert.equal(semantics.healthyForwardTons, 200);
  assert.equal(semantics.totalTons, 350);
});

test("AMM-BL-4: dueTurn（納期）情報がbyMarketProductエントリへ保持される", () => {
  const contracts = [contract({ market: "JP", product: "hoso", outstandingQuantity: 100 as never, dueDate: "2015Q3" as never })];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.equal(semantics.byMarketProduct.length, 1);
  assert.equal(semantics.byMarketProduct[0].earliestDueLabel, "2015年Q3");
});

test("AMM-BL-5: market別合計・product別合計はいずれもtotal backlogと一致する", () => {
  const contracts = [
    contract({ market: "JP", product: "hoso", outstandingQuantity: 300 as never, dueDate: "2015Q2" as never }),
    contract({ market: "US", product: "pd", outstandingQuantity: 200 as never, dueDate: "2014Q4" as never }),
    contract({ market: "JP", product: "vap", outstandingQuantity: 50 as never, dueDate: "2015Q1" as never }),
  ];
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  const marketSum = semantics.byMarket.reduce((s, m) => s + m.totalTons, 0);
  const productSum = semantics.byProduct.reduce((s, p) => s + p.totalTons, 0);
  assert.equal(marketSum, semantics.totalTons);
  assert.equal(productSum, semantics.totalTons);
});

test("AMM-BL-6: BriefingPacketにbacklogからTrust悪化を直接断定するfieldは存在せず、promptにも根拠なき断定禁止が明記されている", () => {
  const context = minimalContext();
  const packet = buildExecutiveBriefingPacket({ context, previousQuarter: null, playerDraft: null, contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null, financialHistory: { reportingPeriod: null, priorPeriod: null } });
  // customerTrustByMarket/deliveryReliabilityByMarketは既存の実測値としてそのまま渡るが、
  // backlogとtrustを結合した「trustRiskFromBacklog」のような派生フィールドは存在しないこと。
  assert.equal((packet.commercial as unknown as Record<string, unknown>).trustRiskFromBacklog, undefined);
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("backlogの残高（healthy forward分を含む）"));
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("Backlog（受注残） != Overdue（納期超過）"));
  assert.ok(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT.includes("outstanding残高（backlogの合計）だけからoverdue状態を推測してはいけません"));
});

test("AMM-BL-7: Test26 BAL Turn1 fixture相当（total 3063.42, overdue 0, US/EU/JP/OTHER HOSO future due）", () => {
  const contracts = [
    contract({ market: "US", product: "hoso", outstandingQuantity: 1367.43 as never, dueDate: "2015Q2" as never }),
    contract({ market: "EU", product: "hoso", outstandingQuantity: 588.3 as never, dueDate: "2015Q2" as never }),
    contract({ market: "JP", product: "hoso", outstandingQuantity: 336.51 as never, dueDate: "2015Q2" as never }),
    contract({ market: "OTHER", product: "hoso", outstandingQuantity: 771.18 as never, dueDate: "2015Q2" as never }),
  ];
  // Turn1は2015Q1（納期2015Q2はすべて1四半期先＝healthy forward、当四半期納期でもoverdueでもない）。
  const semantics = computeBacklogSemantics(contracts, "BAL", 2015, 1);
  assert.ok(Math.abs(semantics.totalTons - 3063.42) < 1e-6);
  assert.equal(semantics.overdueTons, 0);
  assert.equal(semantics.dueThisTurnTons, 0);
  assert.ok(Math.abs(semantics.healthyForwardTons - 3063.42) < 1e-6);
  assert.equal(semantics.byMarket.length, 4);
  assert.ok(semantics.byMarket.every((m) => m.overdueTons === 0));
});

test("AMM-BL-8: supplyPressureCountという生カウントは廃止され、product別のlabel+humanMeaningが渡される", () => {
  const context = minimalContext();
  const packet = buildExecutiveBriefingPacket({ context, previousQuarter: null, playerDraft: null, contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null, financialHistory: { reportingPeriod: null, priorPeriod: null } });
  assert.equal((packet.commercial as unknown as Record<string, unknown>).supplyPressureCount, undefined);
  assert.equal(packet.commercial.supplyPressureFacts.length, 2);
  const pd = packet.commercial.supplyPressureFacts.find((f) => f.product === "pd");
  assert.equal(pd?.label, "balanced");
  assert.ok(typeof pd?.humanMeaning === "string" && pd.humanMeaning.length > 0);
});

test("AMM-BL-9: turn/quarterラベルが正確（前四半期ラベルが今期と異なり、フォーマットが一致する）", () => {
  const context = minimalContext({ turn: 5, year: 2016, quarter: 1 });
  const packet = buildExecutiveBriefingPacket({
    context,
    previousQuarter: { cashUsd: 1, netRevenueUsd: 2, operatingProfitUsd: 3, periodLabel: "2015年Q4" },
    playerDraft: null,
    contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null, financialHistory: { reportingPeriod: null, priorPeriod: null } });
  assert.equal(packet.common.year, 2016);
  assert.equal(packet.common.quarter, 1);
  assert.equal(packet.commercial.lastQuarterLabel, "2015年Q4");
  assert.notEqual(packet.commercial.lastQuarterLabel, `${packet.common.year}年Q${packet.common.quarter}`);
});
