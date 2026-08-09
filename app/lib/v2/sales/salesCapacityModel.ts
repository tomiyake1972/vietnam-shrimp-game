// ShrimpX V2 — 営業能力モデル（Phase 6B 校正・比較用。2026-08-09新設）
//
// 【なぜこのモジュールが要るのか（#04 §1 への回答）】
// salesForce.ts の processingCapacity(headcount) は、doc comment を読むかぎり
// 「営業人員数 → 処理能力」という**会社レベルの一般関数**として書かれている
// （市場という語が一度も出てこない）。ところが SAI-2 追加作業で導入された
// marketEffort.ts は、これを**市場ごとに独立に**適用した。曲線そのものは
// 再校正されなかったため、同一会社の中で同じ飽和曲線が5回掛かる形になった。
//
// 実測（scripts/salesCapacityAudit.ts）:
//   capacity(h) = 200 + 24,000 × h/(h+70)  を市場ごとに適用
//   → 1市場の漸近上限 24,200 工数t、5市場でも 121,000 工数t
//   → 1工場分（約18,500t、約1.57工数t/t）を売るのに 500〜700人が必要
//
// 【このモジュールの位置づけ】
// **正式モデルをまだ決め打ちしない**（#04 §16）。3案を同一インターフェースで
// 切り替えられるようにし、32Q ベンチマークで比較するための土台である。
// 既定は "perMarket"（現行）であり、指定しなければ挙動はビット単位で不変。

import { DemandMarketId } from "../market/types";
import { SalesParameters } from "./parameters";
import { processingCapacity } from "./salesForce";
import { unwrapUnit } from "../core/units";

const EPSILON = 1e-6;

/**
 * 営業能力モデルの種別。
 *
 *  perMarket   … Case Control（現行）。市場ごとに飽和曲線を独立適用する。
 *  companyWide … Case B。会社全体で1回だけ能力を求め、市場へ配分する。
 *  companyWideWithFragmentation
 *              … Case C。Case B に市場展開・商品複雑性の非効率を残す。
 */
export type SalesCapacityModelKind = "perMarket" | "companyWide" | "companyWideWithFragmentation";

export interface SalesCapacityModel {
  readonly kind: SalesCapacityModelKind;
  /**
   * 会社全体モデル（companyWide / companyWideWithFragmentation）で使う曲線。
   * perMarket では未使用（params.salesForce の値をそのまま使う）。
   */
  readonly companyBaselineCapacityTons: number;
  readonly companyCapacityMaxIncrementTons: number;
  readonly companyCapacitySaturationHeadcount: number;
  /**
   * Case C のみ。展開市場が1つ増えるごとに失われる能力の比率。
   * 「5市場だから5倍必要」にはしない — 成長するほど少し運営が難しくなる程度。
   * 例: 0.04 なら 5市場で (1 - 0.04×4) = 0.84 倍。
   */
  readonly fragmentationPenaltyPerExtraMarket: number;
  /** Case C のフラグメンテーション係数の下限（過度な罰を避ける）。 */
  readonly fragmentationFloor: number;
}

/** Case Control（現行）。市場ごとに salesForce の曲線を独立適用する。 */
export const SALES_CAPACITY_MODEL_PER_MARKET: SalesCapacityModel = {
  kind: "perMarket",
  companyBaselineCapacityTons: 0,
  companyCapacityMaxIncrementTons: 0,
  companyCapacitySaturationHeadcount: 1,
  fragmentationPenaltyPerExtraMarket: 0,
  fragmentationFloor: 1,
};

/**
 * 会社全体の営業組織能力（工数t）。
 *
 * perMarket モデルではこの関数は使わない（呼び出し側が市場ごとに求める）。
 */
export function companySalesOrganizationCapacity(totalHeadcount: number, model: SalesCapacityModel): number {
  const h = Math.max(0, totalHeadcount);
  const growth = h / (h + model.companyCapacitySaturationHeadcount);
  return model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons * growth;
}

/**
 * Case C の市場分散による非効率係数。
 * 市場数が1のとき1.0、増えるごとに一定比率で低下し、floor で下げ止まる。
 * **単調非増加**であることをテストで固定する。
 */
export function marketFragmentationFactor(marketCount: number, model: SalesCapacityModel): number {
  if (model.kind !== "companyWideWithFragmentation") return 1;
  const extra = Math.max(0, marketCount - 1);
  return Math.max(model.fragmentationFloor, 1 - model.fragmentationPenaltyPerExtraMarket * extra);
}

/**
 * 会社の各市場が使える営業工数能力（工数t）。
 *
 * 【唯一の計算箇所（SSoT）】Standard AI 側（decision/sales.ts）とエンジン側
 * （sales/marketEffort.ts）は必ずこの関数を通す。片側だけ別式にしない。
 *
 * companyWide 系では、会社全体の能力を**その市場の営業工数需要の比率**で配分する
 * （需要の無い市場へ能力を配らない）。したがって各市場の能力合計は、
 * 会社全体の能力を決して超えない。
 */
export function computeMarketSalesCapacities(
  totalHeadcount: number,
  effortDemandByMarket: ReadonlyMap<DemandMarketId, number>,
  headcountByMarket: ReadonlyMap<DemandMarketId, number>,
  params: SalesParameters,
  model: SalesCapacityModel = params.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET
): Map<DemandMarketId, number> {
  const markets = [...effortDemandByMarket.keys()].sort();
  const result = new Map<DemandMarketId, number>();

  if (model.kind === "perMarket") {
    for (const market of markets) {
      result.set(market, unwrapUnit(processingCapacity(headcountByMarket.get(market) ?? 0, params)));
    }
    return result;
  }

  const companyCapacity = companySalesOrganizationCapacity(totalHeadcount, model) * marketFragmentationFactor(markets.length, model);
  const totalDemand = markets.reduce((sum, m) => sum + Math.max(0, effortDemandByMarket.get(m) ?? 0), 0);

  if (totalDemand <= EPSILON) {
    // 需要が観測できない場合は均等に配る（能力を捏造しない・偏らせない）。
    for (const market of markets) result.set(market, markets.length > 0 ? companyCapacity / markets.length : 0);
    return result;
  }

  for (const market of markets) {
    const share = Math.max(0, effortDemandByMarket.get(market) ?? 0) / totalDemand;
    result.set(market, companyCapacity * share);
  }
  return result;
}
