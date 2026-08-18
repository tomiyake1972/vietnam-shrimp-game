// ShrimpX V2 — Simulation Run API ハンドラーのテスト
//
// Repository をインメモリ実装で注入し、実Redis・環境変数なしで検証する
// （会社ラボ API の handlers.test.ts と同じ方針）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySimulationRunRepository } from "../../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../../../lib/v2/companyLab/simulation/persistence/types";
import {
  handleDeleteSimulationRun,
  handleListSimulationRuns,
  handleLoadSimulationRun,
  handleSaveSimulationRun,
  handleSaveSimulationRunPart,
} from "../handlers";

const AT = "2026-01-01T00:00:00.000Z";
const EMPTY_DATASET = { schemaVersion: "simulationAnalytics-v1", turns: [1], companies: [], companyMetrics: [], marketMetrics: [], producerCountryMetrics: [], bottlenecks: [], aiTrace: [], salesTrace: [], hiringTrace: [], investmentTrace: [] };

function run(simulationRunId: string, overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function body(simulationRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: run(simulationRunId, overrides),
    dataset: EMPTY_DATASET,
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

// ---------------------------------------------------------------------
// Game End / Final Results（END-1）— server-side mutation lock
// ---------------------------------------------------------------------

test("END-LOCK-1: gameEndedAtが未設定のRunへ、gameEndedAtを新規に設定する保存（Game Endそのもの）は成功する", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, body("run-end-1"));
  const ended = await handleSaveSimulationRun(
    repository,
    body("run-end-1", { gameEndedAt: "2026-02-01T00:00:00.000Z", gameEndTurn: 12, finalEvaluationSnapshot: [] })
  );
  assert.equal(ended.status, 200);
  const stored = await repository.loadRun("run-end-1");
  assert.equal(stored?.run.gameEndedAt, "2026-02-01T00:00:00.000Z");
});

test("END-LOCK-2: 既にgameEndedAtが設定されたRunへの以後の保存（legacy形式）は409で拒否される（Advance Turn・Decision変更の再現）", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, body("run-end-2", { gameEndedAt: AT, gameEndTurn: 12, finalEvaluationSnapshot: [] }));
  // 終了後、さらにTurnを進めた/Decisionを変えたつもりの保存を試みる。
  const rejected = await handleSaveSimulationRun(
    repository,
    body("run-end-2", { gameEndedAt: AT, gameEndTurn: 12, finalEvaluationSnapshot: [], completedTurns: 13 })
  );
  assert.equal(rejected.status, 409);
  assert.equal((rejected.body as { error: { code: string } }).error.code, "GAME_FINISHED");
  // 実際にRedis/インメモリ側のcompletedTurnsが13へ進んでいないことも確認する。
  const stored = await repository.loadRun("run-end-2");
  assert.equal(stored?.run.completedTurns, 32);
});

test("END-LOCK-3: manifestOnly形式のcommitも、既にgameEndedAt設定済みなら409で拒否される", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, body("run-end-3", { gameEndedAt: AT, gameEndTurn: 12, finalEvaluationSnapshot: [] }));
  const rejected = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: run("run-end-3", { gameEndedAt: AT, gameEndTurn: 12, finalEvaluationSnapshot: [] }),
    savedAt: AT,
    persistenceRevision: 2,
    hasResumePayload: false,
    hasPackCapture: false,
  });
  assert.equal(rejected.status, 409);
});

test("END-LOCK-4: gameEndedAt設定済みRunへのpart保存（decision下書き相当）も409で拒否される", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, body("run-end-4", { gameEndedAt: AT, gameEndTurn: 12, finalEvaluationSnapshot: [] }));
  const rejected = await handleSaveSimulationRunPart(repository, {
    simulationRunId: "run-end-4",
    revision: 2,
    part: "resume",
    value: { fake: "decision-change-attempt" },
  });
  assert.equal(rejected.status, 409);
});

test("END-LOCK-5: gameEndedAtが無いRunへの通常の保存（Advance Turn相当）は引き続き成功する", async () => {
  const repository = createInMemorySimulationRunRepository();
  await handleSaveSimulationRun(repository, body("run-end-5"));
  const advanced = await handleSaveSimulationRun(repository, body("run-end-5", { completedTurns: 2 }));
  assert.equal(advanced.status, 200);
  const stored = await repository.loadRun("run-end-5");
  assert.equal(stored?.run.completedTurns, 2);
});
