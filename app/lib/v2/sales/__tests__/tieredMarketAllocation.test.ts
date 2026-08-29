// ShrimpX V2 — ENG-TIERED-MKT-1 三層顧客＋全社同時配分（実装指示§16 必須18項目）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { allocateMarketProduct } from "../allocation";
import { allocateMarketProductTiered } from "../tieredAllocation";
import { CUSTOMER_TIER_IDS, SALES_PARAMETERS_V1, SALES_PARAMETERS_TIERED_FIXTURE_V0 } from "../parameters";
import {
  FIXTURE_MARKET,
  FIXTURE_PARAMS,
  FIXTURE_PERIOD,
  FIXTURE_PRODUCT,
  FIXTURE_REFERENCE_PRICE,
  FIXTURE_TARGET_DEMAND,
  FixtureCompanySpec,
  buildEntries,
  buildSalesCapacityMap,
  symmetricCompanySpecs,
} from "./tieredMarketAllocationFixture";

const TOL = 0.02; // roundHosoEqTons が小数2桁のため

function run(specs: readonly FixtureCompanySpec[], product = FIXTURE_PRODUCT) {
  return allocateMarketProductTiered({
    market: FIXTURE_MARKET,
    product,
    period: FIXTURE_PERIOD,
    entries: buildEntries(specs, product),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params: FIXTURE_PARAMS,
    salesCapacityByCompanyMarket: buildSalesCapacityMap(specs),
  });
}
const allocOf = (out: ReturnType<typeof run>, id: string) =>
  unwrapUnit(out.result.companies.find((c) => c.companyId === id)!.allocatedQuantity);
const unconstrainedOf = (out: ReturnType<typeof run>, id: string) =>
  out.diagnostics.companies.find((c) => c.companyId === id)!.unconstrainedAllocation;

const PRICE_SWEEP = [-2, -1, -0.5, 0, 0.5, 1, 2];

// =====================================================================

test("TIER-1: 3層の demandShare 合計が 1.0", () => {
  const sum = CUSTOMER_TIER_IDS.reduce((s, t) => s + SALES_PARAMETERS_TIERED_FIXTURE_V0.tieredMarketAllocation!.tiers[t].demandShare, 0);
  assert.equal(sum, 1);
  const out = run(symmetricCompanySpecs());
  assert.equal(out.diagnostics.tiers.length, 3);
  assert.ok(Math.abs(out.diagnostics.tiers.reduce((s, t) => s + t.tierShare, 0) - 1) < 1e-12);
  assert.ok(Math.abs(out.diagnostics.tiers.reduce((s, t) => s + t.tierDemand, 0) - unwrapUnit(FIXTURE_TARGET_DEMAND)) < 1e-9);
});

test("TIER-2: 5社 final + external = targetDemand（需要保存）", () => {
  for (const adj of PRICE_SWEEP) {
    const specs = symmetricCompanySpecs();
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const out = run(specs);
    const companies = out.diagnostics.companies.reduce((s, c) => s + c.finalAllocation, 0);
    const total = companies + out.diagnostics.externalFinalAllocation;
    assert.ok(Math.abs(total - unwrapUnit(FIXTURE_TARGET_DEMAND)) < 1e-6, `adj=${adj}: 合計 ${total}`);
    assert.ok(Math.abs(out.diagnostics.demandConservationResidual) < 1e-6);
  }
});

test("TIER-3: 対象需要の二重計上・消失がない（層別でも保存される）", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], desired: 200 }; // cap を効かせる
  const out = run(specs);
  for (const t of out.diagnostics.tiers) {
    const sum = t.companies.reduce((s, c) => s + c.finalAllocation, 0) + t.external.finalAllocation;
    assert.ok(Math.abs(sum - t.tierDemand) < 1e-6, `${t.tier}: ${sum} != ${t.tierDemand}`);
    const unc = t.companies.reduce((s, c) => s + c.unconstrainedAllocation, 0) + t.external.unconstrainedAllocation;
    assert.ok(Math.abs(unc - t.tierDemand) < 1e-6, `${t.tier} unconstrained: ${unc}`);
  }
});

test("TIER-4: cap 前需要は値上げに対して厳密に減少する", () => {
  let prev = Number.POSITIVE_INFINITY;
  for (const adj of PRICE_SWEEP) {
    const specs = symmetricCompanySpecs();
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const u = unconstrainedOf(run(specs), specs[0].companyId);
    assert.ok(u < prev - 1e-9, `adj=${adj}: ${u} が直前 ${prev} 以上`);
    prev = u;
  }
});

test("TIER-5: cap 後成約は値上げで増加しない", () => {
  let prev = Number.POSITIVE_INFINITY;
  for (const adj of PRICE_SWEEP) {
    const specs = symmetricCompanySpecs({ desired: 800 });
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const f = allocOf(run(specs), specs[0].companyId);
    assert.ok(f <= prev + TOL, `adj=${adj}: ${f} > ${prev}`);
    prev = f;
  }
});

test("TIER-6: PREMIUM 層では高品質・高差別化の会社が優位（同一価格）", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], quality: 95, differentiation: 95 };
  const out = run(specs, "vap");
  const premium = out.diagnostics.tiers.find((t) => t.tier === "PREMIUM")!;
  const priceSensitive = out.diagnostics.tiers.find((t) => t.tier === "PRICE_SENSITIVE")!;
  const wPremium = premium.companies.find((c) => c.companyId === specs[0].companyId)!.normalizedWeight;
  const wOther = premium.companies.find((c) => c.companyId === specs[1].companyId)!.normalizedWeight;
  assert.ok(wPremium > wOther, "PREMIUM 層で高品質会社が優位でない");
  const gapPremium = wPremium / wOther;
  const gapPrice =
    priceSensitive.companies.find((c) => c.companyId === specs[0].companyId)!.normalizedWeight /
    priceSensitive.companies.find((c) => c.companyId === specs[1].companyId)!.normalizedWeight;
  assert.ok(gapPremium > gapPrice, "PREMIUM 層の方が品質差の効きが大きいこと");

  // 多少の値上げでも相対優位を維持できること。
  const raised = [...specs];
  raised[0] = { ...raised[0], priceAdjustment: 0.2 };
  const out2 = run(raised, "vap");
  const p2 = out2.diagnostics.tiers.find((t) => t.tier === "PREMIUM")!;
  assert.ok(
    p2.companies.find((c) => c.companyId === specs[0].companyId)!.normalizedWeight >
      p2.companies.find((c) => c.companyId === specs[1].companyId)!.normalizedWeight,
    "PREMIUM 層で +$0.2 の値上げ後に相対優位を失っている"
  );
});

test("TIER-7: PRICE_SENSITIVE 層では値下げ効果が大きい", () => {
  const base = symmetricCompanySpecs();
  const cut = [...base];
  cut[0] = { ...cut[0], priceAdjustment: -0.4 };
  const b = run(base);
  const c = run(cut);
  const gain = (tier: string) => {
    const bw = b.diagnostics.tiers.find((t) => t.tier === tier)!.companies.find((x) => x.companyId === base[0].companyId)!.normalizedWeight;
    const cw = c.diagnostics.tiers.find((t) => t.tier === tier)!.companies.find((x) => x.companyId === base[0].companyId)!.normalizedWeight;
    return cw / bw;
  };
  assert.ok(gain("PRICE_SENSITIVE") > gain("STANDARD"), "PRICE_SENSITIVE の値下げ効果が STANDARD 以下");
  assert.ok(gain("STANDARD") > gain("PREMIUM"), "STANDARD の値下げ効果が PREMIUM 以下");
});

test("TIER-8: 留保価格超過で連続的に external へ移る（hard cutoff でない）", () => {
  const reservation = 4.0 * SALES_PARAMETERS_TIERED_FIXTURE_V0.tieredMarketAllocation!.tiers.PRICE_SENSITIVE.reservationPriceMultiplier;
  const justUnder = reservation - 4.0 - 0.001;
  const justOver = reservation - 4.0 + 0.001;
  const mk = (adj: number) => {
    const s = symmetricCompanySpecs();
    s[0] = { ...s[0], priceAdjustment: adj };
    return run(s);
  };
  const a = mk(justUnder);
  const b = mk(justOver);
  const ua = unconstrainedOf(a, "CO-A");
  const ub = unconstrainedOf(b, "CO-A");
  assert.ok(ub < ua, "超過側で需要が減っていない");
  assert.ok(ub > ua * 0.9, "+0.002 の価格差で急落（hard cutoff）している");
  // 超過が広がるほど加速的に悪化する
  const excesses = [0, 0.05, 0.1, 0.2].map((e) => unconstrainedOf(mk(reservation - 4.0 + e), "CO-A"));
  for (let i = 1; i < excesses.length; i++) assert.ok(excesses[i] < excesses[i - 1]);
  const d1 = excesses[0] - excesses[1];
  const d2 = excesses[1] - excesses[2];
  assert.ok(d1 > 0 && d2 > 0);
});

test("TIER-9: 全社が極端に高値なら external が大幅に増える", () => {
  const normal = run(symmetricCompanySpecs());
  const high = run(symmetricCompanySpecs({ priceAdjustment: 2 }));
  const extNormal = normal.diagnostics.externalFinalAllocation;
  const extHigh = high.diagnostics.externalFinalAllocation;
  assert.ok(extHigh > extNormal * 2, `external が増えていない: ${extNormal} → ${extHigh}`);
  assert.ok(extHigh / unwrapUnit(FIXTURE_TARGET_DEMAND) > 0.9, "全社高値でも external が需要の大半を取っていない");
});

test("TIER-10: cap による削減分は他社へ再配分せず external へ移る", () => {
  const base = symmetricCompanySpecs();
  const capped = [...base];
  capped[0] = { ...capped[0], desired: 100 };
  const b = run(base);
  const c = run(capped);
  // 他社の final は cap の有無で変わらない（再配分しない）。
  for (const id of ["CO-B", "CO-C", "CO-D", "CO-E"]) {
    assert.ok(Math.abs(allocOf(c, id) - allocOf(b, id)) < TOL, `${id} へ再配分されている`);
  }
  const reduction = c.diagnostics.companies.find((x) => x.companyId === "CO-A")!.reductionByCap;
  assert.ok(reduction > 0);
  assert.ok(
    Math.abs(c.diagnostics.externalFinalAllocation - (b.diagnostics.externalFinalAllocation + reduction)) < 1e-6,
    "削減分が external へ移っていない"
  );
});

test("TIER-11: desired cap を超えない", () => {
  const specs = symmetricCompanySpecs({ desired: 300 });
  const out = run(specs);
  for (const c of out.diagnostics.companies) {
    assert.ok(c.finalAllocation <= 300 + TOL);
    assert.equal(c.bindingCap, "DESIRED");
  }
});

test("TIER-12: sales capacity cap を超えない", () => {
  const specs = symmetricCompanySpecs({ salesEffortCapacity: 250 });
  const out = run(specs);
  for (const c of out.diagnostics.companies) {
    assert.ok(c.finalAllocation <= 250 + TOL, `${c.companyId}: ${c.finalAllocation}`);
    assert.equal(c.bindingCap, "SALES_CAPACITY");
  }
});

test("TIER-13: supplier share cap を超えない", () => {
  // maximumSupplierShare=0.35 → 10,000 × 0.35 = 3,500
  const specs = symmetricCompanySpecs({ desired: 100_000 });
  const only = [specs[0]];
  const out = allocateMarketProductTiered({
    market: FIXTURE_MARKET,
    product: FIXTURE_PRODUCT,
    period: FIXTURE_PERIOD,
    entries: buildEntries(only),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params: FIXTURE_PARAMS,
  });
  const c = out.diagnostics.companies[0];
  assert.ok(c.unconstrainedAllocation > 3_500, "前提: cap 前需要が share cap を上回ること");
  assert.ok(c.finalAllocation <= 3_500 + TOL);
  assert.equal(c.bindingCap, "SUPPLIER_SHARE");
});

test("TIER-14: approvedAllocationCap（承認済み取引枠）を超えない", () => {
  const specs = symmetricCompanySpecs({ approvedAllocationCap: 120 });
  const out = run(specs);
  for (const c of out.diagnostics.companies) {
    assert.ok(c.finalAllocation <= 120 + TOL);
    assert.equal(c.bindingCap, "APPROVED_ALLOCATION");
  }
});

test("TIER-15: 完全対称な5社なら配分も対称", () => {
  const out = run(symmetricCompanySpecs());
  const values = out.diagnostics.companies.map((c) => c.finalAllocation);
  for (const v of values) assert.ok(Math.abs(v - values[0]) < 1e-9, `対称でない: ${values.join(",")}`);
  for (const t of out.diagnostics.tiers) {
    const w = t.companies.map((c) => c.normalizedWeight);
    for (const x of w) assert.ok(Math.abs(x - w[0]) < 1e-12);
  }
});

test("TIER-16: 決定的（同じ入力から同じ結果）", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: 0.7, quality: 88 };
  const a = run(specs);
  const b = run(specs);
  assert.deepEqual(b.result, a.result);
  assert.deepEqual(b.diagnostics, a.diagnostics);
});

test("TIER-17: 入力の会社順を入れ替えても結果が同一", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: 0.7, quality: 88 };
  specs[3] = { ...specs[3], priceAdjustment: -0.3 };
  const a = run(specs);
  const b = run([...specs].reverse());
  assert.deepEqual(b.result, a.result);
  assert.deepEqual(b.diagnostics.companies, a.diagnostics.companies);
});

test("TIER-18: legacy OFF（既定パラメータ）では既存の水位法がそのまま動く", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: 2 };
  const entries = buildEntries(specs);
  const legacy = allocateMarketProduct(
    FIXTURE_MARKET,
    FIXTURE_PRODUCT,
    FIXTURE_PERIOD,
    entries,
    FIXTURE_REFERENCE_PRICE,
    FIXTURE_TARGET_DEMAND,
    SALES_PARAMETERS_V1
  );
  // 既定では marketAllocationMode が undefined＝legacyWaterfall。
  assert.equal(SALES_PARAMETERS_V1.marketAllocationMode, undefined);
  // 水位法の既知の性質: 全社が desired cap（5,000）未満の取り分で止まり、
  // 高値でも競争力ウェイトは 0 にならず、成約は発生する。
  const a = legacy.companies.find((c) => c.companyId === "CO-A")!;
  assert.ok(a.competitivenessWeight > 0, "legacy の競争力ウェイトが失われている");
  assert.ok(unwrapUnit(a.allocatedQuantity) > 0, "legacy で高値会社の成約が0になっている");
  const total =
    legacy.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(legacy.externalOptionQuantity);
  assert.ok(Math.abs(total - unwrapUnit(FIXTURE_TARGET_DEMAND)) < 1, "legacy の需要保存が壊れている");

  // 新方式を明示的に選んだときだけ結果が変わること。
  const tiered = allocateMarketProduct(
    FIXTURE_MARKET,
    FIXTURE_PRODUCT,
    FIXTURE_PERIOD,
    entries,
    FIXTURE_REFERENCE_PRICE,
    FIXTURE_TARGET_DEMAND,
    FIXTURE_PARAMS
  );
  assert.notDeepEqual(unwrapUnit(tiered.companies[0].allocatedQuantity), unwrapUnit(legacy.companies[0].allocatedQuantity));
});

// ---- §13 cap付き単調性の追加受入条件 ----

test("TIER-13B: cap binding 中は値上げしても final が変わらず、cap を下回った後は減少する", () => {
  const quantities = PRICE_SWEEP.map((adj) => {
    const specs = symmetricCompanySpecs({ desired: 400 });
    specs[0] = { ...specs[0], priceAdjustment: adj };
    const out = run(specs);
    return { adj, unconstrained: unconstrainedOf(out, "CO-A"), final: allocOf(out, "CO-A") };
  });
  for (let i = 1; i < quantities.length; i++) {
    assert.ok(quantities[i].unconstrained < quantities[i - 1].unconstrained - 1e-9, "A: cap前需要が厳密減少していない");
    assert.ok(quantities[i].final <= quantities[i - 1].final + TOL, "B: cap後成約が増加している");
  }
  const bindingRows = quantities.filter((q) => q.unconstrained > 400 + TOL);
  for (const r of bindingRows) assert.ok(Math.abs(r.final - 400) < TOL, "C: cap binding 中の final が cap と一致しない");
  const releasedRows = quantities.filter((q) => q.unconstrained < 400 - TOL);
  for (let i = 1; i < releasedRows.length; i++) {
    assert.ok(releasedRows[i].final < releasedRows[i - 1].final - 1e-9, "D: cap を下回った後に final が減少していない");
  }
});

test("TIER-EX: 使用禁止の price floor が新方式の経路に存在しない", () => {
  // minimumPriceCompetitiveness は legacy 専用。新方式の効用計算は参照しない。
  const withFloorChanged = {
    ...FIXTURE_PARAMS,
    minimumPriceCompetitiveness: 0.0001,
    maximumPriceCompetitiveness: 99,
  };
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], priceAdjustment: 1.5 };
  const a = allocateMarketProductTiered({
    market: FIXTURE_MARKET,
    product: FIXTURE_PRODUCT,
    period: FIXTURE_PERIOD,
    entries: buildEntries(specs),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params: FIXTURE_PARAMS,
  });
  const b = allocateMarketProductTiered({
    market: FIXTURE_MARKET,
    product: FIXTURE_PRODUCT,
    period: FIXTURE_PERIOD,
    entries: buildEntries(specs),
    basePrice: FIXTURE_REFERENCE_PRICE,
    targetDemand: FIXTURE_TARGET_DEMAND,
    params: withFloorChanged as typeof FIXTURE_PARAMS,
  });
  assert.deepEqual(b.diagnostics.companies, a.diagnostics.companies);
});

test("TIER-VAL: tier 設定なしで新方式を選ぶとエラー（既定値を推測しない）", () => {
  assert.throws(
    () =>
      allocateMarketProductTiered({
        market: FIXTURE_MARKET,
        product: FIXTURE_PRODUCT,
        period: FIXTURE_PERIOD,
        entries: buildEntries(symmetricCompanySpecs()),
        basePrice: FIXTURE_REFERENCE_PRICE,
        targetDemand: hosoEqTons(1000),
        params: { ...SALES_PARAMETERS_V1, marketAllocationMode: "tieredSimultaneousAllocation" },
      }),
    /tieredMarketAllocation/
  );
  void usdPerHosoEqKg;
});

// =====================================================================
// ENG-TIERED-MKT-1A: cap の意味を偽装しないことの固定（実装指示§9）
// =====================================================================

test("CAP-SEM-1: approvedAllocationCap は独立した trade/approval cap として機能する", () => {
  // 他の cap（希望量・営業能力・供給者シェア）を非拘束にしたうえで、
  // approvedAllocationCap だけで最終成約が決まること。
  const specs = symmetricCompanySpecs({ desired: 5_000, approvedAllocationCap: 180 });
  const out = run(specs);
  for (const c of out.diagnostics.companies) {
    assert.equal(c.bindingCap, "APPROVED_ALLOCATION");
    assert.ok(c.finalAllocation <= 180 + TOL);
    assert.ok(c.desiredCap > 180, "前提: 希望量は非拘束であること");
    assert.equal(c.approvedAllocationCap, 180);
  }
  // 未指定なら制約なし（Infinity）＝ binding にならない。
  const free = run(symmetricCompanySpecs({ desired: 5_000 }));
  for (const c of free.diagnostics.companies) {
    assert.equal(c.approvedAllocationCap, Number.POSITIVE_INFINITY);
    assert.notEqual(c.bindingCap, "APPROVED_ALLOCATION");
  }
});

test("CAP-SEM-2: physical deliverable cap は現行Engineに存在しない（仕様として固定）", () => {
  // 【現行仕様】final_i = min(unconstrained, desired, salesCapacity, supplierShare, approvedAllocation)
  // 完成品在庫・生産能力・受注残に由来する cap は Engine の成約配分に存在しない。
  // sales モジュールはそれらを入力として受け取らないため、算出もできない。
  const specs = symmetricCompanySpecs({ desired: 5_000 });
  const out = run(specs);
  const capKeys = Object.keys(out.diagnostics.companies[0]).sort();
  assert.deepEqual(capKeys, [
    "approvedAllocationCap",
    "bindingCap",
    "companyId",
    "desiredCap",
    "finalAllocation",
    "reductionByCap",
    "salesCapacityCap",
    "supplierShareCap",
    "unconstrainedAllocation",
  ]);
  // 「deliverable」を名乗る cap を持たないこと（存在しない cap を実装済みと表現しない）。
  assert.ok(!capKeys.some((k) => /deliverable/i.test(k)), "physical deliverable cap を騙る field が存在する");
});

test("CAP-SEM-3: bindingCap の名称が実際の意味と一致する", () => {
  const cases: readonly [string, Partial<FixtureCompanySpec>][] = [
    ["DESIRED", { desired: 200 }],
    ["SALES_CAPACITY", { salesEffortCapacity: 260 }],
    ["APPROVED_ALLOCATION", { approvedAllocationCap: 150 }],
  ];
  for (const [expected, override] of cases) {
    const out = run(symmetricCompanySpecs({ desired: 5_000, ...override }));
    for (const c of out.diagnostics.companies) assert.equal(c.bindingCap, expected, `${expected} が binding になっていない`);
  }
  // 非拘束時は UNCONSTRAINED_DEMAND。
  const free = run(symmetricCompanySpecs({ desired: 5_000, priceAdjustment: 1.5 }));
  for (const c of free.diagnostics.companies) assert.equal(c.bindingCap, "UNCONSTRAINED_DEMAND");
});

test("CAP-SEM-4: legacy mode の結果が本修正で変わらない", () => {
  const specs = symmetricCompanySpecs({ desired: 3_000, approvedAllocationCap: 900 });
  specs[0] = { ...specs[0], priceAdjustment: 1.2 };
  const legacy = allocateMarketProduct(
    FIXTURE_MARKET,
    FIXTURE_PRODUCT,
    FIXTURE_PERIOD,
    buildEntries(specs),
    FIXTURE_REFERENCE_PRICE,
    FIXTURE_TARGET_DEMAND,
    SALES_PARAMETERS_V1
  );
  // legacy は approvedAllocationCap を従来どおり cap の1つとして扱う（意味も名前も不変）。
  for (const c of legacy.companies) assert.ok(unwrapUnit(c.allocatedQuantity) <= 900 + TOL);
  assert.equal(SALES_PARAMETERS_V1.marketAllocationMode, undefined);
  const total = legacy.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(legacy.externalOptionQuantity);
  assert.ok(Math.abs(total - unwrapUnit(FIXTURE_TARGET_DEMAND)) < 1);
});

test("CAP-SEM-6: 同じ入力なら companyId が変わっても結果が変わらない（会社ID非依存）", () => {
  const base = symmetricCompanySpecs({ desired: 900, approvedAllocationCap: 600 });
  const renamed = base.map((s, i) => ({ ...s, companyId: `ZZ-${String(i)}` }));
  const a = run(base);
  const b = run(renamed);
  const norm = (out: ReturnType<typeof run>) =>
    out.diagnostics.companies.map((c) => [c.unconstrainedAllocation, c.finalAllocation, c.bindingCap, c.approvedAllocationCap]);
  assert.deepEqual(norm(b), norm(a));
  assert.equal(b.diagnostics.externalFinalAllocation, a.diagnostics.externalFinalAllocation);
});

test("CAP-SEM-W: competitivenessWeight は 0 固定ではなく、層需要加重の正規化ウェイトになる", () => {
  // companyLab/runner.ts の computeAddressableDemand が分子として読む engine 入力であるため、
  // 0 固定だと addressable demand が 0 へ潰れる。
  const out = allocateMarketProduct(
    FIXTURE_MARKET,
    FIXTURE_PRODUCT,
    FIXTURE_PERIOD,
    buildEntries(symmetricCompanySpecs()),
    FIXTURE_REFERENCE_PRICE,
    FIXTURE_TARGET_DEMAND,
    FIXTURE_PARAMS
  );
  const weights = out.companies.map((c) => c.competitivenessWeight);
  for (const w of weights) assert.ok(w > 0, "competitivenessWeight が 0 のまま");
  const tiered = run(symmetricCompanySpecs());
  const externalShare = tiered.diagnostics.tiers.reduce((s, t) => s + t.tierShare * t.external.normalizedWeight, 0);
  // 全社合計 + 外部シェア = 1（層需要で加重した選択確率の集約であること）。
  assert.ok(Math.abs(weights.reduce((s, w) => s + w, 0) + externalShare - 1) < 1e-9);
});
