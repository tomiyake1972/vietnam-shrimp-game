// ShrimpX V2 — Turn14以降Save/Resume停止BLOCKER修正: 分割保存（manifest + パート）のテスト
//
// 【このテスト群が守る因果】
// resumePayload/dataset/packCaptureを1つの巨大なJSON valueへ束ねる旧設計は、実測で
// Vercel Functionsのrequest body上限（既定約4.5MB）にTurn10〜15あたりで到達し、
// それ以降のserver保存がプラットフォーム側で拒否されていた（実stagingでの
// 「Turn18まで進めたのにTurn14へ戻る」再現の根本原因）。
// この修正の核心は「manifest（小さい）がresume/dataset/packの全パートを書き終えた
// あとにだけ更新される」ことである。saveRunPartだけ呼んでcommitRunManifestを
// 呼ばなければ、loadRunは新しいデータを一切見せない（＝partial saveが正本化されない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySimulationRunRepository, SimulationRunPart } from "../persistence/repository";
import { StoredSimulationRunManifest, manifestToSimulationRunSummary, CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildDatasetFromSession } from "../analytics/dataset";
import { buildResumePayload } from "../persistence/resume";

const AT = "2026-01-01T00:00:00.000Z";

function fakeRun(id: string, completedTurns: number) {
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
    completedTurns,
    startedAt: AT,
    completedAt: null,
    stopReason: "running" as const,
    errorMessage: null,
    failedAtTurn: null,
  };
}

function fakeManifest(id: string, completedTurns: number, revision: number): StoredSimulationRunManifest {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: fakeRun(id, completedTurns),
    persistenceRevision: revision,
    savedAt: AT,
    hasResumePayload: false,
    hasPackCapture: false,
  };
}

// PERSIST-B5: dataset/pack partial saveをactiveにしない
test("PERSIST-B5: saveRunPartだけではloadRunに反映されない（commitRunManifestまでは非公開）", async () => {
  const repo = createInMemorySimulationRunRepository();
  const id = "b5-run";

  await repo.saveRunPart(id, 1, "dataset" as SimulationRunPart, { schemaVersion: "x", turns: [1], companies: [], companyMetrics: [], marketMetrics: [], producerCountryMetrics: [], bottlenecks: [], aiTrace: [], salesTrace: [], hiringTrace: [], investmentTrace: [], contribution: [], fixedCosts: [], salesAllocation: [] });
  const beforeCommit = await repo.loadRun(id);
  assert.equal(beforeCommit, null, "commitRunManifestより前にloadRunがデータを返してしまっている（partial saveが正本化されている）");

  await repo.commitRunManifest(fakeManifest(id, 1, 1), manifestToSimulationRunSummary(fakeManifest(id, 1, 1)));
  const afterCommit = await repo.loadRun(id);
  assert.ok(afterCommit, "commitRunManifest後もloadRunがnullを返している");
  assert.equal(afterCommit?.run.completedTurns, 1);
});

// PERSIST-B6: manifest complete revisionのみload — 新しいrevisionのpartを書いてもcommitするまで古いrevisionのまま
test("PERSIST-B6: 新revisionのパートを書いてもcommitRunManifestを呼ぶまでloadRunは旧revisionのまま", async () => {
  const repo = createInMemorySimulationRunRepository();
  const id = "b6-run";

  await repo.saveRunPart(id, 1, "dataset", { turns: [1], marker: "revision1" });
  await repo.commitRunManifest(fakeManifest(id, 1, 1), manifestToSimulationRunSummary(fakeManifest(id, 1, 1)));

  // revision2のdatasetだけ書く（＝Turn15以降で server save が失敗し続けた状況を模す）。
  await repo.saveRunPart(id, 2, "dataset", { turns: [1, 2], marker: "revision2" });

  const loaded = await repo.loadRun(id);
  assert.equal(loaded?.persistenceRevision, 1, "commitされていないrevision2がloadRunから見えてしまっている");
  assert.deepEqual((loaded?.dataset as unknown as { marker: string }).marker, "revision1");

  // ここでrevision2をcommitして初めて見えるようになる。
  await repo.commitRunManifest(fakeManifest(id, 2, 2), manifestToSimulationRunSummary(fakeManifest(id, 2, 2)));
  const loadedAfter = await repo.loadRun(id);
  assert.equal(loadedAfter?.persistenceRevision, 2);
  assert.deepEqual((loadedAfter?.dataset as unknown as { marker: string }).marker, "revision2");
});

// PERSIST-B1: Turn14→15付近のpayload境界を実測相当のセッションで再確認する
// （旧実装は1つのJSONへ束ねていたため、この境界でVercel Functionsのrequest body上限に
// 到達していた。新実装は各パートを個別に保存するため、パート単体のサイズで見る）。
test("PERSIST-B1: Turn10〜18のdataset/resume各パートは、個別に見れば4.5MBのrequest body上限へ到達しない", () => {
  const session0 = createSimulationSession({ simulationRunId: "b1-run", scenarioId: "baseline", seed: "management-console-32q", requestedTurns: 32, startedAt: AT });
  const session = advanceSimulationTurns({ session: session0, turns: 18, timestamp: AT });
  const dataset = buildDatasetFromSession(session);
  const resumePayload = buildResumePayload(session, {}, {});
  const datasetBytes = Buffer.byteLength(JSON.stringify(dataset));
  const resumeBytes = Buffer.byteLength(JSON.stringify(resumePayload));
  const VERCEL_FUNCTION_REQUEST_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
  assert.ok(datasetBytes < VERCEL_FUNCTION_REQUEST_BODY_LIMIT_BYTES, `Turn18時点のdatasetパート単体が${datasetBytes}bytesあり、4.5MB上限に近い/超えている`);
  assert.ok(resumeBytes < VERCEL_FUNCTION_REQUEST_BODY_LIMIT_BYTES, `Turn18時点のresumeパート単体が${resumeBytes}bytesあり、4.5MB上限に近い/超えている`);

  // 旧実装（束ねた1つのJSON）だったら、Turn18時点でどうなっていたかも記録として残す
  // （このassertは意図的に「上限を超え得る」ことを示すもので、旧設計が危険だった
  // ことのドキュメントを兼ねる）。
  const bundledBytes = datasetBytes + resumeBytes;
  console.log(`[PERSIST-B1] Turn18: dataset=${datasetBytes}B, resume=${resumeBytes}B, bundled(旧設計相当)=${bundledBytes}B, limit=${VERCEL_FUNCTION_REQUEST_BODY_LIMIT_BYTES}B`);
});

// saveRun（便宜メソッド）自体も、内部でsaveRunPart×N→commitRunManifestと同じ結果になることを確認。
test("PERSIST-B: saveRun便宜メソッドはsaveRunPart+commitRunManifestを合成したのと同じ結果になる", async () => {
  const repoA = createInMemorySimulationRunRepository();
  const repoB = createInMemorySimulationRunRepository();
  const id = "compose-run";

  const dataset = { turns: [1], marker: "same" } as never;
  const manifest = fakeManifest(id, 1, 1);

  await repoA.saveRun({ schemaVersion: manifest.schemaVersion, run: manifest.run, dataset, savedAt: manifest.savedAt, persistenceRevision: 1 });

  await repoB.saveRunPart(id, 1, "dataset", dataset);
  await repoB.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest));

  const loadedA = await repoA.loadRun(id);
  const loadedB = await repoB.loadRun(id);
  assert.deepEqual(loadedA?.dataset, loadedB?.dataset);
  assert.equal(loadedA?.persistenceRevision, loadedB?.persistenceRevision);
});
