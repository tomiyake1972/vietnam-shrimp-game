// ShrimpX V2 — 会社ラボ 四半期処理 Application Service テスト（Phase 8C-2）
//
// createCompanyLabQuarterFlowServiceを、インメモリRepository・Redis Repository
// （テスト用フェイククライアント経由）の両方に対して同じテスト一式で検証する。
// 実際のinitializeCompanyLab / advanceCompanyLabQuarter / generateAutoPolicyDecision
// を使う（エンジンのモックは作らない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../sales/types";
import { CompanyDecisionInput } from "../../types";
import { buildCompanyOwnState } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { createInMemoryCompanyLabStateRepository, CompanyLabStateRepository, CompanyLabQuarterCommitInput } from "../../persistence/repository";
import { createCompanyLabStateRepository } from "../../persistence/redisRepository";
import { createFakeCompanyLabRedisClient } from "../../../redis/__tests__/fakeCompanyLabRedisClient";
import {
  CompanyLabAlreadyExistsError,
  CompanyLabCompletedError,
  CompanyLabDraftAlreadySubmittedError,
  CompanyLabDraftConflictError,
  CompanyLabDraftNotFoundError,
  CompanyLabDraftNotSubmittedError,
  CompanyLabDraftTurnMismatchError,
  CompanyLabLockConflictError,
  CompanyLabLockUnavailableError,
  CompanyLabNotFoundError,
  CompanyLabPersistedStateValidationError,
  CompanyLabQuarterProcessingError,
  CompanyLabRevisionConflictError,
  CompanyLabTurnConflictError,
} from "../../persistence/errors";
import {
  createCompanyLabQuarterFlowService,
  CompanyLabDecisionsProvider,
  CompanyLabQuarterFlowService,
} from "../companyLabQuarterFlowService";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";

/** 全社を既存の自動方針で動かす標準provider（復元済み状態から決定論的に生成する）。 */
const autoPolicyProvider: CompanyLabDecisionsProvider = ({ restoredState, fixtures, publicInfo, period, turn }) => {
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const fixture of fixtures) {
    const ownState = buildCompanyOwnState(restoredState, fixture);
    decisions[fixture.companyId] = generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn);
  }
  return decisions;
};

function baseConfig(overrides: Partial<{ seed: string; turns: number }> = {}) {
  return { scenarioId: "baseline", mode: "canonical" as const, seed: "quarter-flow-test-001", turns: 6, ...overrides };
}

interface TestContext {
  readonly repo: CompanyLabStateRepository;
  readonly service: CompanyLabQuarterFlowService;
}

function makeContexts(): readonly { readonly label: string; readonly create: () => TestContext }[] {
  return [
    {
      label: "in-memory",
      create: () => {
        const repo = createInMemoryCompanyLabStateRepository();
        return { repo, service: createCompanyLabQuarterFlowService({ repository: repo }) };
      },
    },
    {
      label: "redis(fake-client)",
      create: () => {
        const repo = createCompanyLabStateRepository({ client: createFakeCompanyLabRedisClient(), appEnv: "staging" });
        return { repo, service: createCompanyLabQuarterFlowService({ repository: repo }) };
      },
    },
  ];
}

/** draft保存→提出→四半期処理、を1回ぶん実行するヘルパー。 */
async function runOneQuarter(ctx: TestContext, labId: string, turnId: string, lockToken: string) {
  await ctx.service.saveDraft({ labId, turnId, draftBody: { note: `draft-${turnId}` }, now: NOW });
  await ctx.service.submitDraft({ labId, turnId, now: NOW });
  return ctx.service.processQuarter({
    labId,
    turnId,
    lockToken,
    now: NOW,
    decisionsProvider: autoPolicyProvider,
  });
}

for (const { label, create } of makeContexts()) {
  // -------------------------------------------------------------------
  // 正常系
  // -------------------------------------------------------------------

  test(`[${label}] 新規ラボを作成でき、labs一覧・revision 0・完全な初期状態が保存される`, async () => {
    const ctx = create();
    const result = await ctx.service.createLab({ labId: "lab-create", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    assert.equal(result.labId, "lab-create");
    assert.equal(result.fixtures.length, 5);
    assert.equal(result.stored.currentState.revision, 0);
    const loaded = await ctx.repo.loadCurrentState("lab-create");
    assert.equal(loaded.currentState.revision, 0);
    assert.equal(loaded.currentState.runtime.isComplete, false);
    assert.deepEqual(await ctx.repo.listLabs(), ["lab-create"]);
  });

  test(`[${label}] 重複labIdのラボ作成はAlreadyExistsエラーになり、既存ラボが破壊されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-dup", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await runOneQuarter(ctx, "lab-dup", "turn-1", "lock-1");
    await assert.rejects(() => ctx.service.createLab({ labId: "lab-dup", config: baseConfig({ seed: "another" }), playerCompanyId: PLAYER_COMPANY_ID, now: NOW }), CompanyLabAlreadyExistsError);
    const current = await ctx.repo.loadCurrentState("lab-dup");
    assert.equal(current.currentState.revision, 1, "重複作成により既存ラボのrevisionが巻き戻されている");
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-dup"), [1]);
  });

  test(`[${label}] draftの保存・提出ライフサイクル（未保存→未提出→提出済み→再提出は冪等→提出後の編集拒否）`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-draft", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    assert.equal(await ctx.repo.loadDraft("lab-draft"), null);

    const saved = await ctx.service.saveDraft({ labId: "lab-draft", turnId: "turn-1", draftBody: { a: 1 }, now: NOW });
    assert.equal(saved.submittedAt, null);
    assert.equal(saved.revision, 0);

    // 同じturnIdの上書き保存はcreatedAtを維持したまま本体を更新する
    const updated = await ctx.service.saveDraft({ labId: "lab-draft", turnId: "turn-1", draftBody: { a: 2 }, now: "2026-01-01T01:00:00.000Z" });
    assert.equal(updated.createdAt, NOW);
    assert.equal(updated.updatedAt, "2026-01-01T01:00:00.000Z");
    assert.deepEqual(updated.draft, { a: 2 });

    const submitted = await ctx.service.submitDraft({ labId: "lab-draft", turnId: "turn-1", now: "2026-01-01T02:00:00.000Z" });
    assert.equal(submitted.submittedAt, "2026-01-01T02:00:00.000Z");

    // 再提出は冪等（submittedAtが更新されない）
    const resubmitted = await ctx.service.submitDraft({ labId: "lab-draft", turnId: "turn-1", now: "2026-01-01T03:00:00.000Z" });
    assert.equal(resubmitted.submittedAt, "2026-01-01T02:00:00.000Z");

    // 提出後の編集は拒否される
    await assert.rejects(() => ctx.service.saveDraft({ labId: "lab-draft", turnId: "turn-1", draftBody: { a: 3 }, now: NOW }), CompanyLabDraftAlreadySubmittedError);
  });

  test(`[${label}] turn 1を処理すると、current・history・index・revision・draftのすべてが正しく更新される`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-t1", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    const result = await runOneQuarter(ctx, "lab-t1", "turn-1", "lock-1");
    assert.equal(result.status, "processed");
    assert.equal(result.revision, 1);
    assert.equal(result.historyEntry.turn, 1);
    assert.equal(result.historyEntry.turnId, "turn-1");

    const current = await ctx.repo.loadCurrentState("lab-t1");
    assert.equal(current.currentState.revision, 1);
    assert.equal(current.currentState.lastProcessedTurnId, "turn-1");
    assert.equal(current.currentState.runtime.scenarioState.currentTurn, 2, "処理後のcurrentは次のturnを指すべき");
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-t1"), [1]);
    // commit成功時にdraftは原子的に削除される（＝「処理済み」状態）
    assert.equal(await ctx.repo.loadDraft("lab-t1"), null);
    // 保存された履歴エントリは読み出し・検証を通過する（書けるが読めない履歴が存在しない）
    const entry = await ctx.repo.loadHistoryEntry("lab-t1", 1);
    assert.equal(entry.turnId, "turn-1");
    assert.equal(entry.record.turn, 1);
  });

  test(`[${label}] turn 2以降は直近履歴が復元時に注入され、連続して処理できる`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-t2", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await runOneQuarter(ctx, "lab-t2", "turn-1", "lock-1");
    const result2 = await runOneQuarter(ctx, "lab-t2", "turn-2", "lock-2");
    assert.equal(result2.status, "processed");
    assert.equal(result2.revision, 2);
    assert.equal(result2.historyEntry.turn, 2);
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-t2"), [1, 2]);
    const current = await ctx.repo.loadCurrentState("lab-t2");
    assert.equal(current.currentState.runtime.scenarioState.currentTurn, 3);
  });

  // -------------------------------------------------------------------
  // 冪等性・競合
  // -------------------------------------------------------------------

  test(`[${label}] 同一turnIdの再試行（commit成功後の応答消失を想定）は再計算・二重保存せず、保存済み結果を返す`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-retry", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    const first = await runOneQuarter(ctx, "lab-retry", "turn-1", "lock-1");
    assert.equal(first.status, "processed");

    // draftは既に削除されているが、同じturnIdの再試行はalreadyProcessedとして
    // 保存済みの確定結果を返す（draftNotFoundに誤変換されない）
    const retry = await ctx.service.processQuarter({
      labId: "lab-retry",
      turnId: "turn-1",
      lockToken: "lock-retry",
      now: NOW,
      decisionsProvider: autoPolicyProvider,
    });
    assert.equal(retry.status, "alreadyProcessed");
    assert.equal(retry.revision, 1);
    assert.equal(retry.historyEntry.turnId, "turn-1");
    // 二重保存されていない
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-retry"), [1]);
    const current = await ctx.repo.loadCurrentState("lab-retry");
    assert.equal(current.currentState.revision, 1);
  });

  test(`[${label}] 異なるturnIdによる同一turnの処理は拒否され、履歴が二重作成されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-turn-conflict", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });

    // ケース1（通常経路）: 処理B（turnId=turn-1-B）が完了した後、別のturnId（turn-1-A）で
    // 同じturnを処理しようとしても、draftは確定時に削除済みのためDraftNotFoundで拒否される。
    await runOneQuarter(ctx, "lab-turn-conflict", "turn-1-B", "lock-B");
    await assert.rejects(
      () =>
        ctx.service.processQuarter({
          labId: "lab-turn-conflict",
          turnId: "turn-1-A",
          lockToken: "lock-A",
          now: NOW,
          decisionsProvider: autoPolicyProvider,
        }),
      CompanyLabDraftNotFoundError
    );
    // 履歴はturn-1-Bの1件だけ（二重作成されていない）
    const entry = await ctx.repo.loadHistoryEntry("lab-turn-conflict", 1);
    assert.equal(entry.turnId, "turn-1-B");
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-turn-conflict"), [1]);
    // ケース2（レース経路）: 万一この事前チェックをすり抜けて同turnへ別turnIdの
    // コミットが到達しても、Lua側のhistoryConflict判定で拒否され、サービスは
    // CompanyLabTurnConflictErrorへ変換する（次のconflict変換テスト、および
    // Repository契約テスト「同じturnに対して異なるturnIdでは保存できない」で検証済み）。
  });

  test(`[${label}] コミット時のhistoryConflict・revisionConflict・lockConflictはそれぞれ型付きエラーへ変換される（Repositoryラッパーによる結果注入）`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-map", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await ctx.service.saveDraft({ labId: "lab-map", turnId: "turn-1", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-map", turnId: "turn-1", now: NOW });

    const conflictResults = [
      { injected: { status: "historyConflict", existingTurnId: "turn-other" } as const, expectedError: CompanyLabTurnConflictError },
      { injected: { status: "revisionConflict", actualRevision: 9 } as const, expectedError: CompanyLabRevisionConflictError },
      { injected: { status: "lockConflict" } as const, expectedError: CompanyLabLockConflictError },
    ];
    for (const { injected, expectedError } of conflictResults) {
      const wrappedRepo: CompanyLabStateRepository = {
        ...ctx.repo,
        commitQuarterAtomically: async (input: CompanyLabQuarterCommitInput) => {
          void input;
          return injected;
        },
      };
      const wrappedService = createCompanyLabQuarterFlowService({ repository: wrappedRepo });
      await assert.rejects(
        () =>
          wrappedService.processQuarter({
            labId: "lab-map",
            turnId: "turn-1",
            lockToken: `lock-${injected.status}`,
            now: NOW,
            decisionsProvider: autoPolicyProvider,
          }),
        expectedError
      );
      // コミットは注入結果を返しただけなので、実ストレージは無変更のまま
      const current = await ctx.repo.loadCurrentState("lab-map");
      assert.equal(current.currentState.revision, 0);
      assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-map"), []);
      const draft = await ctx.repo.loadDraft("lab-map");
      assert.notEqual(draft, null, "競合エラー時にdraftが失われている");
    }
  });

  test(`[${label}] ロックが他の処理に保持されている間はLockUnavailableになり、状態・draftは変更されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-locked", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await ctx.service.saveDraft({ labId: "lab-locked", turnId: "turn-1", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-locked", turnId: "turn-1", now: NOW });
    // 他の処理がロックを保持
    assert.equal(await ctx.repo.acquireProcessingLock({ labId: "lab-locked", token: "other-process", ttlMilliseconds: 60_000, now: NOW }), true);
    await assert.rejects(
      () =>
        ctx.service.processQuarter({
          labId: "lab-locked",
          turnId: "turn-1",
          lockToken: "my-token",
          now: NOW,
          decisionsProvider: autoPolicyProvider,
        }),
      CompanyLabLockUnavailableError
    );
    const current = await ctx.repo.loadCurrentState("lab-locked");
    assert.equal(current.currentState.revision, 0);
    assert.notEqual(await ctx.repo.loadDraft("lab-locked"), null);
    // 他の処理のロックは削除されていない（自トークンのみ解放の確認）
    assert.equal(await ctx.repo.acquireProcessingLock({ labId: "lab-locked", token: "third", ttlMilliseconds: 60_000, now: NOW }), false, "他処理のロックが誤って解放されている");
  });

  test(`[${label}] 処理成功後・処理失敗後のいずれもロックが解放される（自トークンのみ）`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-release", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await runOneQuarter(ctx, "lab-release", "turn-1", "lock-1");
    // 成功後: ロックは解放済みで、すぐ再取得できる
    assert.equal(await ctx.repo.acquireProcessingLock({ labId: "lab-release", token: "after-success", ttlMilliseconds: 60_000, now: NOW }), true);
    assert.equal(await ctx.repo.releaseProcessingLock("lab-release", "after-success"), true);

    // 失敗経路（providerが不足した意思決定を返す）でもロックは解放される
    await ctx.service.saveDraft({ labId: "lab-release", turnId: "turn-2", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-release", turnId: "turn-2", now: NOW });
    const brokenProvider: CompanyLabDecisionsProvider = (context) => {
      const decisions = { ...autoPolicyProvider(context) } as Record<CompanyId, CompanyDecisionInput>;
      delete decisions[context.fixtures[1].companyId]; // 1社ぶん欠落させる
      return decisions;
    };
    await assert.rejects(
      () =>
        ctx.service.processQuarter({
          labId: "lab-release",
          turnId: "turn-2",
          lockToken: "lock-2",
          now: NOW,
          decisionsProvider: brokenProvider,
        }),
      CompanyLabQuarterProcessingError
    );
    assert.equal(await ctx.repo.acquireProcessingLock({ labId: "lab-release", token: "after-failure", ttlMilliseconds: 60_000, now: NOW }), true, "失敗経路でロックが解放されていない");
  });

  // -------------------------------------------------------------------
  // 入力・状態異常
  // -------------------------------------------------------------------

  test(`[${label}] 存在しないlabIdへの各サービス操作はNotFoundエラーになる`, async () => {
    const ctx = create();
    await assert.rejects(() => ctx.service.saveDraft({ labId: "no-lab", turnId: "t", draftBody: {}, now: NOW }), CompanyLabNotFoundError);
    await assert.rejects(() => ctx.service.submitDraft({ labId: "no-lab", turnId: "t", now: NOW }), CompanyLabNotFoundError);
    await assert.rejects(
      () => ctx.service.processQuarter({ labId: "no-lab", turnId: "t", lockToken: "l", now: NOW, decisionsProvider: autoPolicyProvider }),
      CompanyLabNotFoundError
    );
  });

  test(`[${label}] draftなし・未提出draft・turnId不一致draftでの四半期処理はそれぞれ型付きエラーになり、状態は変更されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-draft-guard", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });

    // draftなし
    await assert.rejects(
      () =>
        ctx.service.processQuarter({ labId: "lab-draft-guard", turnId: "turn-1", lockToken: "l1", now: NOW, decisionsProvider: autoPolicyProvider }),
      CompanyLabDraftNotFoundError
    );

    // 未提出draft
    await ctx.service.saveDraft({ labId: "lab-draft-guard", turnId: "turn-1", draftBody: {}, now: NOW });
    await assert.rejects(
      () =>
        ctx.service.processQuarter({ labId: "lab-draft-guard", turnId: "turn-1", lockToken: "l2", now: NOW, decisionsProvider: autoPolicyProvider }),
      CompanyLabDraftNotSubmittedError
    );

    // turnId不一致
    await ctx.service.submitDraft({ labId: "lab-draft-guard", turnId: "turn-1", now: NOW });
    await assert.rejects(
      () =>
        ctx.service.processQuarter({ labId: "lab-draft-guard", turnId: "turn-OTHER", lockToken: "l3", now: NOW, decisionsProvider: autoPolicyProvider }),
      CompanyLabDraftTurnMismatchError
    );

    const current = await ctx.repo.loadCurrentState("lab-draft-guard");
    assert.equal(current.currentState.revision, 0);
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-draft-guard"), []);
    const draft = await ctx.repo.loadDraft("lab-draft-guard");
    assert.equal(draft?.turnId, "turn-1");
    assert.notEqual(draft?.submittedAt, null, "エラー経路でdraftの提出状態が失われている");
  });

  test(`[${label}] 履歴エントリ検証に失敗した場合、コミットは呼び出されず、current・history・index・draftのいずれも変更されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-invalid-entry", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await ctx.service.saveDraft({ labId: "lab-invalid-entry", turnId: "turn-1", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-invalid-entry", turnId: "turn-1", now: NOW });

    // コミットが呼ばれたら検出するスパイ＋読み込んだ現在状態のengineVersionを空文字へ
    // 破損させるラッパー。空のengineVersionはエンジン実行そのものには影響しないが、
    // 履歴エントリの検証（$.engineVersionのrequireNonEmptyString）で決定論的に失敗する。
    // これにより「エンジン実行成功→エントリ検証失敗→コミット未到達」の経路を、
    // 両Repository実装で同一に検証できる。
    let commitCalled = false;
    const spyRepo: CompanyLabStateRepository = {
      ...ctx.repo,
      loadCurrentState: async (labId: string) => {
        const stored = await ctx.repo.loadCurrentState(labId);
        return { ...stored, engineVersion: "" };
      },
      commitQuarterAtomically: async (input: CompanyLabQuarterCommitInput) => {
        commitCalled = true;
        return ctx.repo.commitQuarterAtomically(input);
      },
    };
    const spyService = createCompanyLabQuarterFlowService({ repository: spyRepo });

    await assert.rejects(
      () =>
        spyService.processQuarter({
          labId: "lab-invalid-entry",
          turnId: "turn-1",
          lockToken: "lock-1",
          now: NOW,
          decisionsProvider: autoPolicyProvider,
        }),
      CompanyLabPersistedStateValidationError
    );
    assert.equal(commitCalled, false, "検証失敗時にコミットが呼び出されている");
    const current = await ctx.repo.loadCurrentState("lab-invalid-entry");
    assert.equal(current.currentState.revision, 0);
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-invalid-entry"), []);
    assert.notEqual(await ctx.repo.loadDraft("lab-invalid-entry"), null, "検証失敗時にdraftが失われている");
  });

  test(`[${label}] エンジン実行（コミット前）の失敗では確定状態が変更されず、draftは提出済みのまま再試行できる`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-engine-fail", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await ctx.service.saveDraft({ labId: "lab-engine-fail", turnId: "turn-1", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-engine-fail", turnId: "turn-1", now: NOW });

    // 意思決定の形が壊れているとadvanceCompanyLabQuarterが例外を投げる
    const crashingProvider: CompanyLabDecisionsProvider = (context) => {
      const decisions = { ...autoPolicyProvider(context) } as Record<CompanyId, CompanyDecisionInput>;
      decisions[context.playerCompanyId] = { companyId: context.playerCompanyId } as CompanyDecisionInput; // salesPlans等が欠落
      return decisions;
    };
    await assert.rejects(
      () =>
        ctx.service.processQuarter({
          labId: "lab-engine-fail",
          turnId: "turn-1",
          lockToken: "lock-1",
          now: NOW,
          decisionsProvider: crashingProvider,
        }),
      CompanyLabQuarterProcessingError
    );
    const current = await ctx.repo.loadCurrentState("lab-engine-fail");
    assert.equal(current.currentState.revision, 0);
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-engine-fail"), []);
    const draft = await ctx.repo.loadDraft("lab-engine-fail");
    assert.notEqual(draft?.submittedAt, null, "エンジン失敗後もdraftは提出済みのまま残るべき（再試行可能性）");

    // 原因（provider）を直せば、同じturnIdでそのまま再試行して成功できる
    const retried = await ctx.service.processQuarter({
      labId: "lab-engine-fail",
      turnId: "turn-1",
      lockToken: "lock-2",
      now: NOW,
      decisionsProvider: autoPolicyProvider,
    });
    assert.equal(retried.status, "processed");
  });

  test(`[${label}] 完了済みラボの四半期処理・draft保存は拒否され、current・history・draftは変更されない`, async () => {
    const ctx = create();
    // turns=1のラボはturn 1の処理で完了する
    await ctx.service.createLab({ labId: "lab-done", config: baseConfig({ turns: 1 }), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    const result = await runOneQuarter(ctx, "lab-done", "turn-1", "lock-1");
    assert.equal(result.status, "processed");
    const currentAfter = await ctx.repo.loadCurrentState("lab-done");
    assert.equal(currentAfter.currentState.runtime.isComplete, true);

    // これ以上の処理は拒否
    await assert.rejects(
      () =>
        ctx.service.processQuarter({ labId: "lab-done", turnId: "turn-2", lockToken: "lock-2", now: NOW, decisionsProvider: autoPolicyProvider }),
      CompanyLabCompletedError
    );
    await assert.rejects(() => ctx.service.saveDraft({ labId: "lab-done", turnId: "turn-2", draftBody: {}, now: NOW }), CompanyLabCompletedError);

    // 完了済みturnの冪等な再試行は引き続き成功する（完了チェックより先に判定される）
    const retry = await ctx.service.processQuarter({
      labId: "lab-done",
      turnId: "turn-1",
      lockToken: "lock-3",
      now: NOW,
      decisionsProvider: autoPolicyProvider,
    });
    assert.equal(retry.status, "alreadyProcessed");

    const current = await ctx.repo.loadCurrentState("lab-done");
    assert.equal(current.currentState.revision, 1);
    assert.deepEqual(await ctx.repo.loadHistoryIndex("lab-done"), [1]);
  });

  // -------------------------------------------------------------------
  // Phase 8C-3A追加: Fable監査Minor-1・Minor-2対応の回帰テスト
  // -------------------------------------------------------------------

  test(`[${label}] Minor-1: 提出済みだが未処理の別turnのdraftが存在する場合、異なるturnIdでのsaveDraftはDraftConflictになり、既存draftは変更されない`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-draft-conflict", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    const submitted = await ctx.service.saveDraft({ labId: "lab-draft-conflict", turnId: "turn-1", draftBody: { note: "original" }, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-draft-conflict", turnId: "turn-1", now: NOW });

    await assert.rejects(
      () => ctx.service.saveDraft({ labId: "lab-draft-conflict", turnId: "turn-2", draftBody: { note: "overwrite-attempt" }, now: NOW }),
      CompanyLabDraftConflictError
    );

    // 既存の提出済みdraft（turn-1）が変更されていないことを確認する
    const draftAfter = await ctx.repo.loadDraft("lab-draft-conflict");
    assert.equal(draftAfter?.turnId, "turn-1");
    assert.notEqual(draftAfter?.submittedAt, null);
    assert.deepEqual(draftAfter?.draft, { note: "original" });
    void submitted;
  });

  test(`[${label}] Minor-1: 同じturnIdでの再保存（提出後編集）は引き続きDraftAlreadySubmittedになる（Minor-1対応が既存動作を壊していないことの確認）`, async () => {
    const ctx = create();
    await ctx.service.createLab({ labId: "lab-same-turn-resubmit", config: baseConfig(), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await ctx.service.saveDraft({ labId: "lab-same-turn-resubmit", turnId: "turn-1", draftBody: {}, now: NOW });
    await ctx.service.submitDraft({ labId: "lab-same-turn-resubmit", turnId: "turn-1", now: NOW });
    await assert.rejects(
      () => ctx.service.saveDraft({ labId: "lab-same-turn-resubmit", turnId: "turn-1", draftBody: { note: "edit-attempt" }, now: NOW }),
      CompanyLabDraftAlreadySubmittedError
    );
  });

  test(`[${label}] Minor-2: 完了済みラボへのsubmitDraftは明示的にCompanyLabCompletedErrorで拒否され、current・draftは変更されない`, async () => {
    const ctx = create();
    // turns=1のラボはturn 1の処理で完了する
    await ctx.service.createLab({ labId: "lab-done-submit-guard", config: baseConfig({ turns: 1 }), playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
    await runOneQuarter(ctx, "lab-done-submit-guard", "turn-1", "lock-1");
    const currentAfter = await ctx.repo.loadCurrentState("lab-done-submit-guard");
    assert.equal(currentAfter.currentState.runtime.isComplete, true);

    // 完了後にturn-2ぶんのdraftを直接Repositoryへ差し込み（saveDraft自体は既にisComplete
    // ガードで拒否されるため、submitDraft単体のガードを検証するには直接注入する必要がある）、
    // submitDraftが明示的に完了済みラボを拒否することを確認する。
    await ctx.repo.saveDraft({
      labId: "lab-done-submit-guard",
      period: currentAfter.currentState.runtime.currentPeriod,
      turnId: "turn-2",
      revision: currentAfter.currentState.revision,
      draft: {},
      createdAt: NOW,
      updatedAt: NOW,
      submittedAt: null,
    });
    await assert.rejects(() => ctx.service.submitDraft({ labId: "lab-done-submit-guard", turnId: "turn-2", now: NOW }), CompanyLabCompletedError);

    const draftAfter = await ctx.repo.loadDraft("lab-done-submit-guard");
    assert.equal(draftAfter?.submittedAt, null, "完了済みラボでsubmitDraftが誤って成功し、draftが提出済みになっている");
  });
}
