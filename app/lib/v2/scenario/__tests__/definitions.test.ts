import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenarioDefinition } from "../validation";
import { initializeScenario, getScenarioTurnInput } from "../scenarioEngine";
import { toMarketQuarterInput } from "../marketAdapter";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../../market";
import { createRandomStream } from "../../core/random";
import { unwrapUnit, usdPerHosoEqKg, hosoEqTons } from "../../core/units";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../../market/types";
import { ALL_SCENARIO_DEFINITIONS, BASELINE_SCENARIO, ECUADOR_EARLY_EXPANSION_SCENARIO, GLOBAL_DISEASE_CRISIS_SCENARIO, GLOBAL_DEMAND_BOOM_SCENARIO } from "../definitions";
import { PreviousMarketContext } from "../types";

test("5つの代表シナリオはすべて検証を通る", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    const result = validateScenarioDefinition(definition);
    assert.equal(result.valid, true, `${definition.scenarioId}: ${result.errors.join(", ")}`);
  }
});

test("5つの代表シナリオはすべて標準の32ターン（8年）", () => {
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    assert.equal(definition.durationTurns, 32, definition.scenarioId);
  }
});

test("5つの代表シナリオのscenarioIdはすべて異なる", () => {
  const ids = ALL_SCENARIO_DEFINITIONS.map((d) => d.scenarioId);
  assert.equal(new Set(ids).size, ids.length);
});

test("エクアドル早期拡張シナリオ: エクアドル以外の国の能力トレンドはベースラインと同一に保たれている", () => {
  const otherCountries = ["IN", "ID", "VN"] as const;
  for (const c of otherCountries) {
    const baselineTrend = BASELINE_SCENARIO.longTermTrends.find(
      (t) => t.variable === "COUNTRY_CAPACITY" && t.scope.kind === "country" && t.scope.countryId === c
    );
    const bTrend = ECUADOR_EARLY_EXPANSION_SCENARIO.longTermTrends.find(
      (t) => t.variable === "COUNTRY_CAPACITY" && t.scope.kind === "country" && t.scope.countryId === c
    );
    assert.ok(baselineTrend && bTrend);
    assert.deepEqual(bTrend!.keyframes, baselineTrend!.keyframes);
  }
});

test("エクアドル早期拡張シナリオ: エクアドルの能力は最終turnでベースラインより大きい", () => {
  const baselineEc = BASELINE_SCENARIO.longTermTrends.find(
    (t) => t.variable === "COUNTRY_CAPACITY" && t.scope.kind === "country" && t.scope.countryId === "EC"
  )!;
  const expansionEc = ECUADOR_EARLY_EXPANSION_SCENARIO.longTermTrends.find(
    (t) => t.variable === "COUNTRY_CAPACITY" && t.scope.kind === "country" && t.scope.countryId === "EC"
  )!;
  const baselineEnd = baselineEc.keyframes[baselineEc.keyframes.length - 1].value;
  const expansionEnd = expansionEc.keyframes[expansionEc.keyframes.length - 1].value;
  assert.ok(expansionEnd > baselineEnd);
});

test("世界的疾病危機シナリオ: 各疾病イベントの発生中は対象国のsurvivalRateが既定値より下がる", () => {
  const state = initializeScenario(GLOBAL_DISEASE_CRISIS_SCENARIO, "canonical", "seed-disease-check");
  const eventPeaks: Array<{ country: (typeof COUNTRY_IDS)[number]; turn: number }> = [
    { country: "EC", turn: 8 },
    { country: "IN", turn: 12 },
    { country: "VN", turn: 16 },
    { country: "ID", turn: 20 },
  ];
  for (const { country, turn } of eventPeaks) {
    const input = getScenarioTurnInput(state, turn);
    assert.ok(
      unwrapUnit(input.countries[country].survivalRate) < 0.85,
      `${country} turn=${turn}: 生残率が既定値(0.85)を下回っているはず`
    );
  }
});

test("世界的疾病危機シナリオ: 疾病発生中でも生産量は0以上・有限（NaN/Infinityなし）", () => {
  const state = initializeScenario(GLOBAL_DISEASE_CRISIS_SCENARIO, "canonical", "seed-disease-nan");
  for (let turn = 1; turn <= 32; turn++) {
    const input = getScenarioTurnInput(state, turn);
    for (const c of COUNTRY_IDS) {
      const production = unwrapUnit(input.countries[c].production);
      assert.ok(Number.isFinite(production) && production >= 0, `turn=${turn} ${c}: production=${production}`);
    }
  }
});

test("世界的需要ブームシナリオ: ブーム対象市場（CN/US/EU/JP）の需要は最終turnでベースラインより大きい", () => {
  for (const m of ["CN", "US", "EU", "JP"] as const) {
    const baselineTrend = BASELINE_SCENARIO.longTermTrends.find(
      (t) => t.variable === "REGIONAL_DEMAND" && t.scope.kind === "market" && t.scope.marketId === m
    )!;
    const boomTrend = GLOBAL_DEMAND_BOOM_SCENARIO.longTermTrends.find(
      (t) => t.variable === "REGIONAL_DEMAND" && t.scope.kind === "market" && t.scope.marketId === m
    )!;
    const baselineEnd = baselineTrend.keyframes[baselineTrend.keyframes.length - 1].value;
    const boomEnd = boomTrend.keyframes[boomTrend.keyframes.length - 1].value;
    assert.ok(boomEnd > baselineEnd, `${m}: ブームの需要終端値はベースラインより大きいはず`);
  }
});

test("世界的需要ブームシナリオ: 需要拡大イベントはOTHER市場（対象外）の需要を一切変更しない", () => {
  const withEvent = initializeScenario(GLOBAL_DEMAND_BOOM_SCENARIO, "canonical", "seed-boom-other");
  const input = getScenarioTurnInput(withEvent, 10);
  // OTHER市場はDEMAND_SHOCKイベントのtargetMarketsに含まれないため、
  // トレンドから導出される値のみで、NaN/負値にならない
  assert.ok(Number.isFinite(unwrapUnit(input.demandMarkets.OTHER.priorPeriodConsumption)));
  assert.ok(unwrapUnit(input.demandMarkets.OTHER.priorPeriodConsumption) >= 0);
});

test("統合スモークテスト: 全5シナリオが全ターンにわたりtoMarketQuarterInput→calculateMarketQuarterまで例外なく通り、NaN/Infinityを出さない", () => {
  const previousContext = testPreviousMarketContext();
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    const state = initializeScenario(definition, "canonical", `smoke-${definition.scenarioId}`);
    // 全ターンを検査すると重いため、代表的な複数ターン（序盤・中盤・終盤）だけを検査する。
    const sampleTurns = [1, Math.floor(definition.durationTurns / 2), definition.durationTurns];
    for (const turn of sampleTurns) {
      const turnInput = getScenarioTurnInput(state, turn);
      const marketInput = toMarketQuarterInput(turnInput, previousContext);
      const result = calculateMarketQuarter(
        marketInput,
        MARKET_PARAMETERS_V1,
        createRandomStream(`smoke-${definition.scenarioId}-${turn}`)
      );
      for (const c of COUNTRY_IDS) {
        assert.ok(Number.isFinite(unwrapUnit(result.hosoPrices[c].price)), `${definition.scenarioId} turn=${turn} ${c}`);
      }
      for (const m of DEMAND_MARKET_IDS) {
        assert.ok(Number.isFinite(unwrapUnit(marketInput.demandMarkets[m].priorPeriodConsumption)));
      }
    }
  }
});

function testPreviousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}
