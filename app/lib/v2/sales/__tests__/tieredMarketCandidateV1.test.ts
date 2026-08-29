// ShrimpX V2 — TIERED-MKT-P1D §18 三層顧客モデル V2.00 正式候補（B-moderated-v1）必須テスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
import { allocateMarketProductTiered, resolveTierParameters } from "../tieredAllocation";
import {
  CUSTOMER_TIER_IDS,
  EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1,
  SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
  TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1,
  US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1,
  qualitySensitivityCalibrationFactorFor,
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

const PARAMS = SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1;
const TARGET = unwrapUnit(FIXTURE_TARGET_DEMAND);

function run(specs: readonly FixtureCompanySpec[], product = FIXTURE_PRODUCT, market = FIXTURE_MARKET) {
  return allocateMarketProductTiered({
    market,
    product,
    period: FIXTURE_PERIOD,
    entries: buildEntries(specs, product, market),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params: PARAMS,
    salesCapacityByCompanyMarket: buildSalesCapacityMap(specs, market),
  });
}
const weightOf = (o: ReturnType<typeof run>, id: string) => o.result.companies.find((c) => c.companyId === id)!.competitivenessWeight;
const finalOf = (o: ReturnType<typeof run>, id: string) => unwrapUnit(o.result.companies.find((c) => c.companyId === id)!.allocatedQuantity);
const utilityOf = (o: ReturnType<typeof run>, id: string) =>
  o.diagnostics.tiers.map((t) => t.companies.find((c) => c.companyId === id)!.utility);
const addressableOf = (o: ReturnType<typeof run>) =>
  TARGET * o.result.companies.reduce((s, c) => s + c.competitivenessWeight, 0);

// =====================================================================

test("P1D-TIER-1: 5社 final + external = targetDemand（需要保存）", () => {
  for (const adj of [-2, -1, 0, 1, 2]) {
    const specs = symmetricCompanySpecs();
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const o = run(specs);
    const total = o.diagnostics.companies.reduce((s, c) => s + c.finalAllocation, 0) + o.diagnostics.externalFinalAllocation;
    assert.ok(Math.abs(total - TARGET) < 1e-6, `adj=${adj}: ${total} != ${TARGET}`);
    assert.ok(Math.abs(o.diagnostics.demandConservationResidual) < 1e-6);
  }
});

test("P1D-TIER-2: 価格上昇で対象会社の normalized weight が単調低下", () => {
  let prev = Infinity;
  for (const adj of [-2, -1, 0, 1, 2]) {
    const specs = symmetricCompanySpecs();
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const w = weightOf(run(specs), "CO-A");
    assert.ok(w < prev, `adj=${adj}: weight ${w} が単調低下していない（前=${prev}）`);
    prev = w;
  }
});

test("P1D-TIER-3: quality 上昇で weight 上昇", () => {
  const base = weightOf(run(symmetricCompanySpecs()), "CO-A");
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], quality: 90 };
  assert.ok(weightOf(run(specs), "CO-A") > base);
});

test("P1D-TIER-4: VAP differentiation 上昇で weight 上昇（VAPのみ）", () => {
  const base = weightOf(run(symmetricCompanySpecs(), "vap"), "CO-A");
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], differentiation: 90 };
  assert.ok(weightOf(run(specs, "vap"), "CO-A") > base);
  // HOSO は差別化スコアを読まない（中立固定）ため変化しない。
  assert.ok(Math.abs(weightOf(run(specs, "hoso"), "CO-A") - weightOf(run(symmetricCompanySpecs(), "hoso"), "CO-A")) < 1e-12);
});

test("P1D-TIER-5: salesBase 上昇で weight 上昇", () => {
  const base = weightOf(run(symmetricCompanySpecs()), "CO-A");
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], salesBase: 90 };
  assert.ok(weightOf(run(specs), "CO-A") > base);
});

test("P1D-TIER-6: delivery reliability 上昇で weight 上昇", () => {
  const base = weightOf(run(symmetricCompanySpecs()), "CO-A");
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], deliveryReliability: 90 };
  assert.ok(weightOf(run(specs), "CO-A") > base);
});

const CAP_CASES: Array<[string, Partial<FixtureCompanySpec>]> = [
  ["desired", { desired: 500 }],
  ["salesCapacity", { salesEffortCapacity: 700 }],
  ["approvedAllocationCap", { approvedAllocationCap: 400 }],
];

for (const [label, ov] of CAP_CASES) {
  const idx = CAP_CASES.findIndex((c) => c[0] === label);
  test(`P1D-TIER-${7 + idx}: ${label} cap を変えても utility / weight / addressableDemand は不変`, () => {
    const base = run(symmetricCompanySpecs());
    const specs = symmetricCompanySpecs();
    specs[0] = { ...specs[0], ...ov };
    const capped = run(specs);
    for (const id of specs.map((s) => s.companyId)) {
      assert.deepEqual(utilityOf(capped, id), utilityOf(base, id), `${id} の utility が cap で変化した`);
      assert.ok(Math.abs(weightOf(capped, id) - weightOf(base, id)) < 1e-12, `${id} の weight が cap で変化した`);
    }
    assert.ok(Math.abs(addressableOf(capped) - addressableOf(base)) < 1e-9);
  });
}

test("P1D-TIER-10: cap は final 数量のみを制限する（削減分は外部へ移り、他社は増えない）", () => {
  const base = run(symmetricCompanySpecs());
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], approvedAllocationCap: 400 };
  const capped = run(specs);
  assert.ok(finalOf(capped, "CO-A") <= 400 + 0.02);
  assert.ok(finalOf(capped, "CO-A") < finalOf(base, "CO-A"));
  for (const id of ["CO-B", "CO-C", "CO-D", "CO-E"]) {
    assert.ok(Math.abs(finalOf(capped, id) - finalOf(base, id)) < 0.02, `${id} が cap 削減分を吸収してしまっている`);
  }
  assert.ok(unwrapUnit(capped.result.externalOptionQuantity) > unwrapUnit(base.result.externalOptionQuantity));
});

test("P1D-TIER-11: 同一入力で完全一致（決定的・入力順非依存）", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: -0.5, quality: 82 };
  const a = run(specs);
  const b = run([...specs].reverse());
  assert.deepEqual(JSON.parse(JSON.stringify(a.result)), JSON.parse(JSON.stringify(b.result)));
});

test("P1D-TIER-12: externalOptionBaseUtility = 1.6（全層）と基準snapshot", () => {
  assert.equal(EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1, 1.6);
  for (const t of CUSTOMER_TIER_IDS) {
    assert.equal(TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers[t].externalOptionBaseUtility, 1.6);
  }
  const o = run(symmetricCompanySpecs());
  for (const t of o.diagnostics.tiers) {
    assert.equal(t.external.utility, 1.6, `${t.tier} の外部効用が 1.6 でない`);
  }
  // 完全対称・価格中立時の外部シェア（正規化ウェイト）は層パラメータのみで決まる。
  const extShare = o.diagnostics.tiers.reduce((s, t) => s + t.tierShare * t.external.normalizedWeight, 0);
  const sumW = o.result.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
  assert.ok(Math.abs(sumW + extShare - 1) < 1e-12, "正規化の閉性が崩れている");
  assert.ok(extShare > 0 && extShare < 1);
});

test("P1D-TIER-13: 全15セル（5市場×3商品）で demandShare 合計 = 1", () => {
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1, market, product);
      const sum = CUSTOMER_TIER_IDS.reduce((s, t) => s + tiers[t].demandShare, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-9, `${market}/${product}: demandShare 合計 ${sum}`);
    }
  }
});

test("P1D-TIER-14: US / EU の VAP のみ qualitySensitivity ×0.60（anchor calibration と合成）", () => {
  const f = US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1;
  assert.equal(f, 0.6);
  const base = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const tiers = resolveTierParameters(TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1, market, product);
      // 【TIERED-MKT-P1D-3】解決値 = base × US/EU VAP factor × anchor calibration factor。
      const usEuVapFactor = (market === "US" || market === "EU") && product === "vap" ? f : 1;
      const expectFactor = usEuVapFactor * qualitySensitivityCalibrationFactorFor(market, product);
      for (const t of CUSTOMER_TIER_IDS) {
        assert.ok(
          Math.abs(tiers[t].qualitySensitivity - base[t].qualitySensitivity * expectFactor) < 1e-12,
          `${market}/${product}/${t}: ${tiers[t].qualitySensitivity} != ${base[t].qualitySensitivity * expectFactor}`
        );
        // priceSensitivity / differentiationSensitivity は override 対象外。
        assert.equal(tiers[t].priceSensitivity, base[t].priceSensitivity);
        assert.equal(tiers[t].differentiationSensitivity, base[t].differentiationSensitivity);
      }
    }
  }
});

test("P1D-TIER-15（補足）: 指示で明示された priceSensitivity / differentiationSensitivity", () => {
  const t = TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1.tiers;
  assert.equal(t.PRICE_SENSITIVE.priceSensitivity, 6.5);
  assert.equal(t.STANDARD.priceSensitivity, 3.5);
  assert.equal(t.PREMIUM.priceSensitivity, 1.7);
  assert.equal(t.PRICE_SENSITIVE.differentiationSensitivity, 0.3);
  assert.equal(t.STANDARD.differentiationSensitivity, 1.4);
  assert.equal(t.PREMIUM.differentiationSensitivity, 4.0);
  // 本番 SalesParameters は tiered mode を持たない（legacy 隔離）。
  assert.equal(SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1.marketAllocationMode, "tieredSimultaneousAllocation");
});
