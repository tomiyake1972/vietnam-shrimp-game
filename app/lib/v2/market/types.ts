// ShrimpX V2 — 市場・価格形成モジュール 共通型（Phase 1）
//
// 本ファイルはこのモジュールの入出力型のみを定義する。画面・API・Redisには
// 一切依存しない（市場価格形成モジュール仕様書 v0.2 §1.1「実装後に係数を
// 変更しても、販売・調達・財務モジュールへ影響を限定できるよう独立性を
// 確保する」に対応）。
//
// Product / DemandMarketId(元の型名は "Market") は、全体実装計画書 v0.1
// §19「共通TypeScriptデータモデル」で定義されている
//   type Product = "hoso" | "pd" | "vap";
//   type Market = "CN" | "US" | "EU" | "JP" | "OTHER";
// をそのまま踏襲する。ただし "Market" という型名は本モジュール内で
// 「市場清算（Market Clearing）」等、"market" という語を別の意味でも
// 多用するため、命名衝突を避けて DemandMarketId へリネームしている
// （値は完全に同一。docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md に
// 仕様からの命名変更として明記する）。

import { HosoEqTons, UsdPerHosoEqKg, Ratio, Score0to100 } from "../core/units";
import { PeriodV2 } from "../core/period";

export class MarketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketValidationError";
  }
}

/** 対象産地（国際HOSO市場・PD/VAP加工能力を持つ4か国）。 */
export type CountryId = "EC" | "IN" | "ID" | "VN";
export const COUNTRY_IDS: readonly CountryId[] = ["EC", "IN", "ID", "VN"];

/** 全体実装計画書 §19 の Product 型をそのまま踏襲。 */
export type Product = "hoso" | "pd" | "vap";

/**
 * 需要側の主要市場。全体実装計画書 §19 の `Market` 型と同一の値集合だが、
 * このモジュール内での命名衝突を避けるため DemandMarketId と改称している。
 */
export type DemandMarketId = "CN" | "US" | "EU" | "JP" | "OTHER";
export const DEMAND_MARKET_IDS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];

/**
 * 価格変動の主要因を表す理由コード。GM・将来の生成AI解説がそのまま
 * 参照できるよう、価格の数値だけでなく「なぜ動いたか」を機械可読な形で
 * 保持する（市場価格形成モジュール仕様書 v0.2 §2「説明可能性」）。
 */
export type MarketPriceDriver =
  | "GLOBAL_SUPPLY_SHORTAGE"
  | "GLOBAL_SUPPLY_SURPLUS"
  | "COUNTRY_SUPPLY_SHORTAGE"
  | "COUNTRY_SUPPLY_SURPLUS"
  | "AQUACULTURE_COST_INCREASE"
  | "AQUACULTURE_COST_DECREASE"
  | "DEMAND_GROWTH"
  | "DEMAND_CONTRACTION"
  | "PRICE_CHANGE_CAPPED"
  | "MARKET_SHOCK_APPLIED"
  | "VIETNAM_RAW_MATERIAL_SHORTAGE"
  | "VIETNAM_RAW_MATERIAL_SURPLUS"
  | "MINIMUM_OFFTAKE_RULE_APPLIED"
  | "PROCESSING_CAPACITY_OVERSUPPLY"
  | "PD_CAPACITY_TIGHTNESS"
  | "VAP_CAPACITY_TIGHTNESS"
  | "VAP_DEMAND_STRENGTH"
  | "ECUADOR_PD_CAPACITY_EXPANSION"
  | "QUALITY_PREMIUM_APPLIED";

// ---------------------------------------------------------------------
// 入力型
// ---------------------------------------------------------------------

/** 需要側1市場（CN/US/EU/JP/OTHER）分の当期入力。 */
export interface DemandMarketInput {
  /** 前期のこの市場でのHOSO換算消費量（市場価格形成モジュール仕様書 v0.2 §8）。 */
  readonly priorPeriodConsumption: HosoEqTons;
  /** 景気指数。1.0=横ばい、1.0超で拡大、1.0未満で縮小。 */
  readonly economicIndex: number;
  /** 四半期換算の人口増加率（負値も許容。目安 -0.05〜0.05）。 */
  readonly populationGrowthRate: number;
}

/** 産地1か国（EC/IN/ID/VN）分の当期入力。 */
export interface CountrySupplyInput {
  /** 当期のHOSO換算生産量（収穫量）。 */
  readonly production: HosoEqTons;
  /** 生産量のうち輸出向けに振り向けられる比率（国内消費・加工仕向け控除後）。 */
  readonly exportCapacityRatio: Ratio;
  /** 養殖コスト指数。基準期を1.0とした相対値（正の実数、上限なし）。 */
  readonly aquacultureCostIndex: number;
  /** 前期の養殖コスト指数（コスト変化率の算出に用いる）。 */
  readonly priorAquacultureCostIndex: number;
  /** 品質評価（PD/VAPプレミアムの品質優位判定にも使用）。 */
  readonly qualityScore: Score0to100;
  /** 供給信頼性評価。 */
  readonly reliabilityScore: Score0to100;
  /** 当該国のPD加工能力（HOSO換算量ベース、四半期あたり）。 */
  readonly pdProcessingCapacity: HosoEqTons;
  /** 当該国のVAP加工能力（HOSO換算量ベース、四半期あたり）。 */
  readonly vapProcessingCapacity: HosoEqTons;
}

/** ベトナム国内未凍結原料市場の当期入力。 */
export interface VietnamDomesticInput {
  /** 当期のベトナム国内未凍結原料の供給量（収穫量ベース）。 */
  readonly domesticRawSupply: HosoEqTons;
  /**
   * 5社＋NPC合計の国内買付希望量（業界集計値）。今回のPhase 1では
   * 各社個別の調達意思決定を実装しないため、将来の調達モジュールが
   * 会社別に積み上げた値をこの1フィールドに集計して渡す想定
   * （このモジュールの外側の責務。詳細はdocs参照）。
   */
  readonly domesticProcurementIntent: HosoEqTons;
  /**
   * 過去4四半期の国内購入平均（業界集計）。プロラタ最低引取ルール
   * （全体実装計画書 v0.1 §10.1「過去4Qの国内購入平均×20%を最低引取
   * 基準とする」）の算出に用いる。
   */
  readonly trailingAverageDomesticPurchase: HosoEqTons;
  /** 原料からHOSO換算製品への歩留まり。 */
  readonly hosoYieldRatio: Ratio;
  /** 加工輸出費用（HOSO換算kgあたり、USD）。 */
  readonly processingExportCostUsdPerKg: UsdPerHosoEqKg;
  /** 加工会社が必要とする利益（同単位）。 */
  readonly requiredMarginUsdPerKg: UsdPerHosoEqKg;
}

/** PD/VAP需要構成の当期入力（世界全体集計）。 */
export interface PdVapDemandInput {
  /** 世界全体のPD需要量（HOSO換算）。 */
  readonly pdDemand: HosoEqTons;
  /** 世界全体のVAP需要量（HOSO換算）。 */
  readonly vapDemand: HosoEqTons;
}

/** calculateMarketQuarter への当期入力全体。 */
export interface MarketQuarterInput {
  readonly period: PeriodV2;
  /** 前期の国別HOSO FOB価格。 */
  readonly priorHosoFobPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>;
  readonly countries: Readonly<Record<CountryId, CountrySupplyInput>>;
  readonly demandMarkets: Readonly<Record<DemandMarketId, DemandMarketInput>>;
  readonly vietnamDomestic: VietnamDomesticInput;
  readonly pdVapDemand: PdVapDemandInput;
}

// ---------------------------------------------------------------------
// 出力型
// ---------------------------------------------------------------------

/** 国別HOSO FOB価格の算出結果と、その内訳・理由コード。 */
export interface CountryHosoPriceResult {
  readonly country: CountryId;
  readonly price: UsdPerHosoEqKg;
  readonly priorPrice: UsdPerHosoEqKg;
  /** (price - priorPrice) / priorPrice。 */
  readonly changeRatio: number;
  /** この国固有の需給圧力 L_i（市場価格形成モジュール仕様書 v0.2 §9.2）。 */
  readonly localPressure: number;
  /** 世界共通圧力 G。 */
  readonly worldPressure: number;
  /** 適用された決定論的ショック値（変化率への加算分）。 */
  readonly shockApplied: number;
  readonly exportableSupply: HosoEqTons;
  readonly allocatedDemand: HosoEqTons;
  /** allocatedDemand / exportableSupply。1超で需要超過。 */
  readonly utilizationRatio: number;
  readonly drivers: readonly MarketPriceDriver[];
}

/** ベトナム国内未凍結原料市場の清算結果。 */
export interface VietnamDomesticResult {
  readonly price: UsdPerHosoEqKg;
  /** 理論原料支払上限（市場価格形成モジュール仕様書 v0.2 §10.2）。 */
  readonly buyingCeiling: UsdPerHosoEqKg;
  readonly supply: HosoEqTons;
  /** プロラタ最低引取ルール適用後の実効需要。 */
  readonly effectiveDemand: HosoEqTons;
  /** (effectiveDemand - supply) / supply。正で供給不足、負で供給過剰。 */
  readonly imbalance: number;
  /** 最低引取ルール（全体実装計画書 v0.1 §10.1）が発動したか。 */
  readonly minimumOfftakeApplied: boolean;
  readonly drivers: readonly MarketPriceDriver[];
}

/** 1か国分のPD/VAPプレミアム内訳。 */
export interface CountryProductPremium {
  /** country の HOSO FOB価格に加算するプレミアム。 */
  readonly premium: UsdPerHosoEqKg;
  /** country の HOSO FOB価格 + premium。 */
  readonly finalPrice: UsdPerHosoEqKg;
  /** 品質優位に基づく加算分（premium の内数）。 */
  readonly qualityAdjustment: UsdPerHosoEqKg;
  /** 当該国のこの製品の能力稼働率（需要/能力）。 */
  readonly capacityUtilization: number;
}

/** PD または VAP いずれか一方のプレミアム算出結果（世界全体＋国別）。 */
export interface ProductPremiumResult {
  readonly product: Extract<Product, "pd" | "vap">;
  readonly globalDemand: HosoEqTons;
  readonly globalCapacity: HosoEqTons;
  readonly globalUtilization: number;
  /** 世界共通のベースプレミアム（品質調整前）。 */
  readonly basePremium: UsdPerHosoEqKg;
  readonly byCountry: Readonly<Record<CountryId, CountryProductPremium>>;
  readonly drivers: readonly MarketPriceDriver[];
}

/** calculateMarketQuarter の出力全体。 */
export interface MarketQuarterResult {
  readonly period: PeriodV2;
  readonly parametersVersion: string;
  readonly hosoPrices: Readonly<Record<CountryId, CountryHosoPriceResult>>;
  readonly worldSupply: HosoEqTons;
  readonly worldDemand: HosoEqTons;
  /** (worldDemand - worldSupply) / worldSupply。 */
  readonly worldSupplyDemandBalance: number;
  readonly vietnamDomestic: VietnamDomesticResult;
  readonly pdPremium: ProductPremiumResult;
  readonly vapPremium: ProductPremiumResult;
  readonly globalDrivers: readonly MarketPriceDriver[];
}
