// ShrimpX V2 — 会社ラボ永続化 Repository契約共有テスト（Phase 8C-1 §8-3）
//
// createInMemoryCompanyLabStateRepository()・createCompanyLabStateRepository()
// （Redisバックエンド）の両実装が、全く同じCompanyLabStateRepository契約を満たす
// ことを確認する共有テスト関数。テストファイル自体ではない（"*.test.ts"ではないため
// npm testのファイル探索パターンには含まれず、atomicCommit.test.tsからimportされる）。
//
// 【原子性の確認方法についての設計判断】
//   Redis実装（createCompanyLabStateRepository）は内部でexecuteAtomicQuarterCommit
//   （Redis EVAL）を呼ぶが、本プロジェクトのnpm testはnode:testの単体テストであり、
//   実際のRedisサーバー・@upstash/redis経由のネットワーク接続を必要としない
//   （既存のapp/lib/v2/redis/__tests__/でも同様の方針）。そのため、ここでは
//   CompanyLabRedisClientのテスト用フェイク実装（インメモリのMapを使い、evalは
//   atomicCommit.ts の COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT と論理的に完全に同一の
//   手順を「Luaではなく、決定を下すdecideAtomicQuarterCommit()そのもの＋その結果に
//   基づく複数キー更新」として、awaitを一切挟まずに実行する）を使う。
//   実際のLuaスクリプトテキスト自体が本物のRedis（redis-server）に対して正しく動作
//   することは、Phase 8C-1完了報告§Bに記載の手動検証（redis-cli --eval）で個別に
//   確認済みであり、本テストの目的はそれとは別に「Repository層の契約・冪等性・
//   競合時の完全ロールバック」を、Redis実装・インメモリ実装の両方で同じテスト
//   ケース一式に対して検証することにある。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyLabPersistedStateV1, CompanyLabQuarterHistoryEntry, CompanyLabRuntimeSnapshot } from "../types";
import { CompanyLabStateRepository, CompanyLabQuarterCommitInput, CreateCompanyLabInput } from "../repository";
import { CompanyLabAlreadyExistsError, CompanyLabNotFoundError } from "../errors";

function minimalRuntime(overrides: Partial<CompanyLabRuntimeSnapshot> = {}): CompanyLabRuntimeSnapshot {
  return {
    currentPeriod: "2026Q1" as CompanyLabRuntimeSnapshot["currentPeriod"],
    scenarioState: {
      definition: { scenarioId: "baseline", durationTurns: 32 } as never,
      mode: "canonical",
      randomSeed: "seed",
      currentTurn: 1,
      resolvedEvents: [],
      turnHistory: [],
    } as never,
    contracts: [],
    rawMaterialLots: [],
    productionState: { currentPeriod: "2026Q1" as CompanyLabRuntimeSnapshot["currentPeriod"], finishedGoodsLots: [] },
    lastQuarterActualProduction: {},
    qualityState: { qualityByCompanyProduct: [], trustByCompanyMarket: [], rampHistory: [] },
    financeState: { companies: [] },
    financingState: { companies: [] },
    capexState: { companies: [] },
    isComplete: false,
    ...overrides,
  };
}

function minimalCreateInput(labId: string, overrides: Partial<CreateCompanyLabInput> = {}): CreateCompanyLabInput {
  return {
    labId,
    engineVersion: "test-engine",
    config: { scenarioId: "baseline", mode: "canonical", seed: "seed", turns: 32 },
    fixtures: [],
    // 【Phase 8C-3B】Repository契約テストはfixturesを空配列のまま扱う（契約テストの
    // 関心はfixtures内容ではないため）。playerCompanyIdはApplication Service層でのみ
    // fixtures整合性を検証する設計のため、ここでは任意の非空文字列で構わない。
    playerCompanyId: "TEST-PLAYER" as CreateCompanyLabInput["playerCompanyId"],
    runtime: minimalRuntime(),
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * schema.tsのvalidateCompanyDecisionInputが要求する最小限のキー一式を満たす
 * CompanyDecisionInput（Redisバックエンド実装は原子コミット後の再読込でJSON往復＋
 * ランタイム検証を通すため、インメモリ実装と全く同じ入力を使う本共有テストでも、
 * 検証を確実に通す実データ形にしておく必要がある）。
 */
function minimalDecisionInput(companyId: string): CompanyLabQuarterHistoryEntry["playerSubmission"] {
  return {
    companyId,
    salesPlans: [],
    domesticPurchasePlan: {},
    importOrders: [],
    aquacultureStockingPlans: [],
    productionPlans: [],
    workerAssignments: [],
    financingRequest: {},
    capexDecision: {},
  } as unknown as CompanyLabQuarterHistoryEntry["playerSubmission"];
}

/**
 * schema.tsのvalidateCompanyQuarterRecordが要求する必須キー一式
 * （COMPANY_QUARTER_RECORD_REQUIRED_KEYS）を、存在確認さえ満たせばよい
 * （§検証範囲方針によりリーフの深堀り検証はしない）ダミー値で埋めたCompanyQuarterRecord。
 */
function minimalRecord(turn: number, period: string): CompanyLabQuarterHistoryEntry["record"] {
  return {
    turn,
    period,
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
  } as unknown as CompanyLabQuarterHistoryEntry["record"];
}

/** turn番号（1始まり）から妥当な"YYYYQn"形式のperiodを作る（Qは必ず1〜4。turn 5以降は年を繰り上げる）。 */
function periodForTurn(turn: number): string {
  const year = 2026 + Math.floor((turn - 1) / 4);
  const quarter = ((turn - 1) % 4) + 1;
  return `${year}Q${quarter}`;
}

function minimalHistoryEntry(turn: number, turnId: string, overrides: Partial<CompanyLabQuarterHistoryEntry> = {}): CompanyLabQuarterHistoryEntry {
  return {
    turnId,
    turn,
    period: periodForTurn(turn) as CompanyLabQuarterHistoryEntry["period"],
    engineVersion: "test-engine",
    schemaVersion: 1,
    preProcessingStateSnapshot: minimalRuntime(),
    postProcessingStateSnapshot: minimalRuntime({ isComplete: false }),
    playerSubmission: minimalDecisionInput("TESTCO"),
    otherCompaniesDecisions: [],
    record: minimalRecord(turn, periodForTurn(turn)),
    processedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function nextStoredStateFor(created: CompanyLabPersistedStateV1, turnId: string, nextRevision: number): CompanyLabPersistedStateV1 {
  return {
    ...created,
    draft: null,
    currentState: { runtime: created.currentState.runtime, lastProcessedTurnId: turnId, revision: nextRevision },
    metadata: { ...created.metadata, updatedAt: "2026-01-01T00:10:00.000Z" },
  };
}

async function snapshotAllKeys(repo: CompanyLabStateRepository, labId: string) {
  // Repository契約に存在するAPIだけを使って、比較可能な「現況スナップショット」を作る
  // （current・draft・history index・各history entry）。原子性違反（部分成功）があれば、
  // このスナップショットが操作前後で変化する。
  let current: unknown = null;
  try {
    current = await repo.loadCurrentState(labId);
  } catch (e) {
    if (!(e instanceof CompanyLabNotFoundError)) throw e;
  }
  const draft = await repo.loadDraft(labId).catch(() => null);
  const historyIndex = await repo.loadHistoryIndex(labId);
  const historyEntries = await repo.loadFullHistory(labId);
  return JSON.stringify({ current, draft, historyIndex, historyEntries });
}

/**
 * Repository契約の共有テスト一式。createRepoは呼ばれるたびに新しい空のRepository
 * インスタンスを返すこと（テスト間の状態共有を避けるため）。
 */
export function runCompanyLabStateRepositoryContractTests(label: string, createRepo: () => CompanyLabStateRepository) {
  test(`[${label}] ラボ作成直後、現在状態を読み込める（revision=0・draftはnull）`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-a"));
    assert.equal(created.currentState.revision, 0);
    assert.equal(created.draft, null);
    const loaded = await repo.loadCurrentState("lab-a");
    assert.equal(loaded.currentState.revision, 0);
    assert.equal(await repo.labExists("lab-a"), true);
    assert.equal(await repo.labExists("lab-nonexistent"), false);
  });

  test(`[${label}] 存在しないラボの読込はCompanyLabNotFoundErrorを投げる`, async () => {
    const repo = createRepo();
    await assert.rejects(() => repo.loadCurrentState("no-such-lab"), CompanyLabNotFoundError);
  });

  test(`[${label}] ドラフトの保存・読込・未保存時はnull`, async () => {
    const repo = createRepo();
    await repo.createLab(minimalCreateInput("lab-b"));
    assert.equal(await repo.loadDraft("lab-b"), null);
    const draft = {
      labId: "lab-b",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: { note: "in progress" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: null,
    };
    await repo.saveDraft(draft);
    const loaded = await repo.loadDraft("lab-b");
    assert.deepEqual(loaded, draft);
  });

  test(`[${label}] 原子コミット: 正常系はhistory・current・index・draft削除のすべてが反映される`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-commit-ok"));
    await repo.saveDraft({
      labId: "lab-commit-ok",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: { x: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const input: CompanyLabQuarterCommitInput = {
      labId: "lab-commit-ok",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    };
    const result = await repo.commitQuarterAtomically(input);
    assert.deepEqual(result, { status: "committed", revision: 1 });

    const currentAfter = await repo.loadCurrentState("lab-commit-ok");
    assert.equal(currentAfter.currentState.revision, 1);
    assert.equal(currentAfter.currentState.lastProcessedTurnId, "turn-1");
    assert.equal(await repo.loadDraft("lab-commit-ok"), null);
    assert.deepEqual(await repo.loadHistoryIndex("lab-commit-ok"), [1]);
    const historyEntry = await repo.loadHistoryEntry("lab-commit-ok", 1);
    assert.equal(historyEntry.turnId, "turn-1");
    assert.deepEqual(await repo.loadFullHistory("lab-commit-ok"), [historyEntry]);
  });

  test(`[${label}] 原子コミット: revision不一致は何も変更せずrevisionConflictを返す`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-rev-conflict"));
    await repo.saveDraft({
      labId: "lab-rev-conflict",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const before = await snapshotAllKeys(repo, "lab-rev-conflict");
    const result = await repo.commitQuarterAtomically({
      labId: "lab-rev-conflict",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 5, // 実際は0なので不一致
      nextStoredState: nextStoredStateFor(created, "turn-1", 6),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(result.status, "revisionConflict");
    const after = await snapshotAllKeys(repo, "lab-rev-conflict");
    assert.equal(after, before, "revision不一致時に何らかのキーが変化してしまっている（部分成功状態）");
  });

  test(`[${label}] 原子コミット: 対象turnの履歴が別turnIdで既に存在する場合、historyConflictを返し何も変更しない`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-hist-conflict"));
    await repo.saveDraft({
      labId: "lab-hist-conflict",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const okResult = await repo.commitQuarterAtomically({
      labId: "lab-hist-conflict",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(okResult.status, "committed");

    // 別のturnId（turn-1-retry-with-different-id）で同じturn=1へ再度コミットしようとする → historyConflict。
    await repo.saveDraft({
      labId: "lab-hist-conflict",
      period: "2026Q1" as never,
      turnId: "turn-1-different",
      revision: 1,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:06:00.000Z",
    });
    const currentBeforeConflict = await repo.loadCurrentState("lab-hist-conflict");
    const before = await snapshotAllKeys(repo, "lab-hist-conflict");
    const conflictResult = await repo.commitQuarterAtomically({
      labId: "lab-hist-conflict",
      turn: 1,
      turnId: "turn-1-different",
      expectedRevision: currentBeforeConflict.currentState.revision,
      nextStoredState: nextStoredStateFor(created, "turn-1-different", currentBeforeConflict.currentState.revision + 1),
      historyEntry: minimalHistoryEntry(1, "turn-1-different"),
    });
    assert.equal(conflictResult.status, "historyConflict");
    if (conflictResult.status === "historyConflict") {
      assert.equal(conflictResult.existingTurnId, "turn-1");
    }
    const after = await snapshotAllKeys(repo, "lab-hist-conflict");
    assert.equal(after, before, "historyConflict時に何らかのキーが変化してしまっている（部分成功状態）");
  });

  test(`[${label}] 原子コミット: draft未保存（draftNotFound）の場合は何も変更しない`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-draft-missing"));
    const before = await snapshotAllKeys(repo, "lab-draft-missing");
    const result = await repo.commitQuarterAtomically({
      labId: "lab-draft-missing",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(result.status, "draftNotFound");
    const after = await snapshotAllKeys(repo, "lab-draft-missing");
    assert.equal(after, before);
  });

  test(`[${label}] 原子コミット: draftのturnId不一致（draftTurnMismatch）の場合は何も変更しない`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-draft-mismatch"));
    await repo.saveDraft({
      labId: "lab-draft-mismatch",
      period: "2026Q1" as never,
      turnId: "turn-OTHER",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const before = await snapshotAllKeys(repo, "lab-draft-mismatch");
    const result = await repo.commitQuarterAtomically({
      labId: "lab-draft-mismatch",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(result.status, "draftTurnMismatch");
    const after = await snapshotAllKeys(repo, "lab-draft-mismatch");
    assert.equal(after, before);
  });

  test(`[${label}] 原子コミット: draft未提出（submittedAt=null、draftNotSubmitted）の場合は何も変更しない`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-draft-unsubmitted"));
    await repo.saveDraft({
      labId: "lab-draft-unsubmitted",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: null,
    });
    const before = await snapshotAllKeys(repo, "lab-draft-unsubmitted");
    const result = await repo.commitQuarterAtomically({
      labId: "lab-draft-unsubmitted",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(result.status, "draftNotSubmitted");
    const after = await snapshotAllKeys(repo, "lab-draft-unsubmitted");
    assert.equal(after, before);
  });

  test(`[${label}] 原子コミット: 同一turnIdでの再試行は冪等（alreadyCommitted、二重保存されない）`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-idempotent"));
    await repo.saveDraft({
      labId: "lab-idempotent",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const commitInput: CompanyLabQuarterCommitInput = {
      labId: "lab-idempotent",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    };
    const first = await repo.commitQuarterAtomically(commitInput);
    assert.equal(first.status, "committed");
    const historyAfterFirst = await repo.loadFullHistory("lab-idempotent");
    assert.equal(historyAfterFirst.length, 1);

    // 同じturnId・同じexpectedRevision(0、実際はもう1へ進んでいる古い値)で再試行しても、
    // 二重保存されず、alreadyCommittedが返る。
    const retry = await repo.commitQuarterAtomically(commitInput);
    assert.equal(retry.status, "alreadyCommitted");
    if (retry.status === "alreadyCommitted") {
      assert.equal(retry.revision, 1);
    }
    const historyAfterRetry = await repo.loadFullHistory("lab-idempotent");
    assert.equal(historyAfterRetry.length, 1, "同一turnIdの再試行で履歴が二重保存されている");
  });

  test(`[${label}] 原子コミット: 同じturnに対して異なるturnIdでは保存できない（historyConflict、既存分は変わらない）`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-same-turn-diff-id"));
    await repo.saveDraft({
      labId: "lab-same-turn-diff-id",
      period: "2026Q1" as never,
      turnId: "turn-A",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const first = await repo.commitQuarterAtomically({
      labId: "lab-same-turn-diff-id",
      turn: 1,
      turnId: "turn-A",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-A", 1),
      historyEntry: minimalHistoryEntry(1, "turn-A"),
    });
    assert.equal(first.status, "committed");

    await repo.saveDraft({
      labId: "lab-same-turn-diff-id",
      period: "2026Q1" as never,
      turnId: "turn-B",
      revision: 1,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:06:00.000Z",
    });
    const second = await repo.commitQuarterAtomically({
      labId: "lab-same-turn-diff-id",
      turn: 1,
      turnId: "turn-B",
      expectedRevision: 1,
      nextStoredState: nextStoredStateFor(created, "turn-B", 2),
      historyEntry: minimalHistoryEntry(1, "turn-B"),
    });
    assert.equal(second.status, "historyConflict");
    const entry = await repo.loadHistoryEntry("lab-same-turn-diff-id", 1);
    assert.equal(entry.turnId, "turn-A", "既存のturn=1履歴がturn-Bで上書きされてしまっている");
  });

  test(`[${label}] 原子コミット: history indexにturnの重複がない`, async () => {
    const repo = createRepo();
    let created = await repo.createLab(minimalCreateInput("lab-index-no-dup"));
    for (const turn of [1, 2, 3]) {
      await repo.saveDraft({
        labId: "lab-index-no-dup",
        period: `2026Q${turn}` as never,
        turnId: `turn-${turn}`,
        revision: turn - 1,
        draft: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        submittedAt: "2026-01-01T00:05:00.000Z",
      });
      const result = await repo.commitQuarterAtomically({
        labId: "lab-index-no-dup",
        turn,
        turnId: `turn-${turn}`,
        expectedRevision: turn - 1,
        nextStoredState: nextStoredStateFor(created, `turn-${turn}`, turn),
        historyEntry: minimalHistoryEntry(turn, `turn-${turn}`),
      });
      assert.equal(result.status, "committed");
      created = await repo.loadCurrentState("lab-index-no-dup");
    }
    const index = await repo.loadHistoryIndex("lab-index-no-dup");
    assert.deepEqual(index, [1, 2, 3]);
    assert.equal(new Set(index).size, index.length, "history indexにturnの重複がある");
  });

  test(`[${label}] 原子コミット: 同一turnIdの原子コミットを2つ同時実行しても、二重保存されず片方だけがcommittedになる`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-concurrent"));
    await repo.saveDraft({
      labId: "lab-concurrent",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    // 同じturnId・同じexpectedRevision(0)・同じturn(1)を狙う原子コミットをPromise.allで
    // 同時に2つ投げる（例: 二重クリック submit、リトライと本来の呼び出しが競合、等の
    // 実運用シナリオを模す）。原子性が保たれていれば、必ずどちらか片方だけがcommitted、
    // もう片方はalreadyCommitted（冪等・書き込みなし）になり、"両方ともcommitted"
    // （＝履歴の二重保存）という状態は絶対に起きない。
    const commitInput: CompanyLabQuarterCommitInput = {
      labId: "lab-concurrent",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    };
    const [resultA, resultB] = await Promise.all([repo.commitQuarterAtomically(commitInput), repo.commitQuarterAtomically(commitInput)]);
    const statuses = [resultA.status, resultB.status].sort();
    assert.deepEqual(statuses, ["alreadyCommitted", "committed"], `同時実行の結果はcommitted 1件・alreadyCommitted 1件になるべき（実際: ${JSON.stringify(statuses)}）`);
    const index = await repo.loadHistoryIndex("lab-concurrent");
    assert.deepEqual(index, [1]);
    const history = await repo.loadFullHistory("lab-concurrent");
    assert.equal(history.length, 1, "同時実行によって履歴が二重保存されている");
  });

  // -------------------------------------------------------------------
  // Phase 8C-2追加: Repository契約の統一（§7）・labs一覧（§8）・
  // ページング（§9）・ロック（§6.4）
  // -------------------------------------------------------------------

  /** turnをひとつ確定させるテスト用ヘルパー（draft保存→提出済み化→原子コミット）。 */
  async function commitOneTurn(repo: CompanyLabStateRepository, labId: string, turn: number, turnId: string): Promise<void> {
    const current = await repo.loadCurrentState(labId);
    await repo.saveDraft({
      labId,
      period: periodForTurn(turn) as never,
      turnId,
      revision: current.currentState.revision,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    const result = await repo.commitQuarterAtomically({
      labId,
      turn,
      turnId,
      expectedRevision: current.currentState.revision,
      nextStoredState: nextStoredStateFor(current, turnId, current.currentState.revision + 1),
      historyEntry: minimalHistoryEntry(turn, turnId),
    });
    assert.equal(result.status, "committed");
  }

  test(`[${label}] 重複labIdのcreateLabはAlreadyExistsになり、既存のcurrent・history・labs一覧を破壊しない`, async () => {
    const repo = createRepo();
    await repo.createLab(minimalCreateInput("lab-dup"));
    await commitOneTurn(repo, "lab-dup", 1, "turn-1");
    const before = await snapshotAllKeys(repo, "lab-dup");
    await assert.rejects(() => repo.createLab(minimalCreateInput("lab-dup", { now: "2026-06-01T00:00:00.000Z" })), CompanyLabAlreadyExistsError);
    const after = await snapshotAllKeys(repo, "lab-dup");
    assert.equal(after, before, "重複createLabによって既存ラボの状態が変化してしまっている");
    const labs = await repo.listLabs();
    assert.deepEqual(
      labs.filter((id) => id === "lab-dup"),
      ["lab-dup"],
      "labs一覧にlabIdが重複登録されている"
    );
    // revisionが0へ巻き戻されていない（上書き作成が起きていない）ことを明示的に確認する。
    const current = await repo.loadCurrentState("lab-dup");
    assert.equal(current.currentState.revision, 1);
  });

  test(`[${label}] 存在しないlabIdへの各操作はすべてCompanyLabNotFoundErrorを投げる（契約統一）`, async () => {
    const repo = createRepo();
    const missing = "lab-does-not-exist";
    await assert.rejects(() => repo.loadCurrentState(missing), CompanyLabNotFoundError);
    await assert.rejects(
      () =>
        repo.saveDraft({
          labId: missing,
          period: "2026Q1" as never,
          turnId: "t",
          revision: 0,
          draft: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          submittedAt: null,
        }),
      CompanyLabNotFoundError
    );
    await assert.rejects(() => repo.loadDraft(missing), CompanyLabNotFoundError);
    await assert.rejects(() => repo.loadHistoryEntry(missing, 1), CompanyLabNotFoundError);
    await assert.rejects(() => repo.loadHistoryIndex(missing), CompanyLabNotFoundError);
    await assert.rejects(() => repo.loadFullHistory(missing), CompanyLabNotFoundError);
    await assert.rejects(() => repo.loadLatestHistoryEntry(missing), CompanyLabNotFoundError);
    await assert.rejects(() => repo.loadHistoryPage(missing, { limit: 10 }), CompanyLabNotFoundError);
    await assert.rejects(() => repo.acquireProcessingLock({ labId: missing, token: "t", ttlMilliseconds: 1000, now: "2026-01-01T00:00:00.000Z" }), CompanyLabNotFoundError);
  });

  test(`[${label}] labs一覧: 空→作成順に列挙され、存在するラボのhistoryなしは空配列・draftなしはnull`, async () => {
    const repo = createRepo();
    assert.deepEqual(await repo.listLabs(), []);
    await repo.createLab(minimalCreateInput("lab-list-b"));
    await repo.createLab(minimalCreateInput("lab-list-a"));
    await repo.createLab(minimalCreateInput("lab-list-c"));
    assert.deepEqual(await repo.listLabs(), ["lab-list-b", "lab-list-a", "lab-list-c"], "labs一覧は辞書順ではなく作成順で列挙されるべき");
    // 存在するラボの「まだ何もない」状態の契約
    assert.deepEqual(await repo.loadHistoryIndex("lab-list-a"), []);
    assert.deepEqual(await repo.loadFullHistory("lab-list-a"), []);
    assert.equal(await repo.loadLatestHistoryEntry("lab-list-a"), null);
    assert.equal(await repo.loadDraft("lab-list-a"), null);
    const emptyPage = await repo.loadHistoryPage("lab-list-a", { limit: 5 });
    assert.deepEqual(emptyPage, { entries: [], nextAfterTurn: null });
  });

  test(`[${label}] loadLatestHistoryEntryは最大turnのエントリを返す`, async () => {
    const repo = createRepo();
    await repo.createLab(minimalCreateInput("lab-latest"));
    for (const turn of [1, 2, 3]) {
      await commitOneTurn(repo, "lab-latest", turn, `turn-${turn}`);
    }
    const latest = await repo.loadLatestHistoryEntry("lab-latest");
    assert.equal(latest?.turn, 3);
    assert.equal(latest?.turnId, "turn-3");
  });

  test(`[${label}] loadHistoryPage: limit・afterTurnによるページングが正しく機能する`, async () => {
    const repo = createRepo();
    await repo.createLab(minimalCreateInput("lab-page"));
    for (const turn of [1, 2, 3, 4, 5]) {
      await commitOneTurn(repo, "lab-page", turn, `turn-${turn}`);
    }
    const page1 = await repo.loadHistoryPage("lab-page", { limit: 2 });
    assert.deepEqual(
      page1.entries.map((e) => e.turn),
      [1, 2]
    );
    assert.equal(page1.nextAfterTurn, 2);
    const page2 = await repo.loadHistoryPage("lab-page", { afterTurn: page1.nextAfterTurn as number, limit: 2 });
    assert.deepEqual(
      page2.entries.map((e) => e.turn),
      [3, 4]
    );
    assert.equal(page2.nextAfterTurn, 4);
    const page3 = await repo.loadHistoryPage("lab-page", { afterTurn: page2.nextAfterTurn as number, limit: 2 });
    assert.deepEqual(
      page3.entries.map((e) => e.turn),
      [5]
    );
    assert.equal(page3.nextAfterTurn, null, "最終ページのnextAfterTurnはnullであるべき");
    // ちょうど末尾で切れる場合も、続きがなければnull
    const exactEnd = await repo.loadHistoryPage("lab-page", { afterTurn: 3, limit: 2 });
    assert.deepEqual(
      exactEnd.entries.map((e) => e.turn),
      [4, 5]
    );
    assert.equal(exactEnd.nextAfterTurn, null);
    // 不正なlimitは拒否される
    await assert.rejects(() => repo.loadHistoryPage("lab-page", { limit: 0 }));
  });

  test(`[${label}] ロック: 取得・競合・自トークンのみ解放`, async () => {
    const repo = createRepo();
    await repo.createLab(minimalCreateInput("lab-lock"));
    const now = "2026-01-01T00:00:00.000Z";
    assert.equal(await repo.acquireProcessingLock({ labId: "lab-lock", token: "tokenA", ttlMilliseconds: 60_000, now }), true);
    // 有効なロックがある間は、別トークンでの取得は失敗する
    assert.equal(await repo.acquireProcessingLock({ labId: "lab-lock", token: "tokenB", ttlMilliseconds: 60_000, now }), false);
    // 他トークンでの解放は失敗し、ロックは保持されたまま
    assert.equal(await repo.releaseProcessingLock("lab-lock", "tokenB"), false);
    assert.equal(await repo.acquireProcessingLock({ labId: "lab-lock", token: "tokenB", ttlMilliseconds: 60_000, now }), false, "他トークンによる解放でロックが失われている");
    // 自トークンでの解放は成功し、その後は再取得できる
    assert.equal(await repo.releaseProcessingLock("lab-lock", "tokenA"), true);
    assert.equal(await repo.acquireProcessingLock({ labId: "lab-lock", token: "tokenB", ttlMilliseconds: 60_000, now }), true);
  });

  test(`[${label}] 原子コミット: expectedLockTokenが実際のロックと一致しない場合はlockConflictになり、全キー無変更`, async () => {
    const repo = createRepo();
    const created = await repo.createLab(minimalCreateInput("lab-lock-commit"));
    await repo.saveDraft({
      labId: "lab-lock-commit",
      period: "2026Q1" as never,
      turnId: "turn-1",
      revision: 0,
      draft: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-01T00:05:00.000Z",
    });
    await repo.acquireProcessingLock({ labId: "lab-lock-commit", token: "holder-token", ttlMilliseconds: 60_000, now: "2026-01-01T00:00:00.000Z" });
    const before = await snapshotAllKeys(repo, "lab-lock-commit");
    const result = await repo.commitQuarterAtomically({
      labId: "lab-lock-commit",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      expectedLockToken: "stale-token", // 実際のロックはholder-token
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(result.status, "lockConflict");
    const after = await snapshotAllKeys(repo, "lab-lock-commit");
    assert.equal(after, before, "lockConflict時に何らかのキーが変化してしまっている");
    // 正しいトークンならコミットできる
    const ok = await repo.commitQuarterAtomically({
      labId: "lab-lock-commit",
      turn: 1,
      turnId: "turn-1",
      expectedRevision: 0,
      expectedLockToken: "holder-token",
      nextStoredState: nextStoredStateFor(created, "turn-1", 1),
      historyEntry: minimalHistoryEntry(1, "turn-1"),
    });
    assert.equal(ok.status, "committed");
  });
}
