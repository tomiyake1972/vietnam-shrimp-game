// ShrimpX V2 — REUSE-1: 変更していない保存パートを送り直さない、の検証
//
// 【この修正の範囲】GM Console の保存で、前の revision から変わっていない
// dataset / pack を送らず、サーバー側（Redis内）でコピーさせる。
// gzip・差分追記・保存タイミングのまとめ・受講者提出経路の変更は含まない。
//
// 【このテスト群が守る因果】送り方を軽くしたことで次のいずれかが起きてはいけない。
//   A. 保存される中身が従来方式と変わる（AI Analysis Pack・resume が壊れる）
//   B. 再利用元が無い／ずれているのに、パートが欠けた revision を正本として公開する
//   C. 既に確立している保護（保存競合のCAS・終了済みRun保護）が緩む

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../../../../api/v2/simulation-runs/_lib/handlers";
import { createInMemorySimulationRunRepository } from "../persistence/repository";
import {
  SIMULATION_RUN_REUSE_BASE_MISMATCH,
  fingerprintSimulationRunPart,
  isReusableSimulationRunPart,
  parseSimulationRunPartSource,
} from "../persistence/partReuse";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";

const RUN_ID = "reuse1-run";
const SAVED_AT = "2026-10-16T00:00:00.000Z";

function runMetadata(completedTurns: number, gameEndedAt: string | null = null) {
  return {
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "seed",
    gameParameterVersion: "v1",
    standardAiVersion: "v1",
    strategyProfileVersion: "v1",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns,
    startedAt: SAVED_AT,
    completedAt: null,
    stopReason: "running" as const,
    errorMessage: null,
    failedAtTurn: null,
    ...(gameEndedAt ? { gameEndedAt, gameEndTurn: completedTurns, finalEvaluationSnapshot: [] } : {}),
  };
}

/** turn 1..n ぶんの行を持つ、最小構成の dataset。 */
function datasetThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    schemaVersion: "simulationAnalytics-v1",
    turns,
    companies: [{ companyId: "BAL", displayName: "BAL", color: "#000" }],
    companyMetrics: turns.map((turn) => ({ turn, companyId: "BAL", metric: "revenue", value: turn * 100 })),
    marketMetrics: [],
    producerCountryMetrics: [],
    bottlenecks: [],
    aiTrace: [],
    salesTrace: [],
    hiringTrace: [],
    investmentTrace: [],
    contribution: [],
    fixedCosts: [],
    salesAllocation: [],
  };
}

/**
 * turn 1..n ぶんの pack。
 * 【完全な PackCompanyTurnCapture を作らない理由】このテストが確かめるのは
 * 「再利用で中身が変わらないこと」だけで、行の意味は使わない。
 * 判定に必要な `turn` だけを持つ最小の行にし、型は境界でキャストする。
 */
function packThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    companyTurns: turns.map((turn) => ({ turn, companyId: "BAL", marker: `c${turn}` })),
    worldTurns: turns.map((turn) => ({ turn, marker: `w${turn}` })),
  };
}

function attemptFor(expectedBaseRevision: number, token: string) {
  return { expectedBaseRevision, writeToken: token };
}

type Repo = ReturnType<typeof createInMemorySimulationRunRepository>;

/** dataset/resume/pack を全量で保存し manifest を commit する（＝従来方式の1回ぶん）。 */
async function saveFull(
  repository: Repo,
  options: { readonly base: number; readonly token: string; readonly maxTurn: number; readonly gameEndedAt?: string | null }
): Promise<number> {
  const revision = options.base + 1;
  const attempt = attemptFor(options.base, options.token);
  for (const [part, value] of [
    ["dataset", datasetThrough(options.maxTurn)],
    ["resume", { marker: `resume-${options.maxTurn}` }],
    ["pack", packThrough(options.maxTurn)],
  ] as const) {
    const r = await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part, value, ...attempt });
    assert.equal(r.status, 200, `${part} の全量保存が失敗した: ${JSON.stringify(r.body)}`);
  }
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(options.maxTurn, options.gameEndedAt ?? null),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, `manifest commit が失敗した: ${JSON.stringify(commit.body)}`);
  return revision;
}

function errorCodeOf(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | undefined)?.error?.code;
}

// ---------------------------------------------------------------------
// 送り方の判定（純粋関数）
// ---------------------------------------------------------------------

test("REUSE-1: value と reuseFromRevision は排他で、どちらも無ければ不正", () => {
  assert.deepEqual(parseSimulationRunPartSource({ value: { turns: [] } }), { kind: "value", value: { turns: [] } });
  assert.deepEqual(parseSimulationRunPartSource({ reuseFromRevision: 3 }), { kind: "reuse", fromRevision: 3 });

  assert.ok("error" in parseSimulationRunPartSource({}), "どちらも無いのに通っている");
  assert.ok("error" in parseSimulationRunPartSource({ reuseFromRevision: 1, value: {} }), "同時指定が通っている");
  assert.ok("error" in parseSimulationRunPartSource({ reuseFromRevision: -1 }), "負数が通っている");
  assert.ok("error" in parseSimulationRunPartSource({ reuseFromRevision: 1.5 }), "非整数が通っている");
});

test("REUSE-2: 再利用の対象は dataset / pack だけで、resume は対象外", () => {
  assert.equal(isReusableSimulationRunPart("dataset"), true);
  assert.equal(isReusableSimulationRunPart("pack"), true);
  assert.equal(isReusableSimulationRunPart("resume"), false);
});

/**
 * 【受入前の指摘1】判定は内容そのもので行う。最大turnが同じでも内容が違えば
 * フィンガープリントは必ず違わなければならない（違わなければ変更が静かに失われる）。
 */
test("REUSE-2b: フィンガープリントは内容で決まる（最大turnが同じでも内容が違えば別になる）", async () => {
  const a = await fingerprintSimulationRunPart(datasetThrough(3));
  const same = await fingerprintSimulationRunPart(datasetThrough(3));
  assert.notEqual(a, null, "この環境では crypto.subtle が使えずフィンガープリントが取れない");
  assert.equal(a, same, "同じ内容なのに別のフィンガープリントになっている");

  // 最大turnは3のまま、値だけ変える。
  const changed = { ...datasetThrough(3), companyMetrics: datasetThrough(3).companyMetrics.map((m) => ({ ...m, value: 999 })) };
  const b = await fingerprintSimulationRunPart(changed);
  assert.notEqual(a, b, "最大turnが同じで内容が違うのに同じフィンガープリントになっている");

  // turn が増えた場合も当然違う。
  const longer = await fingerprintSimulationRunPart(datasetThrough(4));
  assert.notEqual(a, longer);

  // pack も同様。
  const p3 = await fingerprintSimulationRunPart(packThrough(3));
  const p3changed = await fingerprintSimulationRunPart({
    ...packThrough(3),
    worldTurns: packThrough(3).worldTurns.map((w) => ({ ...w, marker: "changed" })),
  });
  assert.notEqual(p3, p3changed, "pack の内容変更が検出できていない");
});

// ---------------------------------------------------------------------
// A. 保存される中身が従来方式と同一であること
// ---------------------------------------------------------------------

test("REUSE-3: 再利用したパートは、全量送信した場合と同一の正本になる（resumeだけ更新される）", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 4 });
  const before = await repository.loadRun(RUN_ID);

  const revision = first + 1;
  const attempt = attemptFor(first, "t2");
  for (const part of ["dataset", "pack"] as const) {
    const r = await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part, reuseFromRevision: first, ...attempt });
    assert.equal(r.status, 200, `${part} の再利用が失敗した: ${JSON.stringify(r.body)}`);
  }
  const resumeResult = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision,
    part: "resume",
    value: { marker: "resume-updated" },
    ...attempt,
  });
  assert.equal(resumeResult.status, 200);
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(4),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  const after = await repository.loadRun(RUN_ID);
  assert.ok(after);
  assert.equal(JSON.stringify(after.dataset), JSON.stringify(before?.dataset), "送っていない dataset の中身が変わった");
  assert.equal(JSON.stringify(after.packCapture), JSON.stringify(before?.packCapture), "送っていない pack の中身が変わった");
  assert.deepEqual(after.resumePayload, { marker: "resume-updated" } as never, "resume が更新されていない");
  assert.equal(after.persistenceRevision, revision);
});

// ---------------------------------------------------------------------
// B. 土台が無い／ずれているときに正本化しないこと
// ---------------------------------------------------------------------

test("REUSE-4: 公開済みの土台が無い再利用は 409 で拒否され、正本は作られない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: 1,
    part: "dataset",
    reuseFromRevision: 0,
    ...attemptFor(0, "t1"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_REUSE_BASE_MISMATCH);
  assert.equal(await repository.loadRun(RUN_ID), null, "正本が作られてしまっている");
});

test("REUSE-5: 基準revisionが古い再利用は拒否され、公開中の正本は変わらない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 2 });
  const second = await saveFull(repository, { base: first, token: "t2", maxTurn: 3 });
  assert.equal(second, 2);

  // 既に revision 2 が公開されているのに revision 1 を土台にしようとする。
  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: 3,
    part: "dataset",
    reuseFromRevision: 1,
    ...attemptFor(1, "t3"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_REUSE_BASE_MISMATCH);

  const stored = await repository.loadRun(RUN_ID);
  assert.equal(stored?.persistenceRevision, second, "正本の revision が動いてしまっている");
  assert.equal(JSON.stringify(stored?.dataset), JSON.stringify(datasetThrough(3)), "正本の中身が変わってしまっている");
});

test("REUSE-6: 再利用元が消えている（パートだけ欠けた）場合も拒否される", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 2 });

  // pack を持たない revision を公開し直し、その revision から pack を再利用しようとする。
  const revision = first + 1;
  const attempt = attemptFor(first, "t2");
  await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part: "dataset", value: datasetThrough(2), ...attempt });
  await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part: "resume", value: { marker: "r" }, ...attempt });
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(2),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: false,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: revision + 1,
    part: "pack",
    reuseFromRevision: revision,
    ...attemptFor(revision, "t3"),
  });
  assert.equal(result.status, 409, "pack が無い revision からの再利用が通ってしまっている");
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_REUSE_BASE_MISMATCH);
});

// ---------------------------------------------------------------------
// C. 既存の保護が緩んでいないこと
// ---------------------------------------------------------------------

test("REUSE-7: 終了済みRunへの再利用保存は、従来どおり拒否される", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 3, gameEndedAt: SAVED_AT });

  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: first + 1,
    part: "dataset",
    reuseFromRevision: first,
    ...attemptFor(first, "t2"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), "GAME_FINISHED", `想定外のコード: ${JSON.stringify(result.body)}`);
});

test("REUSE-8: 同じ基準を読んだ2つのwriterのうち、commitに成功するのは一方だけ（CASは不変）", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 3 });

  // 2つのwriterがどちらも revision 1 を基準に、再利用で dataset/pack を置く。
  const a = attemptFor(first, "writer-a");
  const bWriter = attemptFor(first, "writer-b");
  for (const attempt of [a, bWriter]) {
    for (const part of ["dataset", "pack"] as const) {
      const r = await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision: first + 1, part, reuseFromRevision: first, ...attempt });
      assert.equal(r.status, 200);
    }
    const r = await handleSaveSimulationRunPart(repository, {
      simulationRunId: RUN_ID,
      revision: first + 1,
      part: "resume",
      value: { marker: attempt.writeToken },
      ...attempt,
    });
    assert.equal(r.status, 200);
  }

  const manifest = {
    manifestOnly: true,
    run: runMetadata(3),
    savedAt: SAVED_AT,
    persistenceRevision: first + 1,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
  };
  const commitA = await handleSaveSimulationRun(repository, { ...manifest, ...a });
  const commitB = await handleSaveSimulationRun(repository, { ...manifest, ...bWriter });

  assert.equal(commitA.status, 200, "先行writerのcommitが失敗した");
  assert.equal(commitB.status, 409, "後続writerのcommitが通ってしまっている（CASが効いていない）");
  assert.equal(errorCodeOf(commitB.body), "STALE_PERSISTENCE_REVISION");

  const stored = await repository.loadRun(RUN_ID);
  assert.deepEqual(stored?.resumePayload, { marker: "writer-a" } as never, "敗者の内容が正本になっている");
  // 再利用したパートは、どちらが勝っても従来方式と同じ中身である。
  assert.equal(JSON.stringify(stored?.dataset), JSON.stringify(datasetThrough(3)));
  assert.equal(JSON.stringify(stored?.packCapture), JSON.stringify(packThrough(3)));
});

/**
 * 【受入前の指摘2】stagePartFromPublished の契約を両実装でそろえた。
 * インメモリ側をここで固定し、Redis 側は scripts/int1/reuse1IsolatedRedis.ts
 * （REUSE-R10〜R15）で実Redisに対して固定している。
 *
 * 契約: 公開中revision・fromRevision・expectedBaseRevision の三者が一致し、
 * そのパートが実在するときだけ true。
 */
test("REUSE-9: 三者（公開中revision / fromRevision / expectedBaseRevision）が一致しなければ再利用しない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const published = await saveFull(repository, { base: 0, token: "t1", maxTurn: 3 });
  assert.equal(published, 1);

  // 三者一致 → true
  const ok = await repository.stagePartFromPublished(RUN_ID, attemptFor(published, "ok"), "dataset", published);
  assert.equal(ok, true, "三者が一致しているのに再利用できていない");

  // fromRevision だけ食い違う
  const a = await repository.stagePartFromPublished(RUN_ID, attemptFor(published, "a"), "dataset", published + 1);
  assert.equal(a, false, "fromRevision が公開中と違うのに再利用できてしまっている");

  // expectedBaseRevision だけ食い違う
  const bMismatch = await repository.stagePartFromPublished(RUN_ID, attemptFor(published + 1, "b"), "dataset", published);
  assert.equal(bMismatch, false, "expectedBaseRevision が公開中と違うのに再利用できてしまっている");

  // 両方古い（互いには一致しているが公開中と違う）
  const c = await repository.stagePartFromPublished(RUN_ID, attemptFor(published - 1, "c"), "dataset", published - 1);
  assert.equal(c, false, "両方が公開中と違うのに再利用できてしまっている");

  // そのRun自体が無い
  const d = await repository.stagePartFromPublished("no-such-run", attemptFor(published, "d"), "dataset", published);
  assert.equal(d, false);
});

test("REUSE-10: 公開中revisionに存在しないパートは再利用しない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const revision = 1;
  const attempt = attemptFor(0, "t1");
  // pack を持たない Run を公開する。
  await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part: "dataset", value: datasetThrough(2), ...attempt });
  await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part: "resume", value: { marker: "r" }, ...attempt });
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(2),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: false,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200);

  const dataset = await repository.stagePartFromPublished(RUN_ID, attemptFor(revision, "x"), "dataset", revision);
  assert.equal(dataset, true, "存在する dataset が再利用できていない");
  const pack = await repository.stagePartFromPublished(RUN_ID, attemptFor(revision, "y"), "pack", revision);
  assert.equal(pack, false, "存在しない pack が再利用できてしまっている");
});
