// ShrimpX V2 — BW-1: GM Seat 一覧の「変化なし」判定が取りこぼさないこと
//
// Seat（参加linkの発行・再発行・失効、参加、代理提出の記録）は Run の
// persistenceRevision とは独立に変わる。したがって「revision が同じだから変化なし」
// だけでは Seat の変化を見落とす。そのため一覧 API は Seat の指紋も併せて比べる。
//
// ここで固定する契約
//   1. 何も変わっていなければ指紋は同じ（= 大きいパートを読まずに済む）。
//   2. 発行・参加・失効・再発行・代理提出のそれぞれで指紋が必ず変わる。
//   3. Seat レコードがまだ無い会社（旧Run の lazy-create 前）も表現でき、
//      Seat が出来た時点で指紋が変わる。
//   4. Seat の並び順や会社の渡し順では変わらない（無駄な全読みを誘発しない）。
//
// 指紋は「変わったかどうか」だけに使い、join URL の平文や secret hash は含めない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { playerSeatsFingerprint } from "../[runId]/route";
import type { PlayerSeatRecord } from "../../../../../lib/v2/player/types";
import type { CompanyId } from "../../../../../lib/v2/sales/types";

const RUN_ID = "run-bw1-seats";
const COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ"];

function seat(companyId: CompanyId, over: Partial<PlayerSeatRecord> = {}): PlayerSeatRecord {
  return {
    runId: RUN_ID,
    companyId,
    currentJoinSecretHash: "hash-ignored",
    joinIssuedAt: "2026-10-08T00:00:00.000Z",
    joinRevokedAt: null,
    claimedSessionId: null,
    claimedAt: null,
    lastSubmittedTurn: null,
    lastSubmittedAt: null,
    ...over,
  };
}

test("BW1-S1: 何も変わっていなければ指紋は同じ", () => {
  const seats = [seat("BAL"), seat("MASS")];
  assert.equal(playerSeatsFingerprint(COMPANY_IDS, seats), playerSeatsFingerprint(COMPANY_IDS, seats.map((s) => ({ ...s }))));
});

test("BW1-S2: Seat の並び順・会社の渡し順では変わらない", () => {
  const seats = [seat("BAL"), seat("MASS"), seat("JPQ")];
  const a = playerSeatsFingerprint(COMPANY_IDS, seats);
  const b = playerSeatsFingerprint(["JPQ", "BAL", "MASS"], seats.slice().reverse());
  assert.equal(a, b);
});

test("BW1-S3: Seat がまだ無い会社があっても表現でき、出来た時点で変わる", () => {
  const before = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL")]);
  const after = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL"), seat("MASS")]);
  assert.notEqual(before, after, "Seat が新しく出来たのに指紋が変わっていない");
});

test("BW1-S4: 参加link再発行で指紋が変わる", () => {
  const before = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL")]);
  const after = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL", { joinIssuedAt: "2026-10-08T01:00:00.000Z" })]);
  assert.notEqual(before, after, "再発行したのに指紋が変わっていない");
});

test("BW1-S5: PLAYER の参加（claim）で指紋が変わる", () => {
  const before = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL")]);
  const after = playerSeatsFingerprint(COMPANY_IDS, [
    seat("BAL", { claimedSessionId: "sess-1", claimedAt: "2026-10-08T02:00:00.000Z" }),
  ]);
  assert.notEqual(before, after, "参加したのに指紋が変わっていない");
});

test("BW1-S6: 失効で指紋が変わる", () => {
  const before = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL", { claimedSessionId: "sess-1" })]);
  const after = playerSeatsFingerprint(COMPANY_IDS, [
    seat("BAL", { claimedSessionId: "sess-1", joinRevokedAt: "2026-10-08T03:00:00.000Z" }),
  ]);
  assert.notEqual(before, after, "失効したのに指紋が変わっていない");
});

test("BW1-S7: 提出記録の更新で指紋が変わる", () => {
  const base = seat("BAL", { claimedSessionId: "sess-1" });
  const t1 = playerSeatsFingerprint(COMPANY_IDS, [
    { ...base, lastSubmittedTurn: 1, lastSubmittedAt: "2026-10-08T04:00:00.000Z" },
  ]);
  const t2 = playerSeatsFingerprint(COMPANY_IDS, [
    { ...base, lastSubmittedTurn: 2, lastSubmittedAt: "2026-10-08T05:00:00.000Z" },
  ]);
  assert.notEqual(playerSeatsFingerprint(COMPANY_IDS, [base]), t1, "初回提出で指紋が変わっていない");
  assert.notEqual(t1, t2, "次のTurnの提出で指紋が変わっていない");
});

test("BW1-S8: 指紋に secret hash は含めない（表示・漏洩対策）", () => {
  const a = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL", { currentJoinSecretHash: "aaaa" })]);
  const b = playerSeatsFingerprint(COMPANY_IDS, [seat("BAL", { currentJoinSecretHash: "bbbb" })]);
  assert.equal(a, b, "指紋が secret hash に依存している");
  assert.ok(!a.includes("aaaa"));
});
