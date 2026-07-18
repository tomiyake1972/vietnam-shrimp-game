import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialGameSessionV2 } from "../gameSession";
import { INITIAL_PERIOD_V2 } from "../period";
import { SCHEMA_VERSION_V2, ENGINE_VERSION_V2, BALANCE_VERSION_V2 } from "../version";

// テスト21: V2初期GameSessionのバージョン値
test("初期GameSessionV2はschemaVersion=2、engineVersion/balanceVersionが定数と一致する", () => {
  const session = createInitialGameSessionV2({
    gameCode: "E2E-V2-TEST",
    initialPeriod: INITIAL_PERIOD_V2,
    randomSeed: "seed-1",
    companyIds: ["A", "B", "C"],
    now: "2026-07-18T00:00:00.000Z",
  });

  assert.equal(session.schemaVersion, SCHEMA_VERSION_V2);
  assert.equal(session.engineVersion, ENGINE_VERSION_V2);
  assert.equal(session.balanceVersion, BALANCE_VERSION_V2);
  assert.equal(session.currentPeriod, INITIAL_PERIOD_V2);
  assert.equal(session.currentTurnPhase, "P0_OPEN");
  assert.equal(session.scheduledEffects.length, 0);
  assert.deepEqual(session.processedPhasesThisPeriod, []);
  assert.deepEqual(session.companyIds, ["A", "B", "C"]);
  assert.ok(session.companyStates["A"]);
  assert.equal(session.industryState._phase0Placeholder, true);
});

test("gameCode/randomSeedが空、またはcompanyIdsが空の場合は拒否される", () => {
  const base = {
    initialPeriod: INITIAL_PERIOD_V2,
    now: "2026-07-18T00:00:00.000Z",
  };
  assert.throws(() =>
    createInitialGameSessionV2({ ...base, gameCode: "", randomSeed: "s", companyIds: ["A"] })
  );
  assert.throws(() =>
    createInitialGameSessionV2({ ...base, gameCode: "G", randomSeed: "", companyIds: ["A"] })
  );
  assert.throws(() =>
    createInitialGameSessionV2({ ...base, gameCode: "G", randomSeed: "s", companyIds: [] })
  );
});

// テスト22: JSON保存・復元で意味が保たれる
test("JSON.stringify/parseで往復してもGameSessionV2の内容が保たれる", () => {
  const session = createInitialGameSessionV2({
    gameCode: "E2E-V2-TEST",
    initialPeriod: INITIAL_PERIOD_V2,
    randomSeed: "seed-1",
    companyIds: ["A", "B"],
    now: "2026-07-18T00:00:00.000Z",
  });
  const restored = JSON.parse(JSON.stringify(session));
  assert.deepEqual(restored, session);
});
