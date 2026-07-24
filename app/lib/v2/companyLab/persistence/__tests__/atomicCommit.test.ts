// ShrimpX V2 — 会社ラボ 四半期確定の原子コミット テスト（Phase 8C-1 §8-3）
//
// 1. decideAtomicQuarterCommit（純粋関数）自体の条件分岐・優先順位を直接確認する。
// 2. buildAtomicCommitEvalArgs / parseAtomicCommitEvalResultの往復を確認する。
// 3. Repository契約共有テスト（repositoryContract.ts）を、インメモリ実装・
//    Redis実装（テスト用フェイククライアント経由）の両方に対して実行し、
//    両実装が同じ契約・同じ冪等性・同じ「競合時は完全に無変更」を満たすことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAtomicQuarterCommit, buildAtomicCommitEvalArgs, parseAtomicCommitEvalResult } from "../atomicCommit";
import { createInMemoryCompanyLabStateRepository } from "../repository";
import { createCompanyLabStateRepository } from "../redisRepository";
import { createFakeCompanyLabRedisClient } from "../../../redis/__tests__/fakeCompanyLabRedisClient";
import { runCompanyLabStateRepositoryContractTests } from "./repositoryContract";

test("decideAtomicQuarterCommit: currentが存在しなければcurrentNotFound", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: false, currentRevision: null, existingHistoryTurnId: null, draftExists: false, draftTurnId: null, draftSubmitted: false, lockToken: null },
    { turnId: "t1", expectedRevision: 0, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "currentNotFound" });
});

test("decideAtomicQuarterCommit: 同一turnIdの既存履歴は、revisionが古くてもalreadyCommitted（優先順位の確認）", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 5, existingHistoryTurnId: "t1", draftExists: false, draftTurnId: null, draftSubmitted: false, lockToken: null },
    { turnId: "t1", expectedRevision: 0 /* 古い値のまま再試行 */, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "alreadyCommitted", revision: 5 });
});

test("decideAtomicQuarterCommit: 別turnIdの既存履歴はhistoryConflict", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 5, existingHistoryTurnId: "t-existing", draftExists: false, draftTurnId: null, draftSubmitted: false, lockToken: null },
    { turnId: "t-new", expectedRevision: 5, newRevision: 6 }
  );
  assert.deepEqual(result, { status: "historyConflict", existingTurnId: "t-existing" });
});

test("decideAtomicQuarterCommit: revision不一致はrevisionConflict", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 3, existingHistoryTurnId: null, draftExists: true, draftTurnId: "t1", draftSubmitted: true, lockToken: null },
    { turnId: "t1", expectedRevision: 2, newRevision: 3 }
  );
  assert.deepEqual(result, { status: "revisionConflict", actualRevision: 3 });
});

test("decideAtomicQuarterCommit: draft未保存はdraftNotFound", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 0, existingHistoryTurnId: null, draftExists: false, draftTurnId: null, draftSubmitted: false, lockToken: null },
    { turnId: "t1", expectedRevision: 0, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "draftNotFound" });
});

test("decideAtomicQuarterCommit: draftのturnId不一致はdraftTurnMismatch", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 0, existingHistoryTurnId: null, draftExists: true, draftTurnId: "t-other", draftSubmitted: true, lockToken: null },
    { turnId: "t1", expectedRevision: 0, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "draftTurnMismatch", actualTurnId: "t-other" });
});

test("decideAtomicQuarterCommit: draft未提出はdraftNotSubmitted", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 0, existingHistoryTurnId: null, draftExists: true, draftTurnId: "t1", draftSubmitted: false, lockToken: null },
    { turnId: "t1", expectedRevision: 0, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "draftNotSubmitted" });
});

test("decideAtomicQuarterCommit: expectedLockTokenを指定した場合、不一致はlockConflict、一致すればcommitted", () => {
  const view = { currentExists: true, currentRevision: 0, existingHistoryTurnId: null, draftExists: true, draftTurnId: "t1", draftSubmitted: true, lockToken: "tokenA" as string | null };
  const mismatch = decideAtomicQuarterCommit(view, { turnId: "t1", expectedRevision: 0, newRevision: 1, expectedLockToken: "tokenB" });
  assert.deepEqual(mismatch, { status: "lockConflict" });
  const match = decideAtomicQuarterCommit(view, { turnId: "t1", expectedRevision: 0, newRevision: 1, expectedLockToken: "tokenA" });
  assert.deepEqual(match, { status: "committed", revision: 1 });
});

test("decideAtomicQuarterCommit: expectedLockTokenを指定しなければロックは無視され、全条件を満たせばcommitted", () => {
  const result = decideAtomicQuarterCommit(
    { currentExists: true, currentRevision: 0, existingHistoryTurnId: null, draftExists: true, draftTurnId: "t1", draftSubmitted: true, lockToken: "someone-elses-token" },
    { turnId: "t1", expectedRevision: 0, newRevision: 1 }
  );
  assert.deepEqual(result, { status: "committed", revision: 1 });
});

test("buildAtomicCommitEvalArgs / parseAtomicCommitEvalResult: 引数組み立て→戻り値解析の往復", () => {
  const { keys, args } = buildAtomicCommitEvalArgs({
    currentKey: "k:current",
    historyEntryKey: "k:history:1",
    historyIndexKey: "k:history:index",
    draftKey: "k:draft",
    lockKey: "k:lock",
    turnId: "t1",
    turn: 1,
    expectedRevision: 0,
    newRevision: 1,
    nextStoredStateJson: '{"a":1}',
    historyEntryJson: '{"b":2}',
  });
  assert.deepEqual(keys, ["k:current", "k:history:1", "k:history:index", "k:draft", "k:lock"]);
  assert.deepEqual(args, ["t1", "1", "0", '{"a":1}', '{"b":2}', "", "1"]);

  const parsedCommitted = parseAtomicCommitEvalResult(["committed", "1"]);
  assert.deepEqual(parsedCommitted, { status: "committed", revision: 1 });
  const parsedRevisionConflict = parseAtomicCommitEvalResult(["revisionConflict", "3"]);
  assert.deepEqual(parsedRevisionConflict, { status: "revisionConflict", actualRevision: 3 });
  const parsedHistoryConflict = parseAtomicCommitEvalResult(["historyConflict", "other-turn"]);
  assert.deepEqual(parsedHistoryConflict, { status: "historyConflict", existingTurnId: "other-turn" });

  assert.throws(() => parseAtomicCommitEvalResult("not-an-array"));
  assert.throws(() => parseAtomicCommitEvalResult(["unknownStatus", ""]));
});

// --- Repository契約共有テスト（インメモリ実装） ---
runCompanyLabStateRepositoryContractTests("in-memory", () => createInMemoryCompanyLabStateRepository());

// --- Repository契約共有テスト（Redis実装、テスト用フェイククライアント経由） ---
runCompanyLabStateRepositoryContractTests("redis(fake-client)", () => createCompanyLabStateRepository({ client: createFakeCompanyLabRedisClient(), appEnv: "staging" }));
