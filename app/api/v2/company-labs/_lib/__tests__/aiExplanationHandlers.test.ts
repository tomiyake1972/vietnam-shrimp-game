// ShrimpX V2 — Standard AI経営説明レポートAPI ハンドラー結合テスト（MVP）
//
// 実Anthropic APIは一切呼ばない。generateManagementReportへ注入するAnthropicMessagesClient
// モックだけを使う。実Redis接続も経由せず、CompanyLabRedisClientのin-memoryフェイクを使う
// （既存のhandlers.test.tsと同じ、in-memory Repository＋実サービスによる結合テスト方針）。
//
// 【本ファイルの配置について】テスト対象のhandlers.ts自体は、Next.jsのルーティング規約上
// [labId]/[companyId]/[turn] という角括弧つきディレクトリ名の下に置かれている。
// このリポジトリのテストランナー（node:testのファイルglob解決）は角括弧を文字クラスとして
// 解釈するため、角括弧ディレクトリの内側に置いたテストファイルは`npm test`のglobから
// 発見されない（実際に確認済み）。そのため、このテストファイル自体は角括弧を含まない
// 既存の app/api/v2/company-labs/_lib/__tests__/ に置き、テスト対象は相対importで参照する
// （テスト対象モジュールの実体・実装は移動していない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../../../lib/v2/redis/companyLabTypes";
import { AnthropicMessageResponse, AnthropicMessagesClient } from "../../../../../lib/v2/companyLab/aiExplanation/claudeClient";
import { handleCreateLab, handleProcessQuarter, handleSaveDraft, handleSubmitDraft } from "../handlers";
import { CompanyLabApiDependencies } from "../dependencies";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { AiExplanationApiDependencies } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-explanation/_lib/dependencies";
import { handleGetAiExplanation, handlePostAiExplanation } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-explanation/_lib/handlers";

const NOW = "2026-08-01T00:00:00.000Z";

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

function makeDeps(): AiExplanationApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  const redisClient = createInMemoryRedisClient();
  return { repository, service, redisClient } as CompanyLabApiDependencies & { redisClient: CompanyLabRedisClient };
}

async function createBaselineLab(deps: AiExplanationApiDependencies, labId: string): Promise<void> {
  const result = await handleCreateLab(
    deps,
    { scenarioId: "baseline", mode: "canonical", seed: "ai-explanation-route-001", turns: 4, playerCompanyId: "BAL", labId },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
}

const VALID_REPORT_INPUT = {
  headline: "見出し",
  executiveSummary: "要約",
  recommendations: [],
  keyRisks: [],
  questionsForPlayer: [],
  dataLimitations: [],
};

/**
 * 【2026-08-01・tool_use強制への切り替え後】claudeClient.tsはtool_choiceでtool呼び出しを
 * 強制するため、モック応答もtool_use content blockを返す形にする（プレーンテキストの
 * JSON文字列を返す旧方式のテストはclaudeClient.test.ts側に委譲し、ここでは
 * ハンドラー層の配線確認に専念する）。
 */
function toolUseResponse(input: unknown): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", input }], usage: { input_tokens: 1, output_tokens: 2 } };
}

function makeCountingClient(response: AnthropicMessageResponse): { client: AnthropicMessagesClient; callCount: () => number } {
  let calls = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        calls += 1;
        return response;
      },
    },
  };
  return { client, callCount: () => calls };
}

test("handlePostAiExplanation: 初回呼び出しはClaudeを呼び生成・キャッシュする", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-1");
  const { client, callCount } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));

  const result = await handlePostAiExplanation(deps, "lab-post-1", "BAL", "1", NOW, client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { cached: boolean; result: string; report?: { headline: string } };
  assert.equal(body.cached, false);
  assert.equal(body.result, "success");
  assert.equal(body.report?.headline, "見出し");
  assert.equal(callCount(), 1);
});

test("handlePostAiExplanation: 2回目の呼び出しはキャッシュを返し、Claudeを呼び直さない(モックの呼び出し回数は1のまま)", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-2");
  const { client, callCount } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));

  const first = await handlePostAiExplanation(deps, "lab-post-2", "BAL", "1", NOW, client);
  assert.equal(first.status, 200);
  const second = await handlePostAiExplanation(deps, "lab-post-2", "BAL", "1", NOW, client);
  assert.equal(second.status, 200);
  const secondBody = second.body as { cached: boolean };
  assert.equal(secondBody.cached, true);
  // 2回POSTしても、Anthropicクライアントの呼び出しは1回だけ（キャッシュヒットにより2回目はClaudeを呼ばない）。
  assert.equal(callCount(), 1);
});

test("handlePostAiExplanation: labIdが存在しない場合は404", async () => {
  const deps = makeDeps();
  const { client } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));
  const result = await handlePostAiExplanation(deps, "no-such-lab", "BAL", "1", NOW, client);
  assert.equal(result.status, 404);
});

test("handlePostAiExplanation: companyIdがプレイヤー会社と異なる場合は404(対象外)", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-3");
  const { client } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));
  const result = await handlePostAiExplanation(deps, "lab-post-3", "MASS", "1", NOW, client);
  assert.equal(result.status, 404);
});

test("handlePostAiExplanation: turnが現在のturnと異なる場合は404", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-4");
  const { client } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));
  const result = await handlePostAiExplanation(deps, "lab-post-4", "BAL", "99", NOW, client);
  assert.equal(result.status, 404);
});

test("handlePostAiExplanation: Claude呼び出しが失敗(missing_api_key相当)しても例外を投げず、構造化された失敗を返す", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-5");
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    },
  };
  const result = await handlePostAiExplanation(deps, "lab-post-5", "BAL", "1", NOW, failingClient);
  assert.equal(result.status, 200);
  const body = result.body as { result: string; errorCategory?: string };
  assert.equal(body.result, "failure");
  assert.equal(body.errorCategory, "http_error");
});

test("handleGetAiExplanation: 未生成の場合は404", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-get-1");
  const result = await handleGetAiExplanation(deps, "lab-get-1", "BAL", "1");
  assert.equal(result.status, 404);
});

test("handleGetAiExplanation: POST後はGETでキャッシュ済みレポートを取得できる(副作用なし)", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-get-2");
  const { client } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));
  await handlePostAiExplanation(deps, "lab-get-2", "BAL", "1", NOW, client);

  const result = await handleGetAiExplanation(deps, "lab-get-2", "BAL", "1");
  assert.equal(result.status, 200);
  const body = result.body as { cached: boolean; report?: { headline: string } };
  assert.equal(body.cached, true);
  assert.equal(body.report?.headline, "見出し");
});

test("handlePostAiExplanation: 四半期処理が進みStandard AIの状況(コンテキスト)が変わったturnでは、再びClaudeが呼ばれる(古いレポートを誤って再利用しない)", async () => {
  const deps = makeDeps();
  const labId = "lab-context-change-1";
  await createBaselineLab(deps, labId);

  const { client, callCount } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));

  // turn1ぶんのレポートを生成・キャッシュする。
  const turn1Result = await handlePostAiExplanation(deps, labId, "BAL", "1", NOW, client);
  assert.equal(turn1Result.status, 200);
  assert.equal(callCount(), 1);

  // turn1のdraftを保存・提出し、四半期処理を進めてturn2へ移す
  // （decisionsProviderは既存のbuildApiDecisionsProvider経由で実際にStandard AIを実行する）。
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "draft-fixture-seed", turns: 4 });
  const publicInfo = buildPublicMarketInfo(state);
  const fixture = fixtures.find((f) => f.companyId === "BAL");
  if (!fixture) throw new Error("BAL fixture not found");
  const ownState = buildCompanyOwnState(state, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draftBody = buildInitialDraft(fixture, autoDecision);

  const saveResult = await handleSaveDraft(deps, labId, { draft: draftBody }, NOW);
  assert.equal(saveResult.status, 200, JSON.stringify(saveResult.body));
  const submitResult = await handleSubmitDraft(deps, labId, NOW);
  assert.equal(submitResult.status, 200, JSON.stringify(submitResult.body));
  const processResult = await handleProcessQuarter(deps, labId, {}, NOW);
  assert.equal(processResult.status, 200, JSON.stringify(processResult.body));

  // turn2ぶんの状態は、turn1とは自社状態・Standard AIの診断が異なるコンテキストになるため、
  // 同じキャッシュキーには当たらず、Claudeが再び呼ばれる（呼び出し回数が2に増える）。
  const turn2Result = await handlePostAiExplanation(deps, labId, "BAL", "2", NOW, client);
  assert.equal(turn2Result.status, 200, JSON.stringify(turn2Result.body));
  const turn2Body = turn2Result.body as { cached: boolean };
  assert.equal(turn2Body.cached, false);
  assert.equal(callCount(), 2);
});
