// ShrimpX V2 — ENG-TIERED-MKT-COMPAT-1
// SalesParameters SSoT（c9e2e90）× Tiered Market Allocation（c08a9e3d）の統合検証。
//
// 【固定する不変条件】
//  (1) salesParamsOverride = SALES_PARAMETERS_TIERED_FIXTURE_V0 を指定するだけで
//      （sai5.salesBaseAccumulation を true にしなくても）Sales Engine が
//      tieredSimultaneousAllocation 経路へ入る。
//  (2) tiered mode の addressableDemand は
//        targetDemand × Σ(company competitivenessWeight)
//      であり、legacy の w/(w+externalOptionWeight) を再適用しない
//      （tiered の competitivenessWeight は既に外部オプションを含む正規化シェアで
//        あり、再適用は外部の二重計上になる）。
//  (3) legacy mode（marketAllocationMode 未指定）の addressableDemand は
//      従来どおり computeAddressableDemand と完全一致する。
//
// marketEvolution.ts の computeAddressableDemand 自体は変更していない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { computeAddressableDemand } from "../marketEvolution";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import { unwrapUnit } from "../../core/units";
import { allocateMarketProduct } from "../../sales/allocation";
import { allocateMarketProductTiered } from "../../sales/tieredAllocation";
import {
  SALES_PARAMETERS_V1,
  SALES_PARAMETERS_SAI5_SALES_BASE_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1,
  SALES_PARAMETERS_TIERED_FIXTURE_V0,
  CustomerTierId,
} from "../../sales/parameters";
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
} from "../../sales/__tests__/tieredMarketAllocationFixture";

const EPS = 1e-9;

/** 1四半期だけ進めて記録を返す。sai5.productLifecycle は addressableDemand を記録させるため。 */
function runOneQuarter(overrides: Partial<CompanyLabConfig>) {
  const config = {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "compat-test",
    turns: 2,
    sai5: { productLifecycle: true },
    ...overrides,
  } as CompanyLabConfig;
  const init = initializeCompanyLab(config);
  let state: CompanyLabState = init.state;
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of init.fixtures) {
    decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  }
  state = advanceCompanyLabQuarter(state, init.fixtures, decisions);
  return state.history[state.history.length - 1];
}

const TIERED_OVERRIDE: Partial<CompanyLabConfig> = { salesParamsOverride: SALES_PARAMETERS_TIERED_FIXTURE_V0 } as Partial<CompanyLabConfig>;

/** 記録された配分から、各商品の Σ(targetDemand × Σw) を再計算する（tiered 期待式）。 */
function tieredExpectedAddressable(record: ReturnType<typeof runOneQuarter>) {
  const out = { pd: 0, vap: 0 } as Record<"pd" | "vap", number>;
  for (const a of record.salesRecord.allocations) {
    if (a.product !== "pd" && a.product !== "vap") continue;
    const w = a.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
    out[a.product] += unwrapUnit(a.targetDemand) * Math.min(1, Math.max(0, w));
  }
  return out;
}

/** 記録された配分から、legacy 期待式 Σ computeAddressableDemand を再計算する。 */
function legacyExpectedAddressable(record: ReturnType<typeof runOneQuarter>, externalOptionWeight: number) {
  const out = { pd: 0, vap: 0 } as Record<"pd" | "vap", number>;
  for (const a of record.salesRecord.allocations) {
    if (a.product !== "pd" && a.product !== "vap") continue;
    const w = a.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
    out[a.product] += computeAddressableDemand(unwrapUnit(a.targetDemand), w, externalOptionWeight);
  }
  return out;
}

function runTiered(specs: readonly FixtureCompanySpec[], product = FIXTURE_PRODUCT) {
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
const weightOf = (out: ReturnType<typeof runTiered>, id: string) =>
  out.result.companies.find((c) => c.companyId === id)!.competitivenessWeight;

// =====================================================================

test("COMPAT-1: salesParamsOverride だけで tiered 経路へ入る（salesBaseAccumulation 不要）", () => {
  // (a) Sales Engine の dispatch: tiered params を渡すと tiered 実装と完全一致。
  const specs = symmetricCompanySpecs();
  const viaDispatch = allocateMarketProduct(
    FIXTURE_MARKET,
    FIXTURE_PRODUCT,
    FIXTURE_PERIOD,
    buildEntries(specs),
    FIXTURE_REFERENCE_PRICE,
    FIXTURE_TARGET_DEMAND,
    FIXTURE_PARAMS,
    buildSalesCapacityMap(specs)
  );
  assert.deepEqual(viaDispatch, runTiered(specs).result);

  // (b) Runner 経路: salesBaseAccumulation を立てずに override だけを与える。
  const tiered = runOneQuarter(TIERED_OVERRIDE);
  const legacy = runOneQuarter({});
  const key = (r: ReturnType<typeof runOneQuarter>) =>
    r.salesRecord.allocations.map((a) => `${a.market}/${a.product}:${a.companies.map((c) => unwrapUnit(c.allocatedQuantity).toFixed(4)).join(",")}`).join("|");
  assert.notEqual(key(tiered), key(legacy), "override 指定でも legacy と同一＝tiered へ入っていない");

  // tiered の competitivenessWeight は正規化シェアなので全社合計 ≤ 1。
  for (const a of tiered.salesRecord.allocations) {
    const w = a.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
    assert.ok(w <= 1 + EPS, `tiered Σw>1: ${w}`);
  }
});

test("COMPAT-2: tiered の addressableDemand = targetDemand × Σ 正規化ウェイト", () => {
  const record = runOneQuarter(TIERED_OVERRIDE);
  const evo = record.sai5MarketEvolution;
  assert.ok(evo, "sai5MarketEvolution が記録されていない");
  const expected = tieredExpectedAddressable(record);
  for (const p of ["pd", "vap"] as const) {
    assert.ok(Math.abs(evo!.addressableDemandByProduct[p] - expected[p]) < 1e-6, `${p}: ${evo!.addressableDemandByProduct[p]} != ${expected[p]}`);
  }
});

test("COMPAT-3: legacy の addressableDemand は computeAddressableDemand と完全一致（不変）", () => {
  const record = runOneQuarter({});
  const evo = record.sai5MarketEvolution;
  assert.ok(evo);
  const expected = legacyExpectedAddressable(record, SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1.externalOptionWeight);
  for (const p of ["pd", "vap"] as const) {
    assert.ok(Math.abs(evo!.addressableDemandByProduct[p] - expected[p]) < 1e-9, `${p}: ${evo!.addressableDemandByProduct[p]} != ${expected[p]}`);
  }
});

test("COMPAT-4: tiered に legacy 式を再適用していない（外部の二重計上がない）", () => {
  const record = runOneQuarter(TIERED_OVERRIDE);
  const evo = record.sai5MarketEvolution!;
  const tieredExp = tieredExpectedAddressable(record);
  const legacyExp = legacyExpectedAddressable(record, SALES_PARAMETERS_TIERED_FIXTURE_V0.externalOptionWeight);
  for (const p of ["pd", "vap"] as const) {
    assert.ok(legacyExp[p] < tieredExp[p] - 1e-6, `${p}: legacy式が小さくならない（判別不能な fixture）`);
    assert.ok(Math.abs(evo.addressableDemandByProduct[p] - legacyExp[p]) > 1e-6, `${p}: legacy式のまま`);
    // 0 <= addressable <= targetDemand
    assert.ok(evo.addressableDemandByProduct[p] >= 0);
    assert.ok(evo.addressableDemandByProduct[p] <= evo.targetDemandByProduct[p] + 1e-6);
  }
});

test("COMPAT-5: desired cap は正規化ウェイト（＝addressable の分子）を変えない", () => {
  const base = symmetricCompanySpecs();
  const capped = symmetricCompanySpecs();
  capped[0] = { ...capped[0], desired: 10 };
  const a = runTiered(base);
  const b = runTiered(capped);
  for (const id of base.map((s) => s.companyId)) {
    assert.ok(Math.abs(weightOf(a, id) - weightOf(b, id)) < 1e-12, `${id} のウェイトが desired cap で変化した`);
  }
  // 実配分は変わる（cap は数量にのみ効く）。
  assert.ok(
    unwrapUnit(b.result.companies[0].allocatedQuantity) < unwrapUnit(a.result.companies[0].allocatedQuantity),
    "desired cap が数量へ効いていない"
  );
});

test("COMPAT-6: supplier share cap / approvedAllocationCap も正規化ウェイトを変えない", () => {
  const base = symmetricCompanySpecs();
  const capped = symmetricCompanySpecs();
  capped[1] = { ...capped[1], approvedAllocationCap: 100 };
  const a = runTiered(base);
  const b = runTiered(capped);
  for (const id of base.map((s) => s.companyId)) {
    assert.ok(Math.abs(weightOf(a, id) - weightOf(b, id)) < 1e-12, `${id} のウェイトが approvedAllocationCap で変化した`);
  }
  assert.ok(unwrapUnit(b.result.companies[1].allocatedQuantity) <= 100 + 0.02);
});

test("COMPAT-7: 値下げは正規化ウェイトを上げ、addressableDemand を増やす", () => {
  const flat = symmetricCompanySpecs();
  const cheaper = symmetricCompanySpecs();
  cheaper[0] = { ...cheaper[0], priceAdjustment: -1 };
  const a = runTiered(flat);
  const b = runTiered(cheaper);
  assert.ok(weightOf(b, "CO-A") > weightOf(a, "CO-A"), "値下げでウェイトが上がらない");
  const sumW = (o: ReturnType<typeof runTiered>) => o.result.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
  const target = unwrapUnit(FIXTURE_TARGET_DEMAND);
  assert.ok(target * sumW(b) > target * sumW(a), "値下げで addressableDemand が増えない");
});

test("COMPAT-8: 品質優位は PREMIUM 層でより大きなシェアを取る", () => {
  const specs = symmetricCompanySpecs();
  specs[0] = { ...specs[0], quality: 95 };
  const out = runTiered(specs);
  const shareIn = (tierId: CustomerTierId) => {
    const t = out.diagnostics.tiers.find((x) => x.tier === tierId)!;
    const c = t.companies.find((x) => x.companyId === "CO-A")!;
    return c.normalizedWeight;
  };
  const ids = out.diagnostics.tiers.map((t) => t.tier);
  assert.ok(ids.includes("PREMIUM") && ids.includes("PRICE_SENSITIVE"), `tier id: ${ids.join(",")}`);
  assert.ok(shareIn("PREMIUM") > shareIn("PRICE_SENSITIVE"), "品質優位が PREMIUM 層で相対的に効いていない");
});

test("COMPAT-9: tiered runner 記録でも需要保存（Σ配分 + 外部 = targetDemand）", () => {
  const record = runOneQuarter(TIERED_OVERRIDE);
  for (const a of record.salesRecord.allocations) {
    const q = a.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
    const total = q + unwrapUnit(a.externalOptionQuantity);
    assert.ok(Math.abs(total - unwrapUnit(a.targetDemand)) < 0.05 * a.companies.length + 0.05, `${a.market}/${a.product}: ${total} != ${unwrapUnit(a.targetDemand)}`);
  }
});

test("COMPAT-10: tiered 経路は決定的（同一入力で同一記録）", () => {
  const a = runOneQuarter(TIERED_OVERRIDE);
  const b = runOneQuarter(TIERED_OVERRIDE);
  assert.deepEqual(JSON.parse(JSON.stringify(a.salesRecord)), JSON.parse(JSON.stringify(b.salesRecord)));
  assert.deepEqual(a.sai5MarketEvolution?.addressableDemandByProduct, b.sai5MarketEvolution?.addressableDemandByProduct);
});

test("COMPAT-11: 本番 SalesParameters 4種は marketAllocationMode 未指定＝legacy", () => {
  for (const p of [
    SALES_PARAMETERS_V1,
    SALES_PARAMETERS_SAI5_SALES_BASE_V1,
    SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
    SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1,
  ]) {
    assert.equal(p.marketAllocationMode, undefined);
    assert.equal(p.tieredMarketAllocation, undefined);
  }
  assert.equal(SALES_PARAMETERS_TIERED_FIXTURE_V0.marketAllocationMode, "tieredSimultaneousAllocation");
});
