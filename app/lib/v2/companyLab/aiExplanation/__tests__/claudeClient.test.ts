// ShrimpX V2 — Standard AI経営説明レポート機能 Anthropicクライアントラッパーのテスト（MVP）
//
// 実Anthropic APIは一切呼ばない。AnthropicMessagesClientインターフェースをモックした
// フェイクだけを使う。ANTHROPIC_API_KEY等の実キー値は一切使わず、テスト用の
// 明らかに偽と分かるプレースホルダ文字列のみを使う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicMessageResponse, AnthropicMessagesClient, generateManagementReport } from "../claudeClient";
import { ExplanationContext } from "../buildExplanationContext";

const FAKE_API_KEY = "test-fake-key-not-real";

function minimalContext(): ExplanationContext {
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
    },
  };
}

const VALID_REPORT_JSON = JSON.stringify({
  headline: "テスト見出し",
  executiveSummary: "テスト要約",
  recommendations: [],
  keyRisks: [],
  questionsForPlayer: [],
  dataLimitations: [],
});

function textResponse(text: string): AnthropicMessageResponse {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } };
}

function makeClient(responses: readonly (AnthropicMessageResponse | Error)[]): { client: AnthropicMessagesClient; callCount: () => number } {
  let calls = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        const response = responses[calls];
        calls += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
  return { client, callCount: () => calls };
}

test("generateManagementReport: ANTHROPIC_API_KEY未設定ならmissing_api_key(例外を投げない、クライアント未注入時)", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await generateManagementReport(minimalContext());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorCategory, "missing_api_key");
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("generateManagementReport: 正常系(1回で成功)、usageが返る", async () => {
  const { client, callCount } = makeClient([textResponse(VALID_REPORT_JSON)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.report.headline, "テスト見出し");
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 20);
    assert.equal(result.usage.model, "claude-sonnet-4-6");
  }
  assert.equal(callCount(), 1);
});

test("generateManagementReport: 1回目が壊れたJSON、2回目成功→リトライにより成功扱い(呼び出しは2回)", async () => {
  const { client, callCount } = makeClient([textResponse("{not valid json"), textResponse(VALID_REPORT_JSON)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, true);
  assert.equal(callCount(), 2);
});

test("generateManagementReport: 2回とも壊れたJSON→最終的にinvalid_jsonで失敗、呼び出しはちょうど2回まで", async () => {
  const { client, callCount } = makeClient([textResponse("{not valid"), textResponse("{still not valid")]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "invalid_json");
  assert.equal(callCount(), 2);
});

test("generateManagementReport: スキーマ不一致(必須フィールド欠落)は1回目失敗→2回目も不一致ならschema_mismatch", async () => {
  const badJson = JSON.stringify({ executiveSummary: "見出しがありません" });
  const { client, callCount } = makeClient([textResponse(badJson), textResponse(badJson)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "schema_mismatch");
  assert.equal(callCount(), 2);
});

test("generateManagementReport: 空応答(テキストなし)はempty_response、その後リトライしても空ならempty_responseのまま", async () => {
  const { client, callCount } = makeClient([textResponse(""), textResponse("")]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "empty_response");
  assert.equal(callCount(), 2);
});

test("generateManagementReport: HTTPエラー(statusつき例外)はhttp_errorとして即座に失敗し、リトライしない(呼び出しは1回のみ)", async () => {
  const httpError = Object.assign(new Error("rate limited"), { status: 429 });
  const { client, callCount } = makeClient([httpError]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "http_error");
  assert.equal(callCount(), 1);
});

test("generateManagementReport: ネットワークエラー(statusなし例外)はnetwork_errorとして即座に失敗し、リトライしない(呼び出しは1回のみ)", async () => {
  const netError = new Error("ECONNRESET");
  const { client, callCount } = makeClient([netError]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "network_error");
  assert.equal(callCount(), 1);
});

test("generateManagementReport: エラー詳細にAPIキー値やヘッダーが含まれない(テスト用の偽キーで確認)", async () => {
  process.env.ANTHROPIC_API_KEY = FAKE_API_KEY;
  try {
    const httpError = Object.assign(new Error("unauthorized"), { status: 401 });
    const { client } = makeClient([httpError]);
    const result = await generateManagementReport(minimalContext(), client);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.detail?.includes(FAKE_API_KEY), false);
    }
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("getExplanationModelConfig: 環境変数未指定時は既定モデルを返す", async () => {
  const original = process.env.STANDARD_AI_EXPLANATION_MODEL;
  delete process.env.STANDARD_AI_EXPLANATION_MODEL;
  try {
    const { getExplanationModelConfig } = await import("../claudeClient");
    const config = getExplanationModelConfig();
    assert.equal(typeof config.model, "string");
    assert.equal(config.maxTokens, 1200);
  } finally {
    if (original !== undefined) process.env.STANDARD_AI_EXPLANATION_MODEL = original;
  }
});
