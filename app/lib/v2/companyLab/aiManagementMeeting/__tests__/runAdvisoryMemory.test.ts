// AMM-MEM-1..20（AMM-M2.6・実装指示§40）— Run Advisory Memory / Player Correction Memory。
//
// 【背景】プレイヤーが会話中に明示した訂正・そのRun固有の方針・一時的な制約・優先順位・
// 未確認見解を、AI Management Meeting専用のRun-scoped advisory memoryとして保持し、
// 同一Run内の後続turnでもAI役員が参照できるようにする。これはStandard AIの学習でも
// Game Engineの学習でもない。本テストはruntAdvisoryMemory.ts（persistence/confirmation/
// dedupe/expiry/role relevance）とprompt.tsのガードレール、および記憶とゲーム状態の
// 分離を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  applyCandidate,
  buildRunAdvisoryMemorySummary,
  confirmMemoryCandidate,
  expireRunMemories,
  MAX_ACTIVE_RUN_MEMORY,
} from "../runAdvisoryMemory";
import { RunAdvisoryMemoryCandidate, RunAdvisoryMemoryRecord } from "../types";
import { AI_MANAGEMENT_MEETING_SYSTEM_PROMPT } from "../prompt";
import { aiMeetingStructuredResponseSchema } from "../proposalSchema";

function candidate(overrides: Partial<RunAdvisoryMemoryCandidate> = {}): RunAdvisoryMemoryCandidate {
  return {
    action: "SAVE",
    type: "PLAYER_PREFERENCE",
    topic: "CASH_FLOOR",
    statement: "Player prefers to keep cash >= $30M during this run.",
    requestedScope: "RUN",
    ...overrides,
  };
}

function baseRecord(overrides: Partial<RunAdvisoryMemoryRecord> = {}): RunAdvisoryMemoryRecord {
  return {
    id: "mem-existing",
    runId: "lab-1",
    companyId: "BAL",
    createdTurn: 1,
    updatedTurn: 1,
    scope: "RUN",
    type: "PLAYER_PREFERENCE",
    topic: "CASH_FLOOR",
    statement: "Player prefers to keep cash >= $30M during this run.",
    verificationStatus: "NOT_VERIFIABLE",
    sourceMessageId: "msg-1",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const CTX = { runId: "lab-1", companyId: "BAL", currentTurn: 3, sourceMessageId: "msg-3", existingRecords: [] as readonly RunAdvisoryMemoryRecord[] };
const NOW = "2026-01-05T00:00:00.000Z";

test("AMM-MEM-1: 通常の質問に対してmemoryを生成しないことがpromptで明示されている", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /今期の売上は？」のような通常質問には候補を生成しないでください/);
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /通常の質問には生成しない/);
});

test("AMM-MEM-2: confirmed correction候補はBACKLOG_SEMANTICSかつfacts一致の場合のみSUPPORTEDとなり、M2.5 system ruleと重複するため実際には保存しない", () => {
  const c = candidate({ type: "CONFIRMED_CORRECTION", topic: "BACKLOG_SEMANTICS", statement: "受注残はfuture dueでありoverdueではない。" });
  const confirmed = confirmMemoryCandidate(c, { backlogStatus: "FUTURE_DUE" });
  assert.equal(confirmed.verificationStatus, "SUPPORTED");
  assert.equal(confirmed.finalType, "CONFIRMED_CORRECTION");

  // 実装指示§30推奨: M2.5のRuleSemantics/due statusで既に正式ルール化されているため、重複保存はしない。
  const applied = applyCandidate(c, confirmed.finalType, confirmed.verificationStatus, CTX, NOW);
  assert.equal(applied.savedId, null);
  assert.equal(applied.skippedReason, "redundant_with_system_rule");
});

test("AMM-MEM-3: BriefingPacketで機械照合できないCONFIRMED_CORRECTION候補はUNVERIFIED_CLAIMへ降格される（Claudeだけでconfirmedにしない）", () => {
  const c = candidate({ type: "CONFIRMED_CORRECTION", topic: "CASH_FLOOR", statement: "この借入は来期全部返る。", verificationHint: "プレイヤーの発言" });
  const confirmed = confirmMemoryCandidate(c, {});
  assert.equal(confirmed.verificationStatus, "NOT_VERIFIABLE");
  assert.equal(confirmed.finalType, "UNVERIFIED_CLAIM");
});

test("AMM-MEM-4: player preferenceが保存される", () => {
  const c = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "Cashは最低30M維持を希望。", normalizedValue: 30_000_000 });
  const confirmed = confirmMemoryCandidate(c, {});
  const applied = applyCandidate(c, confirmed.finalType, confirmed.verificationStatus, CTX, NOW);
  assert.ok(applied.savedId);
  const saved = applied.records.find((r) => r.id === applied.savedId);
  assert.equal(saved?.type, "PLAYER_PREFERENCE");
  assert.equal(saved?.normalizedValue, 30_000_000);
  assert.equal(saved?.isActive, true);
});

test("AMM-MEM-5: strategic intentが保存される", () => {
  const c = candidate({ type: "STRATEGIC_INTENT", topic: "MARKET_PRIORITY", statement: "このRunではJapanを優先する。" });
  const confirmed = confirmMemoryCandidate(c, {});
  const applied = applyCandidate(c, confirmed.finalType, confirmed.verificationStatus, CTX, NOW);
  assert.ok(applied.savedId);
  const saved = applied.records.find((r) => r.id === applied.savedId);
  assert.equal(saved?.type, "STRATEGIC_INTENT");
  assert.equal(saved?.topic, "MARKET_PRIORITY");
});

test("AMM-MEM-6: temporary constraintはexpiresAfterTurnを超えるとactive=falseになる", () => {
  const record = baseRecord({ type: "TEMPORARY_CONSTRAINT", topic: "CAPEX_POSTURE", expiresAfterTurn: 5, isActive: true });
  const stillActive = expireRunMemories([record], 5, NOW);
  assert.equal(stillActive[0].isActive, true);
  const expired = expireRunMemories([record], 6, NOW);
  assert.equal(expired[0].isActive, false);
});

test("AMM-MEM-7: 同一topic・同一typeのmemoryは新しい発言で更新される（履歴を積み増さない）", () => {
  const first = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "Cash最低30M。", normalizedValue: 30_000_000 });
  const a1 = applyCandidate(first, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", CTX, NOW);
  const second = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "やはり最低40Mにしたい。", normalizedValue: 40_000_000 });
  const a2 = applyCandidate(second, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", { ...CTX, currentTurn: 8, existingRecords: a1.records }, "2026-01-08T00:00:00.000Z");
  assert.equal(a2.records.length, 1, "同一topicなので件数は増えない");
  assert.equal(a2.savedId, a1.savedId, "同一idを更新する");
  assert.equal(a2.records[0].statement, "やはり最低40Mにしたい。");
  assert.equal(a2.records[0].normalizedValue, 40_000_000);
  assert.equal(a2.records[0].updatedTurn, 8);
});

test("AMM-MEM-8: 明示的なforgetでmemoryがinactive化される（完全削除ではない）", () => {
  const saveCandidate = candidate({ type: "STRATEGIC_INTENT", topic: "MARKET_PRIORITY", statement: "Japanを優先。" });
  const saved = applyCandidate(saveCandidate, "STRATEGIC_INTENT", "NOT_VERIFIABLE", CTX, NOW);
  const forgetCandidate = candidate({ action: "FORGET", type: "STRATEGIC_INTENT", topic: "MARKET_PRIORITY", statement: "Japan優先の記憶を取り消し。" });
  const forgotten = applyCandidate(forgetCandidate, "STRATEGIC_INTENT", "NOT_VERIFIABLE", { ...CTX, existingRecords: saved.records }, NOW);
  assert.equal(forgotten.forgottenIds.length, 1);
  const target = forgotten.records.find((r) => r.id === forgotten.forgottenIds[0]);
  assert.equal(target?.isActive, false, "完全削除ではなくinactive化される");
  assert.equal(forgotten.records.length, saved.records.length, "recordそのものは削除されない");
});

test("AMM-MEM-9: Run Advisory MemoryはStandard AIを一切参照・変更しない（構造上の分離）", () => {
  const source = fs.readFileSync(path.join(__dirname, "../runAdvisoryMemory.ts"), "utf8");
  assert.ok(!/standardAi/i.test(source), "runAdvisoryMemory.tsはStandard AIモジュールを一切importしてはいけない");
});

test("AMM-MEM-10: Run Advisory Memoryはgame state SSoTを一切変更しない（構造上の分離）", () => {
  const source = fs.readFileSync(path.join(__dirname, "../runAdvisoryMemory.ts"), "utf8");
  assert.ok(!/CompanyLabState|CompanyDecisionDraft|companyLabStateRepository/i.test(source), "runAdvisoryMemory.tsはgame state SSoTの型・保存関数を一切importしてはいけない");
});

test("AMM-MEM-11: 異なるrunId(labId)のmemoryは分離される（applyCandidateのcontext.runIdで判定）", () => {
  const recordForRunA = baseRecord({ id: "mem-a", runId: "lab-A", companyId: "BAL" });
  const c = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "別Runでの発言。" });
  const applied = applyCandidate(c, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", { runId: "lab-B", companyId: "BAL", currentTurn: 1, sourceMessageId: "msg-x", existingRecords: [recordForRunA] }, NOW);
  // lab-Bのcandidateはlab-Aのrecordと重複判定されず、新規保存される。
  assert.equal(applied.records.length, 2);
  assert.notEqual(applied.savedId, "mem-a");
});

test("AMM-MEM-12: 異なるcompanyIdのmemoryは分離される", () => {
  const recordForCompanyA = baseRecord({ id: "mem-a", runId: "lab-1", companyId: "BAL" });
  const c = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "別会社での発言。" });
  const applied = applyCandidate(c, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", { runId: "lab-1", companyId: "MASS", currentTurn: 1, sourceMessageId: "msg-x", existingRecords: [recordForCompanyA] }, NOW);
  assert.equal(applied.records.length, 2);
  assert.notEqual(applied.savedId, "mem-a");
});

test("AMM-MEM-13: role relevance filtering — CASH_FLOORはCFO/CEOに関連し、COO/COMMERCIALには紐付かない", () => {
  const record = baseRecord({ topic: "CASH_FLOOR", type: "PLAYER_PREFERENCE" });
  const summary = buildRunAdvisoryMemorySummary([record]);
  const item = summary.playerPreferences[0];
  assert.ok(item.relevantRoles.includes("CFO"));
  assert.ok(item.relevantRoles.includes("CEO"));
  assert.ok(!item.relevantRoles.includes("COO"));
  assert.ok(!item.relevantRoles.includes("COMMERCIAL"));
});

test("AMM-MEM-14: 最新のプレイヤー発言が古いpreferenceより優先されることがpromptで明示されている", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /Current player message overrides older preferences when explicitly changed/);
});

test("AMM-MEM-15: 矛盾する場合、現在のstructured briefingが古いmemoryより優先されることがpromptで明示されている", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /Current structured briefing overrides stale memories if they conflict/);
});

test("AMM-MEM-16: unverified claimはgame factとして提示されず、ラベルのまま保持されることがpromptで明示されている", () => {
  assert.match(AI_MANAGEMENT_MEETING_SYSTEM_PROMPT, /Unverified claims must not be presented as game facts/);
  const c = candidate({ type: "UNVERIFIED_CLAIM", topic: "CUSTOM", statement: "来期VAP価格は絶対上がる。" });
  const confirmed = confirmMemoryCandidate(c, {});
  assert.equal(confirmed.finalType, "UNVERIFIED_CLAIM");
});

test("AMM-MEM-17: memoryUsedIdsがstructured responseスキーマへ含まれ、省略時は空配列になる", () => {
  const withIds = aiMeetingStructuredResponseSchema.safeParse({
    primarySpeaker: "CFO",
    responses: [{ speaker: "CFO", text: "Cash floorのpreferenceを踏まえると問題ありません。", proposalIds: [], factsUsed: [], standardAiReferences: [] }],
    requiresCeoSummary: false,
    proposals: [],
    meetingIntent: "CUSTOM",
    potentialStrategicChange: false,
    playerCorrectionStatus: "NOT_APPLICABLE",
    memoryUsedIds: ["mem-1", "mem-2"],
  });
  assert.equal(withIds.success, true);
  if (withIds.success) assert.deepEqual(withIds.data.memoryUsedIds, ["mem-1", "mem-2"]);

  const withoutIds = aiMeetingStructuredResponseSchema.safeParse({
    primarySpeaker: "CFO",
    responses: [{ speaker: "CFO", text: "通常の応答です。", proposalIds: [], factsUsed: [], standardAiReferences: [] }],
    requiresCeoSummary: false,
    proposals: [],
    meetingIntent: "CUSTOM",
    potentialStrategicChange: false,
    playerCorrectionStatus: "NOT_APPLICABLE",
  });
  assert.equal(withoutIds.success, true);
  if (withoutIds.success) {
    assert.deepEqual(withoutIds.data.memoryUsedIds, []);
    assert.deepEqual(withoutIds.data.memoryCandidates, []);
  }
});

test("AMM-MEM-20: active memory件数の上限（MAX_ACTIVE_RUN_MEMORY）に達すると新規保存を見送り、同一topicは重複せず更新される", () => {
  const topics = ["CASH_FLOOR", "MARKET_PRIORITY", "PRODUCT_PRIORITY", "CAPEX_POSTURE", "DEBT_TOLERANCE", "GROWTH_PRIORITY", "MARGIN_PRIORITY", "QUALITY_PRIORITY", "INVENTORY_POLICY", "CUSTOM"] as const;
  let records: readonly RunAdvisoryMemoryRecord[] = [];
  // PLAYER_PREFERENCE/STRATEGIC_INTENTの2 type × 10 topic = 20件でちょうど上限に到達させる。
  for (const type of ["PLAYER_PREFERENCE", "STRATEGIC_INTENT"] as const) {
    for (const topic of topics) {
      const c = candidate({ type, topic, statement: `${type}-${topic}の発言。` });
      const applied = applyCandidate(c, type, "NOT_VERIFIABLE", { ...CTX, existingRecords: records }, NOW);
      records = applied.records;
    }
  }
  assert.equal(records.filter((r) => r.isActive).length, MAX_ACTIVE_RUN_MEMORY);

  // 上限到達後の新規topicは保存を見送る。
  const overflow = candidate({ type: "PLAYER_PREFERENCE", topic: "CUSTOM", statement: "上限超過の新規発言その2。" });
  const overflowApplied = applyCandidate(overflow, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", { ...CTX, existingRecords: records }, NOW);
  assert.equal(overflowApplied.skippedReason, "max_active_count_reached");
  assert.equal(overflowApplied.records.length, records.length);

  // 一方、既存topicの更新（dedupe）は上限に関係なく通る。
  const update = candidate({ type: "PLAYER_PREFERENCE", topic: "CASH_FLOOR", statement: "既存topicの更新は上限を超えない。" });
  const updateApplied = applyCandidate(update, "PLAYER_PREFERENCE", "NOT_VERIFIABLE", { ...CTX, existingRecords: records }, NOW);
  assert.equal(updateApplied.records.length, records.length);
  assert.ok(updateApplied.savedId);
});
