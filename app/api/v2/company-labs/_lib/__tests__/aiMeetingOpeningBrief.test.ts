// ShrimpX V2 — AI Management Meeting Opening Executive Brief 結合テスト（AMM-M2.7）
//
// AMM-TCB-14: Opening brief cached per turn
// AMM-TCB-15: existing conversation does not inject late opening
// AMM-TCB-16: Claude failure graceful fallback
//
// 実Anthropic APIは一切呼ばない。in-memory Redis + in-memory Repositoryのみを使う
// （aiMeetingHandlers.test.tsと同じ結合テスト方針）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../../../lib/v2/redis/companyLabTypes";
import { AnthropicMessageResponse, AnthropicMessagesClient } from "../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";
import { handleCreateLab } from "../handlers";
import { CompanyLabApiDependencies } from "../dependencies";
import { AiMeetingApiDependencies } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/dependencies";
import { handlePostAiMeetingMessage } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";
import { handleGetOpeningBrief } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-meeting/opening-brief/_lib/handlers";
import { OPENING_BRIEF_PROMPT_VERSION, OPENING_BRIEF_SYSTEM_PROMPT } from "../../../../../lib/v2/companyLab/aiManagementMeeting/prompt";
import { OPENING_BRIEF_TOOL_INPUT_SCHEMA } from "../../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";

const NOW = "2026-08-17T00:00:00.000Z";

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

function makeDeps(): AiMeetingApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  const redisClient = createInMemoryRedisClient();
  return { repository, service, redisClient } as CompanyLabApiDependencies & { redisClient: CompanyLabRedisClient };
}

async function createBaselineLab(deps: AiMeetingApiDependencies, labId: string): Promise<void> {
  const result = await handleCreateLab(
    deps,
    { scenarioId: "baseline", mode: "canonical", seed: "ai-meeting-opening-brief-001", turns: 4, playerCompanyId: "BAL", labId },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
}

function toolUseResponse(input: unknown, stopReason: string | null = "tool_use"): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: stopReason };
}

const VALID_OPENING_BRIEF_RESPONSE = {
  speaker: "CEO",
  summary: "会社は初期状態です。現金・受注残・生産能力を確認してください。",
  keyChanges: [
    {
      domain: "FINANCE",
      direction: "NEUTRAL",
      title: "初期資金状況",
      explanation: "現在の現金残高を基準に、今後の投資判断を検討できます。",
      factsUsed: ["common.cashUsd"],
    },
  ],
  suggestedFollowUps: ["CFOに現金繰りを聞く", "COOに生産能力を確認する"],
  memoryUsedIds: [],
};

const VALID_MEETING_RESPONSE = {
  primarySpeaker: "CFO",
  responses: [
    {
      speaker: "CFO",
      text: "現在の現金残高は十分にあり、当面のCAPEXは問題なく賄えます。",
      stance: "SUPPORT",
      proposalIds: [],
      factsUsed: ["cash.current"],
      standardAiReferences: [],
    },
  ],
  requiresCeoSummary: false,
  proposals: [],
  meetingIntent: "PROTECT_CASH",
  potentialStrategicChange: false,
  playerCorrectionStatus: "NOT_APPLICABLE",
};

test("AMM-TCB-14: 同一turnのOpening Briefは2回目以降Claudeを再度呼ばずキャッシュを返す", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-tcb-14");
  let callCount = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        callCount += 1;
        return toolUseResponse(VALID_OPENING_BRIEF_RESPONSE);
      },
    },
  };
  const first = await handleGetOpeningBrief(deps, "lab-tcb-14", "BAL", "1", client);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstBody = first.body as { available: boolean; cached: boolean };
  assert.equal(firstBody.available, true);
  assert.equal(firstBody.cached, false);
  assert.equal(callCount, 1);

  const second = await handleGetOpeningBrief(deps, "lab-tcb-14", "BAL", "1", client);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondBody = second.body as { available: boolean; cached: boolean };
  assert.equal(secondBody.available, true);
  assert.equal(secondBody.cached, true, "2回目はキャッシュから返るはず");
  assert.equal(callCount, 1, "2回目はClaudeを再度呼ばないはず");
});

test("AMM-TCB-15: 既にPlayerが発言済みの会話には、後からOpening Briefを割り込ませない", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-tcb-15");
  const meetingClient: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const posted = await handlePostAiMeetingMessage(deps, "lab-tcb-15", "BAL", "1", { playerMessage: "現金は足りてる？" }, meetingClient);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  let openingBriefCallCount = 0;
  const openingBriefClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        openingBriefCallCount += 1;
        return toolUseResponse(VALID_OPENING_BRIEF_RESPONSE);
      },
    },
  };
  const result = await handleGetOpeningBrief(deps, "lab-tcb-15", "BAL", "1", openingBriefClient);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { available: boolean; unavailableReason?: string };
  assert.equal(body.available, false, "Playerが既に発言済みならOpening Briefは生成されないはず");
  assert.equal(openingBriefCallCount, 0, "Playerが既に発言済みならClaudeを呼ばないはず");
});

test("AMM-TCB-16: Claude呼び出し失敗時も例外を投げず、ゲーム状態・会話ともに変更しない", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-tcb-16");
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    },
  };
  const result = await handleGetOpeningBrief(deps, "lab-tcb-16", "BAL", "1", failingClient);
  assert.equal(result.status, 200);
  const body = result.body as { available: boolean };
  assert.equal(body.available, false);

  // 会話artifactも変更されていないはず（次回呼び出しでもOpening Briefがまだ生成可能）。
  let retryCallCount = 0;
  const workingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        retryCallCount += 1;
        return toolUseResponse(VALID_OPENING_BRIEF_RESPONSE);
      },
    },
  };
  const retry = await handleGetOpeningBrief(deps, "lab-tcb-16", "BAL", "1", workingClient);
  assert.equal(retry.status, 200);
  const retryBody = retry.body as { available: boolean; cached: boolean };
  assert.equal(retryBody.available, true);
  assert.equal(retryBody.cached, false, "失敗時は会話へ何も記録していないため、再試行はcache扱いにならないはず");
  assert.equal(retryCallCount, 1);
});

// ---------------------------------------------------------------------
// 【AI Management Meeting Hotfix】Opening Brief Japanese Output Enforcement
// （AMM-LANG-1〜6）
//
// 実プレイでOpening Briefだけが英語で生成される事象が発生した。通常のAI Meeting
// 会話はPlayerが日本語で質問するため日本語で返っていたが、Opening BriefはPlayer
// 発言が存在せず、userメッセージが英語キーのJSON payloadだけであるため、モデルが
// 英語を選びやすかった（prompt側に出力言語の明示が無かった）。
//
// 実Anthropic APIを呼ばずに固定できるのは「Claudeへ渡す指示（system prompt・
// tool schema description）が日本語出力を明示していること」と「fallback文言が
// 日本語であること」の2点であり、ここではその契約を回帰テストとして固定する。
// ---------------------------------------------------------------------

/** ひらがな・カタカナ・漢字のいずれかを含むか（日本語文であることの機械的判定）。 */
function containsJapanese(text: string): boolean {
  return /[぀-ゟ゠-ヿ一-鿿]/.test(text);
}

test("AMM-LANG-1: Opening Brief system promptがsummaryを日本語で書くよう明示している", () => {
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("【出力言語（必ず日本語）】"), "出力言語の節が存在するはず");
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("出力は必ず日本語で書いてください"), "日本語出力の明示があるはず");
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("summary"), "summaryが日本語対象として名指しされているはず");
  const summarySchema = OPENING_BRIEF_TOOL_INPUT_SCHEMA.properties.summary;
  assert.ok(summarySchema.description.includes("日本語"), "tool schemaのsummary descriptionも日本語を要求するはず");
});

test("AMM-LANG-2: keyChangesのtitle/explanationを日本語で書くよう明示している（英語の例文を残さない）", () => {
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("keyChanges[].title"));
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("keyChanges[].explanation"));

  const itemProps = OPENING_BRIEF_TOOL_INPUT_SCHEMA.properties.keyChanges.items.properties;
  assert.ok(itemProps.title.description.includes("日本語"), "titleのdescriptionが日本語を要求するはず");
  assert.ok(itemProps.explanation.description.includes("日本語"), "explanationのdescriptionが日本語を要求するはず");
  // v1のtitle descriptionは英語の見出し例（'Operating Profit turned negative'）を
  // そのまま示しており、モデルが英語を選ぶ一因になっていた。例文も日本語にする。
  assert.ok(containsJapanese(itemProps.title.description), "titleの説明文自体が日本語であるはず");
  assert.ok(!itemProps.title.description.includes("turned negative"), "英語の見出し例が残っていてはいけない");
});

test("AMM-LANG-3: suggestedFollowUpsを日本語で書くよう明示している", () => {
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("suggestedFollowUps[]"));
  const followUps = OPENING_BRIEF_TOOL_INPUT_SCHEMA.properties.suggestedFollowUps;
  assert.ok(followUps.description.includes("日本語"), "suggestedFollowUpsのdescriptionが日本語を要求するはず");
});

test("AMM-LANG-4: 役職ラベル（CEO等）は英語のままでよく、speakerはCEO固定のまま変更されていない", () => {
  // 発話内容は日本語だが、role nameとしてのCEO/CFO/COO/Commercial Directorは英語で可。
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("役職ラベルは役職名として"), "役職ラベルの例外が明示されているはず");
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("発話内容そのものは必ず日本語"), "発話内容は日本語という条件が明示されているはず");
  // 既存のspeaker固定（M2.7 semantics）は変更しない。
  assert.deepEqual([...OPENING_BRIEF_TOOL_INPUT_SCHEMA.properties.speaker.enum], ["CEO"]);
  assert.ok(OPENING_BRIEF_SYSTEM_PROMPT.includes("speakerは必ずCEO固定です"), "CEO固定の既存原則は残っているはず");
});

test("AMM-LANG-5: Claude呼び出し失敗時のfallback文言が日本語である", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-lang-5");
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    },
  };
  const result = await handleGetOpeningBrief(deps, "lab-lang-5", "BAL", "1", failingClient);
  assert.equal(result.status, 200);
  const body = result.body as { available: boolean; unavailableReason?: string };
  assert.equal(body.available, false);
  assert.ok(body.unavailableReason, "fallback文言が返るはず");
  assert.ok(containsJapanese(body.unavailableReason!), `fallback文言が日本語でない: ${body.unavailableReason}`);
});

test("AMM-LANG-5b: Playerが既に発言済みの場合のunavailableReasonも日本語である", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-lang-5b");
  const meetingClient: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  await handlePostAiMeetingMessage(deps, "lab-lang-5b", "BAL", "1", { playerMessage: "現金は足りてる？" }, meetingClient);
  const result = await handleGetOpeningBrief(deps, "lab-lang-5b", "BAL", "1", undefined);
  const body = result.body as { available: boolean; unavailableReason?: string };
  assert.equal(body.available, false);
  assert.ok(containsJapanese(body.unavailableReason ?? ""), `fallback文言が日本語でない: ${body.unavailableReason}`);
});

test("AMM-LANG-6: 日本語のOpening Briefがそのまま保存・返却される（既存の生成経路を壊していない）", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-lang-6");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_OPENING_BRIEF_RESPONSE) } };
  const result = await handleGetOpeningBrief(deps, "lab-lang-6", "BAL", "1", client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as {
    available: boolean;
    openingBrief?: {
      speaker: string;
      summary: string;
      keyChanges: readonly { title: string; explanation: string }[];
      suggestedFollowUps: readonly string[];
      promptVersion: string;
    };
  };
  assert.equal(body.available, true);
  const brief = body.openingBrief;
  assert.ok(brief, "openingBriefが返るはず");
  assert.equal(brief!.speaker, "CEO", "speakerはCEOのまま（役職ラベルは英語で可）");
  assert.ok(containsJapanese(brief!.summary), "summaryが日本語のまま返るはず");
  for (const change of brief!.keyChanges) {
    assert.ok(containsJapanese(change.title), `keyChange.titleが日本語でない: ${change.title}`);
    assert.ok(containsJapanese(change.explanation), `keyChange.explanationが日本語でない: ${change.explanation}`);
  }
  for (const followUp of brief!.suggestedFollowUps) {
    assert.ok(containsJapanese(followUp), `suggestedFollowUpが日本語でない: ${followUp}`);
  }
  // promptVersionは日本語出力を明示したv2以降であることを固定する（v1で生成された
  // 既存の英語Opening Briefと、保存済みメッセージ上で区別できるようにするため）。
  assert.equal(brief!.promptVersion, OPENING_BRIEF_PROMPT_VERSION);
  assert.notEqual(OPENING_BRIEF_PROMPT_VERSION, "v1", "出力言語を明示したためpromptVersionはv1から進んでいるはず");

  // キャッシュ経路（message形式）でも日本語のまま返ること。
  const cached = await handleGetOpeningBrief(deps, "lab-lang-6", "BAL", "1", client);
  const cachedBody = cached.body as { cached: boolean; message?: { text: string; speaker: string; promptVersion: string } };
  assert.equal(cachedBody.cached, true);
  assert.equal(cachedBody.message?.speaker, "CEO");
  assert.ok(containsJapanese(cachedBody.message?.text ?? ""), "キャッシュ経路でも日本語のまま返るはず");
  assert.equal(cachedBody.message?.promptVersion, OPENING_BRIEF_PROMPT_VERSION);
});
