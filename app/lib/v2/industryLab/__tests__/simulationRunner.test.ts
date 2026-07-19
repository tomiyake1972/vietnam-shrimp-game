import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../../market/types";
import { ALL_SCENARIO_DEFINITIONS } from "../../scenario/definitions";
import {
  initializeIndustrySimulation,
  advanceIndustrySimulation,
  runIndustrySimulation,
  findScenarioDefinition,
} from "../simulationRunner";
import { IndustrySimulationConfig } from "../types";

function baseConfig(overrides?: Partial<IndustrySimulationConfig>): IndustrySimulationConfig {
  return {
    scenarioId: "baseline-v0.1",
    mode: "canonical",
    seed: "lab-test-seed",
    turns: 32,
    ...overrides,
  };
}

test("findScenarioDefinition: 存在しないscenarioIdは例外を投げる", () => {
  assert.throws(() => findScenarioDefinition("nonexistent-scenario"));
});

test("5つの代表シナリオすべてを32ターン実行でき、32件の四半期結果が生成される", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    const result = runIndustrySimulation(baseConfig({ scenarioId: definition.scenarioId, turns: 32 }));
    assert.equal(result.quarters.length, 32, definition.scenarioId);
  }
});

test("四半期は1始まりで連続した正しい順序で生成される", () => {
  const result = runIndustrySimulation(baseConfig({ turns: 24 }));
  const turns = result.quarters.map((q) => q.turn);
  assert.deepEqual(turns, Array.from({ length: 24 }, (_, i) => i + 1));
});

test("同じシナリオ・モード・シードなら常に同じ結果になる（canonical）", () => {
  const resultA = runIndustrySimulation(baseConfig());
  const resultB = runIndustrySimulation(baseConfig());
  assert.deepEqual(JSON.parse(JSON.stringify(resultA)), JSON.parse(JSON.stringify(resultB)));
});

test("同じシナリオ・モード・シードなら常に同じ結果になる（variation）", () => {
  const config = baseConfig({ scenarioId: "global-disease-crisis-v0.1", mode: "variation" });
  const resultA = runIndustrySimulation(config);
  const resultB = runIndustrySimulation(config);
  assert.deepEqual(JSON.parse(JSON.stringify(resultA)), JSON.parse(JSON.stringify(resultB)));
});

test("variationモードで異なるシードなら結果が変わりうる", () => {
  const resultA = runIndustrySimulation(
    baseConfig({ scenarioId: "ecuador-early-expansion-v0.1", mode: "variation", seed: "seed-x" })
  );
  const resultB = runIndustrySimulation(
    baseConfig({ scenarioId: "ecuador-early-expansion-v0.1", mode: "variation", seed: "seed-y" })
  );
  const priceA = unwrapUnit(resultA.quarters[10].marketResult.hosoPrices.EC.price);
  const priceB = unwrapUnit(resultB.quarters[10].marketResult.hosoPrices.EC.price);
  assert.notEqual(priceA, priceB);
});

test("全価格・数量が有限値で、NaN・Infinity・負値がない", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    const result = runIndustrySimulation(baseConfig({ scenarioId: definition.scenarioId }));
    for (const q of result.quarters) {
      for (const c of COUNTRY_IDS) {
        const price = unwrapUnit(q.marketResult.hosoPrices[c].price);
        const supply = unwrapUnit(q.marketResult.hosoPrices[c].exportableSupply);
        assert.ok(Number.isFinite(price) && price >= 0, `${definition.scenarioId} turn=${q.turn} ${c} price=${price}`);
        assert.ok(Number.isFinite(supply) && supply >= 0, `${definition.scenarioId} turn=${q.turn} ${c} supply=${supply}`);
      }
      assert.ok(Number.isFinite(unwrapUnit(q.marketResult.worldSupply)) && unwrapUnit(q.marketResult.worldSupply) >= 0);
      assert.ok(Number.isFinite(unwrapUnit(q.marketResult.worldDemand)) && unwrapUnit(q.marketResult.worldDemand) >= 0);
      assert.ok(Number.isFinite(unwrapUnit(q.marketResult.vietnamDomestic.price)));
      assert.ok(unwrapUnit(q.marketResult.vietnamDomestic.price) >= 0);
    }
  }
});

test("前期の実際の市場結果（HOSO価格）が次期のmarketInput.priorHosoFobPriceへ引き継がれる", () => {
  const result = runIndustrySimulation(baseConfig({ turns: 10 }));
  for (let i = 1; i < result.quarters.length; i++) {
    const prev = result.quarters[i - 1];
    const current = result.quarters[i];
    for (const c of COUNTRY_IDS) {
      assert.equal(
        unwrapUnit(current.marketInput.priorHosoFobPrice[c]),
        unwrapUnit(prev.marketResult.hosoPrices[c].price),
        `turn=${current.turn} ${c}`
      );
    }
  }
});

test("市場結果がScenarioTurnFeedback経由でシナリオ状態のturnHistoryへ記録される", () => {
  let state = initializeIndustrySimulation(baseConfig({ turns: 5 }));
  state = advanceIndustrySimulation(state);
  assert.equal(state.scenarioState.turnHistory.length, 1);
  assert.equal(state.scenarioState.turnHistory[0].turn, 1);
  assert.ok(state.scenarioState.turnHistory[0].feedback?.realizedMarketResult);
  assert.deepEqual(state.scenarioState.turnHistory[0].feedback?.realizedMarketResult, state.quarters[0].marketResult);
});

test("advanceIndustrySimulationは入力stateを変更しない", () => {
  const state = initializeIndustrySimulation(baseConfig({ turns: 5 }));
  const before = JSON.parse(JSON.stringify(state));
  advanceIndustrySimulation(state);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), before);
});

test("config（入力）は変更しない", () => {
  const config = baseConfig({ turns: 5 });
  const before = JSON.parse(JSON.stringify(config));
  runIndustrySimulation(config);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), before);
});

test("turnsがシナリオのdurationTurnsを超える場合は例外を投げる", () => {
  assert.throws(() => initializeIndustrySimulation(baseConfig({ turns: 999 })));
});

test("turnsが1未満・非整数の場合は例外を投げる", () => {
  assert.throws(() => initializeIndustrySimulation(baseConfig({ turns: 0 })));
  assert.throws(() => initializeIndustrySimulation(baseConfig({ turns: 10.5 })));
});

test("シミュレーション結果全体がJSONシリアライズ可能で、往復しても内容が保たれる", () => {
  const result = runIndustrySimulation(baseConfig({ turns: 8 }));
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(result)));
  assert.equal(roundTripped.quarters.length, 8);
});

test("完了済みのシミュレーションをさらに進めようとすると例外を投げる", () => {
  let state = initializeIndustrySimulation(baseConfig({ turns: 2 }));
  state = advanceIndustrySimulation(state);
  state = advanceIndustrySimulation(state);
  assert.equal(state.isComplete, true);
  assert.throws(() => advanceIndustrySimulation(state));
});

test("市場入力のdemandMarketsは5市場すべてを含む", () => {
  const result = runIndustrySimulation(baseConfig({ turns: 1 }));
  const keys = Object.keys(result.quarters[0].marketInput.demandMarkets).sort();
  assert.deepEqual(keys, [...DEMAND_MARKET_IDS].sort());
});
