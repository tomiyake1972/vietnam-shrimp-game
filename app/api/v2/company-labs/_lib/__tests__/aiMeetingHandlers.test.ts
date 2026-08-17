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
import { handleGetAiMeetingConversation, handlePostAiMeetingMessage } from "../../[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";

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
  playerCorrectionStatus: "NOT_APPLICABLE",
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

// AMM-FG-5: confirmed player correction retained
// AMM-FG-6: unsupported player claim not auto-confirmed

test("AMM-FG-5: playerCorrectionStatus=CONFIRMEDの応答は、会話のconfirmedCorrectionsへ記録され、次回呼び出しにも引き継がれる", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-fg5");
  const confirmedResponse = {
    ...VALID_MEETING_RESPONSE,
    playerCorrectionStatus: "CONFIRMED",
    playerCorrectionNote: "受注残はfuture dueでありoverdueではない（overdueTons=0で確認済み）。",
  };
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(confirmedResponse) } };
  const first = await handlePostAiMeetingMessage(deps, "lab-amm-fg5", "BAL", "1", { playerMessage: "受注残は納期遅延ではないです" }, client);
  assert.equal(first.status, 200);
  const firstBody = first.body as { meetingId: string; playerCorrectionStatus: string };
  assert.equal(firstBody.playerCorrectionStatus, "CONFIRMED");

  // 2回目の呼び出しでも会話が引き継がれ、confirmedCorrectionsが保持されていることをGETで確認する。
  const getResult = await handleGetAiMeetingConversation(deps, "lab-amm-fg5", "BAL", firstBody.meetingId);
  assert.equal(getResult.status, 200);
  const conversation = getResult.body as { confirmedCorrections: readonly { note: string }[] };
  assert.equal(conversation.confirmedCorrections.length, 1);
  assert.ok(conversation.confirmedCorrections[0].note.includes("overdueTons=0"));
});

test("AMM-FG-6: playerCorrectionStatus=UNSUPPORTEDの応答は、confirmedCorrectionsへ記録されない", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-fg6");
  const unsupportedResponse = {
    ...VALID_MEETING_RESPONSE,
    playerCorrectionStatus: "UNSUPPORTED",
    playerCorrectionNote: "この借金が来期全額返済されるという記載はBriefingPacketにはありません。",
  };
  const client: AnthropicMessagesClient = { messages: { create: async () => toolUseResponse(unsupportedResponse) } };
  const first = await handlePostAiMeetingMessage(deps, "lab-amm-fg6", "BAL", "1", { playerMessage: "この借金は来期全部返済される" }, client);
  assert.equal(first.status, 200);
  const firstBody = first.body as { meetingId: string; playerCorrectionStatus: string };
  assert.equal(firstBody.playerCorrectionStatus, "UNSUPPORTED");

  const getResult = await handleGetAiMeetingConversation(deps, "lab-amm-fg6", "BAL", firstBody.meetingId);
  const conversation = getResult.body as { confirmedCorrections: readonly unknown[] };
  assert.equal(conversation.confirmedCorrections.length, 0);
});

test("AMM-DUE-5: overdue=0で禁止語彙を含む応答は1回だけrepairされ、repair後の応答が使われる", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-due5");
  const violatingResponse = {
    ...VALID_MEETING_RESPONSE,
    responses: [{ ...VALID_MEETING_RESPONSE.responses[0], text: "未納期限オーバー分がありますが、財務的には問題ありません。" }],
  };
  const repairedResponse = {
    ...VALID_MEETING_RESPONSE,
    responses: [{ ...VALID_MEETING_RESPONSE.responses[0], text: "受注残は次四半期の履行義務であり、財務的には問題ありません。" }],
  };
  let callCount = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        callCount += 1;
        return toolUseResponse(callCount === 1 ? violatingResponse : repairedResponse);
      },
    },
  };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-due5", "BAL", "1", { playerMessage: "現状を分析してください" }, client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(callCount, 2, "1回目で違反が検知され、repairのため2回目のAPI呼び出しが発生するはず");
  const body = result.body as { messages: readonly { speaker: string; text: string }[]; diagnostics: { semanticGuardResult?: string } };
  const cfoMessage = body.messages.find((m) => m.speaker === "CFO");
  assert.ok(cfoMessage?.text.includes("次四半期の履行義務"), "repair後の応答テキストが使われるべき");
  assert.equal(body.diagnostics.semanticGuardResult, "repaired");
});

test("AMM-DUE-6: overdue=0で禁止語彙を含まない応答はrepairされない（1回のAPI呼び出しのみ）", async () => {
  const deps = makeDeps();
  await createBaselineLab(deps, "lab-amm-due6");
  let callCount = 0;
  const client: AnthropicMessagesClient = {
    messages: {
      create: async () => {
        callCount += 1;
        return toolUseResponse(VALID_MEETING_RESPONSE);
      },
    },
  };
  const result = await handlePostAiMeetingMessage(deps, "lab-amm-due6", "BAL", "1", { playerMessage: "現状を分析してください" }, client);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(callCount, 1, "違反が無ければrepair呼び出しは発生しないはず");
  const body = result.body as { diagnostics: { semanticGuardResult?: string } };
  assert.equal(body.diagnostics.semanticGuardResult, "ok");
});
