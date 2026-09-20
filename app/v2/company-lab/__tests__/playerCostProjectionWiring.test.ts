// ShrimpX V2 — Player費用表示接続
//
// Pre-Financing Liquidity の人件費見積が、Engine・Standard AI と同じ
// 当Turnの実効 financeParameters を使うことを固定する。
//
// 【将来を開示しない】Player へ渡るのは StandardAiCostProjection だけであり、
// 指数そのもの・将来Turnの曲線・将来費用値を含まないことも併せて固定する。

import test from "node:test";
import assert from "node:assert/strict";

import { buildPlayerCostProjection } from "../../../lib/v2/companyLab/playerCostProjection";
import { buildTurnEconomicsProjection } from "../../../lib/v2/companyLab/turnEconomicsProjection";
import { NEUTRAL_STANDARD_AI_COST_PROJECTION } from "../../../lib/v2/companyLab/standardAi/costProjection";
import { createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { FINANCE_PARAMETERS_V1, financeParametersForTurn } from "../../../lib/v2/finance/parameters";
import { resolveAllOperatingCostIndices } from "../../../lib/v2/scenario/costIndex";
import { ScenarioDefinition } from "../../../lib/v2/scenario/types";
import { CompanyLabState } from "../../../lib/v2/companyLab/types";

function sessionState(definition?: ScenarioDefinition): CompanyLabState {
  const session = createSimulationSession({
    simulationRunId: "player-proj",
    scenarioId: "dynamic-scenario-2",
    seed: "player-proj-seed",
    requestedTurns: 32,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  if (definition === undefined) return session.state;
  return { ...session.state, scenarioState: { ...session.state.scenarioState, definition } };
}

const INDEXED_DEFINITION = (base: ScenarioDefinition): ScenarioDefinition => ({
  ...base,
  operatingCostInflation: {
    settingsId: "player-wiring-test",
    tracks: {
      regularLabor: {
        interpolation: "linear",
        keyframes: [
          { turn: 1, value: 1.0 },
          { turn: 15, value: 1.0 },
          { turn: 32, value: 1.21 },
        ],
      },
      temporaryLabor: {
        interpolation: "linear",
        keyframes: [
          { turn: 1, value: 1.0 },
          { turn: 15, value: 1.0 },
          { turn: 32, value: 1.21 },
        ],
      },
    },
  },
});

test("PCP-1: 指数未宣言Runでは中立値と同一（表示は変更前とビット単位で同じ）", () => {
  const state = sessionState();
  for (const turn of [1, 16, 32]) {
    const p = buildPlayerCostProjection(state, turn);
    assert.equal(p.financeParameters, FINANCE_PARAMETERS_V1, `turn=${turn} 同一参照`);
    assert.deepEqual(p.indexedRequiredProjectCostByType, NEUTRAL_STANDARD_AI_COST_PROJECTION.indexedRequiredProjectCostByType);
  }
});

test("PCP-2: 指数付きRunでは当Turnの実効financeParametersと一致する（Engineと同値）", () => {
  const base = sessionState().scenarioState.definition;
  const state = sessionState(INDEXED_DEFINITION(base));
  for (const turn of [1, 15, 16, 24, 32]) {
    const p = buildPlayerCostProjection(state, turn);
    // Engine が使うのと同じ合成関数を通した値と一致すること
    const expected = financeParametersForTurn(FINANCE_PARAMETERS_V1, resolveAllOperatingCostIndices(state.scenarioState.definition, turn));
    assert.deepEqual(p.financeParameters, expected, `turn=${turn}`);
  }
  // Turn 32 では宣言どおり 1.21 倍
  const at32 = buildPlayerCostProjection(state, 32);
  assert.equal(at32.financeParameters.labor.regularWorkerSalaryUsdPerQuarter, 1000 * 1.21);
  assert.equal(at32.financeParameters.labor.temporaryWorkerCostUsdPerQuarter, 800 * 1.21);
  // Turn 1 / 15 は中立
  assert.equal(buildPlayerCostProjection(state, 1).financeParameters.labor.regularWorkerSalaryUsdPerQuarter, 1000);
  assert.equal(buildPlayerCostProjection(state, 15).financeParameters.labor.regularWorkerSalaryUsdPerQuarter, 1000);
});

test("PCP-3: Turn N の projection に Turn N+1 以降の値・指数曲線が現れない", () => {
  const base = sessionState().scenarioState.definition;
  const state = sessionState(INDEXED_DEFINITION(base));
  const at16 = buildPlayerCostProjection(state, 16);
  const at32 = buildPlayerCostProjection(state, 32);
  // Turn16 の値は Turn32 の値と異なる（=先の値を先取りしていない）
  assert.notEqual(
    at16.financeParameters.labor.regularWorkerSalaryUsdPerQuarter,
    at32.financeParameters.labor.regularWorkerSalaryUsdPerQuarter
  );
  // Player へ渡る構造は2フィールドのみ。指数・keyframe・将来値を含まない。
  assert.deepEqual(Object.keys(at16).sort(), ["financeParameters", "indexedRequiredProjectCostByType"]);
  const serialized = JSON.stringify(at16);
  assert.equal(serialized.includes("keyframes"), false);
  assert.equal(serialized.includes("operatingCostInflation"), false);
  assert.equal(serialized.includes("interpolation"), false);
  assert.equal(serialized.includes("settingsId"), false);
  // Turn32 の単価（1210）が Turn16 の projection に現れない
  assert.equal(serialized.includes("1210"), false);
});

test("PCP-4: 正本はRunのsnapshot定義であり、コード側registryではない", () => {
  const base = sessionState().scenarioState.definition;
  // コード側の dynamic-scenario-2 は指数未宣言。snapshot だけを指数付きに差し替える。
  const indexed = sessionState(INDEXED_DEFINITION(base));
  const neutral = sessionState();
  assert.notEqual(
    buildPlayerCostProjection(indexed, 32).financeParameters.labor.regularWorkerSalaryUsdPerQuarter,
    buildPlayerCostProjection(neutral, 32).financeParameters.labor.regularWorkerSalaryUsdPerQuarter
  );
  // snapshot 側の値がそのまま反映される（registry を引いていれば中立のままになる）
  assert.equal(buildPlayerCostProjection(indexed, 32).financeParameters.labor.regularWorkerSalaryUsdPerQuarter, 1210);
});

test("PCP-5: buildTurnEconomicsProjection と同一の値を返す（式を二重実装していない）", () => {
  const base = sessionState().scenarioState.definition;
  const state = sessionState(INDEXED_DEFINITION(base));
  for (const turn of [1, 20, 32]) {
    const p = buildPlayerCostProjection(state, turn);
    const full = buildTurnEconomicsProjection({ definition: state.scenarioState.definition, turn });
    assert.deepEqual(p.financeParameters, full.financeParameters, `turn=${turn}`);
    assert.deepEqual(p.indexedRequiredProjectCostByType, full.indexedRequiredProjectCostByType, `turn=${turn}`);
  }
});
