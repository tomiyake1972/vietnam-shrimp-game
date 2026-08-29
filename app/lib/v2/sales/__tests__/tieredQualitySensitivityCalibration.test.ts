// ShrimpX V2 — TIERED-MKT-P1D-3 §12 qualitySensitivity anchor calibration
//
// 品質設備 direct bonus（full ramp +4 point）は変更していない。ここで固定するのは
// 「qualityReputation の差を顧客がどの程度 価格 premium として評価するか」＝
// qualitySensitivity の market×product 別校正係数。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, score0to100, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../market/types";
import { allocateMarketProduct } from "../allocation";
import { allocateMarketProductTiered, resolveTierParameters } from "../tieredAllocation";
import {
  CUSTOMER_TIER_IDS,
  QUALITY_SENSITIVITY_CALIBRATION_V200_CANDIDATE_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1,
  US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1,
  qualitySensitivityCalibrationFactorFor,
} from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS } from "../../companyLab/qualityEquipmentMarketBonus";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const P = period(2020, 1);
const IDS = ["CO-A", "CO-B", "CO-C", "CO-D", "CO-E"];
const T = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1;

/** 指示 §3 の anchor multiplier。 */
const ANCHOR_SPEC: Array<[DemandMarketId, Product, number]> = [
  ["CN", "hoso", 2.5],
  ["JP", "vap", 3.9],
  ["US", "vap", 4.2],
  ["EU", "vap", 3.8],
];

function entries(market: DemandMarketId, product: Product, qualityA: number, priceAdjA: number): CompanySalesPlanEntry[] {
  return IDS.map((companyId, i) => ({
    companyId,
    market,
    product,
    desiredQuantity: hosoEqTons(1e9),
    priceAdjustmentUsdPerHosoEqKg: i === 0 ? priceAdjA : 0,
    salesForceHeadcount: 20,
    qualityReputation: score0to100(i === 0 ? qualityA : 70),
    customerRelationship: score0to100(60),
    deliveryReliability: score0to100(60),
    salesBaseScore: score0to100(50),
    ...(product === "vap" ? { vapCapabilityScore: score0to100(50) } : {}),
  }));
}

function weightA(market: DemandMarketId, product: Product, qualityA: number, priceAdjA: number): number {
  const out = allocateMarketProductTiered({
    market,
    product,
    period: P,
    entries: entries(market, product, qualityA, priceAdjA),
    basePrice: usdPerHosoEqKg(6),
    targetDemand: hosoEqTons(10_000),
    params: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  });
  return out.result.companies.find((c) => c.companyId === "CO-A")!.competitivenessWeight;
}

// =====================================================================

test("P1D3-QS-1: 4 anchor cell の calibration multiplier が指定値", () => {
  for (const [market, product, expected] of ANCHOR_SPEC) {
    assert.equal(
      qualitySensitivityCalibrationFactorFor(market, product),
      expected,
      `${market}/${product}: ${qualitySensitivityCalibrationFactorFor(market, product)} != ${expected}`
    );
  }
  // 表そのものが 4セルだけを持つ。
  const cells = Object.entries(QUALITY_SENSITIVITY_CALIBRATION_V200_CANDIDATE_V1).flatMap(([m, byProduct]) =>
    Object.keys(byProduct).map((p) => `${m}/${p}`)
  );
  assert.deepEqual(cells.sort(), ["CN/hoso", "EU/vap", "JP/vap", "US/vap"]);
});

test("P1D3-QS-2: 非 anchor の 11セルは 1.0（未校正）", () => {
  let nonAnchor = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const isAnchor = ANCHOR_SPEC.some(([m, p]) => m === market && p === product);
      if (isAnchor) continue;
      nonAnchor += 1;
      assert.equal(qualitySensitivityCalibrationFactorFor(market, product), 1, `${market}/${product} が 1.0 でない`);
    }
  }
  assert.equal(nonAnchor, 11);
});

test("P1D3-QS-3: US/EU VAP は 0.60 と anchor multiplier の両方が掛かる", () => {
  const f = US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1;
  assert.equal(f, 0.6);
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(T, market, product);
      const usEuVapFactor = (market === "US" || market === "EU") && product === "vap" ? f : 1;
      const expectFactor = usEuVapFactor * qualitySensitivityCalibrationFactorFor(market, product);
      for (const t of CUSTOMER_TIER_IDS) {
        assert.ok(
          Math.abs(tiers[t].qualitySensitivity - T.tiers[t].qualitySensitivity * expectFactor) < 1e-12,
          `${market}/${product}/${t}: ${tiers[t].qualitySensitivity}`
        );
      }
    }
  }
  // 実効値の確認（0.60 が消えていない・anchor に吸収されていない）。
  const us = resolveTierParameters(T, "US", "vap");
  assert.ok(Math.abs(us.PREMIUM.qualitySensitivity - 2.4 * 0.6 * 4.2) < 1e-12, `US/vap PREMIUM = ${us.PREMIUM.qualitySensitivity}`);
  const jp = resolveTierParameters(T, "JP", "vap");
  assert.ok(Math.abs(jp.PREMIUM.qualitySensitivity - 2.4 * 3.9) < 1e-12, "JP/vap に US/EU factor が掛かってしまっている");
  const cn = resolveTierParameters(T, "CN", "hoso");
  assert.ok(Math.abs(cn.PREMIUM.qualitySensitivity - 2.4 * 2.5) < 1e-12, "CN/hoso に US/EU factor が掛かってしまっている");
});

test("P1D3-QS-4: quality 上昇で normalized weight が単調増加（全15セル）", () => {
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      let prev = -Infinity;
      for (const q of [50, 60, 70, 80, 90]) {
        const w = weightA(market, product, q, 0);
        assert.ok(w > prev, `${market}/${product} quality=${q}: ${w} が単調増加でない（前=${prev}）`);
        prev = w;
      }
      // 単一社が需要を独占しない（外部選択肢と他4社が残る）。
      assert.ok(prev < 1, `${market}/${product}: quality90 の weight が 1 に達している`);
    }
  }
});

test("P1D3-QS-5: 価格上昇で normalized weight が単調低下（quality 50 / 70 / 90 のいずれでも）", () => {
  for (const [market, product] of ANCHOR_SPEC.map(([m, p]) => [m, p] as [DemandMarketId, Product])) {
    for (const q of [50, 70, 90]) {
      let prev = Infinity;
      for (const adj of [-2, -1, 0, 0.5, 1, 2]) {
        const w = weightA(market, product, q, adj);
        assert.ok(w < prev, `${market}/${product} q=${q} adj=${adj}: ${w} が単調低下でない（前=${prev}）`);
        prev = w;
      }
    }
  }
});

test("P1D3-QS-6: quality 設備 direct bonus は +4 のまま（本Phaseで変更していない）", () => {
  assert.equal(EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS, 4);
});

test("P1D3-QS-7: legacy allocation は calibration 表の影響を受けない", () => {
  // 本番 SalesParameters は marketAllocationMode を持たない。
  assert.equal(SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1.marketAllocationMode, undefined);
  assert.equal(SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1.tieredMarketAllocation, undefined);
  // tiered 設定を持たせても mode 未指定なら legacy 経路のまま＝結果は完全一致。
  const withTieredButLegacyMode = {
    ...SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
    tieredMarketAllocation: T,
  };
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const plans = entries(market, product, 90, 0);
      const a = allocateMarketProduct(market, product, P, plans, usdPerHosoEqKg(6), hosoEqTons(10_000), SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1);
      const b = allocateMarketProduct(market, product, P, plans, usdPerHosoEqKg(6), hosoEqTons(10_000), withTieredButLegacyMode);
      assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), `${market}/${product}`);
    }
  }
});
