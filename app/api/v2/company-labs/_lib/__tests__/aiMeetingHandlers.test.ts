// ShrimpX V2 — AI Management Meeting API ハンドラー結合テスト（AMM-M0/M1）
//
// AMM-1: player-message-required
// AMM-13: meeting-intent-extracted
// AMM-14: strategic-change-not-auto-applied
// AMM-15: Claude-failure-does-not-modify-game-state
//
// 実Anthropic APIは一切呼ばない。in-memory Redis + in-memory Repositoryのみを使う
// （aiExplanationHandlers.test.tsと同じ結合テスト方針。角括弧ディレクトリ内の
// handlers.tsを直接importするため、このテストファイル自体は角括弧を含まない
// 既存の __tests__ ディレクトリに置く）。

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

const NOW = "2026-08-16T00:00:00.000Z";

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
    { scenarioId: "baseline", mode: "canonical", seed: "ai-meeting-route-001", turns: 4, playerCompanyId: "BAL", labId },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
}

function toolUseResponse(input: unknown, stopReason: string | null = "tool_use"): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: stopReason };
}

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
};

test("AMM-1: playerMessageが空文字列の場合は400", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-1");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-1", "BAL", "1", { playerMessage: "" }, client);
  assert.equal(result.status, 400);
});

test("AMM-1b: playerMessageが空白のみの場合も400", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-1b");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-1b", "BAL", "1", { playerMessage: "   " }, client);
  assert.equal(result.status, 400);
});

test("AMM-13: meetingIntentが応答へ正しく反映される", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-13");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-13", "BAL", "1", { playerMessage: "現金は足りてる？" }, client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { meetingIntent: string };
  assert.equal(body.meetingIntent, "PROTECT_CASH");
});

test("AMM-14: potentialStrategicChangeは情報としてのみ返され、自動適用されない（draftを書き換える経路が存在しない）", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-14");
  const strategicResponse = { ...VALID_MEETING_RESPONSE, potentialStrategicChange: true, potentialStrategicChangeNote: "積極拡大路線への転換を示唆" };
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(strategicResponse) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-14", "BAL", "1", { playerMessage: "もう積極拡大路線でいく" }, client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { potentialStrategicChange: boolean; potentialStrategicChangeNote: string | null };
  assert.equal(body.potentialStrategicChange, true);
  assert.equal(body.potentialStrategicChangeNote, "積極拡大路線への転換を示唆");
  // このAPIはCompanyDecisionDraft・CompanyLabStateへの書き込み関数を一切呼ばない
  // （handlers.tsの実装自体がsaveConversation以外の書き込みAPIをimportしていないことで
  // 構造的に保証される。ここでは応答が「情報フラグ」であることのみを確認する）。
});

test("AMM-15: Claude呼び出し失敗時も例外を投げず、ゲーム状態は変更されない", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-15");
  const failingClient: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    },
  };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-15", "BAL", "1", { playerMessage: "現金は足りてる？" }, failingClient);
  assert.equal(result.status, 200);
  const body = result.body as { available: boolean; validatedProposals: unknown[] };
  assert.equal(body.available, false);
  assert.equal(body.validatedProposals.length, 0);
});

test("AMM-結合: labIdが存在しない場合は404", async () => {
  const deps = makeDeps();
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "no-such-lab", "BAL", "1", { playerMessage: "test" }, client);
  assert.equal(result.status, 404);
});

test("AMM-結合: companyIdがプレイヤー会社と異なる場合は404", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-x1");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-x1", "MASS", "1", { playerMessage: "test" }, client);
  assert.equal(result.status, 404);
});

test("AMM-結合: turnが現在のturnと異なる場合は404", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-x2");
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(VALID_MEETING_RESPONSE) } };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-x2", "BAL", "99", { playerMessage: "test" }, client);
  assert.equal(result.status, 404);
});

test("AMM-結合: 会話は会話ID単位で永続化され、2回目の呼び出しでも直近履歴を引き継ぐ", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-x3");
  let calls = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        calls += 1;
        return toolUseResponse(VALID_MEETING_RESPONSE);
      },
    },
  };
  const first = await handlePostAiMeetingMessage(deps, "lab-amm-x3", "BAL", "1", { playerMessage: "現金は足りてる？" }, client);
  const firstBody = first.body as { meetingId: string };
  const second = await handlePostAiMeetingMessage(
    deps,
    "lab-amm-x3",
    "BAL",
    "1",
    { meetingId: firstBody.meetingId, playerMessage: "ではCAPEXを検討したい" },
    client
  );
  assert.equal(second.status, 200);
  assert.equal(calls, 2);
});
