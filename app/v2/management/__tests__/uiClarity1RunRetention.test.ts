// ShrimpX V2 — UI-CLARITY-1 A-6: Run保存上限の事前警告
//
// 固定する契約
//   ・一覧が取れていない間は警告しない（推測で脅さない）
//   ・上限に余裕があるときも、ルール自体は伝える
//   ・残りわずか／上限到達では段階を上げ、次に消えるRunを名指しする
//   ・次に消えるのは savedAt が最も古いRun（サーバー側のscoreと同じ基準）

import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_RUN_RETENTION_LIMIT, buildRunRetentionNotice, type RunRetentionInput } from "../lib/runRetentionNotice";

function runs(count: number, startIso = "2026-01-01T00:00:00.000Z"): RunRetentionInput[] {
  const base = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    simulationRunId: `run-${i}`,
    savedAt: new Date(base + i * 86_400_000).toISOString(),
    runName: `テスト${i}`,
  }));
}

test("UIC1-13 (A-6): 一覧が取れていない間は警告しない", () => {
  assert.equal(buildRunRetentionNotice(null), null);
  assert.equal(buildRunRetentionNotice(undefined), null);
});

test("UIC1-14 (A-6): 余裕があるときもルールは伝えるが、削除予定は名指ししない", () => {
  const notice = buildRunRetentionNotice(runs(5));
  assert.ok(notice !== null);
  assert.equal(notice.level, "ok");
  assert.equal(notice.savedRunCount, 5);
  assert.equal(notice.limit, SERVER_RUN_RETENTION_LIMIT);
  assert.equal(notice.runIdToBeEvicted, undefined, "まだ消えないのに削除予定を出している");
  assert.ok(notice.message.includes("自動的に削除されます"), "ルールが伝わらない");
});

test("UIC1-15 (A-6): 残りわずかでは段階を上げ、次に消えるRunを名指しする", () => {
  const notice = buildRunRetentionNotice(runs(18));
  assert.ok(notice !== null);
  assert.equal(notice.level, "nearLimit");
  assert.ok(notice.message.includes("あと 2 本"), `残り本数が出ていない: ${notice.message}`);
  assert.equal(notice.runIdToBeEvicted, "run-0", "最も古いRunが削除予定になっていない");
});

test("UIC1-16 (A-6): 上限到達では、開始すると消えることを明言する", () => {
  const notice = buildRunRetentionNotice(runs(SERVER_RUN_RETENTION_LIMIT));
  assert.ok(notice !== null);
  assert.equal(notice.level, "atLimit");
  assert.ok(notice.message.includes("上限の 20 本に達しています"));
  assert.ok(notice.message.includes("元に戻せません"), "取り返しがつかないことが書かれていない");
  assert.equal(notice.runIdToBeEvicted, "run-0");
  assert.equal(notice.runNameToBeEvicted, "テスト0");
});

test("UIC1-17 (A-6): 削除予定は保存日の最も古いRun（一覧の並び順には依存しない）", () => {
  const shuffled: RunRetentionInput[] = [
    { simulationRunId: "new", savedAt: "2026-03-01T00:00:00.000Z", runName: "新しい" },
    { simulationRunId: "oldest", savedAt: "2025-12-31T00:00:00.000Z", runName: "いちばん古い" },
    { simulationRunId: "mid", savedAt: "2026-02-01T00:00:00.000Z", runName: "まんなか" },
    ...runs(17, "2026-04-01T00:00:00.000Z"),
  ];
  const notice = buildRunRetentionNotice(shuffled);
  assert.ok(notice !== null);
  assert.equal(notice.level, "atLimit");
  assert.equal(notice.runIdToBeEvicted, "oldest");
});
