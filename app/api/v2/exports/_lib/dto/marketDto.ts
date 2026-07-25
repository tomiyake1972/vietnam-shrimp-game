// ShrimpX V2 — Export DTO / §4 市場結果（全17項目、公開情報のみ）
//
// 【データ源】entry.record.marketResult（MarketQuarterResult、app/lib/v2/market/types.ts）
// 会社別の非公開情報を一切含まない、全社共通の公開市場情報である。
//
// 【許可項目の明示的組み立て】内部型 MarketQuarterResult をそのままspreadせず、
// フィールドを1つずつ列挙して組み立てる（三宅さんの指示 §4）。
// hosoPrices と byCountry は Record<CountryId, ...> なので、COUNTRY_IDS の順に
// 走査して配列へ変換する（キー順序が環境依存にならないよう固定順で出力する）。
//
// 【三宅さんの指示 §4 の17項目との対応】
//   1. 国別HOSO価格             → hosoPricesByCountry[].price
//   2. 前期価格                 → hosoPricesByCountry[].priorPrice
//   3. 価格変化率               → hosoPricesByCountry[].changeRatio
//   4. 国別需給圧力             → hosoPricesByCountry[].localPressure / worldPressure
//   5. 輸出可能供給量           → hosoPricesByCountry[].exportableSupply
//   6. 配分需要                 → hosoPricesByCountry[].allocatedDemand
//   7. 稼働率                   → hosoPricesByCountry[].utilizationRatio
//   8. ベトナム国内原料価格     → vietnamDomestic.price
//   9. 買付上限                 → vietnamDomestic.buyingCeiling
//  10. 農家留保価格             → vietnamDomestic.farmerReservationPrice
//  11. 国内供給・需要・取引成立量 → vietnamDomestic.supply / effectiveDemand / transactedVolume
//  12. 未販売供給量             → vietnamDomestic.unsoldSupply
//  13. 国内需給バランス         → vietnamDomestic.imbalance
//  14. PDプレミアム             → pdPremium.basePremium
//  15. VAPプレミアム            → vapPremium.basePremium
//  16. 国別PD/VAP最終価格       → pdPremium.byCountry[].finalPrice / vapPremium.byCountry[].finalPrice
//  17. 市場ドライバー           → globalDrivers、各国 drivers、vietnamDomestic.drivers、各プレミアム drivers
//
// 【対象外（保存されているが本DTOでは出力しない）】
//   - MarketQuarterResult 以外の市場入力 MarketQuarterInput（国別生産量・経済指数等の
//     入力パラメータ）。§4は市場「結果」を対象としているため今回は出力しない。
// 【存在しない項目】市場別（CN/US/EU/JP/OTHER）の商品別価格は MarketQuarterResult に
//   保存されていない。市場別×商品別の価格は成約配分側（salesRecord.allocations の
//   basePrice、§3のsalesDto.ts）に保存されており、そちらから出力する。

import {
  COUNTRY_IDS,
  CountryHosoPriceResult,
  CountryProductPremium,
  MarketQuarterResult,
  ProductPremiumResult,
  VietnamDomesticResult,
} from "../../../../../lib/v2/market/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";

/** 1か国ぶんのHOSO価格結果（CountryHosoPriceResult の許可項目）。 */
export interface ExportCountryHosoPrice {
  readonly country: string;
  /** 当期HOSO FOB価格（USD/HOSO換算kg）。 */
  readonly price: number;
  /** 前期HOSO FOB価格（USD/HOSO換算kg）。 */
  readonly priorPrice: number;
  /** (price - priorPrice) / priorPrice。 */
  readonly changeRatio: number;
  /** この国固有の需給圧力。 */
  readonly localPressure: number;
  /** 世界共通の需給圧力。 */
  readonly worldPressure: number;
  /** 適用された決定論的ショック値（変化率への加算分）。 */
  readonly shockApplied: number;
  /** 輸出可能供給量（HOSO換算トン）。 */
  readonly exportableSupply: number;
  /** 配分需要（HOSO換算トン）。 */
  readonly allocatedDemand: number;
  /** allocatedDemand / exportableSupply（1超で需要超過）。 */
  readonly utilizationRatio: number;
  /** この国の価格ドライバー（理由コード）。 */
  readonly drivers: readonly string[];
}

function buildExportCountryHosoPrice(result: CountryHosoPriceResult): ExportCountryHosoPrice {
  return {
    country: result.country,
    price: result.price,
    priorPrice: result.priorPrice,
    changeRatio: result.changeRatio,
    localPressure: result.localPressure,
    worldPressure: result.worldPressure,
    shockApplied: result.shockApplied,
    exportableSupply: result.exportableSupply,
    allocatedDemand: result.allocatedDemand,
    utilizationRatio: result.utilizationRatio,
    drivers: [...result.drivers],
  };
}

/** ベトナム国内未凍結原料市場の清算結果（VietnamDomesticResult の許可項目）。 */
export interface ExportVietnamDomestic {
  /** 国内原料価格（USD/HOSO換算kg）。 */
  readonly price: number;
  /** 理論原料支払上限（USD/HOSO換算kg）。 */
  readonly buyingCeiling: number;
  /** 養殖農家の販売留保価格（USD/HOSO換算kg）。 */
  readonly farmerReservationPrice: number;
  /** 国内供給量（HOSO換算トン）。 */
  readonly supply: number;
  /** 最低引取ルール適用後の実効需要（HOSO換算トン）。 */
  readonly effectiveDemand: number;
  /** 実際に取引が成立した数量（HOSO換算トン）。 */
  readonly transactedVolume: number;
  /** 農家が売却しなかった潜在供給量（HOSO換算トン）。 */
  readonly unsoldSupply: number;
  /** (effectiveDemand - supply) / supply。 */
  readonly imbalance: number;
  readonly minimumOfftakeApplied: boolean;
  readonly reservationPriceApplied: boolean;
  readonly quantityRationed: boolean;
  readonly drivers: readonly string[];
}

function buildExportVietnamDomestic(result: VietnamDomesticResult): ExportVietnamDomestic {
  return {
    price: result.price,
    buyingCeiling: result.buyingCeiling,
    farmerReservationPrice: result.farmerReservationPrice,
    supply: result.supply,
    effectiveDemand: result.effectiveDemand,
    transactedVolume: result.transactedVolume,
    unsoldSupply: result.unsoldSupply,
    imbalance: result.imbalance,
    minimumOfftakeApplied: result.minimumOfftakeApplied,
    reservationPriceApplied: result.reservationPriceApplied,
    quantityRationed: result.quantityRationed,
    drivers: [...result.drivers],
  };
}

/** 1か国ぶんのPD/VAPプレミアム内訳（CountryProductPremium の許可項目＋国コード）。 */
export interface ExportCountryProductPremium {
  /**
   * 国コード。内部型 CountryProductPremium 自体は国コードを持たず
   * Record<CountryId, ...> のキーとして保持されているため、
   * COUNTRY_IDS の走査キーをそのまま転記する。
   */
  readonly country: string;
  /** HOSO FOB価格へ加算するプレミアム（USD/HOSO換算kg）。 */
  readonly premium: number;
  /** HOSO FOB価格 + premium（USD/HOSO換算kg）。 */
  readonly finalPrice: number;
  /** 品質優位に基づく加算分（premium の内数、USD/HOSO換算kg）。 */
  readonly qualityAdjustment: number;
  /** 当該国のこの製品の能力稼働率（需要/能力）。 */
  readonly capacityUtilization: number;
}

function buildExportCountryProductPremium(country: string, premium: CountryProductPremium): ExportCountryProductPremium {
  return {
    country,
    premium: premium.premium,
    finalPrice: premium.finalPrice,
    qualityAdjustment: premium.qualityAdjustment,
    capacityUtilization: premium.capacityUtilization,
  };
}

/** PDまたはVAPのプレミアム算出結果（ProductPremiumResult の許可項目）。 */
export interface ExportProductPremium {
  readonly product: string;
  /** 世界需要（HOSO換算トン）。 */
  readonly globalDemand: number;
  /** 世界加工能力（HOSO換算トン）。 */
  readonly globalCapacity: number;
  readonly globalUtilization: number;
  /** 世界共通のベースプレミアム（品質調整前、USD/HOSO換算kg）。 */
  readonly basePremium: number;
  readonly byCountry: readonly ExportCountryProductPremium[];
  readonly drivers: readonly string[];
}

function buildExportProductPremium(result: ProductPremiumResult): ExportProductPremium {
  return {
    product: result.product,
    globalDemand: result.globalDemand,
    globalCapacity: result.globalCapacity,
    globalUtilization: result.globalUtilization,
    basePremium: result.basePremium,
    byCountry: COUNTRY_IDS.map((country) => buildExportCountryProductPremium(country, result.byCountry[country])),
    drivers: [...result.drivers],
  };
}

/** 市場結果（公開情報）の全体。 */
export interface ExportMarketResult {
  readonly period: PeriodV2;
  readonly parametersVersion: string;
  /** 世界供給量（HOSO換算トン）。 */
  readonly worldSupply: number;
  /** 世界需要量（HOSO換算トン）。 */
  readonly worldDemand: number;
  /** (worldDemand - worldSupply) / worldSupply。 */
  readonly worldSupplyDemandBalance: number;
  /** 国別HOSO価格（COUNTRY_IDS の順： EC, IN, ID, VN）。 */
  readonly hosoPricesByCountry: readonly ExportCountryHosoPrice[];
  readonly vietnamDomestic: ExportVietnamDomestic;
  readonly pdPremium: ExportProductPremium;
  readonly vapPremium: ExportProductPremium;
  /** 世界共通の価格ドライバー（理由コード）。 */
  readonly globalDrivers: readonly string[];
}

export function buildExportMarketResult(market: MarketQuarterResult): ExportMarketResult {
  return {
    period: market.period,
    parametersVersion: market.parametersVersion,
    worldSupply: market.worldSupply,
    worldDemand: market.worldDemand,
    worldSupplyDemandBalance: market.worldSupplyDemandBalance,
    hosoPricesByCountry: COUNTRY_IDS.map((country) => buildExportCountryHosoPrice(market.hosoPrices[country])),
    vietnamDomestic: buildExportVietnamDomestic(market.vietnamDomestic),
    pdPremium: buildExportProductPremium(market.pdPremium),
    vapPremium: buildExportProductPremium(market.vapPremium),
    globalDrivers: [...market.globalDrivers],
  };
}
