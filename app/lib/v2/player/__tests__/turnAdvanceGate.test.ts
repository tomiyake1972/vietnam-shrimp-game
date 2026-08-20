// ShrimpX V2 — Independent Player Flow: Turn Advance Gate（createPlayerSeatSubmissionGate）のテスト
//
// GMが参加linkを発行した（＝Independent Player Flowへ組み入れた）PLAYER会社だけを
// 対象に、そのTurnの提出が揃っているか検査することを確認する。参加linkを一度も
// 発行していない会社（GM代理操作のみ）はgateの対象にならない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPlayerRepository } from "../repository";
import { createPlayerSeatSubmissionGate } from "../turnAdvanceGate";

const AT = "2026-01-01T00:00:00.000Z";

test("GATE-1: PLAYER会社が無ければ常に許可する", async () => {
  const repo = createInMemoryPlayerRepository();
  const gate = createPlayerSeatSubmissionGate(repo);
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "STANDARD_AI" });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.missingCompanyIds, []);
});

test("GATE-2: 参加linkを一度も発行していないPLAYER会社（GM代理操作のみ）はgate対象外", async () => {
  const repo = createInMemoryPlayerRepository();
  const gate = createPlayerSeatSubmissionGate(repo);
  // 参加link未発行＝Seatが存在しない。
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "PLAYER" });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.missingCompanyIds, []);
});

test("GATE-3: 参加linkを発行済みだが、当該Turnの提出がまだ無いPLAYER会社はブロックする", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-1", "BAL", AT);
  const gate = createPlayerSeatSubmissionGate(repo);
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "PLAYER" });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missingCompanyIds, ["BAL"]);
});

test("GATE-4: 当該Turnの提出（lastSubmittedTurn===completedTurn）が揃っていれば許可する", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-1", "BAL", AT);
  await repo.recordSubmission("run-1", "BAL", 3, AT);
  const gate = createPlayerSeatSubmissionGate(repo);
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "PLAYER" });
  assert.equal(result.allowed, true);
});

test("GATE-5【stale Turn】: 提出済みTurnが古い（前のTurnの提出のまま）場合はブロックする", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-1", "BAL", AT);
  await repo.recordSubmission("run-1", "BAL", 2, AT);
  const gate = createPlayerSeatSubmissionGate(repo);
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "PLAYER" });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missingCompanyIds, ["BAL"]);
});

test("GATE-6【複数PLAYER会社】: 一部だけ未提出なら、未提出の会社だけをmissingとして返す", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-1", "BAL", AT);
  await repo.issueJoinCredential("run-1", "MASS", AT);
  await repo.recordSubmission("run-1", "BAL", 3, AT);
  // MASSは参加linkはあるがまだ提出していない。
  const gate = createPlayerSeatSubmissionGate(repo);
  const result = await gate.checkTurnAdvanceAllowed("run-1", 3, { BAL: "PLAYER", MASS: "PLAYER" });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missingCompanyIds, ["MASS"]);
});

test("GATE-7【Run isolation】: 別Runの同名companyIdの提出状況を混同しない", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-A", "BAL", AT);
  await repo.recordSubmission("run-A", "BAL", 3, AT);
  await repo.issueJoinCredential("run-B", "BAL", AT);
  // run-Bの方は未提出。

  const gate = createPlayerSeatSubmissionGate(repo);
  const resultA = await gate.checkTurnAdvanceAllowed("run-A", 3, { BAL: "PLAYER" });
  assert.equal(resultA.allowed, true);
  const resultB = await gate.checkTurnAdvanceAllowed("run-B", 3, { BAL: "PLAYER" });
  assert.equal(resultB.allowed, false);
});
