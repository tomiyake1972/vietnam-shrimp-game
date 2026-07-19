// ShrimpX V2 — 世界需要モデル（Phase 1）
//
// 市場価格形成モジュール仕様書 v0.2 §8「世界需要モデル」に対応。
// 主要市場別（CN/US/EU/JP/OTHER）に需要を保持し、単一の世界指数へ
// 単純化しない（仕様書 §2「市場分離」原則）。
//
// 需要ₘ,ₜ = 前期消費量ₘ × 景気指数ₘ × (1 + 人口増加率ₘ)
//
// 仕様書§8の完全な需要式（季節性・在庫調整・価格弾力性・原産国選好・代替調達を含む）
// のうち、Phase1では「基礎需要（前期消費量）×景気×人口」のみを実装する。
// 季節性・在庫調整・価格弾力性・原産国選好・代替調達はPhase1のスコープ外
// （docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md の「未実装事項」に明記）。

import { HosoEqTons, hosoEqTons, unwrapUnit } from "../core/units";
import { DemandMarketId, DemandMarketInput, DEMAND_MARKET_IDS } from "./types";
import { assertFinite } from "./validation";

export interface WorldDemandResult {
  readonly totalWorldDemand: HosoEqTons;
  readonly byMarket: Readonly<Record<DemandMarketId, HosoEqTons>>;
}

/** 1市場分の当期需要量を算出する。 */
export function calculateMarketDemand(input: DemandMarketInput): HosoEqTons {
  assertFinite(input.economicIndex, "economicIndex");
  assertFinite(input.populationGrowthRate, "populationGrowthRate");
  const prior = unwrapUnit(input.priorPeriodConsumption);
  const demand = prior * input.economicIndex * (1 + input.populationGrowthRate);
  return hosoEqTons(Math.max(demand, 0));
}

/** 全市場を集計し、世界全体の需要量と市場別内訳を返す。入力を変更しない。 */
export function calculateWorldDemand(
  demandMarkets: Readonly<Record<DemandMarketId, DemandMarketInput>>
): WorldDemandResult {
  const byMarket = {} as Record<DemandMarketId, HosoEqTons>;
  let total = 0;
  for (const marketId of DEMAND_MARKET_IDS) {
    const marketDemand = calculateMarketDemand(demandMarkets[marketId]);
    byMarket[marketId] = marketDemand;
    total += unwrapUnit(marketDemand);
  }
  return { totalWorldDemand: hosoEqTons(total), byMarket };
}
