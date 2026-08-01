// ShrimpX V2 — Test15新設: calculateCompanyCapabilityCoefficient（VAP能力合成係数）テスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { score0to100 } from "../../core/units";
import { calculateCompanyCapabilityCoefficient, VAP_CAPABILITY_WEIGHTS_V1 } from "../premiumPolicy";

test("VCC-1: すべての入力が未接続のとき、中立値50を返す", () => {
  assert.ok(Math.abs(calculateCompanyCapabilityCoefficient({}) - 50) < 1e-9);
});

test("VCC-2: すべての入力が同じ値のとき、その値をそのまま返す（加重平均の性質）", () => {
  const v = score0to100(80);
  const coefficient = calculateCompanyCapabilityCoefficient({
    productDevelopmentScore: v,
    salesBaseScore: v,
    qualityScore: v,
    deliveryReliabilityScore: v,
  });
  assert.ok(Math.abs(coefficient - 80) < 1e-9, `実際: ${coefficient}`);
});

test("VCC-3: ウェイトどおりの加重平均になる（productDevelopment重視、他は中立50のまま）", () => {
  const coefficient = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(100) });
  const w = VAP_CAPABILITY_WEIGHTS_V1;
  const expected = (w.productDevelopment * 100 + w.salesBase * 50 + w.quality * 50 + w.deliveryReliability * 50) / (w.productDevelopment + w.salesBase + w.quality + w.deliveryReliability);
  assert.ok(Math.abs(coefficient - expected) < 1e-9, `実際: ${coefficient}, 期待: ${expected}`);
});

test("VCC-4: 結果は常に[0,100]の範囲に収まる", () => {
  const high = calculateCompanyCapabilityCoefficient({
    productDevelopmentScore: score0to100(100),
    salesBaseScore: score0to100(100),
    qualityScore: score0to100(100),
    deliveryReliabilityScore: score0to100(100),
  });
  const low = calculateCompanyCapabilityCoefficient({
    productDevelopmentScore: score0to100(0),
    salesBaseScore: score0to100(0),
    qualityScore: score0to100(0),
    deliveryReliabilityScore: score0to100(0),
  });
  assert.ok(Math.abs(high - 100) < 1e-9);
  assert.ok(Math.abs(low - 0) < 1e-9);
});

test("VCC-5: VAP商品開発スコアが高いほど、合成係数も単調に高くなる（他の入力を固定）", () => {
  const low = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(20), salesBaseScore: score0to100(50), qualityScore: score0to100(50), deliveryReliabilityScore: score0to100(50) });
  const high = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(90), salesBaseScore: score0to100(50), qualityScore: score0to100(50), deliveryReliabilityScore: score0to100(50) });
  assert.ok(high > low, `high(${high}) should exceed low(${low})`);
});
