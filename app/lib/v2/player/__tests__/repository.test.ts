// ShrimpX V2 — Independent Player Flow: PlayerRepository（in-memory実装）のテスト
//
// 実Redis・環境変数なしで検証する（simulation-runs/_lib/handlers.test.tsと同じ方針）。
// ここは「誰がどの会社を操作してよいか」の認可状態そのものであり、指示で明示された
// 最低限のセキュリティテスト（secret issue/verify/revoke・旧credential失効・
// 二重claim拒否）の中核をここで検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPlayerRepository } from "../repository";
import { PlayerAuthError } from "../types";

const AT = "2026-01-01T00:00:00.000Z";
const AT2 = "2026-01-01T00:05:00.000Z";

test("PLAYER-REPO-1: 参加リンク発行 → claim → 正しくSeat/Sessionが結び付く", async () => {
  const repo = createInMemoryPlayerRepository();
  const { seat, joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  assert.equal(seat.runId, "run-1");
  assert.equal(seat.companyId, "BAL");
  assert.ok(seat.currentJoinSecretHash);
  assert.ok(joinSecret.length >= 32, "joinSecretは十分なエントロピーを持つべき");

  const { session, seat: claimedSeat } = await repo.claimJoinSecret(joinSecret, AT2);
  assert.equal(session.runId, "run-1");
  assert.equal(session.companyId, "BAL");
  assert.equal(claimedSeat.claimedSessionId, session.sessionId);

  const loadedSession = await repo.loadSession(session.sessionId);
  assert.equal(loadedSession?.runId, "run-1");
  assert.equal(loadedSession?.companyId, "BAL");
  assert.equal(loadedSession?.revokedAt, null);
});

test("PLAYER-REPO-2: 存在しないjoin secretのclaimはJOIN_NOT_FOUNDで拒否される", async () => {
  const repo = createInMemoryPlayerRepository();
  await assert.rejects(
    () => repo.claimJoinSecret("never-issued-secret", AT),
    (e: unknown) => e instanceof PlayerAuthError && e.code === "JOIN_NOT_FOUND"
  );
});

test("PLAYER-REPO-3【二重claim拒否】: 一度claimされたSeatへの2人目のclaimはJOIN_ALREADY_CLAIMEDで拒否される", async () => {
  const repo = createInMemoryPlayerRepository();
  const { joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  await repo.claimJoinSecret(joinSecret, AT);
  await assert.rejects(
    () => repo.claimJoinSecret(joinSecret, AT2),
    (e: unknown) => e instanceof PlayerAuthError && e.code === "JOIN_ALREADY_CLAIMED"
  );
});

test("PLAYER-REPO-4【旧credential失効】: GMが参加リンクを再発行すると、旧secretでのclaimは拒否される", async () => {
  const repo = createInMemoryPlayerRepository();
  const first = await repo.issueJoinCredential("run-1", "BAL", AT);
  const second = await repo.issueJoinCredential("run-1", "BAL", AT2);
  assert.notEqual(first.joinSecret, second.joinSecret);

  // 【実装】旧secretのhashはjoinIndexから完全に削除される（tombstoneを残さない設計）ため、
  // 「かつて存在したリンクだった」という情報自体を漏らさないJOIN_NOT_FOUNDとして拒否される。
  // どちらのcode（NOT_FOUND/REVOKED）でも「旧credentialでは二度と入れない」という
  // セキュリティ上の保証は同じであり、ここではその保証だけを検証する。
  await assert.rejects(
    () => repo.claimJoinSecret(first.joinSecret, AT2),
    (e: unknown) => e instanceof PlayerAuthError && e.code === "JOIN_NOT_FOUND"
  );
  // 新しいsecretでは問題なくclaimできる。
  const { session } = await repo.claimJoinSecret(second.joinSecret, AT2);
  assert.equal(session.companyId, "BAL");
});

test("PLAYER-REPO-5【旧credential失効・再発行は既存の参加も失効させる】: 既にclaim済みのSessionがある状態で再発行すると、旧Sessionはrevokedになる", async () => {
  const repo = createInMemoryPlayerRepository();
  const { joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  const { session: oldSession } = await repo.claimJoinSecret(joinSecret, AT);

  await repo.issueJoinCredential("run-1", "BAL", AT2);

  const reloaded = await repo.loadSession(oldSession.sessionId);
  assert.equal(reloaded?.revokedAt, AT2, "再発行によって旧sessionが失効していない");
});

test("PLAYER-REPO-6: GMによるSeat失効（revokeSeat）後は、旧secretでのclaimが拒否され、既存Sessionも失効する", async () => {
  const repo = createInMemoryPlayerRepository();
  const { joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  const { session } = await repo.claimJoinSecret(joinSecret, AT);

  const revoked = await repo.revokeSeat("run-1", "BAL", AT2);
  assert.equal(revoked?.joinRevokedAt, AT2);
  assert.equal(revoked?.claimedSessionId, null);

  const reloadedSession = await repo.loadSession(session.sessionId);
  assert.equal(reloadedSession?.revokedAt, AT2);

  await assert.rejects(
    () => repo.claimJoinSecret(joinSecret, AT2),
    (e: unknown) => e instanceof PlayerAuthError && e.code === "JOIN_NOT_FOUND"
  );
});

test("PLAYER-REPO-7【Run isolation】: 同じcompanyId（例: BAL）でも異なるrunIdなら完全に別のSeat/Sessionになる", async () => {
  const repo = createInMemoryPlayerRepository();
  const a = await repo.issueJoinCredential("run-A", "BAL", AT);
  const b = await repo.issueJoinCredential("run-B", "BAL", AT);
  assert.notEqual(a.joinSecret, b.joinSecret);

  const claimedA = await repo.claimJoinSecret(a.joinSecret, AT);
  assert.equal(claimedA.session.runId, "run-A");

  // run-Aのsecretはrun-Bのclaimには使えない（別のjoinIndexエントリのため、
  // そもそもjoinSecret自体が異なる文字列であり混同しようがない）。
  const claimedB = await repo.claimJoinSecret(b.joinSecret, AT);
  assert.equal(claimedB.session.runId, "run-B");
  assert.notEqual(claimedA.session.sessionId, claimedB.session.sessionId);
});

test("PLAYER-REPO-8: listSeatsForRunは存在するSeatだけを返す（未発行の会社はnullで埋めず省く）", async () => {
  const repo = createInMemoryPlayerRepository();
  await repo.issueJoinCredential("run-1", "BAL", AT);
  const seats = await repo.listSeatsForRun("run-1", ["BAL", "MASS", "TIG"]);
  assert.equal(seats.length, 1);
  assert.equal(seats[0].companyId, "BAL");
});

test("PLAYER-REPO-9: recordSubmissionはSeatが未発行でもlazy-createし、既存Seatなら提出情報だけ更新する", async () => {
  const repo = createInMemoryPlayerRepository();
  const lazily = await repo.recordSubmission("run-1", "BAL", 3, AT);
  assert.equal(lazily.lastSubmittedTurn, 3);
  assert.equal(lazily.joinIssuedAt, null, "参加リンク未発行のまま提出記録だけがlazy-createされる（GM代理操作の副次記録経路）");

  await repo.issueJoinCredential("run-1", "MASS", AT);
  const updated = await repo.recordSubmission("run-1", "MASS", 5, AT2);
  assert.equal(updated.lastSubmittedTurn, 5);
  assert.ok(updated.joinIssuedAt, "既存Seatの他フィールドは保持される");
});

test("PLAYER-REPO-10: touchSessionはlastSeenAtだけを更新する", async () => {
  const repo = createInMemoryPlayerRepository();
  const { joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  const { session } = await repo.claimJoinSecret(joinSecret, AT);
  await repo.touchSession(session.sessionId, AT2);
  const reloaded = await repo.loadSession(session.sessionId);
  assert.equal(reloaded?.lastSeenAt, AT2);
  assert.equal(reloaded?.createdAt, AT);
});

test("PLAYER-REPO-11: revokeSessionはSessionをrevoked扱いにし、Seatのclaim状態を解放する", async () => {
  const repo = createInMemoryPlayerRepository();
  const { joinSecret } = await repo.issueJoinCredential("run-1", "BAL", AT);
  const { session } = await repo.claimJoinSecret(joinSecret, AT);
  await repo.revokeSession(session.sessionId, AT2);

  const reloadedSession = await repo.loadSession(session.sessionId);
  assert.equal(reloadedSession?.revokedAt, AT2);

  const seat = await repo.loadSeat("run-1", "BAL");
  assert.equal(seat?.claimedSessionId, null);
});
