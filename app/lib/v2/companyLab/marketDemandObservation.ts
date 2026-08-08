// ShrimpX V2 — 市場×商品別需要数量の遅行公開（Batch 002 / Market Information Lag）
//
// 【思想】市場には真の現在需要が存在するが、経営者はそれをリアルタイムでは知らない。
// プレイヤーもStandard AIも「約6か月前に確認された市場×商品別需要」から現在を推測する。
// 真の需要（true demand）と観測需要（observed demand）を明確に分離するのがこの層の役割。
//
// 【ゲームメカニクスは変更していない】
// 市場配分・成約・価格形成は従来どおり当期のtrue demandで計算される。この
// モジュールは既に state.history に保存済みの値を読み出して公開するだけであり、
// 需要計算式・価格形成・シェア上限・営業capacityには一切触れていない。
//
// 【true demandの保存元（新規保存は不要だった）】
// sales/runner.ts の advanceSalesQuarter は、市場×商品ごとの対象需要を
// MarketProductAllocationResult.targetDemand として既に SalesQuarterRecord へ
// 保存しており、それが CompanyQuarterRecord.salesRecord.allocations として
// state.history に残っている。したがって市場エンジンの production code を
// 変更する必要は無く、この層は読むだけで済む。
//
// 【単位】targetDemand は「ベトナム産がその四半期にその市場×商品で獲得できる
// 対象需要（HOSO換算トン）」であり、sales/allocation.ts が
// shareCap = targetDemand × maximumSupplierShare として使う値そのものである。
// したがって観測需要 × maximumSupplierShare は、そのまま自社が取り得る上限の
// 目安になる（AI側で 0.35 をhard-codeしないための正しい土台）。

import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import { unwrapUnit } from "../core/units";
import { computeMarketProductMix } from "../market/productLifecycle";
import type { ScenarioDefinition } from "../scenario/types";
import type { CompanyLabState } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * 観測遅延（四半期）。今回は2で固定運用するが、将来1Q/3Qと比較できるよう
 * 明示的なパラメータとして持つ（マジックナンバーをコード中に散らさない）。
 *
 * turn N の意思決定時点で観測できるのは turn N-LAG の実績。
 *   turn3 → turn1実績 / turn4 → turn2実績 / turn5 → turn3実績
 */
export const MARKET_DEMAND_OBSERVATION_LAG_QUARTERS = 2;

/** 観測需要の出所。 */
export type MarketDemandObservationSource =
  /** ゲーム開始時点の既知市場情報（turn1・turn2。まだ2Q前の実績が存在しない）。 */
  | "INITIAL_MARKET_INFORMATION"
  /** 2四半期前の実績（turn3以降）。 */
  | "LAGGED_MARKET_RESULT";

/** 1市場ぶんの観測需要。 */
export interface ObservedMarketDemandEntry {
  readonly market: DemandMarketId;
  /** 市場×商品別の観測需要（HOSO換算トン）。 */
  readonly observedDemandByProduct: Readonly<Record<Product, number>>;
  /** 3商品の合計（表示用。observedDemandByProductの和と必ず一致する）。 */
  readonly observedTotalDemand: number;
  /** 商品構成比（合計が0の場合は全て0）。 */
  readonly observedProductShare: Readonly<Record<Product, number>>;
}

/** プレイヤー・Standard AIへ公開する観測需要一式。 */
export interface ObservedMarketDemand {
  readonly entries: readonly ObservedMarketDemandEntry[];
  /** 観測遅延（四半期）。今回は常に MARKET_DEMAND_OBSERVATION_LAG_QUARTERS。 */
  readonly observationLagQuarters: number;
  /** この観測値がどのturnの実績か。初期情報の場合はnull。 */
  readonly sourceQuarter: number | null;
  readonly observationSource: MarketDemandObservationSource;
}

function emptyByProduct(): Record<Product, number> {
  return { hoso: 0, pd: 0, vap: 0 };
}

function toEntry(market: DemandMarketId, byProduct: Record<Product, number>): ObservedMarketDemandEntry {
  const total = PRODUCTS.reduce((sum, p) => sum + byProduct[p], 0);
  const share = emptyByProduct();
  if (total > 0) {
    for (const p of PRODUCTS) share[p] = byProduct[p] / total;
  }
  return { market, observedDemandByProduct: byProduct, observedTotalDemand: total, observedProductShare: share };
}

/**
 * ゲーム開始時点の既知市場情報（turn1・turn2で公開する値）。
 *
 * 【新しい市場需要の数値を発明していない】使うのは既存のシナリオ前史のみ:
 *   - prehistory.priorMarketConsumptionHosoEqTons（市場別の前史消費量。
 *     CN 380,000 / US 320,000 / EU 260,000 / JP 90,000 / OTHER 150,000）
 *   - prehistory.countrySupplyHosoEqTons（国別前史供給量）からのベトナム供給シェア
 *   - market/productLifecycle.ts computeMarketProductMix(turn)（既存の商品構成比関数）
 *
 * 【なぜベトナム供給シェアを掛けるか】turn3以降に公開する observed demand は
 * sales/allocation.ts が使う targetDemand（＝ベトナム産が獲得できる対象需要）である。
 * 前史消費量は世界の最終消費規模なので、そのまま並べると turn2→turn3 で
 * 単位の意味が変わってしまう。前史のベトナム供給シェアを掛けることで、
 * 同じ「ベトナムが取り得る需要」の尺度に揃える。シェアは前史の既存値だけから
 * 算出しており、新しいパラメータは置いていない。
 *
 * 【精度の限界（正直に記す）】この初期値は実測でturn1の実 targetDemand の
 * 約1.7倍になる（輸出可能比率・PD/VAP加工能力の効果を含まないため）。
 * 相対的な市場規模の順序・比率はほぼ一致するため市場間の配分判断には使えるが、
 * 絶対量の上限としては過大側に出る。この差は docs へ記録し、turn3への
 * 切り替わりで営業配置が振動しないかを実測で確認する（平滑化は入れていない）。
 */
export function buildInitialObservedMarketDemand(definition: ScenarioDefinition, turn: number): ObservedMarketDemand {
  const prehistory = definition.prehistory;
  const totalCountrySupply = Object.values(prehistory.countrySupplyHosoEqTons).reduce((sum, v) => sum + v, 0);
  const vietnamSupplyShare = totalCountrySupply > 0 ? prehistory.countrySupplyHosoEqTons.VN / totalCountrySupply : 0;
  const mix = computeMarketProductMix(turn);

  const entries = DEMAND_MARKET_IDS.map((market) => {
    const marketConsumption = prehistory.priorMarketConsumptionHosoEqTons[market] ?? 0;
    const obtainable = Math.max(0, marketConsumption * vietnamSupplyShare);
    const byProduct = emptyByProduct();
    for (const product of PRODUCTS) byProduct[product] = obtainable * mix[market][product];
    return toEntry(market, byProduct);
  });

  return {
    entries,
    observationLagQuarters: MARKET_DEMAND_OBSERVATION_LAG_QUARTERS,
    sourceQuarter: null,
    observationSource: "INITIAL_MARKET_INFORMATION",
  };
}

/**
 * 指定turnの意思決定時点で公開してよい観測需要を返す。
 *
 * turn N では state.history に turn1..N-1 の記録が入っている。2四半期前の実績は
 * history[history.length - LAG] にあたる（turn3 なら history[0] = turn1）。
 * 履歴が足りない turn1・turn2 は初期市場情報を返す。
 *
 * 【情報リーク防止】当期（turn N）の記録は state.history にまだ存在せず、
 * この関数は history の末尾から LAG 個手前より新しい記録を一切参照しない。
 * したがって現在の true demand も将来の需要も構造的に読めない。
 */
export function buildObservedMarketDemand(
  state: CompanyLabState,
  turn: number,
  lagQuarters: number = MARKET_DEMAND_OBSERVATION_LAG_QUARTERS
): ObservedMarketDemand {
  const index = state.history.length - lagQuarters;
  const record = index >= 0 ? state.history[index] : undefined;
  if (!record) {
    return buildInitialObservedMarketDemand(state.scenarioState.definition, turn);
  }

  const byMarket = new Map<DemandMarketId, Record<Product, number>>();
  for (const market of DEMAND_MARKET_IDS) byMarket.set(market, emptyByProduct());
  for (const allocation of record.salesRecord.allocations) {
    const bucket = byMarket.get(allocation.market);
    if (!bucket) continue;
    // 同一市場×商品の記録は1件だが、将来の分割保存に備えて加算で扱う。
    bucket[allocation.product] += unwrapUnit(allocation.targetDemand);
  }

  return {
    entries: DEMAND_MARKET_IDS.map((market) => toEntry(market, byMarket.get(market)!)),
    observationLagQuarters: lagQuarters,
    sourceQuarter: record.turn,
    observationSource: "LAGGED_MARKET_RESULT",
  };
}
