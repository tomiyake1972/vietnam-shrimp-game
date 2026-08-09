// ShrimpX V2 — Simulation Run API ハンドラーのテスト
//
// Repository をインメモリ実装で注入し、実Redis・環境変数なしで検証する
// （会社ラボ API の handlers.test.ts と同じ方針）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySimulationRunRepository } from "../../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../../../lib/v2/companyLab/simulation/persistence/types";
import { handleDeleteSimulationRun, handleListSimulationRuns, handleLoadSimulationRun, handleSaveSimulationRun } from "../handlers";

const AT = "2026-01-01T00:00:00.000Z";

function body(simulationRunId: string) {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: {
      simulationRunId,
      scenarioId: "baseline",
      scenarioVersion: "v1",
      seed: "s",
      gameParameterVersion: "g",
      standardAiVersion: "a",
      strategyProfileVersion: "sp",
      startingTurn: 1,
      requestedTurns: 32,
      completedTurns: 32,
      startedAt: AT,
      completedAt: AT,
      stopReason: "completed",
      errorMessage: null,
      failedAtTurn: null,
    },
    dataset: { schemaVersion: "simulationAnalytics-v1", turns: [1], companies: [], companyMetrics: [], marketMetrics: [], producerCountryMetrics: [], bottlenecks: [], aiTrace: [], salesTrace: [], hiringTrace: [], investmentTrace: [] },
    savedAt: AT,
  };
}

test("API-1: 保存 → 読み込み → 一覧が往復する", async () => {
  const repository = createInMemorySimulationRunRepository();
  const saved = await handleSaveSimulationRun(repository, body("run-1"));
  assert.equal(saved.status, 200);

  const loaded = await handleLoadSimulationRun(repository, "run-1");
  assert.equal(loaded.status, 200);

  const list = await handleListSimulationRuns(repository);
  assert.equal(list.status, 200);
  assert.equal((list.body as { runs: unknown[] }).runs.length, 1);
});

test("API-2: run / dataset / savedAt が欠けた保存要求は 400 で拒否する", async () => {
  const repository = createInMemorySimulationRunRepository();
  assert.equal((await handleSaveSimulationRun(repository, null)).status, 400);
  assert.equal((await handleSaveSimulationRun(repository, {})).status, 400);
  const { dataset: _dropped, ...withoutDataset } = body("run-2");
  void _dropped;
  assert.equal((await handleSaveSimulationRun(repository, withoutDataset)).status, 400);
});

test("API-3: schemaVersion はクライアントの申告を信用せずサーバー側で確定させる", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, { ...body("run-3"), schemaVersion: 999 });
  const stored = await repository.loadRun("run-3");
  assert.equal(stored?.schemaVersion, CURRENT_SIMULATION_RUN_PERSISTED_VERSION);
});

test("API-4: 存在しない Simulation Run は 404 を返す", async () => {
  const repository = createInMemorySimulationRunRepository();
  assert.equal((await handleLoadSimulationRun(repository, "missing")).status, 404);
});

test("API-5: 削除は存在しなくてもエラーにしない（冪等）", async () => {
  const repository = createInMemorySimulationRunRepository();
  assert.equal((await handleDeleteSimulationRun(repository, "missing")).status, 200);
  await handleSaveSimulationRun(repository, body("run-5"));
  assert.equal((await handleDeleteSimulationRun(repository, "run-5")).status, 200);
  assert.equal(await repository.loadRun("run-5"), null);
});
