// ShrimpX V2 — BW-1: 転送量削減（読むパートの選択と、revision による変化判定）
//
// 【背景（実測）】Staging の Redis が月間帯域 10 GB を使い切って停止した。
// 原因は、変化が無くても定期取得のたびに Run の全パート（dataset / resumePayload /
// packCapture）を読んでいたこと。GM の Seat 一覧は dataset も packCapture も
// 使っていないのに読んでいた。誰も操作していない状態でも毎時十数 GB を消費する
// （scripts/int1/measureBandwidth.ts で実測）。
//
// ここで固定する契約
//   1. loadRun は読むパートを選べる。既定（options 省略）は従来どおり全部読む。
//   2. dataset を読まない指定でも「パート欠落」エラーにはならない。
//   3. 読まなかったパートは undefined になり、読んだパートは全読みと一致する。
//   4. 変化の有無は currentPublishedRevision（manifest だけの軽い読み取り）で判定でき、
//      保存すれば必ず revision が上がる＝更新を取りこぼさない。
//
// 保存形式・保存競合対策（CAS）・ゲーム計算は変更していない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedisSimulationRunRepository } from "../persistence/redisRepository";
import { createSimulationRunWriteToken } from "../persistence/repository";
import { createFakeSimulationRunRedisClient } from "./fakeSimulationRunRedisClient";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRunManifest, manifestToSimulationRunSummary } from "../persistence/types";
import { SimulationRun } from "../types";

const AT = "2026-10-08T00:00:00.000Z";
const APP_ENV = "staging" as const;

function fakeRun(id: string): SimulationRun {
  return {
    simulationRunId: id,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "seed",
    gameParameterVersion: "v1",
    standardAiVersion: "v1",
    strategyProfileVersion: "v1",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns: 3,
    startedAt: AT,
    completedAt: null,
    stopReason: "completed",
    errorMessage: null,
    failedAtTurn: null,
  };
}

function manifestFor(id: string, revision: number): StoredSimulationRunManifest {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: fakeRun(id),
    persistenceRevision: revision,
    savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
    hasResumePayload: true,
    hasPackCapture: true,
  };
}

async function setupRun(id: string, revision = 1) {
  const client = createFakeSimulationRunRedisClient();
  const repo = createRedisSimulationRunRepository({ client, appEnv: APP_ENV });
  const attempt = { expectedBaseRevision: revision - 1, writeToken: createSimulationRunWriteToken("bw1") };
  await repo.saveRunPart(id, attempt, "dataset", { marker: "dataset-body" });
  await repo.saveRunPart(id, attempt, "resume", { marker: "resume-body" });
  await repo.saveRunPart(id, attempt, "pack", { marker: "pack-body" });
  const manifest = manifestFor(id, revision);
  await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);
  return { repo, client };
}

test("BW1-1: options を省略すると従来どおり全パートを読む", async () => {
  const { repo } = await setupRun("bw1-all");
  const loaded = await repo.loadRun("bw1-all");
  assert.ok(loaded !== null);
  assert.deepEqual(loaded.dataset, { marker: "dataset-body" });
  assert.deepEqual(loaded.resumePayload, { marker: "resume-body" });
  assert.deepEqual(loaded.packCapture, { marker: "pack-body" });
});

test("BW1-2: dataset と pack を読まない指定ができ、エラーにならない", async () => {
  const { repo } = await setupRun("bw1-partial");
  const loaded = await repo.loadRun("bw1-partial", { include: { dataset: false, pack: false } });
  assert.ok(loaded !== null, "部分読みで null になっている");
  assert.equal(loaded.dataset, undefined, "読まない指定の dataset が入っている");
  assert.equal(loaded.packCapture, undefined, "読まない指定の packCapture が入っている");
  assert.deepEqual(loaded.resumePayload, { marker: "resume-body" }, "resumePayload が読めていない");
  assert.equal(loaded.run.simulationRunId, "bw1-partial");
  assert.equal(loaded.persistenceRevision, 1);
});

test("BW1-3: 部分読みの resumePayload は全読みと一致する（内容が変わらない）", async () => {
  const { repo } = await setupRun("bw1-same");
  const full = await repo.loadRun("bw1-same");
  const partial = await repo.loadRun("bw1-same", { include: { dataset: false, pack: false } });
  assert.deepEqual(partial?.resumePayload, full?.resumePayload);
  assert.deepEqual(partial?.run, full?.run);
  assert.equal(partial?.persistenceRevision, full?.persistenceRevision);
});

test("BW1-4: resume だけを読まない指定もできる", async () => {
  const { repo } = await setupRun("bw1-noresume");
  const loaded = await repo.loadRun("bw1-noresume", { include: { resume: false } });
  assert.equal(loaded?.resumePayload, undefined);
  assert.deepEqual(loaded?.dataset, { marker: "dataset-body" });
  assert.deepEqual(loaded?.packCapture, { marker: "pack-body" });
});

test("BW1-5: 保存すれば必ず revision が上がる（変化を取りこぼさない）", async () => {
  const { repo } = await setupRun("bw1-rev");
  const before = await repo.currentPublishedRevision("bw1-rev");
  assert.equal(before, 1);

  const attempt2 = { expectedBaseRevision: before, writeToken: createSimulationRunWriteToken("bw1b") };
  await repo.saveRunPart("bw1-rev", attempt2, "dataset", { marker: "dataset-2" });
  await repo.saveRunPart("bw1-rev", attempt2, "resume", { marker: "resume-2" });
  await repo.saveRunPart("bw1-rev", attempt2, "pack", { marker: "pack-2" });
  const m2 = manifestFor("bw1-rev", before + 1);
  await repo.commitRunManifest(m2, manifestToSimulationRunSummary(m2), attempt2);

  const after = await repo.currentPublishedRevision("bw1-rev");
  assert.equal(after, before + 1, "保存したのに revision が上がっていない");
  const loaded = await repo.loadRun("bw1-rev", { include: { dataset: false, pack: false } });
  assert.deepEqual(loaded?.resumePayload, { marker: "resume-2" }, "新しい revision の内容が読めていない");
});

test("BW1-6: 存在しない Run は部分読みでも null（404 判定が変わらない）", async () => {
  const { repo } = await setupRun("bw1-exists");
  const missing = await repo.loadRun("bw1-missing", { include: { dataset: false, pack: false } });
  assert.equal(missing, null);
  assert.equal(await repo.currentPublishedRevision("bw1-missing"), 0);
});

// ---------------------------------------------------------------------------
// 部分読みしたものをそのまま保存しても、既存パートを消さないこと
//
// 部分読みを入れたことで「dataset を読まずに持ってきた StoredSimulationRun を
// そのまま保存し直す」という誤用が起こりうる。その場合に保存が通ってしまうと、
// 既存の dataset が空で上書きされ、Run が壊れる（続きからプレイできなくなる）。
// 保存側は従来からこれを拒否する作りなので、それが実際に効いていることを固定する。
// ---------------------------------------------------------------------------

test("BW1-7: 部分読みした Run をそのまま saveRun すると拒否され、既存 dataset は残る", async () => {
  const { repo } = await setupRun("bw1-nowipe");
  const partial = await repo.loadRun("bw1-nowipe", { include: { dataset: false, pack: false } });
  assert.ok(partial !== null);
  assert.equal(partial.dataset, undefined);

  await assert.rejects(
    () => repo.saveRun(partial),
    /dataset/,
    "dataset を読んでいない Run の保存が通ってしまっている（既存 dataset を消す恐れ）"
  );

  // 既存の保存物は手つかずであること。
  const after = await repo.loadRun("bw1-nowipe");
  assert.deepEqual(after?.dataset, { marker: "dataset-body" }, "既存 dataset が失われている");
  assert.deepEqual(after?.resumePayload, { marker: "resume-body" });
  assert.deepEqual(after?.packCapture, { marker: "pack-body" });
  assert.equal(await repo.currentPublishedRevision("bw1-nowipe"), 1, "拒否されたのに公開 revision が動いている");
});

test("BW1-8: パートを揃えずに manifest commit すると拒否され、前の revision が残る", async () => {
  const { repo } = await setupRun("bw1-partsmissing");
  const attempt = { expectedBaseRevision: 1, writeToken: createSimulationRunWriteToken("bw1-missing") };
  // resume だけ保存して dataset を保存しないまま公開しようとする。
  await repo.saveRunPart("bw1-partsmissing", attempt, "resume", { marker: "resume-2" });
  const m2 = manifestFor("bw1-partsmissing", 2);

  await assert.rejects(
    () => repo.commitRunManifest(m2, manifestToSimulationRunSummary(m2), attempt),
    /揃っていません/,
    "パートが揃っていないのに公開されてしまっている"
  );

  assert.equal(await repo.currentPublishedRevision("bw1-partsmissing"), 1, "拒否されたのに公開 revision が動いている");
  const after = await repo.loadRun("bw1-partsmissing");
  assert.deepEqual(after?.dataset, { marker: "dataset-body" }, "前の revision の dataset が失われている");
  assert.deepEqual(after?.resumePayload, { marker: "resume-body" }, "前の revision の resume が失われている");
});
