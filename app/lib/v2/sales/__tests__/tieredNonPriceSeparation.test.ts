// ShrimpX V2 — TIERED-MKT-P1D §19 nonPrice 三要素分離の必須不変条件
//
// 【§6 必須不変条件】同一入力・同一旧係数なら、
//   旧式 nonPriceSensitivity × (平均(relationship, delivery, salesBase) − 0.5)
// と
//   新3要素式 Σ (s/3) × (各要素 − 0.5)
// で utility / normalized weight / unconstrained allocation / final allocation /
// external allocation が一致する（浮動小数点差 1e-12 以内）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../core/units";
import { allocateMarketProductTiered, computeTierUtility, resolveNonPriceSensitivities } from "../tieredAllocation";
import {
  CUSTOMER_TIER_IDS,
  CustomerTierParameters,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  SalesParameters,
  TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1,
} from "../parameters";
import {
  FIXTURE_MARKET,
  FIXTURE_PERIOD,
  FIXTURE_PRODUCT,
  FIXTURE_REFERENCE_PRICE,
  FIXTURE_TARGET_DEMAND,
  FixtureCompanySpec,
  buildEntries,
  buildSalesCapacityMap,
  symmetricCompanySpecs,
} from "./tieredMarketAllocationFixture";

const TOL = 1e-12;

/** 非対称な検証入力（3要素が互いに異なる値を持つ＝平均式と分離式の差が出る形）。 */
function asymmetricSpecs(): FixtureCompanySpec[] {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: -0.4, quality: 82, relationship: 90, deliveryReliability: 30, salesBase: 65 };
  specs[1] = { ...specs[1], priceAdjustment: 0.6, quality: 44, relationship: 20, deliveryReliability: 88, salesBase: 51 };
  specs[2] = { ...specs[2], priceAdjustment: 0.1, quality: 61, relationship: 55, deliveryReliability: 55, salesBase: 95 };
  return specs;
}

function withExplicitThirds(params: SalesParameters): SalesParameters {
  const t = params.tieredMarketAllocation!;
  const tiers = { ...t.tiers } as Record<string, CustomerTierParameters>;
  for (const id of CUSTOMER_TIER_IDS) {
    const third = t.tiers[id].nonPriceSensitivity / 3;
    tiers[id] = { ...t.tiers[id], relationshipSensitivity: third, deliverySensitivity: third, salesBaseSensitivity: third };
  }
  return {
    ...params,
    tieredMarketAllocation: { ...t, tiers: tiers as never },
  };
}

function run(specs: readonly FixtureCompanySpec[], params: SalesParameters) {
  return allocateMarketProductTiered({
    market: FIXTURE_MARKET,
    product: FIXTURE_PRODUCT,
    period: FIXTURE_PERIOD,
    entries: buildEntries(specs),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params,
    salesCapacityByCompanyMarket: buildSalesCapacityMap(specs),
  });
}

/** 旧式（3要素の単純平均 × nonPriceSensitivity）で utility を再計算する参照実装。 */
function legacyNonPriceUtility(
  askPrice: number,
  ref: number,
  scores: { quality: number; relationship: number; delivery: number; salesBase: number; differentiation: number },
  tier: CustomerTierParameters,
  clamp: number
): number {
  const priceComponent = -tier.priceSensitivity * ((askPrice - ref) / ref);
  const qualityComponent = tier.qualitySensitivity * (scores.quality - 0.5);
  const diffComponent = tier.differentiationSensitivity * (scores.differentiation - 0.5);
  const nonPrice = (scores.relationship + scores.delivery + scores.salesBase) / 3;
  const nonPriceComponent = tier.nonPriceSensitivity * (nonPrice - 0.5);
  const reservationPrice = ref * tier.reservationPriceMultiplier;
  const excess = Math.max(0, (askPrice - reservationPrice) / ref);
  const penalty = -tier.reservationSoftPenaltySlope * excess * excess;
  const raw = priceComponent + qualityComponent + diffComponent + nonPriceComponent + penalty;
  return Math.min(clamp, Math.max(-clamp, raw));
}

// =====================================================================

test("P1D-NP-1: 旧平均式と新3要素式の utility が一致（1e-12以内）", () => {
  const ref = unwrapUnit(FIXTURE_REFERENCE_PRICE);
  const clamp = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.utilityClamp;
  for (const spec of asymmetricSpecs()) {
    const scores = {
      quality: spec.quality / 100,
      differentiation: 0.5, // HOSO は中立固定
      relationship: spec.relationship / 100,
      delivery: spec.deliveryReliability / 100,
      salesBase: spec.salesBase / 100,
    };
    for (const id of CUSTOMER_TIER_IDS) {
      const tier = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers[id];
      const now = computeTierUtility(ref + spec.priceAdjustment, ref, scores, tier, clamp);
      const legacy = legacyNonPriceUtility(ref + spec.priceAdjustment, ref, scores, tier, clamp);
      assert.ok(Math.abs(now.utility - legacy) <= TOL, `${spec.companyId}/${id}: ${now.utility} vs ${legacy}`);
      // 集約値の定義（§5）
      assert.ok(
        Math.abs(now.nonPriceComponent - (now.relationshipComponent + now.deliveryComponent + now.salesBaseComponent)) <= TOL
      );
    }
  }
});

test("P1D-NP-2: normalized weight が一致（明示3等分 vs fallback）", () => {
  const specs = asymmetricSpecs();
  const a = run(specs, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1);
  const b = run(specs, withExplicitThirds(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1));
  for (const s of specs) {
    const wa = a.result.companies.find((c) => c.companyId === s.companyId)!.competitivenessWeight;
    const wb = b.result.companies.find((c) => c.companyId === s.companyId)!.competitivenessWeight;
    assert.ok(Math.abs(wa - wb) <= TOL, `${s.companyId}: ${wa} vs ${wb}`);
  }
});

test("P1D-NP-3: unconstrained / final / external allocation が一致", () => {
  const specs = asymmetricSpecs();
  const a = run(specs, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1);
  const b = run(specs, withExplicitThirds(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1));
  for (const s of specs) {
    const ca = a.diagnostics.companies.find((c) => c.companyId === s.companyId)!;
    const cb = b.diagnostics.companies.find((c) => c.companyId === s.companyId)!;
    assert.ok(Math.abs(ca.unconstrainedAllocation - cb.unconstrainedAllocation) <= 1e-9);
    assert.ok(Math.abs(ca.finalAllocation - cb.finalAllocation) <= 1e-9);
  }
  assert.ok(Math.abs(a.diagnostics.externalFinalAllocation - b.diagnostics.externalFinalAllocation) <= 1e-9);
  assert.deepEqual(JSON.parse(JSON.stringify(a.result)), JSON.parse(JSON.stringify(b.result)));
});

function withOne(field: "relationshipSensitivity" | "deliverySensitivity" | "salesBaseSensitivity", value: number): SalesParameters {
  const base = withExplicitThirds(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1);
  const t = base.tieredMarketAllocation!;
  const tiers = { ...t.tiers } as Record<string, CustomerTierParameters>;
  for (const id of CUSTOMER_TIER_IDS) tiers[id] = { ...t.tiers[id], [field]: value };
  return { ...base, tieredMarketAllocation: { ...t, tiers: tiers as never } };
}

const SINGLE_CASES: Array<[string, "relationshipSensitivity" | "deliverySensitivity" | "salesBaseSensitivity", "relationshipComponent" | "deliveryComponent" | "salesBaseComponent"]> = [
  ["relationshipSensitivity", "relationshipSensitivity", "relationshipComponent"],
  ["deliverySensitivity", "deliverySensitivity", "deliveryComponent"],
  ["salesBaseSensitivity", "salesBaseSensitivity", "salesBaseComponent"],
];

for (let i = 0; i < SINGLE_CASES.length; i++) {
  const [label, field, component] = SINGLE_CASES[i];
  test(`P1D-NP-${4 + i}: ${label} だけを変えると ${component} だけが変わる`, () => {
    const specs = asymmetricSpecs();
    const base = run(specs, withExplicitThirds(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1));
    const changed = run(specs, withOne(field, 5));
    const others = (["relationshipComponent", "deliveryComponent", "salesBaseComponent"] as const).filter((c) => c !== component);
    let changedSeen = false;
    for (const tier of base.diagnostics.tiers) {
      const t2 = changed.diagnostics.tiers.find((t) => t.tier === tier.tier)!;
      for (const c of tier.companies) {
        const c2 = t2.companies.find((x) => x.companyId === c.companyId)!;
        for (const o of others) assert.ok(Math.abs(c[o] - c2[o]) <= TOL, `${c.companyId}/${tier.tier}: ${o} が変化した`);
        assert.ok(Math.abs(c.qualityComponent - c2.qualityComponent) <= TOL);
        assert.ok(Math.abs(c.priceComponent - c2.priceComponent) <= TOL);
        if (Math.abs(c[component] - c2[component]) > TOL) changedSeen = true;
      }
    }
    assert.ok(changedSeen, `${component} が全く変化していない（検証が空振り）`);
  });
}

test("P1D-NP-7: 旧 tiered parameter（nonPriceSensitivity のみ）の fallback が s/3 で解決される", () => {
  for (const id of CUSTOMER_TIER_IDS) {
    const tier = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers[id];
    assert.equal(tier.relationshipSensitivity, undefined);
    assert.equal(tier.deliverySensitivity, undefined);
    assert.equal(tier.salesBaseSensitivity, undefined);
    const r = resolveNonPriceSensitivities(tier);
    assert.equal(r.relationship, tier.nonPriceSensitivity / 3);
    assert.equal(r.delivery, tier.nonPriceSensitivity / 3);
    assert.equal(r.salesBase, tier.nonPriceSensitivity / 3);
  }
  // 部分指定：指定した項目だけが採用され、残りは s/3 のまま。
  const tier = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers.STANDARD;
  const partial = resolveNonPriceSensitivities({ ...tier, deliverySensitivity: 2 });
  assert.equal(partial.delivery, 2);
  assert.equal(partial.relationship, tier.nonPriceSensitivity / 3);
  assert.equal(partial.salesBase, tier.nonPriceSensitivity / 3);
});

test("P1D-NP-8: parameter の JSON roundtrip で挙動が完全一致（schema変更不要の裏づけ）", () => {
  const specs = asymmetricSpecs();
  const explicit = withExplicitThirds(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1);
  for (const params of [SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1, explicit]) {
    const roundtripped = JSON.parse(JSON.stringify(params)) as SalesParameters;
    assert.deepEqual(JSON.parse(JSON.stringify(run(specs, roundtripped).result)), JSON.parse(JSON.stringify(run(specs, params).result)));
  }
  // undefined の3項目は JSON へ現れない＝旧 payload と同一形状。fallback で復元される。
  const raw = JSON.parse(JSON.stringify(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1)) as Record<string, never>;
  const tiers = (raw.tieredMarketAllocation as unknown as { tiers: Record<string, Record<string, unknown>> }).tiers;
  for (const id of CUSTOMER_TIER_IDS) {
    assert.ok(!("relationshipSensitivity" in tiers[id]));
    assert.ok(!("deliverySensitivity" in tiers[id]));
    assert.ok(!("salesBaseSensitivity" in tiers[id]));
  }
});
