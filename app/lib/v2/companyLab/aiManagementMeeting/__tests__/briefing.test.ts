// AMM-8: briefing-uses-existing-facts-only — Packetの中身がExplanationContextの実在フィールド
//        だけから機械的に導出されていること（捏造フィールドが無いこと）を確認する。
// AMM-16: deterministic-briefing-construction — 同一入力からは常に同一Packetが得られること。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutiveBriefingPacket } from "../briefing";
import { ExplanationContext } from "../../aiExplanation/buildExplanationContext";

function minimalContext(): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "BAL",
      turn: 3,
      year: 2015,
      quarter: 3,
      scenarioId: "baseline",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v3",
      contextSchemaVersion: 2,
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
      contractBacklog: [
        { market: "JP", product: "pd", outstandingTons: 120, contractCount: 4, nearestDueDateLabel: "2015Q4" },
        { market: "US", product: "hoso", outstandingTons: 40, contractCount: 1, nearestDueDateLabel: "2015Q3" },
      ],
      rawMaterialInventory: { totalTons: 300, groups: [{ availableFromLabel: "現在利用可能", quantityTons: 300, lotCount: 2 }] },
      finishedGoodsInventoryUsd: 40_000,
      factoryCapacity: [
        {
          factoryId: "F1",
          nominal: { hoso: 5000, pd: 2000, vap: 1000, commonProcessing: 8000, freezingPackaging: 8000 },
          effective: { hoso: 4000, pd: 1800, vap: 900, commonProcessing: 7000, freezingPackaging: 7000 },
        },
      ],
      productionCapacitySummary: { nominalTotalTons: 8000, effectiveTotalTons: 6700, bindingTotalTons: 6700, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [{ factoryId: "F1", product: "hoso", tonsPerRegularWorker: 10 }],
      workforce: { totalRegularHeadcount: 200, byFactory: [{ factoryId: "F1", regularHeadcount: 200 }] },
      salesForce: { headcountTotal: 20, coverageScore: 0.7, currentProcessingCapacityTons: 5000 },
      qualityScoreByProduct: { hoso: 80, pd: 75, vap: 90 },
      customerTrustByMarket: { JP: 70, US: 60 },
      deliveryReliabilityByMarket: { JP: 95, US: 88 },
    },
    marketInfo: {
      hasPriorMarketData: true,
      dataLimitationNote: null,
      vietnamDomesticPriorPriceUsd: 5.2,
      vietnamDomesticPriorMarket: { supplyTons: 1000, effectiveDemandTons: 900, transactedVolumeTons: 850, unsoldSupplyTons: 150 },
      lifecycleTrends: [],
      supplyPressure: [],
    },
    standardAi: {
      decision: {} as never,
      diagnosticEntries: [
        { code: "CAPEX_DEFERRED", domain: "capex", companyId: "BAL", severity: "high", keyValues: { shortfallRatio: 1.2 }, targetFactoryId: "F1" },
        { code: "SALES_PLAN_SUBMITTED", domain: "sales", companyId: "BAL", severity: "low" },
      ] as never,
    },
  };
}

test("AMM-8: briefingは既存Contextのフィールドだけから構築される（捏造なし）", () => {
  const context = minimalContext();
  const packet = buildExecutiveBriefingPacket({ context, previousQuarter: null, playerDraft: null, contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null });

  assert.equal(packet.common.companyId, context.identity.companyId);
  assert.equal(packet.common.cashUsd, context.ownState.balanceSheet.cashUsd);
  assert.equal(packet.common.bindingCapacityTons, context.ownState.productionCapacitySummary.bindingTotalTons);
  assert.equal(packet.cfo.totalAssetsUsd, context.ownState.balanceSheet.totalAssetsUsd);
  assert.equal(packet.coo.totalRegularHeadcount, context.ownState.workforce.totalRegularHeadcount);
  assert.equal(packet.commercial.salesForceHeadcountTotal, context.ownState.salesForce.headcountTotal);
  // 診断エントリのreasonCodeがそのまま転記されている（新しいコードを作っていない）。
  assert.deepEqual(
    packet.common.standardAiReasonCodesTopN.map((r) => r.code),
    ["CAPEX_DEFERRED", "SALES_PLAN_SUBMITTED"]
  );
});

test("AMM-16: 同一入力からは常に同一Packetが得られる（決定論的）", () => {
  const context = minimalContext();
  const a = buildExecutiveBriefingPacket({ context, previousQuarter: null, playerDraft: null, contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null });
  const b = buildExecutiveBriefingPacket({ context, previousQuarter: null, playerDraft: null, contracts: [], receivables: [], payables: [], loans: [], capexProjects: [], borrowingHeadroom: null, crisis: null });
  assert.deepEqual(a, b);
});
