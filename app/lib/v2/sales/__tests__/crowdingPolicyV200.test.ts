// ShrimpX V2 — ENG-CROWDING-MARKDOWN-2 正式 policy（P1）テスト P1-1〜P1-8
//
// 【このファイルの役割】
// V2.00 正式 Crowding policy（CROWDING_POLICY_V200_P1）の直接効果を
// **現 Engine 式からの厳密期待値**で固定する。
//
// 【なぜ厳密値で固定するか】
// CAL-1 / CAL-2 の報告で、P1 の CROWD / OVEROFFER 下落率として
// C2（threshold 0.85）の値（-3.84% / -11.31%）を誤って引用していた。
// P1（threshold 1.00）の正しい値は -2.5073% / -10.6817% である。
// 同じ取り違えが二度と起きないよう、式から計算した期待値をここで固定する。
//
// 【式】
//   pricingContestableDemand = forwardDemandProxy × (1 − protectedExternalShare)
//   crowdingRatio = crowdingLoad / pricingContestableDemand
//   x = max(0, crowdingRatio − threshold)
//   multiplier = floor + (1 − floor) × exp(−lambda × x^gamma)

import test from "node:test";
import assert from "node:assert/strict";

import { hosoEqTons, score0to100 } from "../../core/units";
import { period } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import {
  CROWDING_COEFFICIENTS_V200_P1,
  CROWDING_POLICY_V200_P1,
  crowdingMultiplier,
  pricingContestableDemandOf,
} from "../crowding";
import { applyCrowdingLayer } from "../crowdingLayer";
import { resolveDueDateForPlanEntry } from "../contracts";
import { SALES_PARAMETERS_V1 } from "../parameters";
import type { CompanySalesPlanEntry } from "../types";
import type { CompanyProductPhysicalSupply } from "../credibleOffer";

const P0 = period(2020, 1);
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const M: DemandMarketId = "CN";
const PR: Product = "vap";

const STRUCTURAL = 10.0; // USD/kg
const DEMAND = 10_000; // t
const PE = 0.2;
const CONTESTABLE = 8_000; // = DEMAND × (1 − PE)
const IDS = ["CO-A", "CO-B", "CO-C", "CO-D", "CO-E"];

/** 式から直接計算した期待 multiplier（テスト側で Engine と独立に再計算する）。 */
function expectedMultiplier(load: number): number {
  const c = CROWDING_COEFFICIENTS_V200_P1;
  const ratio = load / CONTESTABLE;
  const x = Math.max(0, ratio - c.threshold);
  if (x === 0) return 1;
  return c.floor + (1 - c.floor) * Math.exp(-c.lambda * Math.pow(x, c.gamma));
}

function table(v: number) {
  const t = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const m of MARKETS) {
    t[m] = {} as Record<Product, number>;
    for (const p of PRODUCTS) t[m][p] = v;
  }
  return t;
}

function plan(id: string, q: number, market: DemandMarketId = M): CompanySalesPlanEntry {
  return {
    companyId: id,
    market,
    product: PR,
    desiredQuantity: hosoEqTons(q),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 20,
    qualityReputation: score0to100(70),
    customerRelationship: score0to100(60),
    deliveryReliability: score0to100(60),
  };
}

function sup(id: string, onHand: number): CompanyProductPhysicalSupply {
  return {
    companyId: id,
    product: PR,
    onHandFinishedGoods: onHand,
    conservativeCommittedSupply: 0,
    method: CROWDING_POLICY_V200_P1.physicalAtpMethod,
    limitations: [],
  };
}

function runLayer(plans: readonly CompanySalesPlanEntry[], supplies: readonly CompanyProductPhysicalSupply[]) {
  return applyCrowdingLayer({
    period: P0,
    policy: CROWDING_POLICY_V200_P1,
    adjustedPlans: plans,
    existingContracts: [],
    physicalSupplies: supplies,
    preCrowdingStructuralPrices: table(STRUCTURAL),
    forwardDemandProxyByMarketProduct: table(DEMAND),
    resolveDueDateForPlan: (e, p) => resolveDueDateForPlanEntry(e, p, SALES_PARAMETERS_V1),
  });
}

function bucket(r: ReturnType<typeof runLayer>) {
  const b = r.buckets.find((x) => x.market === M && x.product === PR);
  assert.ok(b, "bucket が存在すること");
  return b!;
}

test("P1-0: 正式 P1 parameter が採用値どおりに固定されている", () => {
  assert.deepEqual(CROWDING_COEFFICIENTS_V200_P1, { threshold: 1.0, lambda: 0.6, gamma: 1.0, floor: 0.82 });
  assert.equal(CROWDING_POLICY_V200_P1.enabled, true);
  for (const p of PRODUCTS) {
    // 商品別 override を導入しない＝3商品とも同一係数
    assert.deepEqual(CROWDING_POLICY_V200_P1.byProduct[p], CROWDING_COEFFICIENTS_V200_P1);
    assert.equal(CROWDING_POLICY_V200_P1.protectedExternalShare[p], 0.2);
  }
  // 市場別 override を導入しない
  assert.equal(CROWDING_POLICY_V200_P1.marketOverrides, undefined);
  // pricing contestable demand の式
  assert.equal(pricingContestableDemandOf(DEMAND, PE), CONTESTABLE);
});

test("P1-1: ratio <= 1.00 なら multiplier = 1.0（threshold 以下は値下げなし）", () => {
  for (const ratio of [0, 0.25, 0.5, 0.75, 0.99, 1.0]) {
    assert.equal(crowdingMultiplier(ratio, CROWDING_COEFFICIENTS_V200_P1), 1, `ratio=${ratio}`);
  }
  // 層レベル: contestable demand ちょうど（8,000t）までは構造価格のまま
  const r = runLayer(IDS.map((id) => plan(id, CONTESTABLE / 5)), IDS.map((id) => sup(id, CONTESTABLE / 5)));
  const b = bucket(r);
  assert.equal(b.grossCompanyAddressableDemand, CONTESTABLE);
  assert.equal(b.totalCredibleOffers, CONTESTABLE);
  assert.equal(b.crowdingRatio, 1);
  assert.equal(b.crowdingMultiplier, 1);
  assert.equal(b.postCrowdingClearingPrice, STRUCTURAL);
});

test("P1-2: demand 10,000 / pe 0.20 / load 10,000 → ratio 1.25 と厳密 multiplier", () => {
  const r = runLayer(IDS.map((id) => plan(id, 2_000)), IDS.map((id) => sup(id, 2_000)));
  const b = bucket(r);

  assert.equal(b.forwardDemandProxy, DEMAND);
  assert.equal(b.protectedExternalShare, PE);
  assert.equal(b.protectedExternalDemand, 2_000);
  assert.equal(b.grossCompanyAddressableDemand, CONTESTABLE);
  assert.equal(b.totalCredibleOffers, 10_000);
  assert.equal(b.crowdingRatio, 1.25);

  // 式から独立に計算した期待値と厳密一致（0.9749274358…）
  const expected = expectedMultiplier(10_000);
  assert.equal(b.crowdingMultiplier, expected);
  assert.ok(Math.abs(expected - 0.9749274358) < 1e-9, `期待 multiplier: ${expected}`);
  assert.ok(
    Math.abs(100 * (1 - expected) - 2.5073) < 1e-3,
    `P1 の CROWD 下落率は約 2.51%（C2 の 3.84% ではない）。実測 ${100 * (1 - expected)}%`
  );
  assert.equal(b.postCrowdingClearingPrice, STRUCTURAL * expected);
});

test("P1-3: load 20,000 → ratio 2.50 と厳密 multiplier", () => {
  const r = runLayer(IDS.map((id) => plan(id, 4_000)), IDS.map((id) => sup(id, 4_000)));
  const b = bucket(r);

  assert.equal(b.totalCredibleOffers, 20_000);
  assert.equal(b.crowdingRatio, 2.5);

  const expected = expectedMultiplier(20_000);
  assert.equal(b.crowdingMultiplier, expected);
  assert.ok(Math.abs(expected - 0.8931825388) < 1e-9, `期待 multiplier: ${expected}`);
  assert.ok(
    Math.abs(100 * (1 - expected) - 10.6817) < 1e-3,
    `P1 の OVEROFFER 下落率は約 10.68%（C2 の 11.31% ではない）。実測 ${100 * (1 - expected)}%`
  );
  assert.equal(b.postCrowdingClearingPrice, STRUCTURAL * expected);
});

test("P1-4: 極端な load でも multiplier >= 0.82（floor を割らない）", () => {
  for (const ratio of [10, 1e3, 1e6, 1e12]) {
    const m = crowdingMultiplier(ratio, CROWDING_COEFFICIENTS_V200_P1);
    assert.ok(Number.isFinite(m), `NaN/Infinity: ratio=${ratio}`);
    assert.ok(m >= 0.82, `floor 未満: ${m}`);
    assert.ok(m <= 1, `1 超過: ${m}`);
  }
  // 層レベル: 需要の 100 倍を提示しても floor で止まる
  const r = runLayer(IDS.map((id) => plan(id, 200_000)), IDS.map((id) => sup(id, 200_000)));
  const b = bucket(r);
  assert.ok(b.crowdingMultiplier >= 0.82, `floor 未満: ${b.crowdingMultiplier}`);
  assert.ok(b.postCrowdingClearingPrice >= STRUCTURAL * 0.82 - 1e-12);
  assert.ok(Number.isFinite(b.postCrowdingClearingPrice) && b.postCrowdingClearingPrice > 0);
});

test("P1-5: load 増加で multiplier / clearing price は単調非増加", () => {
  let prevM = Number.POSITIVE_INFINITY;
  let prevP = Number.POSITIVE_INFINITY;
  for (const perCompany of [500, 1_000, 1_600, 2_000, 3_000, 4_000, 6_000]) {
    const r = runLayer(IDS.map((id) => plan(id, perCompany)), IDS.map((id) => sup(id, perCompany)));
    const b = bucket(r);
    assert.ok(b.crowdingMultiplier <= prevM + 1e-12, `multiplier が増加: ${prevM} -> ${b.crowdingMultiplier}`);
    assert.ok(b.postCrowdingClearingPrice <= prevP + 1e-12, `価格が上昇: ${prevP} -> ${b.postCrowdingClearingPrice}`);
    prevM = b.crowdingMultiplier;
    prevP = b.postCrowdingClearingPrice;
  }
});

test("P1-6: SOLO / TWO は threshold 以下なので値下げなし", () => {
  // 1社あたり 2,000t（CROWD で ratio 1.25 になる量）を固定して会社数だけ変える。
  const cases = [
    { n: 1, label: "SOLO" },
    { n: 2, label: "TWO" },
  ];
  for (const { n, label } of cases) {
    const ids = IDS.slice(0, n);
    const r = runLayer(ids.map((id) => plan(id, 2_000)), ids.map((id) => sup(id, 2_000)));
    const b = bucket(r);
    assert.equal(b.totalCredibleOffers, 2_000 * n, `${label} の提示量`);
    assert.ok(b.crowdingRatio <= 1, `${label} の ratio は threshold 以下: ${b.crowdingRatio}`);
    assert.equal(b.crowdingMultiplier, 1, `${label} は値下げなし`);
    assert.equal(b.postCrowdingClearingPrice, STRUCTURAL);
  }
  // 5社（CROWD）でのみ threshold を超える
  const crowd = bucket(runLayer(IDS.map((id) => plan(id, 2_000)), IDS.map((id) => sup(id, 2_000))));
  assert.ok(crowd.crowdingRatio > 1);
  assert.ok(crowd.crowdingMultiplier < 1);
});

test("P1-7: DIVERSIFIED が非混雑なら値下げなし", () => {
  // CROWD と会社あたり総量を同一（2,000t）にしたまま3市場へ均等分散する。
  const others: DemandMarketId[] = ["US", "EU"];
  const plans = IDS.flatMap((id) => [
    plan(id, 2_000 / 3, M),
    ...others.map((mk) => plan(id, 2_000 / 3, mk)),
  ]);
  const r = runLayer(plans, IDS.map((id) => sup(id, 2_000)));
  const b = bucket(r);
  assert.ok(Math.abs(b.totalCredibleOffers - 10_000 / 3) < 1e-6, `対象市場の提示量: ${b.totalCredibleOffers}`);
  assert.ok(b.crowdingRatio <= 1, `分散後の ratio は threshold 以下: ${b.crowdingRatio}`);
  assert.equal(b.crowdingMultiplier, 1, "分散すれば値下げなし");
  assert.equal(b.postCrowdingClearingPrice, STRUCTURAL);
});

test("P1-8: FAKE CAPACITY — desired を水増ししても physical ATP が同じなら価格不変", () => {
  const supplies = IDS.map((id) => sup(id, 2_000));
  const honest = runLayer(IDS.map((id) => plan(id, 2_000)), supplies);
  const inflated = runLayer(IDS.map((id) => plan(id, 20_000)), supplies);

  const a = bucket(honest);
  const b = bucket(inflated);

  assert.equal(b.totalDesiredOffers, 100_000, "希望量は 10 倍になっている");
  assert.equal(a.totalDesiredOffers, 10_000);
  assert.equal(b.totalCredibleOffers, a.totalCredibleOffers, "信頼可能提示量は変わらない");
  assert.equal(b.crowdingRatio, a.crowdingRatio, "ratio は変わらない");
  assert.equal(b.crowdingMultiplier, a.crowdingMultiplier, "multiplier は変わらない");
  assert.equal(b.postCrowdingClearingPrice, a.postCrowdingClearingPrice, "clearing price は変わらない");
  for (const o of b.companyOffers) {
    assert.equal(o.bindingReason, "PHYSICAL_ATP", `${o.companyId} は physical ATP で拘束される`);
  }
});
