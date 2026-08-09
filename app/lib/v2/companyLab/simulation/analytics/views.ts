// ShrimpX V2 — 32Q Management Console Phase 2: dataset から画面用の形へ変換する
//
// 【Console と Analysis の食い違いを構造的に防ぐ】
// 保存された dataset だけを入力にして描画できる形へ揃える。実行直後の画面も、
// リロード後の画面も、Analysis 画面も、**すべてこの同じ関数**を通る。
// 「実行中は state から、復元後は dataset から」という二重経路を作らない。

import { DemandMarketId, Product } from "../../../market/types";
import {
  BottleneckKind,
  CompanyMetricKey,
  MarketMetricKey,
  MetricVisibility,
  ProducerCountryMetricKey,
  SimulationAnalyticsDataset,
} from "./types";

export interface SeriesPoint {
  readonly turn: number;
  readonly value: number | null;
}

export interface CompanyMetricSeries {
  readonly companyId: string;
  readonly displayName: string;
  readonly color: string;
  readonly points: readonly SeriesPoint[];
}

/** 会社×ターンの1指標を、会社ごとの折れ線へ組み替える。 */
export function toCompanySeries(dataset: SimulationAnalyticsDataset, metric: CompanyMetricKey): readonly CompanyMetricSeries[] {
  const index = new Map<string, number | null>();
  for (const fact of dataset.companyMetrics) {
    if (fact.metric === metric) index.set(`${fact.turn}:${fact.companyId}`, fact.value);
  }
  return dataset.companies.map((c) => ({
    companyId: c.companyId,
    displayName: c.displayName,
    color: c.color,
    points: dataset.turns.map((turn) => ({ turn, value: index.get(`${turn}:${c.companyId}`) ?? null })),
  }));
}

/** 指定ターン（省略時は最終ターン）の会社別スカラー値。 */
export function latestCompanyValues(dataset: SimulationAnalyticsDataset, metric: CompanyMetricKey, turn?: number): ReadonlyMap<string, number | null> {
  const target = turn ?? dataset.turns[dataset.turns.length - 1];
  const out = new Map<string, number | null>();
  for (const c of dataset.companies) out.set(c.companyId, null);
  for (const fact of dataset.companyMetrics) {
    if (fact.metric === metric && fact.turn === target) out.set(fact.companyId, fact.value);
  }
  return out;
}

/** 会社1社ぶんの、最終ターンの全指標。Company Inspector が使う。 */
export function companySnapshot(dataset: SimulationAnalyticsDataset, companyId: string, turn?: number): ReadonlyMap<CompanyMetricKey, number | null> {
  const target = turn ?? dataset.turns[dataset.turns.length - 1];
  const out = new Map<CompanyMetricKey, number | null>();
  for (const fact of dataset.companyMetrics) {
    if (fact.companyId === companyId && fact.turn === target) out.set(fact.metric, fact.value);
  }
  return out;
}

/**
 * 市場×商品の1指標を、市場ごとの折れ線へ組み替える。
 *
 * 【TRUE と OBSERVED を繋がない】visibility を必ず指定させる。省略できないため、
 * 呼び出し側が「どちらの系列を描いているか」を明示しないまま描画することはできない。
 */
export interface MarketSeries {
  readonly market: DemandMarketId;
  readonly points: readonly SeriesPoint[];
  readonly visibility: MetricVisibility;
}

export function toMarketSeries(
  dataset: SimulationAnalyticsDataset,
  metric: MarketMetricKey,
  product: Product,
  visibility: MetricVisibility
): readonly MarketSeries[] {
  const markets = new Set<DemandMarketId>();
  const index = new Map<string, number | null>();
  for (const fact of dataset.marketMetrics) {
    if (fact.metric !== metric || fact.product !== product || fact.visibility !== visibility) continue;
    markets.add(fact.market);
    index.set(`${fact.turn}:${fact.market}`, fact.value);
  }
  return [...markets]
    .sort()
    .map((market) => ({ market, visibility, points: dataset.turns.map((turn) => ({ turn, value: index.get(`${turn}:${market}`) ?? null })) }));
}

/** 産地国データ（GLOBAL PRODUCER DATA）を国ごとの折れ線へ。 */
export interface ProducerCountrySeries {
  readonly country: string;
  readonly points: readonly SeriesPoint[];
}

export function toProducerCountrySeries(dataset: SimulationAnalyticsDataset, metric: ProducerCountryMetricKey): readonly ProducerCountrySeries[] {
  const countries = new Set<string>();
  const index = new Map<string, number | null>();
  for (const fact of dataset.producerCountryMetrics) {
    if (fact.metric !== metric) continue;
    countries.add(fact.country);
    index.set(`${fact.turn}:${fact.country}`, fact.value);
  }
  return [...countries].sort().map((country) => ({ country, points: dataset.turns.map((turn) => ({ turn, value: index.get(`${turn}:${country}`) ?? null })) }));
}

/** 律速ヒートマップ（行＝会社、列＝ターン）。 */
export interface BottleneckHeatmapRow {
  readonly companyId: string;
  readonly cells: readonly { readonly turn: number; readonly kind: BottleneckKind; readonly primaryShare: number | null; readonly severity: number }[];
}

export function toBottleneckHeatmap(dataset: SimulationAnalyticsDataset): readonly BottleneckHeatmapRow[] {
  const index = new Map<string, { kind: BottleneckKind; primaryShare: number | null; severity: number }>();
  for (const f of dataset.bottlenecks) {
    const severity = Math.max(f.rawMaterialShortfall, f.equipmentShortfall, f.laborShortfall);
    index.set(`${f.turn}:${f.companyId}`, { kind: f.primary, primaryShare: f.primaryShare, severity });
  }
  return dataset.companies.map((c) => ({
    companyId: c.companyId,
    cells: dataset.turns.map((turn) => {
      const cell = index.get(`${turn}:${c.companyId}`);
      return { turn, kind: cell?.kind ?? "none", primaryShare: cell?.primaryShare ?? null, severity: cell?.severity ?? 0 };
    }),
  }));
}
