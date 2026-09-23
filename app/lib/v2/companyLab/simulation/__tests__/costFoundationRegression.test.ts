// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: 既存Scenario回帰・決定論・resume互換
//
// 【この検証が担保すること】
//  (a) 既存Scenario（何も宣言していない）は、指数解決が常に1.00・
//      建設費方式が legacy であるため、32Q実行の結果が変更前と一致する。
//  (b) 同一 scenario × seed の2回実行が完全一致する（決定論）。
//  (c) resumePayload 経由の復元結果が変わらない。
//  (d) persistence version・Redis key は変更していない。

import test from "node:test";
import assert from "node:assert/strict";

import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../../persistence/types";
import { simulationRunIndexKeyV2, simulationRunManifestKeyV2, simulationRunSummaryKeyV2 } from "../../../redis/simulationRunRedisKeys";
import { ALL_SCENARIO_DEFINITIONS } from "../../../scenario/definitions";
import { resolveAllOperatingCostIndices, resolveConstructionCostPolicy, resolveRawPriceCaptureIndex } from "../../../scenario/costIndex";
import { FINANCE_PARAMETERS_V1, financeParametersForTurn } from "../../../finance/parameters";

const SCENARIOS = ["baseline", "dynamic-scenario-1", "dynamic-scenario-2"] as const;
const SEED = "cost-foundation-regression";

function runTurns(scenarioId: string, turns: number) {
  const session = createSimulationSession({
    simulationRunId: `cf-${scenarioId}`,
    scenarioId,
    seed: SEED,
    requestedTurns: turns,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  return advanceSimulationTurns({ session, turns, timestamp: "2026-01-01T01:00:00.000Z" });
}

test("CFR-1: 既存Scenarioは全Turnで指数1.00・legacy建設費方式", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    assert.equal(resolveConstructionCostPolicy(definition), "legacy-requested-cost", definition.scenarioId);
    for (let turn = 1; turn <= definition.durationTurns; turn++) {
      const indices = resolveAllOperatingCostIndices(definition, turn);
      for (const [key, value] of Object.entries(indices)) {
        assert.equal(value, 1, `${definition.scenarioId} turn=${turn} ${key}`);
      }
      assert.equal(resolveRawPriceCaptureIndex(definition, turn), 1, `${definition.scenarioId} turn=${turn}`);
      // 実効パラメータが base と同一参照＝現行計算とビット一致。
      assert.equal(financeParametersForTurn(FINANCE_PARAMETERS_V1, indices), FINANCE_PARAMETERS_V1);
    }
  }
});

test("CFR-2: 同一scenario×seedの2回実行が完全一致（決定論）", () => {
  for (const scenarioId of SCENARIOS) {
    const a = runTurns(scenarioId, 8);
    const b = runTurns(scenarioId, 8);
    assert.equal(
      JSON.stringify(a.state.history),
      JSON.stringify(b.state.history),
      `${scenarioId} history`
    );
    assert.equal(JSON.stringify(a.state.financeState), JSON.stringify(b.state.financeState), `${scenarioId} finance`);
  }
});

test("CFR-3: 既存Scenarioの32Q実行が完了し、marketInput/marketResultに新フィールドが現れない", () => {
  for (const scenarioId of SCENARIOS) {
    const session = runTurns(scenarioId, 32);
    assert.ok(session.state.history.length > 0, scenarioId);
    const serialized = JSON.stringify(session.state.history);
    // 中立時はキー自体を作らない規約（保存結果の完全一致）。
    assert.equal(serialized.includes("rawPriceCaptureIndex"), false, `${scenarioId}: rawPriceCaptureIndex`);
    assert.equal(serialized.includes("priceMultiplier"), false, `${scenarioId}: priceMultiplier`);
    assert.equal(serialized.includes("tradeRatio"), false, `${scenarioId}: tradeRatio`);
    assert.equal(serialized.includes("operatingCostInflation"), false, `${scenarioId}: operatingCostInflation`);
    assert.equal(serialized.includes("constructionCostPolicy"), false, `${scenarioId}: constructionCostPolicy`);
  }
});

test("CFR-4: resumePayload経由の復元結果が変わらない（configにも新フィールドが増えない）", () => {
  for (const scenarioId of SCENARIOS) {
    const session = runTurns(scenarioId, 4);
    const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
    const restored = restoreSessionFromResumePayload(session.run, payload);
    assert.equal(JSON.stringify(restored.state.config), JSON.stringify(session.state.config), scenarioId);
    // resume後に進めても壊れない。
    const advanced = advanceSimulationTurns({ session: restored, turns: 1, timestamp: "2026-01-01T02:00:00.000Z" });
    assert.ok(advanced.state.history.length >= session.state.history.length, scenarioId);
  }
});

test("CFR-5: persistence version・Redis keyを変更していない", () => {
  // 【MANUAL-BALANCE-1で5→6、BALANCE-PROFILE-1で6→7、年間純利益ベース配当で7→8へ意図的に更新】DS2費用追随（本テストの対象Phase）は
  // 今もpersistence versionを変更していない。6以降への引き上げはいずれも後続Phaseによるもので、
  // Management Console 手動バランス調整が、optionalフィールドの追加のみ
  // （manualBalanceOverrides / manualBalanceApplied）で行ったものであり、
  // マイグレーション不要・旧v1〜v5データはそのまま読める。
  // このテストの本来の意図（Redis keyの体系が変わっていないこと、versionが
  // 把握済みの値であること）は下の各assertで引き続き担保される。
  // 【ENG-CROWDING-MARKDOWN-3で8→9】Crowding診断（optionalフィールド追加のみ）。
  // v8以前のデータは引き続きそのまま読める（後方互換。migration不要）。
  assert.equal(CURRENT_SIMULATION_RUN_PERSISTED_VERSION, 9);
  assert.equal(CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, 9);
  assert.equal(simulationRunIndexKeyV2("staging"), "staging:v2:simulationRun:index");
  assert.equal(simulationRunManifestKeyV2("staging", "run-1"), "staging:v2:simulationRun:run-1");
  assert.equal(simulationRunSummaryKeyV2("staging", "run-1"), "staging:v2:simulationRun:run-1:summary");
});
