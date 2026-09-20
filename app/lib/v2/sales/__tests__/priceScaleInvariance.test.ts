// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: 価格スケールに関する不変性・単調性
//
// 【前提として明示する事実】提示価格は
//   askPrice = basePrice + priceAdjustmentUsdPerHosoEqKg（固定USD/kg）
// であり、tiered / legacy のどちらの価格評価も相対価格
//   (askPrice − basePrice) / basePrice = priceAdjustment / basePrice
// にしか依存しない（tieredAllocation.ts の priceComponent・reservationExcess、
// allocation.ts の priceScore）。
// したがって「basePriceだけを動かす」と相対価格差が変わるため weight は変わる。
// 不変になるのは「basePriceと全社のpriceAdjustmentを同率で動かした」場合だけである。

import test from "node:test";
import assert from "node:assert/strict";

import { allocateMarketProductTiered } from "../tieredAllocation";
import { allocateMarketProduct } from "../allocation";
import { SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1, SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../../core/units";
import { period } from "../../core/period";

const MARKET = "JP" as const;
const PRODUCT = "vap" as const;
const PERIOD = period(2015, 3);
const TARGET_DEMAND = hosoEqTons(10_000);

function entries(adjustments: Readonly<Record<string, number>>): CompanySalesPlanEntry[] {
  return Object.entries(adjustments).map(([companyId, adj]) => ({
    companyId,
    market: MARKET,
    product: PRODUCT,
    desiredQuantity: hosoEqTons(5_000),
    priceAdjustmentUsdPerHosoEqKg: adj,
    salesForceHeadcount: 10,
  }));
}

const BASE_ADJUSTMENTS = { AAA: -0.2, BBB: 0.0, CCC: 0.3 } as const;

function tieredWeights(basePrice: number, adjustments: Readonly<Record<string, number>>): Record<string, number> {
  const out = allocateMarketProductTiered({
    market: MARKET,
    product: PRODUCT,
    period: PERIOD,
    entries: entries(adjustments),
    basePrice: usdPerHosoEqKg(basePrice),
    targetDemand: TARGET_DEMAND,
    params: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  });
  const weights: Record<string, number> = {};
  for (const tier of out.diagnostics.tiers) {
    for (const c of tier.companies) {
      weights[`${tier.tier}::${c.companyId}`] = c.normalizedWeight;
    }
    weights[`${tier.tier}::__external__`] = tier.external.normalizedWeight;
  }
  return weights;
}

function tieredQuantities(basePrice: number, adjustments: Readonly<Record<string, number>>): Record<string, number> {
  const out = allocateMarketProductTiered({
    market: MARKET,
    product: PRODUCT,
    period: PERIOD,
    entries: entries(adjustments),
    basePrice: usdPerHosoEqKg(basePrice),
    targetDemand: TARGET_DEMAND,
    params: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  });
  const q: Record<string, number> = {};
  for (const c of out.result.companies) q[c.companyId] = unwrapUnit(c.allocatedQuantity);
  return q;
}

function legacyPriceScores(basePrice: number, adjustments: Readonly<Record<string, number>>): Record<string, number> {
  const result = allocateMarketProduct(
    MARKET,
    PRODUCT,
    PERIOD,
    entries(adjustments),
    usdPerHosoEqKg(basePrice),
    TARGET_DEMAND,
    SALES_PARAMETERS_V1
  );
  const scores: Record<string, number> = {};
  for (const c of result.companies) scores[c.companyId] = c.competitivenessWeight;
  return scores;
}

// ---------------------------------------------------------------- T-8a 単調性
test("PRICE-8a-tiered: 同一basePriceで値上げすると、その会社のweightと成約量は増加しない", () => {
  const base = 9.0;
  const lower = tieredQuantities(base, { ...BASE_ADJUSTMENTS, BBB: 0.0 });
  const higher = tieredQuantities(base, { ...BASE_ADJUSTMENTS, BBB: 0.5 });
  assert.ok(higher.BBB <= lower.BBB + 1e-9, `BBB ${higher.BBB} <= ${lower.BBB}`);

  const wLower = tieredWeights(base, { ...BASE_ADJUSTMENTS, BBB: 0.0 });
  const wHigher = tieredWeights(base, { ...BASE_ADJUSTMENTS, BBB: 0.5 });
  for (const key of Object.keys(wLower)) {
    if (!key.endsWith("::BBB")) continue;
    assert.ok(wHigher[key] <= wLower[key] + 1e-12, `${key}: ${wHigher[key]} <= ${wLower[key]}`);
  }
});

test("PRICE-8a-legacy: legacyでも値上げでcompetitivenessWeightが増加しない（clamp域では不変を許容）", () => {
  const base = 9.0;
  const lower = legacyPriceScores(base, { ...BASE_ADJUSTMENTS, BBB: 0.0 });
  const higher = legacyPriceScores(base, { ...BASE_ADJUSTMENTS, BBB: 0.5 });
  // 厳密減少は要求しない（priceScore が min/max へ張り付く領域では不変が正しい）。
  assert.ok(higher.BBB <= lower.BBB + 1e-12, `${higher.BBB} <= ${lower.BBB}`);
});

// ------------------------------------------------------------- T-8b 不変性
test("PRICE-8b-tiered: basePriceと全社priceAdjustmentを同率で拡大するとnormalized weightが一致", () => {
  const base = 6.0;
  const k = 1.5;
  const scaled = Object.fromEntries(Object.entries(BASE_ADJUSTMENTS).map(([id, v]) => [id, v * k]));
  const a = tieredWeights(base, BASE_ADJUSTMENTS);
  const b = tieredWeights(base * k, scaled);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const key of Object.keys(a)) {
    assert.ok(Math.abs(a[key] - b[key]) < 1e-12, `${key}: ${a[key]} vs ${b[key]}`);
  }
});

test("PRICE-8b-legacy: legacyでも同率拡大でcompetitivenessWeightが一致", () => {
  const base = 6.0;
  const k = 1.5;
  const scaled = Object.fromEntries(Object.entries(BASE_ADJUSTMENTS).map(([id, v]) => [id, v * k]));
  const a = legacyPriceScores(base, BASE_ADJUSTMENTS);
  const b = legacyPriceScores(base * k, scaled);
  for (const key of Object.keys(a)) {
    assert.ok(Math.abs(a[key] - b[key]) < 1e-12, `${key}: ${a[key]} vs ${b[key]}`);
  }
});

// ------------------------------------------------- T-8c basePriceのみ動かす
test("PRICE-8c-tiered: basePriceだけ動かすと相対価格差が縮まりweightが変わる（正常挙動）", () => {
  const a = tieredWeights(6.0, BASE_ADJUSTMENTS);
  const b = tieredWeights(12.0, BASE_ADJUSTMENTS);
  const changed = Object.keys(a).some((key) => Math.abs(a[key] - b[key]) > 1e-9);
  assert.ok(changed, "固定USD/kgの価格調整を据え置いてbasePriceだけ上げれば、相対価格差は縮まりweightは変わる");
});

test("PRICE-8c-legacy: legacyでもbasePriceだけ動かすとweightが変わる", () => {
  const a = legacyPriceScores(6.0, BASE_ADJUSTMENTS);
  const b = legacyPriceScores(12.0, BASE_ADJUSTMENTS);
  const changed = Object.keys(a).some((key) => Math.abs(a[key] - b[key]) > 1e-9);
  assert.ok(changed);
});

// ----------------------------------------------------------- 許容レンジ判定
test("PRICE-8d-legacy: askPrice許容レンジ判定は比率のためスケール不変", () => {
  const k = 3.0;
  const adjustments = { AAA: -0.2, BBB: 0.0, CCC: 0.3 };
  const scaled = Object.fromEntries(Object.entries(adjustments).map(([id, v]) => [id, v * k]));
  assert.doesNotThrow(() => legacyPriceScores(6.0, adjustments));
  assert.doesNotThrow(() => legacyPriceScores(6.0 * k, scaled));
});
