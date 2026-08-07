import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeScenario, getScenarioTurnInput } from "../scenarioEngine";
import { toMarketQuarterInput } from "../marketAdapter";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../../market";
import { createRandomStream } from "../../core/random";
import { usdPerHosoEqKg, hosoEqTons, unwrapUnit } from "../../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../../market/types";
import { testScenarioDefinition } from "./fixtures";
import { PreviousMarketContext } from "../types";

function testPreviousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}

test("toMarketQuarterInput: ScenarioTurnInputの接続可能なサブセットだけをMarketQuarterInputへ変換する", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed");
  const turnInput = getScenarioTurnInput(state, 5);
  const previousContext = testPreviousMarketContext();

  const marketInput = toMarketQuarterInput(turnInput, previousContext);

  assert.equal(marketInput.period, turnInput.period);
  for (const c of COUNTRY_IDS) {
    assert.equal(marketInput.countries[c].production, turnInput.countries[c].production);
    assert.equal(marketInput.countries[c].exportCapacityRatio, turnInput.countries[c].exportCapacityRatio);
    assert.equal(marketInput.countries[c].aquacultureCostIndex, turnInput.countries[c].aquacultureCostIndex);
  }
  for (const m of DEMAND_MARKET_IDS) {
    assert.equal(marketInput.demandMarkets[m].priorPeriodConsumption, turnInput.demandMarkets[m].priorPeriodConsumption);
  }
  assert.equal(marketInput.vietnamDomestic.domesticRawSupply, turnInput.vietnamDomesticRawSupply);
  assert.equal(marketInput.vietnamDomestic.domesticProcurementIntent, previousContext.domesticProcurementIntent);
  assert.equal(marketInput.pdVapDemand.pdDemand, turnInput.pdVapDemand.pdDemand);
});

test("toMarketQuarterInput: 入力オブジェクトを変更しない", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed");
  const turnInput = getScenarioTurnInput(state, 5);
  const previousContext = testPreviousMarketContext();
  const turnInputBefore = JSON.parse(JSON.stringify(turnInput));
  const contextBefore = JSON.parse(JSON.stringify(previousContext));

  toMarketQuarterInput(turnInput, previousContext);

  assert.deepEqual(JSON.parse(JSON.stringify(turnInput)), turnInputBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(previousContext)), contextBefore);
});

test("toMarketQuarterInputの出力はcalculateMarketQuarterへそのまま渡せる（統合スモークテスト）", () => {
  const state = initializeScenario(testScenarioDefinition({ durationTurns: 24 }), "canonical", "seed-integration");
  const turnInput = getScenarioTurnInput(state, 3);
  const marketInput = toMarketQuarterInput(turnInput, testPreviousMarketContext());

  const result = calculateMarketQuarter(marketInput, MARKET_PARAMETERS_V1, createRandomStream("market-seed"));

  for (const c of COUNTRY_IDS) {
    assert.ok(Number.isFinite(unwrapUnit(result.hosoPrices[c].price)));
    assert.ok(unwrapUnit(result.hosoPrices[c].price) >= 0);
  }
  assert.ok(Number.isFinite(unwrapUnit(result.vietnamDomestic.price)));
});
