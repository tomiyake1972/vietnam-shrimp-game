// ShrimpX V2 — 市場・価格形成モジュール エントリポイント（Phase 1）
//
// 画面・API・Redis保存から独立した純粋なTypeScriptドメインモジュール。
// 将来のゲームエンジンは本モジュールを次のように呼び出す。
//
//   const marketResult = calculateMarketQuarter(input, parameters, randomStream);
//
// 内部では市場価格形成モジュール仕様書 v0.2 §11「ターン処理順序」のうち、
// Phase1が対象とする範囲（コスト指数・供給・世界需要・HOSO清算・国内原料市場・
// PD/VAPプレミアム）をこの順序で呼び出す。イベント抽選（§12）・情報レベル別
// レポート生成（§14）はPhase1のスコープ外（docs参照）。

import { RandomStream } from "../core/random";
import { COUNTRY_IDS, MarketQuarterInput, MarketQuarterResult, MarketPriceDriver } from "./types";
import { MarketParameters, MARKET_PARAMETERS_V1 } from "./parameters";
import { calculateWorldDemand } from "./globalDemand";
import { summarizeCountrySupply } from "./countrySupply";
import { openHosoMarket, clearHosoMarket } from "./hosoPricing";
import { clearVietnamRawMarket } from "./vietnamRawMarket";
import { calculateProductPremium } from "./productPremium";

/**
 * 1四半期分の市場・価格形成を計算する。入力オブジェクト（input/parameters）は
 * 一切変更しない。同じinput・同じparameters・同じ消費順序のrandomStreamからは
 * 常に同じ結果を返す（再現性。市場価格形成モジュール仕様書 v0.2 §2「再現可能性」）。
 *
 * randomStreamはこの関数の実行中に、国順（COUNTRY_IDS の順）で各国のHOSO価格
 * ショックを1回ずつ消費する。呼び出し側は、ターンごとに独立したRandomStreamを
 * 渡すか、消費順序が意図と一致することを確認した上で共有ストリームを渡すこと。
 */
export function calculateMarketQuarter(
  input: MarketQuarterInput,
  parameters: MarketParameters,
  randomStream: RandomStream
): MarketQuarterResult {
  const countryIds = COUNTRY_IDS;

  // 1. 国別のコスト指数変化・輸出可能供給量（市場価格形成モジュール仕様書 v0.2 §11 手順2-3, 6相当）
  const countrySupplySummary = summarizeCountrySupply(input.countries, countryIds);

  // 2. 世界需要（同 手順7）
  const worldDemand = calculateWorldDemand(input.demandMarkets);

  // 3. Market Opening（同 §9、手順8前半）
  const opening = openHosoMarket(
    countrySupplySummary,
    worldDemand.totalWorldDemand,
    countryIds,
    parameters
  );

  // 4. Market Clearing（同 §9、手順8後半）
  const hosoPrices = clearHosoMarket(opening, input.priorHosoFobPrice, countryIds, parameters, randomStream);

  // 5. ベトナム国内未凍結原料市場（同 §10、手順9-11）
  const vietnamDomestic = clearVietnamRawMarket(hosoPrices.VN.price, input.vietnamDomestic, parameters);

  // 6. PD/VAPプレミアム（全体実装計画書 v0.1 Product型・PD/VAPプレミアム定義）
  const pdPremium = calculateProductPremium(
    "pd",
    hosoPrices,
    input.countries,
    countryIds,
    { demand: input.pdVapDemand.pdDemand, basePremiumRatio: parameters.pdVapPremium.pdBasePremiumRatio },
    parameters
  );
  const vapPremium = calculateProductPremium(
    "vap",
    hosoPrices,
    input.countries,
    countryIds,
    { demand: input.pdVapDemand.vapDemand, basePremiumRatio: parameters.pdVapPremium.vapBasePremiumRatio },
    parameters
  );

  const globalDrivers = collectGlobalDrivers(hosoPrices, vietnamDomestic, pdPremium, vapPremium);

  return {
    period: input.period,
    parametersVersion: parameters.parametersVersion,
    hosoPrices,
    worldSupply: opening.worldSupply,
    worldDemand: opening.worldDemand,
    worldSupplyDemandBalance: opening.worldSupplyDemandBalance,
    vietnamDomestic,
    pdPremium,
    vapPremium,
    globalDrivers,
  };
}

function collectGlobalDrivers(
  hosoPrices: MarketQuarterResult["hosoPrices"],
  vietnamDomestic: MarketQuarterResult["vietnamDomestic"],
  pdPremium: MarketQuarterResult["pdPremium"],
  vapPremium: MarketQuarterResult["vapPremium"]
): readonly MarketPriceDriver[] {
  const set = new Set<MarketPriceDriver>();
  for (const country of COUNTRY_IDS) {
    for (const driver of hosoPrices[country].drivers) set.add(driver);
  }
  for (const driver of vietnamDomestic.drivers) set.add(driver);
  for (const driver of pdPremium.drivers) set.add(driver);
  for (const driver of vapPremium.drivers) set.add(driver);
  return Array.from(set);
}

export { MARKET_PARAMETERS_V1 };
export type { MarketParameters } from "./parameters";
export * from "./types";
export { calculateWorldDemand, calculateMarketDemand } from "./globalDemand";
export { calculateExportableSupply, calculateCostPressure, summarizeCountrySupply } from "./countrySupply";
export { openHosoMarket, clearHosoMarket } from "./hosoPricing";
export { calculateBuyingCeiling, applyMinimumOfftakeRule, clearVietnamRawMarket } from "./vietnamRawMarket";
export { calculateProductPremium } from "./productPremium";
