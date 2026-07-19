import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDomesticPurchaseIntent,
  applyDomesticPurchaseIntentOverride,
  allocateDomesticPurchase,
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

test("aggregateDomesticPurchaseIntentは全社の希望量を単純合計する", () => {
  const plans = [entry("A", { desiredQuantity: hosoEqTons(100) }), entry("B", { desiredQuantity: hosoEqTons(250) })];
  const total = aggregateDomesticPurchaseIntent(plans);
  assert.equal(unwrapUnit(total), 350);
});

test("applyDomesticPurchaseIntentOverrideはvietnamDomestic.domesticProcurementIntentだけを置き換え、他のフィールドは変更しない", () => {
  const marketInput = {
    vietnamDomestic: {
      domesticRawSupply: hosoEqTons(1000),
      domesticProcurementIntent: hosoEqTons(999),
      trailingAverageDomesticPurchase: hosoEqTons(500),
      hosoYieldRatio: 0.9,
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

test("国内買付希望量の増加により、他条件一定なら国内原料価格が上昇する方向のシグナルになる（希望量集計がPhase3入力へそのまま伝わる）", () => {
  const low = aggregateDomesticPurchaseIntent([entry("A", { desiredQuantity: hosoEqTons(100) })]);
  const high = aggregateDomesticPurchaseIntent([entry("A", { desiredQuantity: hosoEqTons(1000) })]);
  assert.ok(unwrapUnit(high) > unwrapUnit(low));
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
