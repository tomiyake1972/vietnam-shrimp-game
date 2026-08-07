import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateMarketQuarter } from "../index";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { unwrapUnit } from "../../core/units";
import { COUNTRY_IDS } from "../types";
import { baseMarketQuarterInput, scaleAllCountriesProduction } from "./fixtures";

function averagePrice(result: ReturnType<typeof calculateMarketQuarter>): number {
  let sum = 0;
  for (const c of COUNTRY_IDS) sum += unwrapUnit(result.hosoPrices[c].price);
  return sum / COUNTRY_IDS.length;
}

// テスト2: 世界供給不足でHOSO基準価格が上がる
test("世界供給が不足すると、基準となる均衡入力より国別HOSO価格の平均が上がる", () => {
  const balanced = baseMarketQuarterInput();
  const shortage = scaleAllCountriesProduction(balanced, 0.7); // 供給を30%削減

  const balancedResult = calculateMarketQuarter(balanced, MARKET_PARAMETERS_V1, createRandomStream("seed-a"));
  const shortageResult = calculateMarketQuarter(shortage, MARKET_PARAMETERS_V1, createRandomStream("seed-a"));

  assert.ok(shortageResult.worldSupplyDemandBalance > balancedResult.worldSupplyDemandBalance);
  assert.ok(averagePrice(shortageResult) > averagePrice(balancedResult));
  for (const c of COUNTRY_IDS) {
    assert.ok(shortageResult.hosoPrices[c].drivers.includes("GLOBAL_SUPPLY_SHORTAGE"));
  }
});

// テスト3: 世界供給過剰でHOSO基準価格が下がる
test("世界供給が過剰になると、基準となる均衡入力より国別HOSO価格の平均が下がる", () => {
  const balanced = baseMarketQuarterInput();
  const surplus = scaleAllCountriesProduction(balanced, 1.3); // 供給を30%増加

  const balancedResult = calculateMarketQuarter(balanced, MARKET_PARAMETERS_V1, createRandomStream("seed-b"));
  const surplusResult = calculateMarketQuarter(surplus, MARKET_PARAMETERS_V1, createRandomStream("seed-b"));

  assert.ok(surplusResult.worldSupplyDemandBalance < balancedResult.worldSupplyDemandBalance);
  assert.ok(averagePrice(surplusResult) < averagePrice(balancedResult));
  for (const c of COUNTRY_IDS) {
    assert.ok(surplusResult.hosoPrices[c].drivers.includes("GLOBAL_SUPPLY_SURPLUS"));
  }
});

test("均衡入力では価格変化率が上限にほぼ張り付かない（基準点として妥当）", () => {
  const balanced = baseMarketQuarterInput();
  const result = calculateMarketQuarter(balanced, MARKET_PARAMETERS_V1, createRandomStream("seed-c"));
  for (const c of COUNTRY_IDS) {
    assert.ok(Math.abs(result.hosoPrices[c].changeRatio) < MARKET_PARAMETERS_V1.maxQuarterlyPriceChangeRatio);
  }
});

test("価格変化率が上限を超える入力では、PRICE_CHANGE_CAPPEDが付与され上限で頭打ちになる", () => {
  const extreme = scaleAllCountriesProduction(baseMarketQuarterInput(), 0.2);
  const result = calculateMarketQuarter(extreme, MARKET_PARAMETERS_V1, createRandomStream("seed-d"));
  for (const c of COUNTRY_IDS) {
    assert.ok(result.hosoPrices[c].drivers.includes("PRICE_CHANGE_CAPPED"));
    assert.ok(
      Math.abs(result.hosoPrices[c].changeRatio) <= MARKET_PARAMETERS_V1.maxQuarterlyPriceChangeRatio + 1e-9
    );
  }
});

test("養殖コスト指数の上昇はHOSO価格を押し上げる方向に働く", () => {
  const base = baseMarketQuarterInput();
  const costUp = {
    ...base,
    countries: {
      ...base.countries,
      EC: { ...base.countries.EC, aquacultureCostIndex: 1.3, priorAquacultureCostIndex: 1.0 },
    },
  };
  const baseResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-e"));
  const costUpResult = calculateMarketQuarter(costUp, MARKET_PARAMETERS_V1, createRandomStream("seed-e"));
  assert.ok(unwrapUnit(costUpResult.hosoPrices.EC.price) > unwrapUnit(baseResult.hosoPrices.EC.price));
});
