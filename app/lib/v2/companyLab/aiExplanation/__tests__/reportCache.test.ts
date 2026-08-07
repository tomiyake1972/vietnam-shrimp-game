// ShrimpX V2 — Standard AI経営説明レポート機能 キャッシュのテスト（MVP）

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../redis/companyLabTypes";
import { buildExplanationCacheKey, computeContextHash, loadCachedReport, saveReport, StoredExplanationReport } from "../reportCache";
import { ExplanationContext } from "../buildExplanationContext";

function createInMemoryRedisClient(): CompanyLabRedisClient {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key) : null),
    set: async (key: string, value: string, options?: CompanyLabRedisSetOptions) => {
      if (options?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    del: async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    eval: async () => {
      throw new Error("not used in this test");
    },
    zrange: async () => [],
  };
}

function baseContext(overrides: Partial<ExplanationContext["standardAi"]> = {}): ExplanationContext {
  return {
    identity: {
      labId: "lab-1",
      companyId: "A",
      turn: 1,
      year: 2015,
      quarter: 1,
      scenarioId: "baseline",
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      contextSchemaVersion: 1,
    },
    ownState: {
      balanceSheet: {
        cashUsd: 100,
        totalAssetsUsd: 100,
        totalLiabilitiesUsd: 0,
        totalEquityUsd: 100,
        receivablesUsd: 0,
        receivablesCount: 0,
        payablesUsd: 0,
        payablesCount: 0,
        shortTermLoansUsd: 0,
        longTermLoansUsd: 0,
        accruedInterestPayableUsd: 0,
        activeLoanCount: 0,
      },
      contractBacklog: [],
      rawMaterialInventory: { totalTons: 0, groups: [] },
      finishedGoodsInventoryUsd: 0,
      factoryCapacity: [],
      productionCapacitySummary: { nominalTotalTons: 0, effectiveTotalTons: 0, bindingTotalTons: 0, bindingConstraintLabel: "商品別実効能力" },
      laborProductivity: [],
      workforce: { totalRegularHeadcount: 0, byFactory: [] },
      salesForce: { headcountTotal: 0, coverageScore: 0, currentProcessingCapacityTons: 0 },
      qualityScoreByProduct: {},
      customerTrustByMarket: {},
      deliveryReliabilityByMarket: {},
    },
    marketInfo: {
      hasPriorMarketData: false,
      dataLimitationNote: "turn1のため前四半期データなし",
      vietnamDomesticPriorPriceUsd: null,
      vietnamDomesticPriorMarket: null,
      lifecycleTrends: null,
      supplyPressure: null,
    },
    standardAi: {
      decision: {
        companyId: "A" as never,
        salesPlans: [],
        domesticPurchasePlan: { quantity: 0 } as never,
        importOrders: [],
        aquacultureStockingPlans: [],
        productionPlans: [],
        workerAssignments: [],
        financingRequest: {} as never,
        capexDecision: { newProposals: [], cancelRequests: [], resumeRequests: [] } as never,
      },
      diagnosticEntries: [],
      ...overrides,
    },
  };
}

test("computeContextHash: 同一内容なら常に同じハッシュになる(順序を変えても安定)", () => {
  const context1 = baseContext();
  const context2 = JSON.parse(JSON.stringify(context1)) as ExplanationContext;
  assert.equal(computeContextHash(context1), computeContextHash(context2));
});

test("computeContextHash: standardAi.diagnosticEntriesが変わればハッシュも変わる", () => {
  const context1 = baseContext();
  const context2 = baseContext({
    diagnosticEntries: [
      { code: "CASH_BUFFER_SHORTAGE" as never, domain: "finance" as never, companyId: "A", severity: "warning" as never, message: "テスト" },
    ],
  });
  assert.notEqual(computeContextHash(context1), computeContextHash(context2));
});

test("buildExplanationCacheKey: 同一入力なら常に同じキー文字列(安定性)", () => {
  const context = baseContext();
  const contextHash = computeContextHash(context);
  const key1 = buildExplanationCacheKey({
    labId: "lab-1",
    companyId: "A",
    turn: 1,
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash,
  });
  const key2 = buildExplanationCacheKey({
    labId: "lab-1",
    companyId: "A",
    turn: 1,
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash,
  });
  assert.equal(key1, key2);
  assert.match(key1, /^companylab:v2:lab-1:A:1:aiExplanation:v1:1:[0-9a-f]{64}$/);
});

test("buildExplanationCacheKey: contextHashが変わればキーも変わる(古いレポートを誤って再利用しない)", () => {
  const contextA = baseContext();
  const contextB = baseContext({
    diagnosticEntries: [
      { code: "CASH_BUFFER_SHORTAGE" as never, domain: "finance" as never, companyId: "A", severity: "warning" as never, message: "テスト" },
    ],
  });
  const keyA = buildExplanationCacheKey({
    labId: "lab-1",
    companyId: "A",
    turn: 1,
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash: computeContextHash(contextA),
  });
  const keyB = buildExplanationCacheKey({
    labId: "lab-1",
    companyId: "A",
    turn: 1,
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash: computeContextHash(contextB),
  });
  assert.notEqual(keyA, keyB);
});

test("loadCachedReport: 未保存キーはnullを返す(load-miss)", async () => {
  const client = createInMemoryRedisClient();
  const result = await loadCachedReport(client, "companylab:v2:lab-1:A:1:aiExplanation:v1:1:doesnotexist");
  assert.equal(result, null);
});

test("saveReport→loadCachedReport: 保存した内容がそのまま往復する", async () => {
  const client = createInMemoryRedisClient();
  const key = "companylab:v2:lab-1:A:1:aiExplanation:v1:1:abc123";
  const stored: StoredExplanationReport = {
    generatedAt: "2026-08-01T00:00:00.000Z",
    result: "success",
    report: {
      headline: "見出し",
      executiveSummary: "要約",
      recommendations: [],
      keyRisks: [],
      questionsForPlayer: [],
      dataLimitations: [],
    },
    model: "claude-sonnet-4-6",
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash: "abc123",
  };
  await saveReport(client, key, stored);
  const loaded = await loadCachedReport(client, key);
  assert.deepEqual(loaded, stored);
});

test("saveReport: 失敗結果(result=failure)も保存・復元できる", async () => {
  const client = createInMemoryRedisClient();
  const key = "companylab:v2:lab-1:A:1:aiExplanation:v1:1:failcase";
  const stored: StoredExplanationReport = {
    generatedAt: "2026-08-01T00:00:00.000Z",
    result: "failure",
    errorCategory: "missing_api_key",
    model: "claude-sonnet-4-6",
    promptVersion: "v1",
    contextSchemaVersion: 1,
    contextHash: "failcase",
  };
  await saveReport(client, key, stored);
  const loaded = await loadCachedReport(client, key);
  assert.deepEqual(loaded, stored);
});
