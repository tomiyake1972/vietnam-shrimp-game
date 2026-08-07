import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDomesticPurchaseIntent,
  applyDomesticPurchaseIntentOverride,
  allocateDomesticPurchase,
  calculateEffectivePurchaseIntent,
  procurementCapacity,
} from "../domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../parameters";
import { DomesticPurchasePlanEntry, RawMaterialsValidationError } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { MarketQuarterInput } from "../../market/types";

const P1 = period(2015, 1);
const MARKET_PRICE = usdPerHosoEqKg(3.0);

function entry(companyId: string, overrides: Partial<DomesticPurchasePlanEntry> = {}): DomesticPurchasePlanEntry {
  return {
    companyId,
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    procurementHeadcount: 5,
    ...overrides,
  };
}

test("aggregateDomesticPurchaseIntentは各社の有効買付意向（信認上限適用後）を合計する", () => {
  // procurementHeadcount=100（処理能力が十分大きい）、referenceSupplyも十分大きくして
  // desiredQuantity自体が信認上限を超えない条件では、単純合計と一致する。
  const plans = [
    entry("A", { desiredQuantity: hosoEqTons(100), procurementHeadcount: 100 }),
    entry("B", { desiredQuantity: hosoEqTons(250), procurementHeadcount: 100 }),
  ];
  const total = aggregateDomesticPurchaseIntent(plans, hosoEqTons(100000), RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(unwrapUnit(total), 350);
});

test("applyDomesticPurchaseIntentOverrideはvietnamDomestic.domesticProcurementIntentだけを置き換え、他のフィールドは変更しない", () => {
  const marketInput = {
    vietnamDomestic: {
      domesticRawSupply: hosoEqTons(1000),
      domesticProcurementIntent: hosoEqTons(999),
      trailingAverageDomesticPurchase: hosoEqTons(500),
      hosoEqRecoveryRatio: 0.9,
      processingExportCostUsdPerKg: 0.1,
      requiredMarginUsdPerKg: 0.2,
    },
  } as unknown as MarketQuarterInput;

  const overridden = applyDomesticPurchaseIntentOverride(marketInput, hosoEqTons(777));
  assert.equal(unwrapUnit(overridden.vietnamDomestic.domesticProcurementIntent), 777);
  assert.equal(unwrapUnit(overridden.vietnamDomestic.domesticRawSupply), 1000);
  // 元の入力は変更されない（不変更新）。
  assert.equal(unwrapUnit(marketInput.vietnamDomestic.domesticProcurementIntent), 999);
});

test("全社合計配分量は供給量を超えない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id) => entry(id, { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 20 }));
  const supply = hosoEqTons(3000);
  const result = allocateDomesticPurchase(P1, entries, MARKET_PRICE, supply, RAW_MATERIALS_PARAMETERS_V1);
  const total = result.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  assert.ok(total <= unwrapUnit(supply) + 0.1);
  assert.ok(Math.abs(total + unwrapUnit(result.unallocatedSupply) - unwrapUnit(supply)) < 0.1);
});

test("各社配分量は買付希望量を超えない", () => {
  const entries = ["A", "B", "C"].map((id) => entry(id, { desiredQuantity: hosoEqTons(20), procurementHeadcount: 30 }));
  const result = allocateDomesticPurchase(P1, entries, MARKET_PRICE, hosoEqTons(100000), RAW_MATERIALS_PARAMETERS_V1);
  for (const c of result.companies) {
    assert.ok(unwrapUnit(c.allocatedQuantity) <= 20 + 1e-6);
  }
});

test("入力順（配列の並び）を変えても結果が変わらない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id, i) => entry(id, { priceAdjustmentUsdPerHosoEqKg: (i - 2) * 0.1, procurementHeadcount: i * 3 }));
  const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]];

  const resultA = allocateDomesticPurchase(P1, entries, MARKET_PRICE, hosoEqTons(4000), RAW_MATERIALS_PARAMETERS_V1);
  const resultB = allocateDomesticPurchase(P1, shuffled, MARKET_PRICE, hosoEqTons(4000), RAW_MATERIALS_PARAMETERS_V1);
  assert.deepEqual(resultA, resultB);
});

test("他条件一定で提示買付価格を上げると配分量が増える（国内原料価格が実質的に上昇する方向に効く）", () => {
  const priceAdjustments = [-0.3, -0.15, 0, 0.15, 0.3];
  const entries = priceAdjustments.map((adj, i) => entry(`P${i}`, { priceAdjustmentUsdPerHosoEqKg: adj, desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 8 }));
  const result = allocateDomesticPurchase(P1, entries, MARKET_PRICE, hosoEqTons(3000), RAW_MATERIALS_PARAMETERS_V1);

  const quantities = priceAdjustments.map((_, i) => unwrapUnit(result.companies.find((c) => c.companyId === `P${i}`)!.allocatedQuantity));
  for (let i = 1; i < quantities.length; i++) {
    assert.ok(quantities[i] > quantities[i - 1], `higher bid price should yield higher allocation: ${quantities.join(",")}`);
  }
});

test("各社の実配分量は調達処理能力（procurementHeadcountに基づく）を超えない", () => {
  const entries = ["A", "B", "C", "D", "E"].map((id, i) => entry(id, { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: i * 3 }));
  const result = allocateDomesticPurchase(P1, entries, MARKET_PRICE, hosoEqTons(1000000), RAW_MATERIALS_PARAMETERS_V1);
  for (let i = 0; i < entries.length; i++) {
    const capacity = procurementCapacity(i * 3, RAW_MATERIALS_PARAMETERS_V1);
    const c = result.companies.find((x) => x.companyId === entries[i].companyId)!;
    assert.ok(unwrapUnit(c.allocatedQuantity) <= unwrapUnit(capacity) + 1e-6);
  }
});

test("国内買付希望量の増加により、他条件一定なら国内原料価格が上昇する方向のシグナルになる（希望量集計がPhase3入力へそのまま伝わる）", () => {
  const referenceSupply = hosoEqTons(100000); // 信認上限が効かない十分大きい基準供給量
  const low = aggregateDomesticPurchaseIntent([entry("A", { desiredQuantity: hosoEqTons(100), procurementHeadcount: 100 })], referenceSupply, RAW_MATERIALS_PARAMETERS_V1);
  const high = aggregateDomesticPurchaseIntent([entry("A", { desiredQuantity: hosoEqTons(1000), procurementHeadcount: 100 })], referenceSupply, RAW_MATERIALS_PARAMETERS_V1);
  assert.ok(unwrapUnit(high) > unwrapUnit(low));
});

test("全社の信認された需要増加では、有効買付意向の合計が上昇する（信認上限に収まる範囲での増加）", () => {
  const referenceSupply = hosoEqTons(100000);
  const before = aggregateDomesticPurchaseIntent(
    ["A", "B", "C"].map((id) => entry(id, { desiredQuantity: hosoEqTons(500), procurementHeadcount: 50 })),
    referenceSupply,
    RAW_MATERIALS_PARAMETERS_V1
  );
  const after = aggregateDomesticPurchaseIntent(
    ["A", "B", "C"].map((id) => entry(id, { desiredQuantity: hosoEqTons(800), procurementHeadcount: 50 })),
    referenceSupply,
    RAW_MATERIALS_PARAMETERS_V1
  );
  assert.ok(unwrapUnit(after) > unwrapUnit(before));
});

test("1社が買付希望量を極端に増やしても、その会社の有効買付意向は信認上限を超えない（100万トン等の非現実的希望量で価格を際限なく操作できない）", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const referenceSupply = hosoEqTons(1000);
  const extreme = entry("A", { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 20 });
  const effective = calculateEffectivePurchaseIntent(extreme, referenceSupply, params);

  const capacity = procurementCapacity(20, params);
  const shareCap = unwrapUnit(referenceSupply) * params.domesticPurchase.maximumPriceInfluenceShare;
  const expectedCap = Math.min(unwrapUnit(capacity), shareCap);
  assert.ok(unwrapUnit(effective) <= expectedCap + 1e-6);
  assert.ok(unwrapUnit(effective) < 1000000, "非現実的な希望量がそのまま有効買付意向へは反映されないはず");
});

test("極端な希望量を持つ1社を含めても、全社合計の有効買付意向（=国内価格へ渡す買付意向）が青天井にならない", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const referenceSupply = hosoEqTons(1000);
  const normalPlans = ["B", "C", "D", "E"].map((id) => entry(id, { desiredQuantity: hosoEqTons(200), procurementHeadcount: 5 }));
  const withoutExtreme = aggregateDomesticPurchaseIntent(normalPlans, referenceSupply, params);
  const withExtreme = aggregateDomesticPurchaseIntent(
    [...normalPlans, entry("A", { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 20 })],
    referenceSupply,
    params
  );
  // Aの追加分は referenceSupply * maximumPriceInfluenceShare （信認上限）でしか増えない
  // ＝希望量を100万トンにしても、青天井には増加しない。
  const maxIncrease = unwrapUnit(referenceSupply) * params.domesticPurchase.maximumPriceInfluenceShare;
  assert.ok(unwrapUnit(withExtreme) - unwrapUnit(withoutExtreme) <= maxIncrease + 1e-6);
});

test("調達人員ゼロまたは少数の会社は、希望量だけを大きくしても大きな価格影響力（有効買付意向）を持てない", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const referenceSupply = hosoEqTons(1000000); // shareCapが効かないほど大きい基準供給量
  const zeroHeadcount = entry("A", { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 0 });
  const effective = calculateEffectivePurchaseIntent(zeroHeadcount, referenceSupply, params);
  const capacityAtZero = procurementCapacity(0, params);
  assert.ok(Math.abs(unwrapUnit(effective) - unwrapUnit(capacityAtZero)) < 1e-6, "調達人員ゼロなら処理能力（baselineCapacityTons）が有効買付意向の上限になるはず");
  assert.ok(unwrapUnit(effective) < 1000, "調達人員ゼロの会社は非現実的な希望量でも小さな有効買付意向にしかならないはず");
});

test("approvedPurchaseCapは価格形成用の有効買付意向にも適用される", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const referenceSupply = hosoEqTons(100000);
  const capped = entry("A", { desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 100, approvedPurchaseCap: hosoEqTons(30) });
  const effective = calculateEffectivePurchaseIntent(capped, referenceSupply, params);
  assert.ok(unwrapUnit(effective) <= 30 + 1e-6);
});

test("大幅な高値提示でも価格競争力が設定上限で頭打ちになる（法外な高値の独占防止）", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const highBids = [0.2, 0.3, 0.45];
  const entries = highBids.map((b, i) => entry(`H${i}`, { priceAdjustmentUsdPerHosoEqKg: b * unwrapUnit(MARKET_PRICE), desiredQuantity: hosoEqTons(1000000), procurementHeadcount: 8 }));
  const result = allocateDomesticPurchase(P1, entries, MARKET_PRICE, hosoEqTons(20000), params);
  const weights = highBids.map((_, i) => result.companies.find((c) => c.companyId === `H${i}`)!.competitivenessWeight);
  assert.ok(Math.abs(weights[0] - weights[1]) < 1e-9);
  assert.ok(Math.abs(weights[1] - weights[2]) < 1e-9);
});

test("極端な高値・大量希望量でも1社の配分量が最大買付シェアを超えない", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const extreme = entry("X", { priceAdjustmentUsdPerHosoEqKg: 0.45 * unwrapUnit(MARKET_PRICE), procurementHeadcount: 1000, desiredQuantity: hosoEqTons(1000000) });
  const others = ["B", "C", "D", "E"].map((id) => entry(id, { procurementHeadcount: 5 }));
  const supply = hosoEqTons(10000);
  const result = allocateDomesticPurchase(P1, [extreme, ...others], MARKET_PRICE, supply, params);
  const x = result.companies.find((c) => c.companyId === "X")!;
  const maxShareCap = unwrapUnit(supply) * params.domesticPurchase.maximumBuyerShare;
  assert.ok(unwrapUnit(x.allocatedQuantity) <= maxShareCap + 0.1);
});

test("承認済み買付枠を指定した場合、その数量を超えない", () => {
  const params = RAW_MATERIALS_PARAMETERS_V1;
  const capped = entry("A", {
    priceAdjustmentUsdPerHosoEqKg: 0.45 * unwrapUnit(MARKET_PRICE),
    procurementHeadcount: 1000,
    desiredQuantity: hosoEqTons(1000000),
    approvedPurchaseCap: hosoEqTons(50),
  });
  const others = ["B", "C", "D", "E"].map((id) => entry(id, { procurementHeadcount: 5 }));
  const result = allocateDomesticPurchase(P1, [capped, ...others], MARKET_PRICE, hosoEqTons(10000), params);
  const a = result.companies.find((c) => c.companyId === "A")!;
  assert.ok(unwrapUnit(a.allocatedQuantity) <= 50 + 1e-6);
});

test("提示買付価格が許容範囲外だとRawMaterialsValidationErrorを投げる", () => {
  const tooLow = [entry("A", { priceAdjustmentUsdPerHosoEqKg: -10 })];
  assert.throws(() => allocateDomesticPurchase(P1, tooLow, MARKET_PRICE, hosoEqTons(1000), RAW_MATERIALS_PARAMETERS_V1), RawMaterialsValidationError);

  const tooHigh = [entry("A", { priceAdjustmentUsdPerHosoEqKg: 100 })];
  assert.throws(() => allocateDomesticPurchase(P1, tooHigh, MARKET_PRICE, hosoEqTons(1000), RAW_MATERIALS_PARAMETERS_V1), RawMaterialsValidationError);
});

test("同じ会社の買付計画が重複しているとRawMaterialsValidationErrorを投げる", () => {
  const dup = [entry("A"), entry("A", { priceAdjustmentUsdPerHosoEqKg: 0.1 })];
  assert.throws(() => allocateDomesticPurchase(P1, dup, MARKET_PRICE, hosoEqTons(1000), RAW_MATERIALS_PARAMETERS_V1), RawMaterialsValidationError);
});
