// ShrimpX V2 — TIERED-MKT-P1D-2 §3 market×product 15セル demandShare の固定
//
// #04 が回収・確定した Phase 1B calibrated candidate を、指定表と1セルずつ突き合わせる。
// （V2.00 calibrated candidate であり最終固定値ではない。）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, score0to100, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../market/types";
import { allocateMarketProductTiered, resolveTierParameters } from "../tieredAllocation";
import {
  CUSTOMER_TIER_IDS,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1,
  US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1,
  qualitySensitivityCalibrationFactorFor,
} from "../parameters";
import { CompanySalesPlanEntry } from "../types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 実装指示 TIERED-MKT-P1D-2 §1 の表（PRICE_SENSITIVE / STANDARD / PREMIUM）。 */
const SPEC: Readonly<Record<DemandMarketId, Readonly<Record<Product, readonly [number, number, number]>>>> = {
  CN: { hoso: [0.55, 0.35, 0.1], pd: [0.6, 0.3, 0.1], vap: [0.45, 0.4, 0.15] },
  JP: { hoso: [0.1, 0.45, 0.45], pd: [0.15, 0.45, 0.4], vap: [0.1, 0.4, 0.5] },
  US: { hoso: [0.5, 0.4, 0.1], pd: [0.35, 0.45, 0.2], vap: [0.15, 0.45, 0.4] },
  EU: { hoso: [0.15, 0.5, 0.35], pd: [0.2, 0.45, 0.35], vap: [0.15, 0.4, 0.45] },
  OTHER: { hoso: [0.45, 0.42, 0.13], pd: [0.35, 0.45, 0.2], vap: [0.25, 0.45, 0.3] },
};

const PARAMS = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1;

// =====================================================================

test("P1D2-CELL-1: 15セルの demandShare が指定表と完全一致", () => {
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(PARAMS, market, product);
      const expected = SPEC[market][product];
      CUSTOMER_TIER_IDS.forEach((tierId, i) => {
        assert.equal(tiers[tierId].demandShare, expected[i], `${market}/${product}/${tierId}: ${tiers[tierId].demandShare} != ${expected[i]}`);
      });
    }
  }
});

test("P1D2-CELL-2: 15セルすべてで合計 = 1（誤差 1e-9 以内）", () => {
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(PARAMS, market, product);
      const sum = CUSTOMER_TIER_IDS.reduce((s, t) => s + tiers[t].demandShare, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-9, `${market}/${product}: ${sum}`);
    }
  }
});

test("P1D2-CELL-3: override は正しいセルにだけ適用される（base placeholder は到達しない）", () => {
  // 15セルすべてが override 由来。base の demandShare（0.4/0.4/0.2）が残るセルは無い。
  const base = PARAMS.tiers;
  let cellsDifferingFromBase = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(PARAMS, market, product);
      const sameAsBase = CUSTOMER_TIER_IDS.every((t) => tiers[t].demandShare === base[t].demandShare);
      if (!sameAsBase) cellsDifferingFromBase += 1;
    }
  }
  assert.equal(cellsDifferingFromBase, 15, "全15セルが 15セル表由来になっていない");
  // qualitySensitivity の override は US/EU VAP factor と anchor calibration factor の積。
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(PARAMS, market, product);
      const usEuVapFactor = (market === "US" || market === "EU") && product === "vap" ? US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1 : 1;
      const factor = usEuVapFactor * qualitySensitivityCalibrationFactorFor(market, product);
      for (const t of CUSTOMER_TIER_IDS) {
        assert.ok(Math.abs(tiers[t].qualitySensitivity - base[t].qualitySensitivity * factor) < 1e-12, `${market}/${product}/${t}`);
        // demandShare / qualitySensitivity 以外は override していない。
        assert.equal(tiers[t].priceSensitivity, base[t].priceSensitivity);
        assert.equal(tiers[t].differentiationSensitivity, base[t].differentiationSensitivity);
        assert.equal(tiers[t].nonPriceSensitivity, base[t].nonPriceSensitivity);
        assert.equal(tiers[t].reservationPriceMultiplier, base[t].reservationPriceMultiplier);
        assert.equal(tiers[t].reservationSoftPenaltySlope, base[t].reservationSoftPenaltySlope);
        assert.equal(tiers[t].externalOptionBaseUtility, base[t].externalOptionBaseUtility);
      }
    }
  }
});

test("P1D2-CELL-4: overrides の適用は入力順に依存しない（順序を入れ替えても同一）", () => {
  const shuffled = { ...PARAMS, overrides: [...(PARAMS.overrides ?? [])].reverse() };
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      assert.deepEqual(resolveTierParameters(shuffled, market, product), resolveTierParameters(PARAMS, market, product));
    }
  }
});

test("P1D2-CELL-5: 15セルの配分が実際に走り、層需要が指定比率で分割される", () => {
  const ids = ["CO-A", "CO-B", "CO-C", "CO-D", "CO-E"];
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const entries: CompanySalesPlanEntry[] = ids.map((companyId) => ({
        companyId,
        market,
        product,
        desiredQuantity: hosoEqTons(1_000_000),
        priceAdjustmentUsdPerHosoEqKg: 0,
        salesForceHeadcount: 20,
        qualityReputation: score0to100(70),
        customerRelationship: score0to100(60),
        deliveryReliability: score0to100(60),
        salesBaseScore: score0to100(50),
        ...(product === "vap" ? { vapCapabilityScore: score0to100(50) } : {}),
      }));
      const out = allocateMarketProductTiered({
        market,
        product,
        period: period(2020, 1),
        entries,
        basePrice: usdPerHosoEqKg(4),
        targetDemand: hosoEqTons(10_000),
        params: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
      });
      const expected = SPEC[market][product];
      CUSTOMER_TIER_IDS.forEach((tierId, i) => {
        const t = out.diagnostics.tiers.find((x) => x.tier === tierId)!;
        assert.equal(t.tierShare, expected[i], `${market}/${product}/${tierId} tierShare`);
        assert.ok(Math.abs(t.tierDemand - 10_000 * expected[i]) < 1e-9, `${market}/${product}/${tierId} tierDemand`);
      });
      assert.ok(Math.abs(out.diagnostics.demandConservationResidual) < 1e-6, `${market}/${product} 需要保存`);
    }
  }
});
