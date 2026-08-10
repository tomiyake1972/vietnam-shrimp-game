// ShrimpX V2 — Management Console: Game Setup / Scenario Selection（Phase 8）
//
// 【この受入で守る因果】
//   createSimulationSession に runName・companyControlModes を渡すと、
//   SimulationRun メタデータへそのまま記録される（推測で埋めない・省略時はundefined）。
//   同じScenario+Seedなら同じ結果になる（決定論はSetup画面が謳う内容の裏付け）。
//   別Scenario・別Seedを渡せば、当然ながら独立したRunになる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { toSimulationRunSummary } from "../persistence/types";
import { buildDatasetFromSession } from "../analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";

const AT = "2026-01-01T00:00:00.000Z";

test("SETUP-Q: runName・companyControlModesがSimulationRunメタデータへそのまま記録される", () => {
  const session = createSimulationSession({
    simulationRunId: "setup-test-1",
    scenarioId: "baseline",
    seed: "setup-test-seed",
    requestedTurns: 2,
    startedAt: AT,
    runName: "BALをPLAYERにしたテストプレイ",
    companyControlModes: { BAL: "PLAYER", MASS: "STANDARD_AI" },
  });
  assert.equal(session.run.runName, "BALをPLAYERにしたテストプレイ");
  assert.deepEqual(session.run.companyControlModes, { BAL: "PLAYER", MASS: "STANDARD_AI" });
});

test("SETUP-Q2: runName・companyControlModesを省略すると、undefinedのまま（捏造しない）", () => {
  const session = createSimulationSession({
    simulationRunId: "setup-test-2",
    scenarioId: "baseline",
    seed: "setup-test-seed",
    requestedTurns: 1,
    startedAt: AT,
  });
  assert.equal(session.run.runName, undefined);
  assert.equal(session.run.companyControlModes, undefined);
});

test("SETUP-3: 同じScenario+Seedなら、2回実行しても同じ結果になる（決定論）", () => {
  const run = () =>
    advanceSimulationTurns({
      session: createSimulationSession({ simulationRunId: "x", scenarioId: "baseline", seed: "reproducibility-seed", requestedTurns: 3, startedAt: AT }),
      turns: 3,
      timestamp: AT,
    });
  const a = run();
  const b = run();
  const fingerprint = (s: ReturnType<typeof run>) =>
    s.state.history.map((h) => h.companySummaries.map((c) => `${c.companyId}:${c.newContractedQuantity}`).join("|")).join("||");
  assert.equal(fingerprint(a), fingerprint(b));
});

test("SETUP-4: 別Scenario・別Seedなら独立したRunになる（run idもmetadataも別）", () => {
  const a = createSimulationSession({ simulationRunId: "run-a", scenarioId: "baseline", seed: "seed-a", requestedTurns: 1, startedAt: AT });
  const b = createSimulationSession({ simulationRunId: "run-b", scenarioId: "global-demand-boom", seed: "seed-b", requestedTurns: 1, startedAt: AT });
  assert.notEqual(a.run.simulationRunId, b.run.simulationRunId);
  assert.notEqual(a.run.scenarioId, b.run.scenarioId);
  assert.notEqual(a.run.seed, b.run.seed);
});

// ---------------------------------------------------------------------
// Run History 用の要約（playerCompanyIds・runName）
// ---------------------------------------------------------------------

test("SETUP-8/L: toSimulationRunSummaryが、開始時に設定したPLAYER会社・Run名を要約へ反映する", () => {
  const session = createSimulationSession({
    simulationRunId: "setup-summary-test",
    scenarioId: "baseline",
    seed: "setup-summary-seed",
    requestedTurns: 1,
    startedAt: AT,
    runName: "テストRun",
    companyControlModes: { BAL: "PLAYER", MASS: "PLAYER", JPQ: "STANDARD_AI" },
  });
  const summary = toSimulationRunSummary({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    savedAt: AT,
  });
  assert.equal(summary.runName, "テストRun");
  assert.deepEqual([...summary.playerCompanyIds!].sort(), ["BAL", "MASS"]);
});

test("SETUP-E: legacy summary（companyControlModes未記録）はplayerCompanyIdsが空配列になる（NOT_RECORDEDにしない）", () => {
  const session = createSimulationSession({ simulationRunId: "legacy-summary-test", scenarioId: "baseline", seed: "legacy-seed", requestedTurns: 1, startedAt: AT });
  const summary = toSimulationRunSummary({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    savedAt: AT,
  });
  assert.deepEqual(summary.playerCompanyIds, []);
});
