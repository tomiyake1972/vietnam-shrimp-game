// ShrimpX V2 — 5シナリオ共通の長期トレンド組み立て（Phase 2）
//
// 実装指示 §12「BとCの初期条件はできる限り揃える」を満たすため、需要成長・
// 景気指数・養殖コストインフレという「物語に依存しない背景トレンド」を
// 一箇所に集約し、各シナリオ（definitions/*.ts）はこれをベースに、物語上の
// 差分（エクアドル拡張の有無・時期、疾病の有無、需要ブームの有無等）だけを
// 上書き／追加する。数値はすべてPhase2新規・要校正の仮置き。

import { CountryId, DemandMarketId } from "../../market/types";
import { LongTermTrend } from "../types";
import { SCENARIO_PREHISTORY_BASELINE_V1, STANDARD_SCENARIO_DURATION_TURNS } from "../parameters";
import { countryTrend, marketTrend, kf } from "./trendHelpers";

export const COUNTRY_IDS: readonly CountryId[] = ["EC", "IN", "ID", "VN"];
export const DEMAND_MARKET_IDS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];

/** 世界需要（地域別潜在需要）の標準的な緩やかな成長率（8年でこの倍率まで成長）。 */
export const DEFAULT_DEMAND_GROWTH_RATIO: Readonly<Record<DemandMarketId, number>> = {
  CN: 1.21,
  US: 1.11,
  EU: 1.06,
  JP: 1.02,
  OTHER: 1.17,
};

/** 国別養殖能力の標準的な緩やかな成長率（8年でこの倍率まで成長）。 */
export const DEFAULT_CAPACITY_GROWTH_RATIO: Readonly<Record<CountryId, number>> = {
  EC: 1.1,
  IN: 1.08,
  ID: 1.07,
  VN: 1.09,
};

/** 国別capacityの後方導出フォールバック（既定の稼働率・生残率・生産性から逆算）。 */
export function backSolvedCapacityApprox(country: CountryId): number {
  return SCENARIO_PREHISTORY_BASELINE_V1.countrySupplyHosoEqTons[country] / (0.85 * 0.85 * 1.0);
}

export function standardDemandTrends(
  idPrefix: string,
  growthRatio: Readonly<Record<DemandMarketId, number>> = DEFAULT_DEMAND_GROWTH_RATIO
): LongTermTrend[] {
  return DEMAND_MARKET_IDS.map((m) => {
    const start = SCENARIO_PREHISTORY_BASELINE_V1.priorMarketConsumptionHosoEqTons[m];
    return marketTrend(`${idPrefix}-demand-${m}`, "REGIONAL_DEMAND", m, [
      kf(1, start),
      kf(STANDARD_SCENARIO_DURATION_TURNS, start * growthRatio[m]),
    ]);
  });
}

export function standardEconomicIndexTrends(idPrefix: string): LongTermTrend[] {
  return DEMAND_MARKET_IDS.map((m) =>
    marketTrend(`${idPrefix}-econ-${m}`, "ECONOMIC_INDEX", m, [
      kf(1, 1.0),
      kf(16, 1.02),
      kf(STANDARD_SCENARIO_DURATION_TURNS, 1.03),
    ])
  );
}

export function standardCapacityTrends(
  idPrefix: string,
  excludeCountries: readonly CountryId[] = [],
  growthRatio: Readonly<Record<CountryId, number>> = DEFAULT_CAPACITY_GROWTH_RATIO
): LongTermTrend[] {
  return COUNTRY_IDS.filter((c) => !excludeCountries.includes(c)).map((c) => {
    const start = backSolvedCapacityApprox(c);
    return countryTrend(`${idPrefix}-capacity-${c}`, "COUNTRY_CAPACITY", c, [
      kf(1, start),
      kf(STANDARD_SCENARIO_DURATION_TURNS, start * growthRatio[c]),
    ]);
  });
}

export function standardAquacultureCostTrends(idPrefix: string): LongTermTrend[] {
  return COUNTRY_IDS.map((c) => {
    const start = SCENARIO_PREHISTORY_BASELINE_V1.countryAquacultureCostIndex[c];
    return countryTrend(`${idPrefix}-cost-${c}`, "AQUACULTURE_COST", c, [
      kf(1, start),
      kf(STANDARD_SCENARIO_DURATION_TURNS, start * 1.12),
    ]);
  });
}
