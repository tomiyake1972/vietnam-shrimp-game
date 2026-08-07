// ShrimpX V2 — PD/VAPプレミアム（Phase 1）
//
// 全体実装計画書 v0.1 の対象商品定義（HOSO/PD/VAP、§19 Product型）と、
// 「PD/VAPプレミアム — 世界有効加工能力の逼迫度」（同計画書 表）に対応する。
// PD・VAPはHOSO基準価格（国別）にプレミアムを加える形で価格形成する
// （市場価格形成モジュール仕様書 v0.2 §4定義「HOSO価格は…冷凍製品価格」を
// 基準商品として、PD/VAPをその派生製品として扱う設計）。
//
// ベースプレミアムは世界全体の稼働率（需要/能力）から算出し、国別の品質優位
// （qualityScore）に応じて上乗せする。これにより、ベトナム・インドネシアは
// HOSOでは原料高により相対的に不利（country HOSO価格が高いまま）だが、
// PD/VAPでは品質プレミアムにより一部相殺される、という仕様書の想定
// （「HOSOではベトナム・インドネシアの原料高による不利」「ベトナムと
// インドネシアの品質プレミアム」）を、country HOSO価格 + premium という
// 積み上げ構造の中で自然に表現する。

import { HosoEqTons, hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import {
  CountryId,
  CountryHosoPriceResult,
  CountryProductPremium,
  ProductPremiumResult,
  MarketPriceDriver,
} from "./types";
import { MarketParameters } from "./parameters";
import { CountrySupplyInput } from "./types";
import { assertFinite, clamp, safeDivide } from "./validation";

type PremiumProduct = "pd" | "vap";

interface CapacityDemand {
  readonly demand: HosoEqTons;
  readonly basePremiumRatio: number;
}

function getCountryCapacity(input: CountrySupplyInput, product: PremiumProduct): HosoEqTons {
  return product === "pd" ? input.pdProcessingCapacity : input.vapProcessingCapacity;
}

/**
 * PD または VAP いずれかのプレミアムを算出する。
 *
 * 1. 世界全体の稼働率 = 世界需要 / 世界能力（4か国合算）からベースプレミアム
 *    倍率を決める（能力過剰なら倍率<1でプレミアム縮小、能力逼迫なら倍率>1で
 *    プレミアム拡大）。エクアドル・インドの加工能力が伸びれば世界能力が増え、
 *    稼働率が下がってプレミアムが縮小する（＝資料が想定する「エクアドル・
 *    インドのPD能力がゲーム後半で伸びる」影響を、能力を入力として与える形で
 *    表現する。期に応じた能力の伸び自体は、このモジュールの外側
 *    （呼び出し側のシナリオ設定）の責務とする）。
 * 2. 国別には、その国のHOSO価格にベースプレミアムを乗せたうえで、
 *    品質スコアに応じた品質プレミアムを加算する。
 */
export function calculateProductPremium(
  product: PremiumProduct,
  hosoPrices: Readonly<Record<CountryId, CountryHosoPriceResult>>,
  countries: Readonly<Record<CountryId, CountrySupplyInput>>,
  countryIds: readonly CountryId[],
  capacityDemand: CapacityDemand,
  parameters: MarketParameters
): ProductPremiumResult {
  let globalCapacityValue = 0;
  for (const country of countryIds) {
    globalCapacityValue += unwrapUnit(getCountryCapacity(countries[country], product));
  }
  const globalDemandValue = unwrapUnit(capacityDemand.demand);
  const globalUtilization = safeDivide(globalDemandValue, globalCapacityValue);
  assertFinite(globalUtilization, `${product} globalUtilization`);

  const p = parameters.pdVapPremium;
  const utilizationMultiplier = clamp(
    1 + (globalUtilization - p.referenceUtilization) * p.utilizationSensitivity,
    p.utilizationMultiplierFloor,
    p.utilizationMultiplierCap
  );

  const drivers: MarketPriceDriver[] = [];
  const t = parameters.driverThresholds;
  if (globalUtilization > t.capacityTightUtilization) {
    drivers.push(product === "pd" ? "PD_CAPACITY_TIGHTNESS" : "VAP_CAPACITY_TIGHTNESS");
    if (product === "vap") drivers.push("VAP_DEMAND_STRENGTH");
  }
  if (globalUtilization < t.capacityLooseUtilization) {
    drivers.push("PROCESSING_CAPACITY_OVERSUPPLY");
  }
  const ecuadorIndiaShare = safeDivide(
    unwrapUnit(getCountryCapacity(countries.EC, product)) + unwrapUnit(getCountryCapacity(countries.IN, product)),
    globalCapacityValue
  );
  if (product === "pd" && ecuadorIndiaShare > t.ecuadorIndiaPdShareTightness) {
    drivers.push("ECUADOR_PD_CAPACITY_EXPANSION");
  }

  const basePremiumRatio = capacityDemand.basePremiumRatio * utilizationMultiplier;

  const byCountry = {} as Record<CountryId, CountryProductPremium>;
  for (const country of countryIds) {
    const countryHosoPrice = unwrapUnit(hosoPrices[country].price);
    const qualityScore = unwrapUnit(countries[country].qualityScore);
    const qualityAdjustmentRatio =
      ((qualityScore - p.referenceQualityScore) / 100) * p.qualityPremiumSensitivity;

    const basePremiumValue = countryHosoPrice * basePremiumRatio;
    const qualityAdjustmentValue = countryHosoPrice * qualityAdjustmentRatio;
    const premiumValue = Math.max(basePremiumValue + qualityAdjustmentValue, p.minPremiumUsdPerKg);
    const finalPriceValue = countryHosoPrice + premiumValue;

    // Phase1ではPD/VAP需要を世界全体の集計値としてのみ扱い、国別の需要配分
    // モデルは持たない（§実装対象3「今回、プレイヤー各社の実際の調達決定は
    // 未実装で構いません」と同様の簡略化）。そのため国別稼働率は世界稼働率を
    // そのまま用いる。国別の需要配分モデルは後続モジュールの拡張点とする。
    byCountry[country] = {
      premium: usdPerHosoEqKg(premiumValue),
      finalPrice: usdPerHosoEqKg(finalPriceValue),
      qualityAdjustment: usdPerHosoEqKg(Math.max(qualityAdjustmentValue, 0)),
      capacityUtilization: globalUtilization,
    };

    if (qualityAdjustmentValue > 0) drivers.push("QUALITY_PREMIUM_APPLIED");
  }

  return {
    product,
    globalDemand: hosoEqTons(globalDemandValue),
    globalCapacity: hosoEqTons(globalCapacityValue),
    globalUtilization,
    basePremium: usdPerHosoEqKg(Math.max(basePremiumRatio, 0) * averageHosoPrice(hosoPrices, countryIds)),
    byCountry,
    drivers: dedupeDrivers(drivers),
  };
}

function averageHosoPrice(
  hosoPrices: Readonly<Record<CountryId, CountryHosoPriceResult>>,
  countryIds: readonly CountryId[]
): number {
  let sum = 0;
  for (const country of countryIds) sum += unwrapUnit(hosoPrices[country].price);
  return sum / countryIds.length;
}

function dedupeDrivers(drivers: readonly MarketPriceDriver[]): MarketPriceDriver[] {
  return Array.from(new Set(drivers));
}
