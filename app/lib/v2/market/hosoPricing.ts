// ShrimpX V2 — 世界HOSO価格形成（Phase 1）
//
// 市場価格形成モジュール仕様書 v0.2 §9「世界HOSO価格形成」に対応。
// 仕様書が指定する「Market Opening」→「Market Clearing」の二段階構造を守る。
//
//   Market Opening（openHosoMarket）:
//     各国の輸出可能供給量・世界需要の国別配分・需給圧力 L_i を算出する。
//     まだ価格には触れない（＝「開場」＝需給指標の確定）。
//
//   Market Clearing（clearHosoMarket）:
//     L_i・世界共通圧力 G・決定論的ショックから当期HOSO FOB価格を確定する
//     （＝「清算」＝価格の確定）。
//
// 完全な数量ベース市場清算（§9.1: softmaxによる原産地シェア配分と反復収束）は
// 仕様書自身が「移行条件：国別供給量と市場別需要量が安定して計算できた段階で
// 数量ベースの市場清算方式へ置き換える」とプロトタイプ後の移行対象と位置づけて
// いるため、Phase1では §9.2 の簡易式（ローカル圧力 L_i と世界共通圧力 G の
// 加重平均）を採用する。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { RandomStream } from "../core/random";
import { CountryId, CountryHosoPriceResult, MarketPriceDriver } from "./types";
import { MarketParameters } from "./parameters";
import { CountrySupplySummary } from "./countrySupply";
import { assertFinite, clamp, safeDivide } from "./validation";

// ---------------------------------------------------------------------
// Market Opening: 需給指標の確定
// ---------------------------------------------------------------------

export interface CountryMarketOpening {
  readonly country: CountryId;
  readonly exportableSupply: HosoEqTons;
  readonly allocatedDemand: HosoEqTons;
  /** allocatedDemand / exportableSupply。 */
  readonly utilizationRatio: number;
  /** L_i = (allocatedDemand - exportableSupply) / exportableSupply と
   *  コスト変化率を合成した、この国固有の需給圧力。 */
  readonly localPressure: number;
}

export interface MarketOpeningResult {
  readonly worldSupply: HosoEqTons;
  readonly worldDemand: HosoEqTons;
  /** (worldDemand - worldSupply) / worldSupply。 */
  readonly worldSupplyDemandBalance: number;
  readonly byCountry: Readonly<Record<CountryId, CountryMarketOpening>>;
  /** 世界共通圧力 G = Σ worldInfluenceWeight_i × L_i。 */
  readonly worldPressure: number;
}

/**
 * Market Opening（開場）。各国の需給圧力 L_i と世界共通圧力 G を確定する。
 * まだ価格計算は行わない。
 *
 * 需要の国別配分は、仕様書§9.1の完全なsoftmax原産地シェア配分の代わりに、
 * §16「簡易世界影響度 EC45/IN25/VN18/ID12」を国別の世界需要シェアとして
 * 転用する（Phase1の簡易化。将来softmax配分へ置き換える際は本関数のみを
 * 差し替えればよい設計としている）。
 */
export function openHosoMarket(
  countrySupply: Readonly<Record<CountryId, CountrySupplySummary>>,
  worldDemand: HosoEqTons,
  countryIds: readonly CountryId[],
  parameters: MarketParameters
): MarketOpeningResult {
  const worldDemandValue = unwrapUnit(worldDemand);
  let worldSupplyValue = 0;
  const byCountry = {} as Record<CountryId, CountryMarketOpening>;

  for (const country of countryIds) {
    const supply = countrySupply[country];
    const exportableSupplyValue = unwrapUnit(supply.exportableSupply);
    worldSupplyValue += exportableSupplyValue;

    const demandShare = parameters.worldInfluenceWeight[country];
    const allocatedDemandValue = worldDemandValue * demandShare;
    const utilizationRatio = safeDivide(allocatedDemandValue, exportableSupplyValue);
    const supplyDemandImbalance = safeDivide(
      allocatedDemandValue - exportableSupplyValue,
      exportableSupplyValue
    );

    const localPressure =
      parameters.supplyDemandPressureWeight * supplyDemandImbalance +
      parameters.costPressureWeight * supply.costPressure;
    assertFinite(localPressure, `localPressure(${country})`);

    byCountry[country] = {
      country,
      exportableSupply: hosoEqTons(exportableSupplyValue),
      allocatedDemand: hosoEqTons(allocatedDemandValue),
      utilizationRatio,
      localPressure,
    };
  }

  let worldPressure = 0;
  for (const country of countryIds) {
    worldPressure += parameters.worldInfluenceWeight[country] * byCountry[country].localPressure;
  }
  assertFinite(worldPressure, "worldPressure");

  const worldSupplyDemandBalance = safeDivide(worldDemandValue - worldSupplyValue, worldSupplyValue);

  return {
    worldSupply: hosoEqTons(worldSupplyValue),
    worldDemand: hosoEqTons(worldDemandValue),
    worldSupplyDemandBalance,
    byCountry,
    worldPressure,
  };
}

// ---------------------------------------------------------------------
// Market Clearing: 価格の確定
// ---------------------------------------------------------------------

/**
 * Market Clearing（清算）。開場で確定した需給圧力から当期HOSO FOB価格を
 * 確定する。乱数ストリームから国順（countryIds の順）に1つずつショックを
 * 消費するため、消費順序は呼び出しごとに固定される（再現性の担保）。
 *
 * Rᵢ = localPressureWeight × L_i + worldPressureWeight × G + shock_i
 * 価格ᵢ,ₜ = 価格ᵢ,ₜ₋₁ × (1 + clamp(Rᵢ, -上限, +上限))
 */
export function clearHosoMarket(
  opening: MarketOpeningResult,
  priorPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>,
  countryIds: readonly CountryId[],
  parameters: MarketParameters,
  randomStream: RandomStream
): Readonly<Record<CountryId, CountryHosoPriceResult>> {
  const result = {} as Record<CountryId, CountryHosoPriceResult>;

  for (const country of countryIds) {
    const countryOpening = opening.byCountry[country];
    const priorPriceValue = unwrapUnit(priorPrice[country]);

    // 決定論的な小さな市場ショック: [-magnitude, +magnitude] の一様乱数。
    const shock =
      (randomStream.next() * 2 - 1) * parameters.marketShockMagnitude;

    const rawChangeRatio =
      parameters.localPressureWeight * countryOpening.localPressure +
      parameters.worldPressureWeight * opening.worldPressure +
      shock;

    const cap = parameters.maxQuarterlyPriceChangeRatio;
    const changeRatio = clamp(rawChangeRatio, -cap, cap);
    const wasCapped = Math.abs(rawChangeRatio - changeRatio) > 1e-12;

    let newPriceValue = priorPriceValue * (1 + changeRatio);
    newPriceValue = Math.max(newPriceValue, parameters.priceFloorUsdPerKg);

    const drivers: MarketPriceDriver[] = [];
    const t = parameters.driverThresholds;
    if (countryOpening.localPressure > t.supplyDemandImbalance) drivers.push("COUNTRY_SUPPLY_SHORTAGE");
    if (countryOpening.localPressure < -t.supplyDemandImbalance) drivers.push("COUNTRY_SUPPLY_SURPLUS");
    if (opening.worldSupplyDemandBalance > t.supplyDemandImbalance) drivers.push("GLOBAL_SUPPLY_SHORTAGE");
    if (opening.worldSupplyDemandBalance < -t.supplyDemandImbalance) drivers.push("GLOBAL_SUPPLY_SURPLUS");
    if (wasCapped) drivers.push("PRICE_CHANGE_CAPPED");
    if (Math.abs(shock) > 1e-9) drivers.push("MARKET_SHOCK_APPLIED");

    const finalChangeRatio = safeDivide(newPriceValue - priorPriceValue, priorPriceValue);

    result[country] = {
      country,
      price: usdPerHosoEqKg(newPriceValue),
      priorPrice: usdPerHosoEqKg(priorPriceValue),
      changeRatio: finalChangeRatio,
      localPressure: countryOpening.localPressure,
      worldPressure: opening.worldPressure,
      shockApplied: shock,
      exportableSupply: countryOpening.exportableSupply,
      allocatedDemand: countryOpening.allocatedDemand,
      utilizationRatio: countryOpening.utilizationRatio,
      drivers,
    };
  }

  return result;
}
