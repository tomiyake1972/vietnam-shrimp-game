import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFinite, clamp, safeDivide } from "../validation";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { COUNTRY_IDS } from "../types";

test("assertFiniteはNaN/Infinityを拒否する", () => {
  assert.throws(() => assertFinite(NaN, "x"));
  assert.throws(() => assertFinite(Infinity, "x"));
  assert.throws(() => assertFinite(-Infinity, "x"));
  assert.doesNotThrow(() => assertFinite(1.5, "x"));
});

test("clampは範囲内に値を収める", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test("clampはmin>maxで例外", () => {
  assert.throws(() => clamp(1, 10, 0));
});

test("safeDivideはゼロに近い分母でも無限大にならない", () => {
  const result = safeDivide(10, 0);
  assert.ok(Number.isFinite(result));
});

test("MARKET_PARAMETERS_V1の世界影響度ウェイトの合計は1.0に近い", () => {
  const sum = COUNTRY_IDS.reduce((acc, c) => acc + MARKET_PARAMETERS_V1.worldInfluenceWeight[c], 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

test("MARKET_PARAMETERS_V1のlocalPressureWeight + worldPressureWeight = 1.0", () => {
  const sum = MARKET_PARAMETERS_V1.localPressureWeight + MARKET_PARAMETERS_V1.worldPressureWeight;
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

test("MARKET_PARAMETERS_V1のsupplyDemandPressureWeight + costPressureWeight = 1.0", () => {
  const sum = MARKET_PARAMETERS_V1.supplyDemandPressureWeight + MARKET_PARAMETERS_V1.costPressureWeight;
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

test("MARKET_PARAMETERS_V1の初期HOSO価格は4か国すべてに定義され正の値である", () => {
  for (const c of COUNTRY_IDS) {
    assert.ok(MARKET_PARAMETERS_V1.initialHosoFobPriceUsdPerKg[c] > 0);
  }
});
