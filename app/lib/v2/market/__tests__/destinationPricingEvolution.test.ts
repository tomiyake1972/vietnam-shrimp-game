// ShrimpX V2 — 商品別の仕向市場価格係数の時間発展／商品別成約競争力（加工品市場進化 §c）
//
// DPE-1〜DPE-9。監査§3で特定した「3係数へ同一倍率」という構造的ブロッカーの
// 解消と、実装指示の必須2性質（PDのコモディティ性・VAPのばらつき／
// 低能力の会社が値上げだけで高く売れないこと）を検証する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1,
  deriveProductWiseDestinationPriceCoefficients,
} from "../destinationPricingEvolution";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DestinationMarketPriceCoefficientTable,
} from "../destinationPricingParameters";
import {
  computeMarketProductMix,
  PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1,
} from "../productLifecycle";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../types";
import { allocateMarketProduct } from "../../sales/allocation";
import {
  SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1,
  SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  SalesParameters,
} from "../../sales/parameters";
import { CompanySalesPlanEntry } from "../../sales/types";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const TUNED_LIFECYCLE = PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1;
const INITIAL_MIX = computeMarketProductMix(1, TUNED_LIFECYCLE);
const BASE_COEFFICIENTS = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS;

/** 共通倍率が中立（＝在庫・購買圧力の調整がまだ無い turn1 相当）のケース。 */
const NEUTRAL_COMMON: DestinationMarketPriceCoefficientTable = BASE_COEFFICIENTS;

function evolveAt(turn: number, commonAdjusted: DestinationMarketPriceCoefficientTable = NEUTRAL_COMMON) {
  return deriveProductWiseDestinationPriceCoefficients(
    BASE_COEFFICIENTS,
    commonAdjusted,
    computeMarketProductMix(turn, TUNED_LIFECYCLE),
    INITIAL_MIX
  );
}

// ---------------------------------------------------------------------
// 商品別の係数発展
// ---------------------------------------------------------------------

test("DPE-1: turn1では商品別の傾きが立たず、固定係数と完全に一致する（後方互換の基準点）", () => {
  const { coefficients, breakdowns } = evolveAt(1);
  for (const market of DEMAND_MARKET_IDS) {
    assert.deepEqual(coefficients[market], BASE_COEFFICIENTS[market], `${market}: turn1では固定係数のまま`);
    assert.equal(breakdowns[market].pdMixShift, 0, `${market}: turn1のPD構成比変化は0`);
    assert.equal(breakdowns[market].vapMixShift, 0, `${market}: turn1のVAP構成比変化は0`);
    assert.equal(breakdowns[market].clampApplied, false, `${market}: turn1ではクランプが発動しない`);
  }
});

test("DPE-2: 【監査§3ブロッカーの解消】PD係数とVAP係数が別々に動く", () => {
  const { coefficients } = evolveAt(32);
  // 旧実装では pd/vap/base の3係数すべてが同一倍率だったため、
  // 「係数 ÷ 固定係数」がどの商品でも同じ値になっていた。
  let sawDifferentRatios = false;
  for (const market of DEMAND_MARKET_IDS) {
    const pdRatio = coefficients[market].pdPremiumCoefficient / BASE_COEFFICIENTS[market].pdPremiumCoefficient;
    const vapRatio = coefficients[market].vapPremiumCoefficient / BASE_COEFFICIENTS[market].vapPremiumCoefficient;
    if (Math.abs(pdRatio - vapRatio) > 1e-6) sawDifferentRatios = true;
  }
  assert.ok(sawDifferentRatios, "PD係数とVAP係数の変化率が全市場で一致してしまっている（＝商品別に分かれていない）");
});

test("DPE-3: VAP需要が強く伸びる市場ほどVAPプレミアム係数が上がる（JP/US > CN）", () => {
  const { coefficients, breakdowns } = evolveAt(32);
  const vapLift = (market: DemandMarketId) =>
    coefficients[market].vapPremiumCoefficient / BASE_COEFFICIENTS[market].vapPremiumCoefficient;

  // turn32時点のVAP構成比の伸び: JP +0.20 / US +0.20 / EU +0.13 / OTHER +0.11 / CN +0.09
  assert.ok(breakdowns.JP.vapMixShift > breakdowns.CN.vapMixShift, "JPのVAP需要シフトはCNより大きい");
  assert.ok(vapLift("JP") > vapLift("CN"), `JPのVAP係数上昇はCNより大きい（JP=${vapLift("JP")} CN=${vapLift("CN")}）`);
  assert.ok(vapLift("US") > vapLift("CN"), "USのVAP係数上昇はCNより大きい");
  for (const market of DEMAND_MARKET_IDS) {
    assert.ok(vapLift(market) >= 1, `${market}: VAP構成比は非減少なのでVAP係数も低下しない`);
  }
});

test("DPE-4: PD係数の反応はVAP係数より小さい（PDのコモディティ性を価格側でも表現する）", () => {
  const { coefficients, breakdowns } = evolveAt(32);
  for (const market of DEMAND_MARKET_IDS) {
    const pdLift = coefficients[market].pdPremiumCoefficient / BASE_COEFFICIENTS[market].pdPremiumCoefficient;
    const vapLift = coefficients[market].vapPremiumCoefficient / BASE_COEFFICIENTS[market].vapPremiumCoefficient;
    assert.ok(
      pdLift - 1 <= vapLift - 1 + 1e-12,
      `${market}: PD係数の上昇幅(${pdLift - 1})がVAP係数の上昇幅(${vapLift - 1})を超えている`
    );
  }
  // 重み設定そのものの不変条件。
  assert.ok(
    DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1.pdShiftWeight < DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1.vapShiftWeight,
    "pdShiftWeight は vapShiftWeight より小さくあるべき"
  );
  // 参考: 実測の上昇幅（turn32、共通倍率中立）。
  assert.ok(breakdowns.JP.vapTiltMultiplier > breakdowns.JP.pdTiltMultiplier, "JPではVAP傾きがPD傾きを上回る");
});

test("DPE-5: HOSO基礎価値係数は商品別の傾きの影響を受けない", () => {
  for (const turn of [1, 16, 32]) {
    const { coefficients } = evolveAt(turn);
    for (const market of DEMAND_MARKET_IDS) {
      assert.equal(
        coefficients[market].baseValueCoefficient,
        BASE_COEFFICIENTS[market].baseValueCoefficient,
        `turn=${turn} ${market}: 共通倍率が中立ならHOSO基礎価値係数は不変であるべき`
      );
    }
  }
});

test("DPE-6: 共通倍率（在庫・購買圧力）と商品別傾きの合成は必ず有界（二重圧縮の歯止め）", () => {
  const p = DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1;
  // 共通倍率が極端な値（0.3倍・3.0倍）でも、最終係数は必ず設定した範囲へ収まる。
  for (const extremeFactor of [0.3, 3.0]) {
    const extremeCommon = {} as Record<DemandMarketId, (typeof BASE_COEFFICIENTS)[DemandMarketId]>;
    for (const market of DEMAND_MARKET_IDS) {
      extremeCommon[market] = {
        baseValueCoefficient: BASE_COEFFICIENTS[market].baseValueCoefficient * extremeFactor,
        pdPremiumCoefficient: BASE_COEFFICIENTS[market].pdPremiumCoefficient * extremeFactor,
        vapPremiumCoefficient: BASE_COEFFICIENTS[market].vapPremiumCoefficient * extremeFactor,
      };
    }
    const { coefficients, breakdowns } = evolveAt(32, extremeCommon);
    for (const market of DEMAND_MARKET_IDS) {
      for (const field of ["baseValueCoefficient", "pdPremiumCoefficient", "vapPremiumCoefficient"] as const) {
        const multiplier = coefficients[market][field] / BASE_COEFFICIENTS[market][field];
        assert.ok(
          multiplier >= p.coefficientMultiplierFloor - 1e-9 && multiplier <= p.coefficientMultiplierCap + 1e-9,
          `${market}.${field}: 合成倍率 ${multiplier} が範囲外`
        );
      }
      assert.equal(breakdowns[market].clampApplied, true, `${market}: 極端な共通倍率ではクランプが発動しているはず`);
    }
  }
});

// ---------------------------------------------------------------------
// 商品別の成約競争力（PDのコモディティ性 / VAPのばらつき）
// ---------------------------------------------------------------------

function entry(companyId: string, product: Product, capability: number, priceAdjustment: number): CompanySalesPlanEntry {
  return {
    companyId: companyId as CompanySalesPlanEntry["companyId"],
    market: "JP",
    product,
    desiredQuantity: hosoEqTons(2000),
    priceAdjustmentUsdPerHosoEqKg: priceAdjustment,
    salesForceHeadcount: 8,
    customerRelationship: score0to100(capability),
    qualityReputation: score0to100(capability),
    deliveryReliability: score0to100(capability),
    vapCapabilityScore: score0to100(capability),
  } as CompanySalesPlanEntry;
}

function allocate(product: Product, params: SalesParameters, companies: readonly CompanySalesPlanEntry[]): Record<string, number> {
  const result = allocateMarketProduct("JP", product, period(2026, 1), companies, usdPerHosoEqKg(6.0), hosoEqTons(6000), params);
  return Object.fromEntries(result.companies.map((c) => [c.companyId, unwrapUnit(c.allocatedQuantity)]));
}

/** 能力35（価格据置）と能力95（+$0.50）の成約量比。大きいほど能力差が効く＝ばらつきが大きい。 */
function capabilitySpread(product: Product, params: SalesParameters): number {
  const allocated = allocate(product, params, [
    entry("LOW", product, 35, 0),
    entry("MID", product, 55, 0),
    entry("TOP", product, 95, 0.5),
    entry("X", product, 50, 0),
    entry("Y", product, 50, 0),
  ]);
  return allocated.TOP / allocated.LOW;
}

test("DPE-7: 【必須性質】PDはVAPよりコモディティ的で、会社間のばらつきが小さい", () => {
  const hoso = capabilitySpread("hoso", SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1);
  const pd = capabilitySpread("pd", SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1);
  const vap = capabilitySpread("vap", SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1);

  assert.ok(hoso < pd, `HOSO(${hoso}) < PD(${pd}) の順序であるべき`);
  assert.ok(pd < vap, `PD(${pd}) < VAP(${vap}) の順序であるべき`);
  assert.ok(vap / pd >= 1.3, `VAPのばらつきはPDの1.3倍以上であるべき（実測 ${vap / pd}倍）`);

  // 現行（全商品共通ウェイト）ではHOSOとPDのばらつきが完全に同一だった。
  const oldHoso = capabilitySpread("hoso", SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1);
  const oldPd = capabilitySpread("pd", SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1);
  assert.ok(Math.abs(oldHoso - oldPd) < 1e-9, "共通ウェイトではHOSOとPDのばらつきが同一だった（比較の基準）");
  assert.ok(pd < oldPd, `商品別ウェイトによりPDはより commodity 的になる（${oldPd} → ${pd}）`);
  assert.ok(vap > capabilitySpread("vap", SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1), "VAPはより差がつくようになる");
});

test("DPE-8: 【必須性質】能力の低い会社は値上げだけでは得をしない（価格弾力性が全商品で維持される）", () => {
  for (const product of ["hoso", "pd", "vap"] as const) {
    for (const capability of [35, 50, 95]) {
      const others = [
        entry("A", product, 50, 0),
        entry("B", product, 50, 0),
        entry("C", product, 50, 0),
        entry("D", product, 50, 0),
      ];
      const flat = allocate(product, SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, [
        entry("T", product, capability, 0),
        ...others,
      ]);
      const raised = allocate(product, SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, [
        entry("T", product, capability, 0.5),
        ...others,
      ]);
      assert.ok(
        raised.T < flat.T,
        `${product} 能力${capability}: 値上げしたのに成約量が減っていない（${flat.T} → ${raised.T}）`
      );
    }
  }
  // 低能力の会社が値上げした場合、低能力のまま据え置いた場合より必ず不利。
  const lowFlat = allocate("vap", SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, [
    entry("T", "vap", 35, 0),
    entry("A", "vap", 50, 0),
    entry("B", "vap", 50, 0),
    entry("C", "vap", 50, 0),
    entry("D", "vap", 50, 0),
  ]);
  const lowRaised = allocate("vap", SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, [
    entry("T", "vap", 35, 0.5),
    entry("A", "vap", 50, 0),
    entry("B", "vap", 50, 0),
    entry("C", "vap", 50, 0),
    entry("D", "vap", 50, 0),
  ]);
  assert.ok(lowRaised.T < lowFlat.T, "低能力会社の値上げは必ず成約量を減らす");
});

test("DPE-9: どの商品プロファイルも価格ウェイトが0にならず、合計1.0を保つ", () => {
  const profiles = SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1.competitivenessWeightsByProduct!;
  for (const product of ["hoso", "pd", "vap"] as const) {
    const w = profiles[product]!;
    const total = w.price + w.coverage + w.relationship + w.quality + w.deliveryReliability + w.salesBase + w.vapCapability;
    assert.ok(Math.abs(total - 1) < 1e-9, `${product}: ウェイト合計が1.0でない（${total}）`);
    assert.ok(w.price > 0, `${product}: 価格ウェイトが0だと値上げの抜け道ができる`);
  }
  // コモディティ性の順序: HOSO ≥ PD > VAP の価格ウェイト。
  assert.ok(profiles.hoso!.price >= profiles.pd!.price, "HOSOの価格ウェイトはPD以上");
  assert.ok(profiles.pd!.price > profiles.vap!.price, "PDの価格ウェイトはVAPより大きい");
  // VAP能力ウェイトはVAPプロファイルにのみ存在する。
  assert.equal(profiles.hoso!.vapCapability, 0);
  assert.equal(profiles.pd!.vapCapability, 0);
  assert.ok(profiles.vap!.vapCapability > 0);
});
