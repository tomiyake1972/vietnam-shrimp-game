// ShrimpX V2 — Procurement Planning: procurementPricingViewModel のテスト（PROC-PRICE-1〜10）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { period } from "../../../lib/v2/core/period";
import { CountryId } from "../../../lib/v2/market/types";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../../lib/v2/rawMaterials/parameters";
import { RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import {
  buildAquaculturePricingViewModel,
  buildDomesticPricingViewModel,
  buildImportPricingRows,
  buildRawMaterialCostSummary,
  toCostSummaryLotLike,
} from "../procurementPricingViewModel";

const P = RAW_MATERIALS_PARAMETERS_V1;

// PROC-PRICE-1: Implied Offer Price = Reference + Adjustment（値上げ）
test("PROC-PRICE-1: Implied Offer Price は Reference Price + Price Adjustment（値上げ）", () => {
  const vm = buildDomesticPricingViewModel(2.5, 0.2);
  assert.equal(vm.referencePriceUsdPerHosoEqKg, 2.5);
  assert.equal(vm.priceAdjustmentUsdPerHosoEqKg, 0.2);
  assert.equal(vm.impliedOfferPriceUsdPerHosoEqKg, 2.7);
});

// PROC-PRICE-2: 値引き（負のadjustment）も同じ式で成立する
test("PROC-PRICE-2: 値引き（priceAdjustmentが負）でもImplied Offer Priceは同じ加算式", () => {
  const vm = buildDomesticPricingViewModel(2.5, -0.3);
  assert.ok(Math.abs(vm.impliedOfferPriceUsdPerHosoEqKg - 2.2) < 1e-9);
});

// PROC-PRICE-3: Valid Bid Range は既存パラメータ(min/maxBidPriceRatioOfMarket)から導出される
test("PROC-PRICE-3: Valid Bid Range は minBidPriceRatioOfMarket/maxBidPriceRatioOfMarketから導出される", () => {
  const vm = buildDomesticPricingViewModel(2.5, 0);
  assert.ok(Math.abs(vm.validBidRange.minUsdPerHosoEqKg - 2.5 * P.domesticPurchase.minBidPriceRatioOfMarket) < 1e-9);
  assert.ok(Math.abs(vm.validBidRange.maxUsdPerHosoEqKg - 2.5 * P.domesticPurchase.maxBidPriceRatioOfMarket) < 1e-9);
});

// PROC-PRICE-4: Implied Offer PriceがValid Bid Range内かどうかを正しく判定する
test("PROC-PRICE-4: isWithinValidBidRangeが範囲内・範囲外を正しく判定する", () => {
  const within = buildDomesticPricingViewModel(2.5, 0.1);
  assert.equal(within.isWithinValidBidRange, true);

  // referencePrice(2.5) × maxRatio を超える極端な値上げは範囲外になる。
  const excessive = 2.5 * (P.domesticPurchase.maxBidPriceRatioOfMarket + 1) - 2.5;
  const outOfRange = buildDomesticPricingViewModel(2.5, excessive);
  assert.equal(outOfRange.isWithinValidBidRange, false);
});

// PROC-PRICE-5: 輸入着地価格の内訳は原産国別にcalculateLandedPriceをそのまま呼ぶ
test("PROC-PRICE-5: 輸入着地価格の内訳（duty/freight/insurance/adjustment/landed）を原産国別に取得できる", () => {
  const origins: readonly CountryId[] = ["EC", "ID"];
  const fob: Readonly<Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>> = {
    EC: usdPerHosoEqKg(5.0),
    IN: usdPerHosoEqKg(4.0),
    ID: usdPerHosoEqKg(4.5),
    VN: usdPerHosoEqKg(3.5),
  };
  const rows = buildImportPricingRows(origins, fob);
  assert.equal(rows.length, 2);
  const ec = rows.find((r) => r.originCountry === "EC")!;
  assert.ok(Math.abs(ec.breakdown.originPrice - 5.0) < 1e-9);
  assert.ok(Math.abs(ec.breakdown.freightUsdPerHosoEqKg - P.imports.freightUsdPerHosoEqKg) < 1e-9);
  assert.ok(Math.abs(ec.breakdown.dutyAndTaxUsdPerHosoEqKg - 5.0 * P.imports.dutyRatio) < 1e-9);
  // landedPrice = origin + duty + freight + insurance + countryAdjustment
  const expectedLanded =
    5.0 + 5.0 * P.imports.dutyRatio + P.imports.freightUsdPerHosoEqKg + P.imports.insuranceHandlingUsdPerHosoEqKg + (P.imports.originCountryAdjustmentUsdPerHosoEqKg.EC ?? 0);
  assert.ok(Math.abs(ec.breakdown.landedPrice - expectedLanded) < 1e-6);
});

// PROC-PRICE-6: 養殖単価は既存パラメータをそのまま返す（UI独自定数を作らない）
test("PROC-PRICE-6: 養殖単価パラメータをそのまま返す", () => {
  const vm = buildAquaculturePricingViewModel();
  assert.equal(vm.unitCostUsdPerHosoEqKg, P.aquaculture.aquacultureUnitCostUsdPerHosoEqKg);
});

// PROC-PRICE-7: 加重平均原料単価はsource別に正しく算出される
test("PROC-PRICE-7: source別の数量加重平均単価とシェアが正しく算出される", () => {
  const summary = buildRawMaterialCostSummary([
    { source: "domestic", remainingQuantity: 1000, unitCost: 2.0 },
    { source: "domestic", remainingQuantity: 500, unitCost: 3.0 },
    { source: "import", remainingQuantity: 500, unitCost: 4.0 },
  ]);
  const domestic = summary.bySource.find((s) => s.source === "domestic")!;
  assert.equal(domestic.quantityTons, 1500);
  // (1000*2.0 + 500*3.0) / 1500 = 2.333...
  assert.ok(Math.abs((domestic.weightedAverageUnitCostUsdPerHosoEqKg ?? 0) - (1000 * 2.0 + 500 * 3.0) / 1500) < 1e-9);
  assert.ok(Math.abs(domestic.shareOfTotal - 1500 / 2000) < 1e-9);
  assert.equal(summary.totalQuantityTons, 2000);
});

// PROC-PRICE-8: 数量0のsourceはweightedAverageUnitCostがundefined（0除算を捏造しない）
test("PROC-PRICE-8: 数量0のsourceのweightedAverageUnitCostUsdPerHosoEqKgはundefined", () => {
  const summary = buildRawMaterialCostSummary([{ source: "domestic", remainingQuantity: 100, unitCost: 2.0 }]);
  const aquaculture = summary.bySource.find((s) => s.source === "aquaculture")!;
  assert.equal(aquaculture.quantityTons, 0);
  assert.equal(aquaculture.weightedAverageUnitCostUsdPerHosoEqKg, undefined);
});

// PROC-PRICE-9: 入力が空配列のとき、全体加重平均もundefined
test("PROC-PRICE-9: 入力が空配列のとき overallWeightedAverageUnitCostUsdPerHosoEqKg は undefined", () => {
  const summary = buildRawMaterialCostSummary([]);
  assert.equal(summary.totalQuantityTons, 0);
  assert.equal(summary.overallWeightedAverageUnitCostUsdPerHosoEqKg, undefined);
});

// PROC-PRICE-10: toCostSummaryLotLikeはstatus=available以外をnullにする（簿価集計の対象を手持ち在庫に限定）
test("PROC-PRICE-10: toCostSummaryLotLikeはstatus!==availableのロットをnullにする", () => {
  const CURRENT = period(2026, 2);
  const baseLot: RawMaterialLot = {
    lotId: "lot-1",
    companyId: "BAL",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: CURRENT,
    originalQuantity: hosoEqTons(500),
    remainingQuantity: hosoEqTons(500),
    unitCost: usdPerHosoEqKg(2.5),
    availableFromPeriod: CURRENT,
    status: "available",
  };
  const converted = toCostSummaryLotLike(baseLot);
  assert.notEqual(converted, null);
  assert.equal(converted!.remainingQuantity, 500);
  assert.equal(converted!.unitCost, 2.5);

  const inTransitLot: RawMaterialLot = { ...baseLot, source: "import", status: "inTransitImport" };
  assert.equal(toCostSummaryLotLike(inTransitLot), null);
});
