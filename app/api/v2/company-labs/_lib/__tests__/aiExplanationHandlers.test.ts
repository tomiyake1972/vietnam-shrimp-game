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

test("handlePostAiExplanation: 失敗結果はキャッシュへ保存されない(同一turn・同一状態でも次回POSTでClaudeが再び呼ばれる)", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-6");
  let calls = 0;
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        calls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    },
  };

  const first = await handlePostAiExplanation(deps, "lab-post-6", "BAL", "1", NOW, failingClient);
  assert.equal((first.body as { result: string }).result, "failure");
  assert.equal(calls, 1);

  // contextは全く変わっていない（turn・状態とも同一）にもかかわらず、直前の失敗が
  // 永久キャッシュされていないため、2回目のPOSTでもClaudeが再び呼ばれる。
  const second = await handlePostAiExplanation(deps, "lab-post-6", "BAL", "1", NOW, failingClient);
  assert.equal((second.body as { result: string }).result, "failure");
  assert.equal(calls, 2);

  // GET側にも失敗結果は残らない(未生成として404のまま)。
  const getResult = await handleGetAiExplanation(deps, "lab-post-6", "BAL", "1");
  assert.equal(getResult.status, 404);
});

test("handlePostAiExplanation: 失敗の後に成功すれば、その成功結果はキャッシュされGETでも取得できる", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-7");
  const responses: (AnthropicMessageResponse | Error)[] = [
    Object.assign(new Error("rate limited"), { status: 429 }),
    toolUseResponse(VALID_REPORT_INPUT),
  ];
  let calls = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        const r = responses[calls];
        calls += 1;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };

  const first = await handlePostAiExplanation(deps, "lab-post-7", "BAL", "1", NOW, client);
  assert.equal((first.body as { result: string }).result, "failure");

  const second = await handlePostAiExplanation(deps, "lab-post-7", "BAL", "1", NOW, client);
  assert.equal((second.body as { result: string }).result, "success");

  const getResult = await handleGetAiExplanation(deps, "lab-post-7", "BAL", "1");
  assert.equal(getResult.status, 200);
  const getBody = getResult.body as { cached: boolean; report?: { headline: string } };
  assert.equal(getBody.cached, true);
  assert.equal(getBody.report?.headline, "見出し");
});

test("handlePostAiExplanation/handleGetAiExplanation: 修正前に保存された既存のresult=failureキャッシュ(TTLなし)が残っていても、ヒットとして扱わずClaudeを呼び直す", async () => {
  // 【2026-08-01・実際にVercel Previewで確認した再発防止テスト】failure結果を新規に
  // 保存しないよう修正しても、それより前のデプロイで既にRedisへ保存されていた
  // failure結果(TTLなし)は残ったまま消えない。実際に本番同等のPreview環境で、
  // この修正を含むデプロイ後もschema_mismatchの古いキャッシュがヒットし続け、
  // Claudeが呼ばれないことをVercelランタイムログで確認した。読み取り側でも
  // result==="failure"のキャッシュはヒットとして扱わないことを確認する。
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-post-8");

  // まずキャッシュキーを実際に導出させるため、失敗する呼び出しを1回行う
  // （この時点では前のテストで確認済みのとおりRedisへは保存されない）。
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    },
  };
  const first = await handlePostAiExplanation(deps, "lab-post-8", "BAL", "1", NOW, failingClient);
  const cacheKey = (first.body as { cacheKey: string }).cacheKey;

  // 修正前の挙動を模して、failure結果を直接Redis(in-memoryフェイク)へ書き込む
  // （TTLなしで無期限に残っている既存の不良データを再現する）。
  await deps.redisClient.set(
    cacheKey,
    JSON.stringify({
      generatedAt: NOW,
      result: "failure",
      errorCategory: "schema_mismatch",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v1",
      contextSchemaVersion: 1,
      contextHash: "dummy",
    })
  );

  // GETは「未生成」として404を返す(failureキャッシュを生成済みの結果として返さない)。
  const getResult = await handleGetAiExplanation(deps, "lab-post-8", "BAL", "1");
  assert.equal(getResult.status, 404);

  // POSTは既存のfailureキャッシュをヒットとして扱わず、Claudeを呼び直して成功する。
  const { client: succeedingClient, callCount } = makeCountingClient(toolUseResponse(VALID_REPORT_INPUT));
  const second = await handlePostAiExplanation(deps, "lab-post-8", "BAL", "1", NOW, succeedingClient);
  assert.equal((second.body as { result: string; cached: boolean }).result, "success");
  assert.equal((second.body as { result: string; cached: boolean }).cached, false);
  assert.equal(callCount(), 1);
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
