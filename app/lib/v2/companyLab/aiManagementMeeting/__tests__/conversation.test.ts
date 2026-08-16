// AMM-17: conversation-history-truncation

import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_MEETING_RECENT_MESSAGE_COUNT, buildRecentHistoryForPrompt } from "../conversation";
import { AiMeetingMessage } from "../types";

function msg(i: number): AiMeetingMessage {
  return { id: `m${i}`, speaker: i % 2 === 0 ? "PLAYER" : "CFO", text: `message ${i}`, turn: 1, proposalIds: [], factsUsed: [] };
}

test("AMM-17: 履歴が上限以下ならそのまま全件を送り、要約は無い", () => {
  const messages = Array.from({ length: 5 }, (_, i) => msg(i));
  const { recent, compactSummary } = buildRecentHistoryForPrompt(messages);
  assert.equal(recent.length, 5);
  assert.equal(compactSummary, null);
});

test("AMM-17b: 履歴が上限を超えたら、直近N件のみを送り、古い部分は要約へ圧縮する（毎回全件は再送しない）", () => {
  const messages = Array.from({ length: 15 }, (_, i) => msg(i));
  const { recent, compactSummary } = buildRecentHistoryForPrompt(messages);
  assert.equal(recent.length, AI_MEETING_RECENT_MESSAGE_COUNT);
  assert.equal(recent[0].id, `m${15 - AI_MEETING_RECENT_MESSAGE_COUNT}`);
  assert.notEqual(compactSummary, null);
  assert.ok(compactSummary!.includes("m0") === false); // 要約は文言のみ（idはそのまま含まれない）
  assert.ok(compactSummary!.includes("message 0"));
});
