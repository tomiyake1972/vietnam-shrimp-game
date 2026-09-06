// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: 原料価格捕捉指数
//
// 【この検証の範囲】同一Turn・同一市場入力に対する純関数
// clearVietnamRawMarket の挙動だけを検証する。
// 32Qのfull-runでは、原料価格が変われば Standard AI の調達・投資・Cash判断が
// 変わるため後続Turnの数量は変わり得る。数量不変を要求するのは
// 「同一入力の1回の清算」に限る、というのがこのテストの前提である。

import test from "node:test";
import assert from "node:assert/strict";

import { clearVietnamRawMarket } from "../vietnamRawMarket";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { MarketValidationError, VietnamDomesticInput } from "../types";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";

function input(overrides: Partial<VietnamDomesticInput> = {}): VietnamDomesticInput {
  return {
    domesticRawSupply: hosoEqTons(100_000),
    domesticProcurementIntent: hosoEqTons(95_000),
    trailingAverageDomesticPurchase: hosoEqTons(90_000),
    hosoEqRecoveryRatio: ratio(1.0),
    processingExportCostUsdPerKg: usdPerHosoEqKg(0.85),
    requiredMarginUsdPerKg: usdPerHosoEqKg(0.25),
    ...overrides,
  };
}

const HOSO_FOB = usdPerHosoEqKg(8.0);

test("RAWCAP-1: index未指定と1.00は現行と完全一致（診断キーも作らない）", () => {
  const withoutArg = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1);
  const withNeutral = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.0);
  assert.deepEqual(JSON.parse(JSON.stringify(withoutArg)), JSON.parse(JSON.stringify(withNeutral)));
  // 中立時は診断キー自体を作らない（既存Scenarioの保存結果を不変に保つ規約）。
  assert.equal("priceMultiplier" in withoutArg, false);
  assert.equal("rawPriceCaptureIndex" in withoutArg, false);
  assert.equal("tradeRatio" in withoutArg, false);
});

test("RAWCAP-2: indexを上げるとmが上がる（または上限1.0で不変）／rawPriceが上がる／spreadが縮む", () => {
  const base = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.0);
  let previousPrice = unwrapUnit(base.price);
  let previousSpread = unwrapUnit(HOSO_FOB) - previousPrice;
  for (const index of [1.02, 1.05, 1.08, 1.2, 2.0]) {
    const r = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, index);
    const price = unwrapUnit(r.price);
    const spread = unwrapUnit(HOSO_FOB) - price;
    assert.ok(price >= previousPrice - 1e-12, `price index=${index}`);
    assert.ok(spread <= previousSpread + 1e-12, `spread index=${index}`);
    // 上限1.0の維持: rawPrice は buyingCeiling を超えない。
    assert.ok(price <= unwrapUnit(r.buyingCeiling) + 1e-9, `ceiling index=${index}`);
    assert.ok((r.priceMultiplier ?? 0) <= 1.0 + 1e-12, `multiplier<=1 index=${index}`);
    previousPrice = price;
    previousSpread = spread;
  }
});

test("RAWCAP-3: ceiling・farmerReservationPrice はindexで変わらない", () => {
  const a = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.0);
  const b = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.5);
  assert.equal(unwrapUnit(a.buyingCeiling), unwrapUnit(b.buyingCeiling));
  assert.equal(unwrapUnit(a.farmerReservationPrice), unwrapUnit(b.farmerReservationPrice));
});

test("RAWCAP-4: 同一Turn・同一市場入力では取引数量がindexで変わらない", () => {
  // 【前提】これは1回の清算に対する検証である。32Qのfull-runでは、価格変化が
  // Standard AIの調達意向・Cash・投資判断を通じて後続Turnの数量を変え得るため、
  // full-runでの数量不変は要求しない。
  for (const index of [1.0, 1.05, 1.3, 2.0]) {
    const r = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, index);
    const neutral = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.0);
    assert.equal(unwrapUnit(r.transactedVolume), unwrapUnit(neutral.transactedVolume), `transacted index=${index}`);
    assert.equal(unwrapUnit(r.unsoldSupply), unwrapUnit(neutral.unsoldSupply), `unsold index=${index}`);
    assert.equal(unwrapUnit(r.effectiveDemand), unwrapUnit(neutral.effectiveDemand), `demand index=${index}`);
    assert.equal(r.quantityRationed, neutral.quantityRationed, `rationed index=${index}`);
  }
});

test("RAWCAP-5: 数量ラショニング分岐（ceiling < reservation）はindexの影響を受けない", () => {
  // HOSO FOBを低くして ceiling < farmerReservationPrice を成立させる。
  const lowFob = usdPerHosoEqKg(2.0);
  const neutral = clearVietnamRawMarket(lowFob, input(), MARKET_PARAMETERS_V1, 1.0);
  assert.equal(neutral.quantityRationed, true, "前提: この入力では数量調整が発生する");
  for (const index of [1.2, 2.0]) {
    const r = clearVietnamRawMarket(lowFob, input(), MARKET_PARAMETERS_V1, index);
    assert.equal(r.quantityRationed, true);
    assert.equal(unwrapUnit(r.price), unwrapUnit(neutral.price));
    assert.equal(unwrapUnit(r.transactedVolume), unwrapUnit(neutral.transactedVolume));
  }
});

test("RAWCAP-6: 非正・非有限のindexは例外", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, bad), MarketValidationError, String(bad));
  }
});

test("RAWCAP-7: 非中立indexのときだけ診断値が載る", () => {
  const r = clearVietnamRawMarket(HOSO_FOB, input(), MARKET_PARAMETERS_V1, 1.05);
  assert.equal(r.rawPriceCaptureIndex, 1.05);
  assert.equal(typeof r.priceMultiplier, "number");
  assert.equal(typeof r.tradeRatio, "number");
});
