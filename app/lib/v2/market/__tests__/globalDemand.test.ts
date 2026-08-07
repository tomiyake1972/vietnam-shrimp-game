import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateWorldDemand, calculateMarketDemand } from "../globalDemand";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { baseDemandMarketInput } from "./fixtures";
import { DEMAND_MARKET_IDS } from "../types";

test("1市場の需要は前期消費量×景気指数×(1+人口増加率)", () => {
  const demand = calculateMarketDemand({
    priorPeriodConsumption: hosoEqTons(10000),
    economicIndex: 1.1,
    populationGrowthRate: 0.02,
  });
  // 10000 * 1.1 * 1.02 = 11220
  assert.ok(Math.abs(unwrapUnit(demand) - 11220) < 1e-6);
});

test("景気指数が上がると需要が増える", () => {
  const base = calculateMarketDemand(baseDemandMarketInput({ economicIndex: 1.0 }));
  const boosted = calculateMarketDemand(baseDemandMarketInput({ economicIndex: 1.2 }));
  assert.ok(unwrapUnit(boosted) > unwrapUnit(base));
});

test("人口増加率が上がると需要が増える", () => {
  const base = calculateMarketDemand(baseDemandMarketInput({ populationGrowthRate: 0 }));
  const boosted = calculateMarketDemand(baseDemandMarketInput({ populationGrowthRate: 0.05 }));
  assert.ok(unwrapUnit(boosted) > unwrapUnit(base));
});

test("世界需要は5市場の合計と一致する", () => {
  const demandMarkets = {
    CN: baseDemandMarketInput(),
    US: baseDemandMarketInput(),
    EU: baseDemandMarketInput(),
    JP: baseDemandMarketInput(),
    OTHER: baseDemandMarketInput(),
  };
  const result = calculateWorldDemand(demandMarkets);
  let sum = 0;
  for (const m of DEMAND_MARKET_IDS) sum += unwrapUnit(result.byMarket[m]);
  assert.ok(Math.abs(unwrapUnit(result.totalWorldDemand) - sum) < 1e-9);
});

test("calculateWorldDemandは入力オブジェクトを変更しない", () => {
  const demandMarkets = {
    CN: baseDemandMarketInput(),
    US: baseDemandMarketInput(),
    EU: baseDemandMarketInput(),
    JP: baseDemandMarketInput(),
    OTHER: baseDemandMarketInput(),
  };
  const snapshot = JSON.parse(JSON.stringify(demandMarkets));
  calculateWorldDemand(demandMarkets);
  assert.deepEqual(JSON.parse(JSON.stringify(demandMarkets)), snapshot);
});
