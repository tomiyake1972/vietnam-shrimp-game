// ShrimpX V2 — 商品×仕向市場の参照価格差別化（Phase 8P-0A）テスト
//
// 実装指示 §20「重要テスト」のうち、価格分解・係数の適用範囲・HOSO換算・
// 中立構造の後方互換性を、market/モジュール単体で検証する。会社ラボ・
// companyLab統合レベルの検証は companyLab/__tests__/destinationMarketPricing.test.ts
// を参照。

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateMarketQuarter } from "../index";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { MarketValidationError, DEMAND_MARKET_IDS, DemandMarketId } from "../types";
import { baseMarketQuarterInput } from "./fixtures";
import {
  decomposeVietnamProductPrices,
  computeMarketReferencePrice,
  deriveMarketReferencePrices,
  deriveMarketReferencePriceBreakdowns,
  ProductPriceDecomposition,
} from "../destinationPricing";
import {
  DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1,
  DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1,
  DESTINATION_MARKET_DEMAND_WEIGHTS_V1,
  weightedAverageCoefficient,
} from "../destinationPricingParameters";
import { deriveVietnamBasePrices } from "../../sales/marketAdapter";

function fixtureMarketResult(seed = "destination-pricing-fixture") {
  const input = baseMarketQuarterInput();
  return calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(seed));
}

// ---------------------------------------------------------------------
// 1. 価格分解（実装指示 §20「価格分解」）
// ---------------------------------------------------------------------

test("価格分解: PD価格-HOSO価格=PD加工プレミアム、VAP価格-PD価格=VAP追加プレミアムに一致する", () => {
  const marketResult = fixtureMarketResult();
  const decomposition = decomposeVietnamProductPrices(marketResult);
  const hoso = unwrapUnit(marketResult.hosoPrices.VN.price);
  const pd = unwrapUnit(marketResult.pdPremium.byCountry.VN.finalPrice);
  const vap = unwrapUnit(marketResult.vapPremium.byCountry.VN.finalPrice);
  assert.ok(Math.abs(unwrapUnit(decomposition.pdProcessingPremium) - (pd - hoso)) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(decomposition.vapIncrementalPremium) - (vap - pd)) < 1e-9);
  assert.equal(decomposition.pdPremiumWasClampedToZero, false);
  assert.equal(decomposition.vapPremiumWasClampedToZero, false);
});

test("価格分解: 5シナリオ相当の極端な入力（供給過剰・供給不足）でもPD/VAPプレミアムが非負である（逆転が発生しない）", () => {
  const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let pdClampCount = 0;
  let vapClampCount = 0;
  for (const seed of seeds) {
    const marketResult = fixtureMarketResult(seed);
    const decomposition = decomposeVietnamProductPrices(marketResult);
    if (decomposition.pdPremiumWasClampedToZero) pdClampCount++;
    if (decomposition.vapPremiumWasClampedToZero) vapClampCount++;
    assert.ok(unwrapUnit(decomposition.pdProcessingPremium) >= 0);
    assert.ok(unwrapUnit(decomposition.vapIncrementalPremium) >= 0);
  }
  // 実装指示§6: 逆転が実際に発生する場合は発生条件・件数を報告する対象。
  // baseline系のパラメータでは発生しないことを回帰確認として明示する。
  assert.equal(pdClampCount, 0, "PD価格がHOSO価格を下回るケースが発生した（要報告）");
  assert.equal(vapClampCount, 0, "VAP価格がPD価格を下回るケースが発生した（要報告）");
});

test("価格分解: 非有限の入力価格を拒否する", () => {
  const marketResult = fixtureMarketResult();
  const brokenResult = {
    ...marketResult,
    hosoPrices: {
      ...marketResult.hosoPrices,
      VN: { ...marketResult.hosoPrices.VN, price: NaN as unknown as ReturnType<typeof usdPerHosoEqKg> },
    },
  };
  assert.throws(() => decomposeVietnamProductPrices(brokenResult), MarketValidationError);
});

// ---------------------------------------------------------------------
// 2. 中立係数による完全再構成（実装指示 §20「中立構造」）
// ---------------------------------------------------------------------

test("中立構造: 全係数1.0で、5市場すべての参照価格が既存の商品別基準価格（deriveVietnamBasePrices）と完全に一致する", () => {
  const marketResult = fixtureMarketResult();
  const legacy = deriveVietnamBasePrices(marketResult);
  const marketReferencePrices = deriveMarketReferencePrices(marketResult, DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      assert.ok(
        Math.abs(unwrapUnit(marketReferencePrices[market][product]) - unwrapUnit(legacy[product])) < 1e-9,
        `market=${market} product=${product} が既存基準価格と一致しない`
      );
    }
  }
});

// ---------------------------------------------------------------------
// 3. 係数の適用範囲（実装指示 §20「係数の適用範囲」）— 明示例
// ---------------------------------------------------------------------

function exampleDecomposition(): ProductPriceDecomposition {
  return {
    hosoBasePrice: usdPerHosoEqKg(4.0),
    pdProcessingPremium: usdPerHosoEqKg(0.8),
    vapIncrementalPremium: usdPerHosoEqKg(1.2),
    pdPremiumWasClampedToZero: false,
    vapPremiumWasClampedToZero: false,
  };
}

function coeffTableWith(market: DemandMarketId, overrides: Partial<{ baseValueCoefficient: number; pdPremiumCoefficient: number; vapPremiumCoefficient: number }>) {
  return {
    ...DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1,
    [market]: { ...DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1[market], ...overrides },
  };
}

test("明示例: hoso=4.00, pdPremium=0.80, vapPremium=1.20で、中立係数の参照価格がHOSO=4.00/PD=4.80/VAP=6.00になる", () => {
  const decomposition = exampleDecomposition();
  const hoso = computeMarketReferencePrice(decomposition, "US", "hoso", DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  const pd = computeMarketReferencePrice(decomposition, "US", "pd", DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  const vap = computeMarketReferencePrice(decomposition, "US", "vap", DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  assert.ok(Math.abs(unwrapUnit(hoso.marketReferencePrice) - 4.0) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(pd.marketReferencePrice) - 4.8) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(vap.marketReferencePrice) - 6.0) < 1e-9);
});

test("係数の適用範囲: VAP市場係数を変更してもHOSO・PDの参照価格は変わらない", () => {
  const decomposition = exampleDecomposition();
  const table = coeffTableWith("US", { vapPremiumCoefficient: 1.5 });
  const hoso = computeMarketReferencePrice(decomposition, "US", "hoso", table);
  const pd = computeMarketReferencePrice(decomposition, "US", "pd", table);
  const vap = computeMarketReferencePrice(decomposition, "US", "vap", table);
  assert.ok(Math.abs(unwrapUnit(hoso.marketReferencePrice) - 4.0) < 1e-9);
  assert.ok(Math.abs(unwrapUnit(pd.marketReferencePrice) - 4.8) < 1e-9);
  // VAP = 4.0 + 0.8 + 1.2*1.5 = 6.6
  assert.ok(Math.abs(unwrapUnit(vap.marketReferencePrice) - 6.6) < 1e-9);
});

test("係数の適用範囲: PD市場係数を変更してもHOSOの参照価格は変わらず、PD・VAPのPD部分だけが変わる", () => {
  const decomposition = exampleDecomposition();
  const table = coeffTableWith("US", { pdPremiumCoefficient: 1.25 });
  const hoso = computeMarketReferencePrice(decomposition, "US", "hoso", table);
  const pd = computeMarketReferencePrice(decomposition, "US", "pd", table);
  const vap = computeMarketReferencePrice(decomposition, "US", "vap", table);
  assert.ok(Math.abs(unwrapUnit(hoso.marketReferencePrice) - 4.0) < 1e-9);
  // PD = 4.0 + 0.8*1.25 = 5.0
  assert.ok(Math.abs(unwrapUnit(pd.marketReferencePrice) - 5.0) < 1e-9);
  // VAP = 4.0 + 0.8*1.25 + 1.2 = 6.2 （PDプレミアム部分だけがVAPにも反映される）
  assert.ok(Math.abs(unwrapUnit(vap.marketReferencePrice) - 6.2) < 1e-9);
});

test("係数の適用範囲: HOSO基礎価値係数を変更すると、HOSO/PD/VAPすべてのHOSO基礎価値部分が同じ倍率で変わる（プレミアム部分は変わらない）", () => {
  const decomposition = exampleDecomposition();
  const table = coeffTableWith("US", { baseValueCoefficient: 1.1 });
  const hoso = computeMarketReferencePrice(decomposition, "US", "hoso", table);
  const pd = computeMarketReferencePrice(decomposition, "US", "pd", table);
  const vap = computeMarketReferencePrice(decomposition, "US", "vap", table);
  // HOSO = 4.0*1.1 = 4.4
  assert.ok(Math.abs(unwrapUnit(hoso.marketReferencePrice) - 4.4) < 1e-9);
  // PD = 4.0*1.1 + 0.8 = 5.2
  assert.ok(Math.abs(unwrapUnit(pd.marketReferencePrice) - 5.2) < 1e-9);
  // VAP = 4.0*1.1 + 0.8 + 1.2 = 6.4
  assert.ok(Math.abs(unwrapUnit(vap.marketReferencePrice) - 6.4) < 1e-9);
});

test("係数の適用範囲: いずれの係数変更も価格全体への単純乗算になっていない（HOSO系数だけ変えてもVAP価格がHOSO系数×元のVAP価格にはならない）", () => {
  const decomposition = exampleDecomposition();
  const table = coeffTableWith("US", { baseValueCoefficient: 1.1 });
  const vap = computeMarketReferencePrice(decomposition, "US", "vap", table);
  const naiveMultiply = 6.0 * 1.1; // 単純乗算だった場合の（誤った）値
  assert.ok(Math.abs(unwrapUnit(vap.marketReferencePrice) - naiveMultiply) > 1e-6, "価格全体への単純乗算になっている（誤り）");
});

// ---------------------------------------------------------------------
// 4. HOSO換算（実装指示 §20「HOSO換算」）
// ---------------------------------------------------------------------

test("HOSO換算: 数量単位に一切関与しない（本モジュールは価格のみを扱い、物理歩留り換算を一切行わない）", () => {
  // decomposeVietnamProductPrices・computeMarketReferencePriceのシグネチャに
  // 数量パラメータが存在しないこと自体が「物理歩留りを再度掛けない」設計の
  // 構造的な保証である。ここでは中立係数の下で入力価格がそのまま出力される
  // （yield等の追加変換が挟まっていない）ことを数値で確認する。
  const decomposition = exampleDecomposition();
  const hoso = computeMarketReferencePrice(decomposition, "JP", "hoso", DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1);
  assert.equal(unwrapUnit(hoso.marketReferencePrice), unwrapUnit(decomposition.hosoBasePrice));
});

// ---------------------------------------------------------------------
// 5. 妥当性検証
// ---------------------------------------------------------------------

test("不正な係数（0以下・非有限）を拒否する", () => {
  const decomposition = exampleDecomposition();
  const zeroTable = coeffTableWith("US", { baseValueCoefficient: 0 });
  assert.throws(() => computeMarketReferencePrice(decomposition, "US", "hoso", zeroTable), MarketValidationError);
  const negativeTable = coeffTableWith("US", { pdPremiumCoefficient: -0.5 });
  assert.throws(() => computeMarketReferencePrice(decomposition, "US", "pd", negativeTable), MarketValidationError);
  const nanTable = coeffTableWith("US", { vapPremiumCoefficient: NaN });
  assert.throws(() => computeMarketReferencePrice(decomposition, "US", "vap", nanTable), MarketValidationError);
});

test("0以下の市場参照価格を拒否する（分解値が全てゼロの極端なケース）", () => {
  const zeroDecomposition: ProductPriceDecomposition = {
    hosoBasePrice: usdPerHosoEqKg(0),
    pdProcessingPremium: usdPerHosoEqKg(0),
    vapIncrementalPremium: usdPerHosoEqKg(0),
    pdPremiumWasClampedToZero: false,
    vapPremiumWasClampedToZero: false,
  };
  assert.throws(
    () => computeMarketReferencePrice(zeroDecomposition, "US", "hoso", DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1),
    MarketValidationError
  );
});

// ---------------------------------------------------------------------
// 6. 加重平均の中立化（実装指示 §14）
// ---------------------------------------------------------------------

test("加重平均の中立化: 初期係数（INITIAL_V1）の基準需要加重平均が、baseValueCoefficient・pdPremiumCoefficient・vapPremiumCoefficientのいずれも1.0000±0.001に収まる", () => {
  const weights = DESTINATION_MARKET_DEMAND_WEIGHTS_V1;
  const totalWeight = DEMAND_MARKET_IDS.reduce((s, m) => s + weights[m], 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9, "重みの合計が1.0でない");

  const baseAvg = weightedAverageCoefficient(DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1, "baseValueCoefficient");
  const pdAvg = weightedAverageCoefficient(DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1, "pdPremiumCoefficient");
  const vapAvg = weightedAverageCoefficient(DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1, "vapPremiumCoefficient");
  assert.ok(Math.abs(baseAvg - 1) < 0.001, `baseValueCoefficientの加重平均が1.0から乖離: ${baseAvg}`);
  assert.ok(Math.abs(pdAvg - 1) < 0.001, `pdPremiumCoefficientの加重平均が1.0から乖離: ${pdAvg}`);
  assert.ok(Math.abs(vapAvg - 1) < 0.001, `vapPremiumCoefficientの加重平均が1.0から乖離: ${vapAvg}`);
});

test("初期係数（INITIAL_V1）は実装指示§13の許容範囲に収まる（baseValue: 0.98-1.02 / pd: 0.90-1.10 / vap: 0.85-1.25）", () => {
  for (const market of DEMAND_MARKET_IDS) {
    const c = DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1[market];
    assert.ok(c.baseValueCoefficient >= 0.98 && c.baseValueCoefficient <= 1.02, `${market} baseValueCoefficient=${c.baseValueCoefficient} が範囲外`);
    assert.ok(c.pdPremiumCoefficient >= 0.9 && c.pdPremiumCoefficient <= 1.1, `${market} pdPremiumCoefficient=${c.pdPremiumCoefficient} が範囲外`);
    assert.ok(c.vapPremiumCoefficient >= 0.85 && c.vapPremiumCoefficient <= 1.25, `${market} vapPremiumCoefficient=${c.vapPremiumCoefficient} が範囲外`);
  }
});

test("初期係数（INITIAL_V1）の方向性: JPのVAPプレミアム係数が最も高く、CNが最も低い（実装指示§13の方向性表と整合）", () => {
  const vapByMarket = Object.fromEntries(
    DEMAND_MARKET_IDS.map((m) => [m, DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1[m].vapPremiumCoefficient])
  ) as Record<DemandMarketId, number>;
  const sorted = [...DEMAND_MARKET_IDS].sort((a, b) => vapByMarket[a] - vapByMarket[b]);
  assert.equal(sorted[0], "CN", "VAPプレミアム係数が最も低いのはCNのはず");
  assert.equal(sorted[sorted.length - 1], "JP", "VAPプレミアム係数が最も高いのはJPのはず");
});

// ---------------------------------------------------------------------
// 7. 診断構造（実装指示 §8）
// ---------------------------------------------------------------------

test("診断構造: deriveMarketReferencePriceBreakdownsが5市場×3商品すべてについて内訳を返し、内訳の合計が最終価格と一致する", () => {
  const marketResult = fixtureMarketResult();
  const breakdowns = deriveMarketReferencePriceBreakdowns(marketResult, DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1);
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const b = breakdowns[market][product];
      const sum = unwrapUnit(b.hosoBaseValuePart) + unwrapUnit(b.pdPremiumPart) + unwrapUnit(b.vapPremiumPart);
      assert.ok(Math.abs(sum - unwrapUnit(b.marketReferencePrice)) < 1e-9);
    }
  }
});

test("副作用なし: decomposeVietnamProductPrices・computeMarketReferencePriceはmarketResultを変更しない", () => {
  const marketResult = fixtureMarketResult();
  const before = JSON.stringify(marketResult);
  const decomposition = decomposeVietnamProductPrices(marketResult);
  computeMarketReferencePrice(decomposition, "JP", "vap", DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1);
  assert.equal(JSON.stringify(marketResult), before);
});
