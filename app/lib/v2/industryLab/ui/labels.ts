// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 日本語ラベルマップ
//
// 市場モジュールの理由コード（MarketPriceDriver）・シナリオモジュールの
// イベント種別（ScenarioEventType）・イベント発現段階・情報公開レベルを
// 画面へ日本語表示するための静的なラベルマップのみを提供する。
// 生成AI（Claude API等）は一切使わない（実装指示 §7・§17）。

import { MarketPriceDriver } from "../../market/types";
import { ScenarioEventType } from "../../scenario/types";
import { ScenarioEventPhase, DisplayInformationLevel } from "../types";

export const MARKET_PRICE_DRIVER_LABELS: Readonly<Record<MarketPriceDriver, string>> = {
  GLOBAL_SUPPLY_SHORTAGE: "世界供給不足",
  GLOBAL_SUPPLY_SURPLUS: "世界供給過剰",
  COUNTRY_SUPPLY_SHORTAGE: "当該国の供給不足",
  COUNTRY_SUPPLY_SURPLUS: "当該国の供給過剰",
  AQUACULTURE_COST_INCREASE: "養殖コスト上昇",
  AQUACULTURE_COST_DECREASE: "養殖コスト低下",
  DEMAND_GROWTH: "需要拡大",
  DEMAND_CONTRACTION: "需要縮小",
  PRICE_CHANGE_CAPPED: "価格変化率の上限に到達",
  COUNTRY_PRICE_SPREAD_BOUNDED: "国別価格差が基準価格からの上限に到達",
  MARKET_SHOCK_APPLIED: "市場ショック適用",
  VIETNAM_RAW_MATERIAL_SHORTAGE: "ベトナム国内原料不足",
  VIETNAM_RAW_MATERIAL_SURPLUS: "ベトナム国内原料過剰",
  MINIMUM_OFFTAKE_RULE_APPLIED: "プロラタ最低買付ルール発動",
  VIETNAM_FARMER_RESERVATION_PRICE_APPLIED: "農家の販売留保価格で下支え",
  VIETNAM_PROCUREMENT_QUANTITY_RATIONED: "買付上限が留保価格を下回り取引数量が縮小",
  PROCESSING_CAPACITY_OVERSUPPLY: "加工能力の供給過剰",
  PD_CAPACITY_TIGHTNESS: "PD加工能力の逼迫",
  VAP_CAPACITY_TIGHTNESS: "VAP加工能力の逼迫",
  VAP_DEMAND_STRENGTH: "VAP需要の強さ",
  ECUADOR_PD_CAPACITY_EXPANSION: "エクアドル・インドPD能力の拡大",
  QUALITY_PREMIUM_APPLIED: "品質プレミアム適用",
};

export function marketPriceDriverLabel(driver: MarketPriceDriver): string {
  return MARKET_PRICE_DRIVER_LABELS[driver] ?? driver;
}

export const SCENARIO_EVENT_TYPE_LABELS: Readonly<Record<ScenarioEventType, string>> = {
  DISEASE_OUTBREAK: "疾病発生",
  ABNORMAL_WEATHER: "異常気象",
  FEED_COST_SHOCK: "飼料コストショック",
  TRADE_REGULATION: "貿易規制",
  LOGISTICS_DISRUPTION: "物流混乱",
  DEMAND_SHOCK: "需要ショック",
  FOOD_SAFETY_INCIDENT: "食品安全上の事案",
  CAPACITY_EXPANSION: "能力拡張",
  CAPACITY_DELAY: "能力拡張の遅延",
  ECONOMIC_BOOM: "好況",
  ECONOMIC_DOWNTURN: "景気後退",
};

export function scenarioEventTypeLabel(eventType: ScenarioEventType): string {
  return SCENARIO_EVENT_TYPE_LABELS[eventType] ?? eventType;
}

export const SCENARIO_EVENT_PHASE_LABELS: Readonly<Record<ScenarioEventPhase, string>> = {
  beforeStart: "開始前",
  rampUp: "ramp-up（立ち上がり中）",
  active: "継続中",
  recovering: "回復中",
  ended: "終了",
};

export function scenarioEventPhaseLabel(phase: ScenarioEventPhase): string {
  return SCENARIO_EVENT_PHASE_LABELS[phase] ?? phase;
}

export const DISPLAY_INFORMATION_LEVEL_LABELS: Readonly<Record<DisplayInformationLevel, string>> = {
  public: "公開情報（一般プレイヤー相当）",
  standard: "標準情報",
  advanced: "高度情報",
  gm: "GM専用（内部情報すべて）",
};

export function displayInformationLevelLabel(level: DisplayInformationLevel): string {
  return DISPLAY_INFORMATION_LEVEL_LABELS[level] ?? level;
}
