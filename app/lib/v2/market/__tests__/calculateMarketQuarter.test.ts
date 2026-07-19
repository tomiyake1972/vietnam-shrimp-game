import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateMarketQuarter } from "../index";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { unwrapUnit, hosoEqTons } from "../../core/units";
import { COUNTRY_IDS } from "../types";
import { baseMarketQuarterInput, scaleAllCountriesProduction } from "./fixtures";

// テスト1: 同じ入力・同じシードなら常に同じ結果になる
test("同じ入力・同じシードのRandomStreamからは常に同じ結果になる", () => {
  const input = baseMarketQuarterInput();
  const resultA = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("deterministic-seed"));
  const resultB = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("deterministic-seed"));
  assert.deepEqual(JSON.parse(JSON.stringify(resultA)), JSON.parse(JSON.stringify(resultB)));
});

test("異なるシードからは異なる結果になる（少なくとも1国の価格が異なる）", () => {
  const input = baseMarketQuarterInput();
  const resultA = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("seed-x"));
  const resultB = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("seed-y"));
  const anyDifferent = COUNTRY_IDS.some(
    (c) => unwrapUnit(resultA.hosoPrices[c].price) !== unwrapUnit(resultB.hosoPrices[c].price)
  );
  assert.ok(anyDifferent);
});

// テスト10: 入力オブジェクトを破壊的に変更しない
test("calculateMarketQuarterはinput・parametersを一切変更しない", () => {
  const input = baseMarketQuarterInput();
  const inputSnapshot = JSON.parse(JSON.stringify(input));
  const parametersSnapshot = JSON.parse(JSON.stringify(MARKET_PARAMETERS_V1));

  calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("mutation-check"));

  assert.deepEqual(JSON.parse(JSON.stringify(input)), inputSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(MARKET_PARAMETERS_V1)), parametersSnapshot);
});

// テスト11: NaN、Infinity、負の数量、定義外の価格を出力しない
test("出力にNaN・Infinityが含まれない（極端な入力でも）", () => {
  const extremeInputs = [
    scaleAllCountriesProduction(baseMarketQuarterInput(), 0.01), // ほぼゼロ供給
    scaleAllCountriesProduction(baseMarketQuarterInput(), 10), // 極端な供給過剰
  ];
  for (const input of extremeInputs) {
    const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("extreme-seed"));
    assertNoNaNOrInfinity(result, "result");
  }
});

test("国内原料供給がゼロに近くてもゼロ割りで例外にならず、有限な結果を返す", () => {
  const input = {
    ...baseMarketQuarterInput(),
    vietnamDomestic: {
      ...baseMarketQuarterInput().vietnamDomestic,
      domesticRawSupply: hosoEqTons(0.0001),
    },
  };
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("near-zero-supply"));
  assertNoNaNOrInfinity(result, "result");
  assert.ok(unwrapUnit(result.vietnamDomestic.price) >= 0);
});

test("出力価格・数量はすべて非負である", () => {
  const input = baseMarketQuarterInput();
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("non-negative-check"));
  for (const c of COUNTRY_IDS) {
    assert.ok(unwrapUnit(result.hosoPrices[c].price) > 0);
    assert.ok(unwrapUnit(result.hosoPrices[c].exportableSupply) >= 0);
    assert.ok(unwrapUnit(result.hosoPrices[c].allocatedDemand) >= 0);
    assert.ok(unwrapUnit(result.pdPremium.byCountry[c].finalPrice) > 0);
    assert.ok(unwrapUnit(result.vapPremium.byCountry[c].finalPrice) > 0);
  }
  assert.ok(unwrapUnit(result.vietnamDomestic.price) > 0);
  assert.ok(unwrapUnit(result.worldSupply) >= 0);
  assert.ok(unwrapUnit(result.worldDemand) >= 0);
});

// テスト12: すべての価格・数量に単位型を使う（branded typeであることをランタイムでも
// 間接的に確認する: スマートコンストラクタを経由しない生のnumberを直接代入すると
// TypeScriptの型チェックで弾かれるため、ここではhosoPrices.price等がunwrapUnit()を
// 通さないと使えない=branded typeであることを、コンパイルが通ること自体で保証する。
// 加えて、ランタイムでも「有限な正の数値」であることを検証する）。
test("価格・数量フィールドはbranded typeのスマートコンストラクタ経由の値である", () => {
  const input = baseMarketQuarterInput();
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream("unit-type-check"));
  // unwrapUnitはbranded typeにしか適用できない（コンパイル時に強制される）。
  const price: number = unwrapUnit(result.hosoPrices.VN.price);
  const supply: number = unwrapUnit(result.worldSupply);
  assert.ok(Number.isFinite(price) && price > 0);
  assert.ok(Number.isFinite(supply) && supply >= 0);
});

function assertNoNaNOrInfinity(value: unknown, path: string): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限数ではありません: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoNaNOrInfinity(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      assertNoNaNOrInfinity(v, `${path}.${key}`);
    }
  }
}
