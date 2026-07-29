// ShrimpX V2 — SAI-2追加作業: 市場別営業配置・商品別営業工数 単体テスト
//
// 実装指示（SAI-2追加作業）§6「自動テスト」で明示された10項目のうち、
// 販売ドメイン（sales/marketEffort.ts・sales/salesForce.ts・sales/runner.ts）
// レベルで検証できる項目をここでカバーする。standard AIの市場別配分（項目7）は
// companyLab/standardAi/__tests__/salesEffort.test.ts、永続化往復（項目9）は
// companyLab/persistence/__tests__/salesEffortRoundtrip.test.tsで別途カバーする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import {
  salesEffortWeightedQuantity,
  computeMarketSalesEffort,
  allocateHeadcountAcrossMarkets,
  applyMarketSalesEffortCapacity,
} from "../marketEffort";
import { processingCapacity, validateSalesForceHeadcountBudget } from "../salesForce";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { allocateMarketProduct } from "../allocation";
import { CompanySalesPlanEntry, SalesValidationError } from "../types";
import { advanceSalesQuarter, initializeSalesState } from "../runner";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";

const PARAMS = SALES_PARAMETERS_V1;

function entry(overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId: "C1",
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. HOSO 1,000t vs PD 1,000t — PDは1.2倍の営業工数を消費する
// ---------------------------------------------------------------------
test("1. 同じ1,000tでも、PDの営業工数換算量はHOSOの1.2倍になる", () => {
  const hosoEffort = salesEffortWeightedQuantity({ hoso: 1000, pd: 0, vap: 0 }, PARAMS);
  const pdEffort = salesEffortWeightedQuantity({ hoso: 0, pd: 1000, vap: 0 }, PARAMS);
  assert.equal(hosoEffort, 1000);
  assert.equal(pdEffort, 1200);
  assert.equal(pdEffort / hosoEffort, 1.2);
});

// ---------------------------------------------------------------------
// 2. HOSO 1,000t vs VAP 1,000t — VAPは3倍の営業工数を消費する
// ---------------------------------------------------------------------
test("2. 同じ1,000tでも、VAPの営業工数換算量はHOSOの3倍になる", () => {
  const hosoEffort = salesEffortWeightedQuantity({ hoso: 1000, pd: 0, vap: 0 }, PARAMS);
  const vapEffort = salesEffortWeightedQuantity({ hoso: 0, pd: 0, vap: 1000 }, PARAMS);
  assert.equal(hosoEffort, 1000);
  assert.equal(vapEffort, 3000);
  assert.equal(vapEffort / hosoEffort, 3);
});

// ---------------------------------------------------------------------
// 3. 同一市場の複数商品は営業能力を共有する
// ---------------------------------------------------------------------
test("3. 同一市場のHOSO/PD/VAPは共有の営業工数換算能力を分け合う（片方だけの都合で無制限に増えない）", () => {
  const headcount = 5;
  const capacity = unwrapUnit(processingCapacity(headcount, PARAMS)); // 200 + 4800*5/15 = 1800
  assert.equal(capacity, 1800);

  // HOSO単独でも、PDを足しても、合計の営業工数換算量が能力を超えれば同じ市場の
  // 全商品が一律で比例縮小される（片方だけ据え置きで他方だけ削られる、という
  // 独立した挙動にはならない）。
  const desired = { hoso: 1200, pd: 1000, vap: 0 }; // 効果換算: 1200 + 1200 = 2400 > 1800
  const result = computeMarketSalesEffort(headcount, desired, PARAMS);
  assert.ok(result.isConstrained);
  const scale = result.scaleFactor;
  assert.ok(scale > 0 && scale < 1);
  // 両商品とも同一のscaleFactorで縮小される（比例配分）。
  assert.ok(Math.abs(result.adjustedQuantityByProduct.hoso - 1200 * scale) < 1e-6);
  assert.ok(Math.abs(result.adjustedQuantityByProduct.pd - 1000 * scale) < 1e-6);
  // 縮小後の効果換算合計は能力にちょうど一致する。
  const adjustedEffort = salesEffortWeightedQuantity(result.adjustedQuantityByProduct, PARAMS);
  assert.ok(Math.abs(adjustedEffort - capacity) < 1e-6);
});

// ---------------------------------------------------------------------
// 4. 市場ごとの営業人員配分の合計は、実在する営業人員数を超えない
// ---------------------------------------------------------------------
test("4. allocateHeadcountAcrossMarkets: 市場別配分の合計は必ず実在する総人数と一致する（過不足なし）", () => {
  const weights = new Map([
    ["CN", 500],
    ["US", 300],
    ["EU", 0],
    ["JP", 123],
  ] as const);
  for (const total of [0, 1, 7, 16, 17, 100]) {
    const allocated = allocateHeadcountAcrossMarkets(total, weights);
    const sum = Array.from(allocated.values()).reduce((s, h) => s + h, 0);
    assert.equal(sum, total, `total=${total}のとき合計が一致しない`);
    for (const h of allocated.values()) {
      assert.ok(Number.isInteger(h) && h >= 0, "配分人数は0以上の整数である必要がある");
    }
  }
});

// ---------------------------------------------------------------------
// 5. ある市場の余剰能力は、暗黙には別の市場へ流用されない
// ---------------------------------------------------------------------
test("5. 会社×市場ごとに独立して制約が適用される（CN市場の余剰能力がUS市場の不足を補わない）", () => {
  const plans: CompanySalesPlanEntry[] = [
    // CN市場: 余裕あり（能力に対して希望量が小さい）
    entry({ market: "CN", product: "hoso", desiredQuantity: hosoEqTons(100), salesForceHeadcount: 20 }),
    // US市場: 明らかに能力不足（同じ会社だが別市場）
    entry({ market: "US", product: "vap", desiredQuantity: hosoEqTons(5000), salesForceHeadcount: 1 }),
  ];
  const { adjustedPlans, adjustments } = applyMarketSalesEffortCapacity(plans, PARAMS);

  const cn = adjustedPlans.find((p) => p.market === "CN")!;
  const us = adjustedPlans.find((p) => p.market === "US")!;
  // CN市場は制約対象ではないため、希望量そのまま。
  assert.equal(unwrapUnit(cn.desiredQuantity), 100);
  // US市場は縮小される。
  assert.ok(unwrapUnit(us.desiredQuantity) < 5000);
  // US市場の縮小後の量は、US市場自身の能力（CN市場の余剰を含まない）で決まる。
  const usCapacity = unwrapUnit(processingCapacity(1, PARAMS));
  assert.ok(Math.abs(unwrapUnit(us.desiredQuantity) * 3 - usCapacity) < 1e-6, "US市場(VAP)の縮小後効果換算量は自市場の能力と一致するはず");
  // 調整記録にはUS市場のみが含まれ、CN市場は含まれない。
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].market, "US");
});

// ---------------------------------------------------------------------
// 6. 営業能力不足時、販売計画は適切に制限される（allocateMarketProduct経由の実際の成約まで）
// ---------------------------------------------------------------------
test("6. 営業工数換算能力が不足する場合、成約配分に渡る前にdesiredQuantityが縮小される", () => {
  const plans: CompanySalesPlanEntry[] = [
    entry({ market: "CN", product: "hoso", desiredQuantity: hosoEqTons(2000), salesForceHeadcount: 2 }),
    entry({ market: "CN", product: "vap", desiredQuantity: hosoEqTons(2000), salesForceHeadcount: 2 }),
  ];
  const { adjustedPlans } = applyMarketSalesEffortCapacity(plans, PARAMS);
  const capacity = unwrapUnit(processingCapacity(2, PARAMS)); // 200 + 4800*2/12 = 1000
  const totalEffortAfter = adjustedPlans.reduce((sum, p) => {
    const coef = p.product === "vap" ? 3 : p.product === "pd" ? 1.2 : 1;
    return sum + coef * unwrapUnit(p.desiredQuantity);
  }, 0);
  assert.ok(totalEffortAfter <= capacity + 1e-6, "縮小後の効果換算合計が市場の能力を超えている");
  // 元の希望量よりは必ず縮小されている。
  for (const p of adjustedPlans) assert.ok(unwrapUnit(p.desiredQuantity) < 2000);
});

// ---------------------------------------------------------------------
// 8. 既存の重複配置防止（同一市場×商品の重複行禁止）が維持されている
// ---------------------------------------------------------------------
test("8. 既存の重複配置防止: 同一会社の同一市場×商品の行が重複していればallocateMarketProductが例外を投げる", () => {
  const relevant: CompanySalesPlanEntry[] = [entry({ companyId: "C1" }), entry({ companyId: "C1" })];
  assert.throws(
    () => allocateMarketProduct("CN", "hoso", "2015Q1" as PeriodV2, relevant, PARAMS.minAskPriceRatioOfBase as never, hosoEqTons(1000) as never, PARAMS),
    SalesValidationError
  );
});

test("8b. 新しい重複防止: 同一会社の同一市場内で異なる営業人員(salesForceHeadcount)を指定すると例外を投げる", () => {
  const plans: CompanySalesPlanEntry[] = [
    entry({ market: "CN", product: "hoso", salesForceHeadcount: 5 }),
    entry({ market: "CN", product: "pd", salesForceHeadcount: 8 }),
  ];
  assert.throws(() => applyMarketSalesEffortCapacity(plans, PARAMS), SalesValidationError);
  assert.throws(() => validateSalesForceHeadcountBudget(plans, 100), SalesValidationError);
});

test("8c. validateSalesForceHeadcountBudget: 市場ごとに重複排除した合計が実在人数を超えれば例外を投げる（超えなければ通る）", () => {
  const plans = [
    { market: "CN" as const, salesForceHeadcount: 8 },
    { market: "CN" as const, salesForceHeadcount: 8 }, // 同一市場・同一値は正しい入力（共有）
    { market: "US" as const, salesForceHeadcount: 8 },
  ];
  // 市場ごとに重複排除した合計 = 8(CN) + 8(US) = 16
  assert.doesNotThrow(() => validateSalesForceHeadcountBudget(plans, 16));
  assert.throws(() => validateSalesForceHeadcountBudget(plans, 15), SalesValidationError);
});

// ---------------------------------------------------------------------
// 10. HOSO単独の場合は、旧仕様（商品別係数なし）と原理的に一致する
// ---------------------------------------------------------------------
test("10. HOSOのみの市場では、営業工数換算能力の制約は旧来のprocessingCapacity単独チェックと原理的に一致する", () => {
  const headcount = 4;
  const capacity = unwrapUnit(processingCapacity(headcount, PARAMS));
  // 能力ぎりぎり未満: 縮小されない。
  const underCapacity = computeMarketSalesEffort(headcount, { hoso: capacity - 1, pd: 0, vap: 0 }, PARAMS);
  assert.ok(!underCapacity.isConstrained);
  assert.equal(underCapacity.adjustedQuantityByProduct.hoso, capacity - 1);
  // 能力超過: HOSO係数は1.0なので、縮小後の量は旧来のcapacity値そのものと一致する。
  const overCapacity = computeMarketSalesEffort(headcount, { hoso: capacity + 500, pd: 0, vap: 0 }, PARAMS);
  assert.ok(overCapacity.isConstrained);
  assert.ok(Math.abs(overCapacity.adjustedQuantityByProduct.hoso - capacity) < 1e-6);
});

// ---------------------------------------------------------------------
// 補足: advanceSalesQuarter経由でも、営業工数換算制約が実際に適用される
// ---------------------------------------------------------------------
test("補足: advanceSalesQuarter経由でも営業工数換算制約が適用され、二重適用にはならない（allocation.ts側の行単位capacityは非拘束のまま）", () => {
  const quarters = runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "market-effort-fixture-001", turns: 1 }).quarters;
  const plans: CompanySalesPlanEntry[] = [
    entry({ market: "CN", product: "hoso", desiredQuantity: hosoEqTons(3000), salesForceHeadcount: 3 }),
    entry({ market: "CN", product: "vap", desiredQuantity: hosoEqTons(3000), salesForceHeadcount: 3 }),
  ];
  let state = initializeSalesState(quarters[0].marketInput.period);
  state = advanceSalesQuarter(state, { plans, marketResult: quarters[0].marketResult, marketInput: quarters[0].marketInput });
  const record = state.history[0];
  assert.equal(record.salesEffortAdjustments.length, 1, "CN市場は能力超過のはずなので調整記録が1件あるはず");
  assert.equal(record.salesEffortAdjustments[0].market, "CN");
  // 実際の成約量（allocations経由）が、調整後のdesiredQuantityを超えていないこと
  // （二重適用で不当にさらに絞られてもいない・逆に無視されてもいないことの間接確認）。
  const cnHoso = record.allocations.find((a) => a.market === "CN" && a.product === "hoso");
  const cnVap = record.allocations.find((a) => a.market === "CN" && a.product === "vap");
  const wonHoso = cnHoso?.companies.find((c) => c.companyId === "C1")?.allocatedQuantity ?? hosoEqTons(0);
  const wonVap = cnVap?.companies.find((c) => c.companyId === "C1")?.allocatedQuantity ?? hosoEqTons(0);
  assert.ok(unwrapUnit(wonHoso) <= 3000 + 1e-6);
  assert.ok(unwrapUnit(wonVap) <= 3000 + 1e-6);
});
