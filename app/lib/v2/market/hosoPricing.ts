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
 * §16「簡易世界影響度 EC45/IN25/VN18/ID12」を国別の世界需要シェアの基準として
 * 使う（Phase1の簡易化）。
 *
 * 【Phase 6.3修正（実装指示 §8）】priorPriceが与えられた場合、需要シェアを
 * 前期価格に応答させる: share_i ∝ weight_i × exp(-感度 × (価格_i - 需要ウェイト
 * 平均価格) / 平均価格)。安い原産国へ需要が移ることで、割安になった国の需給が
 * 引き締まり、価格下落が自己修正される（同品質の国際商品の裁定の簡易表現）。
 * priorPrice未指定・感度0では従来の固定シェア配分（後方互換）。
 */
export function openHosoMarket(
  countrySupply: Readonly<Record<CountryId, CountrySupplySummary>>,
  worldDemand: HosoEqTons,
  countryIds: readonly CountryId[],
  parameters: MarketParameters,
  priorPrice?: Readonly<Record<CountryId, UsdPerHosoEqKg>>
): MarketOpeningResult {
  const worldDemandValue = unwrapUnit(worldDemand);
  let worldSupplyValue = 0;
  const byCountry = {} as Record<CountryId, CountryMarketOpening>;

  // --- 需要シェア（価格応答つき）の決定 ---
  const sensitivity = parameters.hosoPriceSelfCorrection.demandReallocationPriceSensitivity;
  const demandShares = {} as Record<CountryId, number>;
  if (priorPrice !== undefined && sensitivity > 0) {
    let referencePrice = 0;
    for (const country of countryIds) {
      referencePrice += parameters.worldInfluenceWeight[country] * unwrapUnit(priorPrice[country]);
    }
    let totalAdjusted = 0;
    const adjusted = {} as Record<CountryId, number>;
    for (const country of countryIds) {
      const deviation = referencePrice > 0 ? (unwrapUnit(priorPrice[country]) - referencePrice) / referencePrice : 0;
      const w = parameters.worldInfluenceWeight[country] * Math.exp(-sensitivity * deviation);
      assertFinite(w, `demandShareWeight(${country})`);
      adjusted[country] = w;
      totalAdjusted += w;
    }
    for (const country of countryIds) {
      demandShares[country] = totalAdjusted > 0 ? adjusted[country] / totalAdjusted : parameters.worldInfluenceWeight[country];
    }
  } else {
    for (const country of countryIds) {
      demandShares[country] = parameters.worldInfluenceWeight[country];
    }
  }

  for (const country of countryIds) {
    const supply = countrySupply[country];
    const exportableSupplyValue = unwrapUnit(supply.exportableSupply);
    worldSupplyValue += exportableSupplyValue;

    const demandShare = demandShares[country];
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
 *      − meanReversionRate × (価格ᵢ,ₜ₋₁ − アンカーᵢ,ₜ) / アンカーᵢ,ₜ 【Phase 6.3】
 * 価格ᵢ,ₜ = 価格ᵢ,ₜ₋₁ × (1 + clamp(Rᵢ, -上限, +上限))
 * さらに国別価格をグローバル基準価格（需要ウェイト平均）±最大乖離比率へ
 * クランプする【Phase 6.3】。
 *
 * アンカー価格ᵢ,ₜ = initialHosoFobPrice_i × 養殖コスト指数ᵢ,ₜ（コスト連動の
 * 長期基準）。恒常的な需給圧力Pの下でも、価格はアンカー比 P/回帰率 の有限な
 * ディスカウント/プレミアムへ収束し、絶対下限へ発散しない（積分器の暴走防止）。
 * costIndexByCountry未指定時はコスト指数1.0（=アンカーは初期価格のまま）。
 */
export function clearHosoMarket(
  opening: MarketOpeningResult,
  priorPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>,
  countryIds: readonly CountryId[],
  parameters: MarketParameters,
  randomStream: RandomStream,
  costIndexByCountry?: Readonly<Record<CountryId, number>>
): Readonly<Record<CountryId, CountryHosoPriceResult>> {
  const result = {} as Record<CountryId, CountryHosoPriceResult>;
  const sc = parameters.hosoPriceSelfCorrection;

  // 第1パス: 変化率ベースの候補価格を国順に確定する（乱数消費順序は従来どおり）。
  const candidates = {} as Record<
    CountryId,
    { priceValue: number; shock: number; wasCapped: boolean; priorPriceValue: number }
  >;
  for (const country of countryIds) {
    const countryOpening = opening.byCountry[country];
    const priorPriceValue = unwrapUnit(priorPrice[country]);

    // 決定論的な小さな市場ショック: [-magnitude, +magnitude] の一様乱数。
    const shock =
      (randomStream.next() * 2 - 1) * parameters.marketShockMagnitude;

    // 【Phase 6.3】コスト連動アンカーへの平均回帰項。
    const costIndex = costIndexByCountry !== undefined ? costIndexByCountry[country] : 1.0;
    const anchorPrice = parameters.initialHosoFobPriceUsdPerKg[country] * Math.max(costIndex, 1e-9);
    const anchorDeviation = safeDivide(priorPriceValue - anchorPrice, anchorPrice);
    const reversionTerm = -sc.meanReversionRate * anchorDeviation;

    const rawChangeRatio =
      parameters.localPressureWeight * countryOpening.localPressure +
      parameters.worldPressureWeight * opening.worldPressure +
      reversionTerm +
      shock;

    const cap = parameters.maxQuarterlyPriceChangeRatio;
    const changeRatio = clamp(rawChangeRatio, -cap, cap);
    const wasCapped = Math.abs(rawChangeRatio - changeRatio) > 1e-12;

    let newPriceValue = priorPriceValue * (1 + changeRatio);
    newPriceValue = Math.max(newPriceValue, parameters.priceFloorUsdPerKg);
    candidates[country] = { priceValue: newPriceValue, shock, wasCapped, priorPriceValue };
  }

  // 第2パス【Phase 6.3】: グローバル基準価格（需要ウェイト平均）に対する有限
  // スプレッドへクランプする（同品質の国際商品の原産国価格が長期間極端に
  // 乖離しない、という経済原則の下限・上限ガード）。
  let referencePriceValue = 0;
  for (const country of countryIds) {
    referencePriceValue += parameters.worldInfluenceWeight[country] * candidates[country].priceValue;
  }
  const maxDev = sc.maxCountryDeviationRatioFromReference;

  for (const country of countryIds) {
    const countryOpening = opening.byCountry[country];
    const c = candidates[country];

    let newPriceValue = c.priceValue;
    let spreadBounded = false;
    if (maxDev > 0 && referencePriceValue > 0) {
      const lower = referencePriceValue * (1 - maxDev);
      const upper = referencePriceValue * (1 + maxDev);
      const bounded = clamp(newPriceValue, lower, upper);
      spreadBounded = Math.abs(bounded - newPriceValue) > 1e-12;
      newPriceValue = bounded;
    }
    newPriceValue = Math.max(newPriceValue, parameters.priceFloorUsdPerKg);

    const drivers: MarketPriceDriver[] = [];
    const t = parameters.driverThresholds;
    if (countryOpening.localPressure > t.supplyDemandImbalance) drivers.push("COUNTRY_SUPPLY_SHORTAGE");
    if (countryOpening.localPressure < -t.supplyDemandImbalance) drivers.push("COUNTRY_SUPPLY_SURPLUS");
    if (opening.worldSupplyDemandBalance > t.supplyDemandImbalance) drivers.push("GLOBAL_SUPPLY_SHORTAGE");
    if (opening.worldSupplyDemandBalance < -t.supplyDemandImbalance) drivers.push("GLOBAL_SUPPLY_SURPLUS");
    if (c.wasCapped) drivers.push("PRICE_CHANGE_CAPPED");
    if (spreadBounded) drivers.push("COUNTRY_PRICE_SPREAD_BOUNDED");
    if (Math.abs(c.shock) > 1e-9) drivers.push("MARKET_SHOCK_APPLIED");

    const finalChangeRatio = safeDivide(newPriceValue - c.priorPriceValue, c.priorPriceValue);

    result[country] = {
      country,
      price: usdPerHosoEqKg(newPriceValue),
      priorPrice: usdPerHosoEqKg(c.priorPriceValue),
      changeRatio: finalChangeRatio,
      localPressure: countryOpening.localPressure,
      worldPressure: opening.worldPressure,
      shockApplied: c.shock,
      exportableSupply: countryOpening.exportableSupply,
      allocatedDemand: countryOpening.allocatedDemand,
      utilizationRatio: countryOpening.utilizationRatio,
      drivers,
    };
  }

  return result;
}
