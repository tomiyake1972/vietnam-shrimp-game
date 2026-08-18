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
