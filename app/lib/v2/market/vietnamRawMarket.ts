// ShrimpX V2 — ベトナム国内未凍結原料市場（Phase 1）
//
// 市場価格形成モジュール仕様書 v0.2 §10「ベトナム国内未凍結原料市場」に対応。
// 国際HOSO価格の下流ではなく、HOSO等の期待製品価値を加工会社の買付上限へ
// 変換したうえで、当期の収穫量と加工会社の買付希望量を突き合わせて清算する
// 独立市場として実装する（§10冒頭・仕様書§17不変条件「HOSO価格とベトナム国内
// 原料価格が別フィールド・別計算として保存される」）。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { VietnamDomesticInput, VietnamDomesticResult, MarketPriceDriver } from "./types";
import { MarketParameters } from "./parameters";
import { assertFinite, clamp, safeDivide } from "./validation";

/**
 * 理論原料支払上限（買付上限）。
 * 買付上限 = HOSO FOB価格 × HOSO歩留まり − 加工輸出費用 − 必要利益
 * （仕様書§10.2の式から、Phase1ではゲーム内通貨をUSD単一建てとしているため
 * 為替項を省略した単純化版。docsに明記する。）
 */
export function calculateBuyingCeiling(
  vietnamHosoFobPrice: UsdPerHosoEqKg,
  input: VietnamDomesticInput
): UsdPerHosoEqKg {
  const hoso = unwrapUnit(vietnamHosoFobPrice);
  const yieldRatio = unwrapUnit(input.hosoYieldRatio);
  const cost = unwrapUnit(input.processingExportCostUsdPerKg);
  const margin = unwrapUnit(input.requiredMarginUsdPerKg);
  const ceiling = hoso * yieldRatio - cost - margin;
  return usdPerHosoEqKg(Math.max(ceiling, 0));
}

/**
 * プロラタ最低引取ルール適用後の実効需要量。
 * 全体実装計画書 v0.1 §10.1「一律に買付予定の20%を強制するのではなく、
 * 過去4Qの国内購入平均×20%を最低引取基準とする」に対応する。
 * Phase1では会社別の按分（プロラタ配分）自体は調達モジュールの責務とし、
 * ここでは業界集計値としての実効需要（表明値と最低引取基準の大きい方）のみを
 * 算出する。
 */
export function applyMinimumOfftakeRule(
  input: VietnamDomesticInput,
  parameters: MarketParameters
): { readonly effectiveDemand: HosoEqTons; readonly applied: boolean } {
  const intent = unwrapUnit(input.domesticProcurementIntent);
  const floor = unwrapUnit(input.trailingAverageDomesticPurchase) * parameters.minimumOfftakeRatio;
  const effectiveDemandValue = Math.max(intent, floor);
  return {
    effectiveDemand: hosoEqTons(effectiveDemandValue),
    applied: floor > intent,
  };
}

/**
 * ベトナム国内未凍結原料市場を清算する。
 * 国内原料価格 = 買付上限 × 需給調整乗数（仕様書§10.3を単純化）。
 * 供給不足では乗数が1.0（買付上限）へ近づき、供給過剰では下限乗数まで下がる。
 */
export function clearVietnamRawMarket(
  vietnamHosoFobPrice: UsdPerHosoEqKg,
  input: VietnamDomesticInput,
  parameters: MarketParameters
): VietnamDomesticResult {
  const buyingCeiling = calculateBuyingCeiling(vietnamHosoFobPrice, input);
  const { effectiveDemand, applied } = applyMinimumOfftakeRule(input, parameters);

  const supplyValue = unwrapUnit(input.domesticRawSupply);
  const demandValue = unwrapUnit(effectiveDemand);
  const rawImbalance = safeDivide(demandValue - supplyValue, supplyValue);
  const p = parameters.vietnamDomestic;
  const imbalance = clamp(rawImbalance, -p.imbalanceClamp, p.imbalanceClamp);

  const multiplier = clamp(p.baseMultiplier + imbalance * p.demandSensitivity, p.floorMultiplier, 1.0);
  const priceValue = unwrapUnit(buyingCeiling) * multiplier;
  assertFinite(priceValue, "vietnamDomesticPrice");

  const drivers: MarketPriceDriver[] = [];
  const t = parameters.driverThresholds;
  if (imbalance > t.supplyDemandImbalance) drivers.push("VIETNAM_RAW_MATERIAL_SHORTAGE");
  if (imbalance < -t.supplyDemandImbalance) drivers.push("VIETNAM_RAW_MATERIAL_SURPLUS");
  if (applied) drivers.push("MINIMUM_OFFTAKE_RULE_APPLIED");

  return {
    price: usdPerHosoEqKg(Math.max(priceValue, p.absolutePriceFloorUsdPerKg)),
    buyingCeiling,
    supply: hosoEqTons(supplyValue),
    effectiveDemand,
    imbalance,
    minimumOfftakeApplied: applied,
    drivers,
  };
}
