// ShrimpX V2 — Standard AI経営説明レポート機能 Anthropicクライアントラッパーのテスト（MVP）
//
// 実Anthropic APIは一切呼ばない。AnthropicMessagesClientインターフェースをモックした
// フェイクだけを使う。ANTHROPIC_API_KEY等の実キー値は一切使わず、テスト用の
// 明らかに偽と分かるプレースホルダ文字列のみを使う。
//
// 【2026-08-01・本番Preview手動観察テストで発見された invalid_json バグの事後対応】
// 従来はプレーンテキスト応答をJSON.parseしていたが、Claudeがマークダウンのコード
// フェンス（```json ... ```）付きで返すことがあり、初回・リトライの両方が同じ理由で
// 系統的に失敗する実例が発生した。対策として、応答をtool_use（tool_choiceで強制）の
// content blockから取り出す方式へ変更したため、本ファイルのモック応答もtool_use
// ブロックを返す形に更新した（プレーンテキストのJSON文字列を返すテストはもう存在しない
// ＝この失敗モード自体が構造的に起こりえないことをテストで表現する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicMessageResponse,
  AnthropicMessagesClient,
  buildAnthropicClientOptions,
  EXPLANATION_CLAUDE_MAX_RETRIES,
  EXPLANATION_CLAUDE_TIMEOUT_MS,
  EXPLANATION_REPORT_TOOL_INPUT_SCHEMA,
  EXPLANATION_REPORT_TOOL_NAME,
  generateManagementReport,
} from "../claudeClient";
import { EXPLANATION_OUTPUT_LIMITS } from "../reportSchema";
import { STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2 } from "../systemPrompt";
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

const VALID_REPORT_INPUT = {
  headline: "テスト見出し",
  executiveSummary: "テスト要約",
  recommendations: [],
  keyRisks: [],
  questionsForPlayer: [],
  dataLimitations: [],
};

/** tool_choiceで強制した想定どおりの、tool_use content blockを持つ応答。 */
function toolUseResponse(input: unknown): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", input }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/**
 * tool_choiceで強制したにもかかわらず、tool_useブロックが無い応答
 * （例: モデルがテキストのみを返してきた場合。マークダウンのコードフェンスや前置き文章
 * つきのテキストであっても、tool_useブロックが無い以上は同じ扱いになることを示す）。
 */
function textOnlyResponse(text: string): AnthropicMessageResponse {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } };
}

/** contentが空配列の応答（空応答）。 */
function emptyContentResponse(): AnthropicMessageResponse {
  return { content: [], usage: { input_tokens: 10, output_tokens: 20 } };
}

interface CapturedCall {
  readonly tools?: readonly { readonly name: string }[];
  readonly tool_choice?: { readonly type: string; readonly name: string };
}

function makeClient(responses: readonly (AnthropicMessageResponse | Error)[]): {
  client: AnthropicMessagesClient;
  callCount: () => number;
  capturedCalls: CapturedCall[];
} {
  let calls = 0;
  const capturedCalls: CapturedCall[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      create: async (params) => {
        capturedCalls.push({ tools: params.tools, tool_choice: params.tool_choice });
        const response = responses[calls];
        calls += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
  return { client, callCount: () => calls, capturedCalls };
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

test("generateManagementReport: 正常系(1回で成功、tool_useブロック経由)、usageが返る", async () => {
  const { client, callCount } = makeClient([toolUseResponse(VALID_REPORT_INPUT)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.report.headline, "テスト見出し");
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 20);
    assert.equal(result.usage.model, "claude-haiku-4-5-20251001");
  }
  assert.equal(callCount(), 1);
});

test("generateManagementReport: リクエストにtool定義とtool_choiceが必ず含まれる（tool_use強制の確認）", async () => {
  const { client, capturedCalls } = makeClient([toolUseResponse(VALID_REPORT_INPUT)]);
  await generateManagementReport(minimalContext(), client);
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].tools?.length, 1);
  assert.equal(capturedCalls[0].tools?.[0]?.name, EXPLANATION_REPORT_TOOL_NAME);
  assert.deepEqual(capturedCalls[0].tool_choice, { type: "tool", name: EXPLANATION_REPORT_TOOL_NAME });
});

test("generateManagementReport: tool_useブロックが無い(テキストのみ)応答1回目→2回目もtool_useなしなら最終的にinvalid_jsonで失敗", async () => {
  // マークダウンのコードフェンス付きテキストであっても、tool_useブロックが存在しない
  // 限り同じ扱いになることを示す（コードフェンスの有無自体で分岐しない設計）。
  const { client, callCount } = makeClient([
    textOnlyResponse("```json\n" + JSON.stringify(VALID_REPORT_INPUT) + "\n```"),
    textOnlyResponse("以下がレポートです: " + JSON.stringify(VALID_REPORT_INPUT)),
  ]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "invalid_json");
  assert.equal(callCount(), 2);
});

test("generateManagementReport: 1回目tool_useなし、2回目tool_useあり→リトライにより成功扱い(呼び出しは2回)", async () => {
  const { client, callCount } = makeClient([textOnlyResponse("(tool_useなしの応答)"), toolUseResponse(VALID_REPORT_INPUT)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, true);
  assert.equal(callCount(), 2);
});

test("generateManagementReport: スキーマ不一致(必須フィールド欠落、tool_useのinputとして)は1回目失敗→2回目も不一致ならschema_mismatch", async () => {
  const badInput = { executiveSummary: "見出しがありません" };
  const { client, callCount } = makeClient([toolUseResponse(badInput), toolUseResponse(badInput)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "schema_mismatch");
  assert.equal(callCount(), 2);
});

test("generateManagementReport: スキーマ不一致時、console.errorへ実際のissues(path/code等の構造情報)が出るが本文(headline等の文章)は出ない", async () => {
  // 【2026-08-01・schema_mismatch診断強化の回帰テスト】従来はスキーマ不一致時、
  // console.errorに「スキーマ不一致」というタグしか出ておらず、Vercelランタイムログだけを
  // 見ても実際にどのfield・pathで何が起きたか分からなかった。この不具合の再発を防ぐため、
  // ログへ実際のZod issues（path等の構造情報）が出ること、かつ本文（headline等の実際の
  // 文章）が出ないことを確認する。
  const badInput = {
    headline: "テスト見出し",
    executiveSummary: "テスト要約",
    recommendations: [],
    keyRisks: [{ severity: "critical", title: "x", description: "y" }],
    questionsForPlayer: [],
    dataLimitations: [],
  };
  const { client } = makeClient([toolUseResponse(badInput), toolUseResponse(badInput)]);
  const originalConsoleError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await generateManagementReport(minimalContext(), client);
    assert.equal(result.ok, false);
  } finally {
    console.error = originalConsoleError;
  }
  const schemaMismatchLogs = captured.filter((line) => line.includes("スキーマ不一致"));
  assert.equal(schemaMismatchLogs.length, 2);
  // path情報(keyRisks配下のsevirity)が出ている。
  assert.ok(schemaMismatchLogs[0].includes("keyRisks"));
  assert.ok(schemaMismatchLogs[0].includes("severity"));
  // 本文(実際の文章)はログに含まれない。
  assert.equal(schemaMismatchLogs[0].includes("テスト見出し"), false);
  assert.equal(schemaMismatchLogs[0].includes("テスト要約"), false);
});

test("generateManagementReport: 空応答(contentが空配列)はinvalid_json扱い、その後リトライしても空ならinvalid_jsonのまま", async () => {
  const { client, callCount } = makeClient([emptyContentResponse(), emptyContentResponse()]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "invalid_json");
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

test("buildAnthropicClientOptions: timeout=25000・maxRetries=0が実クライアント構築オプションへ渡る(76秒問題の修正確認)", () => {
  // 【2026-08-02・76秒問題の修正】Anthropic SDKの既定maxRetries=2とtimeout=25000が
  // 組み合わさり、実測76秒級の失敗検知latency（約3倍化）を引き起こしていた問題への
  // 対応。今回はtimeout値自体は変更せず、まずSDK側のmaxRetriesを明示的に0へ固定して
  // 暗黙のリトライを無効化する。このテストは、実クライアント（createRealClient）へ渡す
  // コンストラクタオプションが確実にこの2値を維持していることを直接検証する
  // （実際のAnthropicコンストラクタは呼ばない。値の組み立てのみを検証）。
  const options = buildAnthropicClientOptions("some-fake-key");
  assert.equal(options.timeout, 25_000);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.apiKey, "some-fake-key");
  // 定数そのものも想定値のままであることを確認する(今回timeoutは変更しない指示のため)。
  assert.equal(EXPLANATION_CLAUDE_TIMEOUT_MS, 25_000);
  assert.equal(EXPLANATION_CLAUDE_MAX_RETRIES, 0);
});

test("generateManagementReport: タイムアウト相当のnetwork_error発生時、フォールバック(ok:false)へ速やかに到達し、後続処理を止めない(76秒級の実待機を伴わない)", async () => {
  // 【2026-08-02・76秒問題の修正の回帰テスト】SDK自体のmaxRetries設定はこのモック
  // クライアントには効かない（モックがSDK内部のretryループを再現していないため）が、
  // 「AnthropicMessagesClient.messages.createがタイムアウト相当のエラーで例外を投げた
  // 場合、generateManagementReportがhttp_error/network_errorとしてリトライせず即座に
  // ok:falseを返す」という、アプリ側の既存方針(第一段落・attemptOnceのコメント参照)を
  // 明示的に固定する。実際のタイムアウト(25秒)を待たずにテストが完了することも、
  // このテスト自体の実行時間の短さで示される(実待機なし)。
  const timeoutLikeError = Object.assign(new Error("Request timed out."), { code: "ETIMEDOUT" });
  const startedAt = Date.now();
  const { client, callCount } = makeClient([timeoutLikeError]);
  const result = await generateManagementReport(minimalContext(), client);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "network_error");
  // リトライしない(呼び出しは1回のみ)ため、mockが即座に例外を投げる限りテスト自体も
  // 高速に完了する。実際の25秒timeoutを待つ必要はない。
  assert.equal(callCount(), 1);
  assert.ok(elapsedMs < 5_000, `想定外に時間がかかった elapsedMs=${elapsedMs}`);
});

// 【2026-08-02・25秒問題対応・出力量削減の回帰テスト】tool定義のmaxItemsと
// systemPrompt V2の件数指示が、単一の定義元(EXPLANATION_OUTPUT_LIMITS)からずれずに
// 一致していることを確認する。三宅さんの指示7「schemaの件数上限と生成指示が一致
// している」ことの検証。
test("EXPLANATION_REPORT_TOOL_INPUT_SCHEMA: 各配列のmaxItemsがEXPLANATION_OUTPUT_LIMITSと一致する", () => {
  const schema = EXPLANATION_REPORT_TOOL_INPUT_SCHEMA.properties;
  assert.equal(schema.recommendations.maxItems, EXPLANATION_OUTPUT_LIMITS.maxRecommendations);
  assert.equal(schema.recommendations.items.properties.reasons.maxItems, EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation);
  assert.equal(schema.keyRisks.maxItems, EXPLANATION_OUTPUT_LIMITS.maxKeyRisks);
  assert.equal(schema.questionsForPlayer.maxItems, EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer);
  assert.equal(schema.dataLimitations.maxItems, EXPLANATION_OUTPUT_LIMITS.maxDataLimitations);
});

test("STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2: 件数指示がEXPLANATION_OUTPUT_LIMITSの値と一致する文言を含む(schemaとpromptのドリフト防止)", () => {
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes(`最大${EXPLANATION_OUTPUT_LIMITS.maxRecommendations}件`));
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes(`最大${EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation}件`));
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes(`最大${EXPLANATION_OUTPUT_LIMITS.maxKeyRisks}件`));
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes(`最大${EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer}件`));
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes(`最大${EXPLANATION_OUTPUT_LIMITS.maxDataLimitations}件`));
  // 簡潔さの指示（concise/do not repeat diagnostic values/do not explain every field/
  // focus on primary constraint等）が日本語で含まれていることも確認する。
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes("簡潔"));
  assert.ok(STANDARD_AI_EXPLANATION_SYSTEM_PROMPT_V2.includes("主要制約"));
});

test("generateManagementReport: timeout/maxRetries/modelは今回変更していない(25秒問題対応の比較のため固定)", () => {
  assert.equal(EXPLANATION_CLAUDE_TIMEOUT_MS, 25_000);
  assert.equal(EXPLANATION_CLAUDE_MAX_RETRIES, 0);
  const options = buildAnthropicClientOptions("some-fake-key");
  assert.equal(options.timeout, 25_000);
  assert.equal(options.maxRetries, 0);
});

test("generateManagementReport: 目安件数を超えた正常なtool_use応答でも引き続きok:trueで成功する(Zod側は件数を強制しないため既存の正常parseは壊れない)", async () => {
  const bigButValidInput = {
    headline: "テスト見出し",
    executiveSummary: "テスト要約",
    recommendations: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxRecommendations + 3 }, (_, i) => ({
      area: "sales",
      title: `提案${i}`,
      action: "action",
      reasons: [{ label: "l", value: "v" }],
    })),
    keyRisks: [],
    questionsForPlayer: [],
    dataLimitations: [],
  };
  const { client, callCount } = makeClient([toolUseResponse(bigButValidInput)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, true);
  assert.equal(callCount(), 1);
});

test("generateManagementReport: schema mismatch時のfallback(1回だけリトライ→最終的にok:false)は今回の変更後も維持されている", async () => {
  const badInput = { executiveSummary: "見出しがありません" };
  const { client, callCount } = makeClient([toolUseResponse(badInput), toolUseResponse(badInput)]);
  const result = await generateManagementReport(minimalContext(), client);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCategory, "schema_mismatch");
  assert.equal(callCount(), 2);
});

test("getExplanationModelConfig: 環境変数未指定時は既定モデルを返す", async () => {
  const original = process.env.STANDARD_AI_EXPLANATION_MODEL;
  delete process.env.STANDARD_AI_EXPLANATION_MODEL;
  try {
    const { getExplanationModelConfig } = await import("../claudeClient");
    const config = getExplanationModelConfig();
    assert.equal(typeof config.model, "string");
    // 【2026-08-01・maxTokens不足によるschema_mismatchの修正】実機Previewで
    // stop_reason="max_tokens"（応答が1200トークンで打ち切られ、recommendations等の
    // 配列フィールドが丸ごと欠落）を確認したため、4096へ引き上げた（1200には戻さない）。
    // 【2026-08-02・25秒問題対応・出力量削減】出力量を件数目安つきで絞ったため、
    // 4096は過大と判断し2000へ縮小した（EXPLANATION_MAX_OUTPUT_TOKENSのコメント参照）。
    assert.equal(config.maxTokens, 2000);
  } finally {
    if (original !== undefined) process.env.STANDARD_AI_EXPLANATION_MODEL = original;
  }
});
