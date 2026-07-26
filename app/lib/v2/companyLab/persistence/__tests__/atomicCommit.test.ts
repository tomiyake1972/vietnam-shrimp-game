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
import { createInMemoryCompanyLabStateRepository, CompanyLabStateRepository, CompanyLabQuarterCommitInput } from "../repository";
import { createCompanyLabStateRepository } from "../redisRepository";
import { CompanyLabPersistedStateV1 } from "../types";
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

// ---------------------------------------------------------------------
// Phase 8C-2追加: ロックTTL切れの安全性（実装別。§6.4）
//
// 「処理中にロックTTLが切れ、別処理がロックを取得した場合、古い処理はコミット
// できない」を検証する。TTL到達そのものを実時間で待つテストは書かず、
//   - インメモリ実装: acquireへ渡す論理時刻（now）を進めて期限切れを表現する
//   - Redis実装: TTL到達によるキー消滅を、フェイククライアントのキー削除で模す
// という決定論的な方法で、安全性の中核（ロックトークン検証）を確認する。
// ---------------------------------------------------------------------

function minimalCommitInputForLock(created: CompanyLabPersistedStateV1, turnId: string, expectedLockToken: string): CompanyLabQuarterCommitInput {
  return {
    labId: created.labId,
    turn: 1,
    turnId,
    expectedRevision: 0,
    expectedLockToken,
    nextStoredState: {
      ...created,
      draft: null,
      currentState: { runtime: created.currentState.runtime, lastProcessedTurnId: turnId, revision: 1 },
    },
    historyEntry: {
      turnId,
      turn: 1,
      period: "2026Q1" as never,
      engineVersion: "test-engine",
      schemaVersion: 1,
      preProcessingStateSnapshot: created.currentState.runtime,
      postProcessingStateSnapshot: created.currentState.runtime,
      playerSubmission: {
        companyId: "TESTCO",
        salesPlans: [],
        domesticPurchasePlan: {},
        importOrders: [],
        aquacultureStockingPlans: [],
        productionPlans: [],
        workerAssignments: [],
        financingRequest: {},
        capexDecision: {},
      } as never,
      otherCompaniesDecisions: [],
      record: {
        turn: 1,
        period: "2026Q1",
        decisions: [],
        marketInput: {},
        marketResult: {},
        salesRecord: {},
        rawMaterialRequirements: [],
        domesticAllocation: {},
        productionAllocation: {},
        batches: [],
        newFinishedGoodsLots: [],
        fulfillmentPlan: {},
        companyLoadMetrics: [],
        factoryLoadMetrics: [],
        companySummaries: [],
        globalReasonCodes: [],
        turnDebug: {},
        qualityAdjustments: [],
        qualityStateAfter: {},
        deliveryObservations: [],
        financialResults: [],
        financingResults: [],
        capexResults: [],
      } as never,
      processedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

async function setupLabWithSubmittedDraft(repo: CompanyLabStateRepository, labId: string, turnId: string) {
  const created = await repo.createLab({
    labId,
    engineVersion: "test-engine",
    config: { scenarioId: "baseline", mode: "canonical", seed: "seed", turns: 32 },
    fixtures: [],
    playerCompanyId: "TEST-PLAYER" as never,
    runtime: {
      currentPeriod: "2026Q1" as never,
      scenarioState: { definition: {}, mode: "canonical", randomSeed: "seed", currentTurn: 1, resolvedEvents: [], turnHistory: [] } as never,
      contracts: [],
      rawMaterialLots: [],
      productionState: { currentPeriod: "2026Q1" as never, finishedGoodsLots: [] },
      lastQuarterActualProduction: {},
      qualityState: { qualityByCompanyProduct: [], trustByCompanyMarket: [], rampHistory: [] },
      financeState: { companies: [] },
      financingState: { companies: [] },
      capexState: { companies: [] },
      workforceState: { companies: [] },
      isComplete: false,
    },
    now: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveDraft({
    labId,
    period: "2026Q1" as never,
    turnId,
    revision: 0,
    draft: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:05:00.000Z",
  });
  return created;
}

test("[in-memory] ロックTTL切れ後に別処理がロックを取得した場合、古い処理はコミットできない（論理時刻による決定論的検証）", async () => {
  const repo = createInMemoryCompanyLabStateRepository();
  const created = await setupLabWithSubmittedDraft(repo, "lab-ttl-mem", "turn-1");
  // 処理AがTTL 1000msでロックを取得
  assert.equal(await repo.acquireProcessingLock({ labId: "lab-ttl-mem", token: "tokenA", ttlMilliseconds: 1000, now: "2026-01-01T00:00:00.000Z" }), true);
  // 論理時刻がTTLを超えた後、処理Bがロックを取得できる（期限切れロックの上書き）
  assert.equal(await repo.acquireProcessingLock({ labId: "lab-ttl-mem", token: "tokenB", ttlMilliseconds: 60_000, now: "2026-01-01T00:00:02.000Z" }), true);
  // 古い処理AのトークンでのコミットはlockConflictになり、何も書き込まれない
  const result = await repo.commitQuarterAtomically(minimalCommitInputForLock(created, "turn-1", "tokenA"));
  assert.equal(result.status, "lockConflict");
  assert.deepEqual(await repo.loadHistoryIndex("lab-ttl-mem"), []);
  // 処理Bのトークンならコミットできる
  const ok = await repo.commitQuarterAtomically(minimalCommitInputForLock(created, "turn-1", "tokenB"));
  assert.equal(ok.status, "committed");
});

test("[redis(fake-client)] ロックTTL切れ（キー消滅）後に別処理がロックを取得した場合、古い処理はコミットできない", async () => {
  const client = createFakeCompanyLabRedisClient();
  const repo = createCompanyLabStateRepository({ client, appEnv: "staging" });
  const created = await setupLabWithSubmittedDraft(repo, "lab-ttl-redis", "turn-1");
  assert.equal(await repo.acquireProcessingLock({ labId: "lab-ttl-redis", token: "tokenA", ttlMilliseconds: 60_000, now: "2026-01-01T00:00:00.000Z" }), true);
  // RedisのTTL到達によるキー消滅を、フェイククライアント上でロックキーを直接削除して模す
  await client.del("staging:v2:companyLab:lab-ttl-redis:lock");
  // 消滅後は別処理がロックを取得できる
  assert.equal(await repo.acquireProcessingLock({ labId: "lab-ttl-redis", token: "tokenB", ttlMilliseconds: 60_000, now: "2026-01-01T00:00:02.000Z" }), true);
  // 古い処理AのトークンでのコミットはlockConflict
  const result = await repo.commitQuarterAtomically(minimalCommitInputForLock(created, "turn-1", "tokenA"));
  assert.equal(result.status, "lockConflict");
  assert.deepEqual(await repo.loadHistoryIndex("lab-ttl-redis"), []);
  const ok = await repo.commitQuarterAtomically(minimalCommitInputForLock(created, "turn-1", "tokenB"));
  assert.equal(ok.status, "committed");
});

test("[redis(fake-client)] TTL切れで誰も再取得していない場合も、expectedLockToken指定のコミットはlockConflictになる（安全側）", async () => {
  const client = createFakeCompanyLabRedisClient();
  const repo = createCompanyLabStateRepository({ client, appEnv: "staging" });
  const created = await setupLabWithSubmittedDraft(repo, "lab-ttl-gone", "turn-1");
  assert.equal(await repo.acquireProcessingLock({ labId: "lab-ttl-gone", token: "tokenA", ttlMilliseconds: 60_000, now: "2026-01-01T00:00:00.000Z" }), true);
  await client.del("staging:v2:companyLab:lab-ttl-gone:lock"); // TTL到達（キー消滅）を模す
  const result = await repo.commitQuarterAtomically(minimalCommitInputForLock(created, "turn-1", "tokenA"));
  assert.equal(result.status, "lockConflict", "ロックを保持していると証明できない処理はコミットできないべき");
  assert.deepEqual(await repo.loadHistoryIndex("lab-ttl-gone"), []);
});
