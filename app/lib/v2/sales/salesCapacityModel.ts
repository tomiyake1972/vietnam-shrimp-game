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

/**
 * 【legacy】市場ごとに salesForce の曲線を独立適用する旧モデル。
 *
 * Phase 6C までの Test16 既定であり、後方互換・比較対照のために残す。
 * 構造的な問題（展開市場を増やすほど会社の総営業能力が増える／1工場分を売るのに
 * 500〜700人を要する）が Phase 6B の監査で確認されたため、**新規の既定ではない**。
 */
export const SALES_CAPACITY_MODEL_PER_MARKET: SalesCapacityModel = {
  kind: "perMarket",
  companyBaselineCapacityTons: 0,
  companyCapacityMaxIncrementTons: 0,
  companyCapacitySaturationHeadcount: 1,
  fragmentationPenaltyPerExtraMarket: 0,
  fragmentationFloor: 1,
};

/**
 * 【Test16 正式営業能力モデル（2026-08-10 採用・#05 Phase 6C §2〜§3）】
 * 会社営業組織モデル v1（Company Sales Organization Model v1）。
 *
 * ベンチマーク上の呼称は "Case B + V1" だったが、Case名は研究用の一時的な符牒で
 * あるため、正式名称でここに固定する。
 *
 * 【モデルの意味】
 *   営業能力は**会社の営業組織**が持つものであり、市場ごとに独立して湧くものではない。
 *   会社全体で1回だけ処理能力を求め、それを各市場の営業工数需要の比率で配分する。
 *   したがって市場を増やしても会社の総能力は増えない（旧モデルはここが逆だった）。
 *
 * 【能力関数】
 *   capacity(h) = 1,000 + 95,000 × h / (h + 190)   （工数トン／四半期）
 *     h=0   →   1,000
 *     h=60  →  23,800
 *     h=100 →  33,759
 *     h=130 →  39,594
 *     h=190 →  48,500（半飽和点＝増分上限の半分）
 *     h→∞   →  96,000（漸近上限）
 *
 * 【市場分散の非効率】適用しない（fragmentationPenaltyPerExtraMarket = 0）。
 *   研究候補 Case C はこれを 0.03（5市場で0.88倍）としていたが、5seed検証で
 *   1seed において MASS が資金枯渇 → 生産0×16Q → 現金 −159M に陥ったため
 *   正式採用しない（研究候補としては残す。#05 §4）。
 *
 * 【営業工数係数】salesEffortCoefficients は変更しない（HOSO 1.0 / PD 1.2 / VAP 3.0）。
 *   ベンチマークの "V1" とはこの既存値そのものであり、新しい値を導入していない。
 */
export const SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1: SalesCapacityModel = {
  kind: "companyWide",
  companyBaselineCapacityTons: 1_000,
  companyCapacityMaxIncrementTons: 95_000,
  companyCapacitySaturationHeadcount: 190,
  fragmentationPenaltyPerExtraMarket: 0,
  fragmentationFloor: 1,
};

/**
 * 【研究候補・production default にはしない（#05 §4）】
 * 会社営業組織モデルに市場展開の非効率を加えたもの（ベンチマーク呼称 "Case C"）。
 * 将来の AGGRESSIVE / growth-oriented archetype の研究材料として残す。
 */
export const SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_WITH_FRAGMENTATION_RESEARCH: SalesCapacityModel = {
  ...SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1,
  kind: "companyWideWithFragmentation",
  fragmentationPenaltyPerExtraMarket: 0.03,
  fragmentationFloor: 0.85,
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
