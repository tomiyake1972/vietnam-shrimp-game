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

/** 会社1社について、商品別の限界利益率（%）の推移。 */
export function toContributionRatioSeriesByProduct(dataset: SimulationAnalyticsDataset, companyId: string): readonly { readonly product: Product; readonly points: readonly SeriesPoint[] }[] {
  const index = new Map<string, number | null>();
  for (const f of dataset.contribution) {
    if (f.companyId !== companyId) continue;
    index.set(`${f.turn}:${f.product}`, f.contributionMarginRatio);
  }
  return (["hoso", "pd", "vap"] as const).map((product) => ({
    product,
    points: dataset.turns.map((turn) => {
      const v = index.get(`${turn}:${product}`);
      return { turn, value: v === undefined ? null : v };
    }),
  }));
}

/** 1商品について、5社の限界利益率（%）の推移。 */
export function toContributionRatioSeriesByCompany(dataset: SimulationAnalyticsDataset, product: Product): readonly CompanyMetricSeries[] {
  const index = new Map<string, number | null>();
  for (const f of dataset.contribution) {
    if (f.product !== product) continue;
    index.set(`${f.turn}:${f.companyId}`, f.contributionMarginRatio);
  }
  return dataset.companies.map((c) => ({
    companyId: c.companyId,
    displayName: c.displayName,
    color: c.color,
    points: dataset.turns.map((turn) => {
      const v = index.get(`${turn}:${c.companyId}`);
      return { turn, value: v === undefined ? null : v };
    }),
  }));
}

/** 固定費の指定区分について、5社の推移。 */
export function toFixedCostSeriesByCompany(dataset: SimulationAnalyticsDataset, component: string): readonly CompanyMetricSeries[] {
  const index = new Map<string, number | null>();
  for (const f of dataset.fixedCosts) {
    if (f.component !== component) continue;
    index.set(`${f.turn}:${f.companyId}`, f.value);
  }
  return dataset.companies.map((c) => ({
    companyId: c.companyId,
    displayName: c.displayName,
    color: c.color,
    points: dataset.turns.map((turn) => ({ turn, value: index.get(`${turn}:${c.companyId}`) ?? null })),
  }));
}

/** 会社1社について、固定費区分ごとの推移（内訳表示用）。 */
export function toFixedCostSeriesByComponent(
  dataset: SimulationAnalyticsDataset,
  companyId: string,
  components: readonly string[]
): readonly { readonly component: string; readonly points: readonly SeriesPoint[] }[] {
  const index = new Map<string, number | null>();
  for (const f of dataset.fixedCosts) {
    if (f.companyId !== companyId) continue;
    index.set(`${f.turn}:${f.component}`, f.value);
  }
  return components.map((component) => ({
    component,
    points: dataset.turns.map((turn) => ({ turn, value: index.get(`${turn}:${component}`) ?? null })),
  }));
}

/** 会社1社について、市場別の営業人員配置（未配置を含む）の推移。 */
export function toSalesAllocationSeries(
  dataset: SimulationAnalyticsDataset,
  companyId: string
): readonly { readonly market: string; readonly points: readonly SeriesPoint[] }[] {
  const markets: string[] = [];
  const index = new Map<string, number>();
  for (const f of dataset.salesAllocation) {
    if (f.companyId !== companyId) continue;
    if (!markets.includes(f.market)) markets.push(f.market);
    index.set(`${f.turn}:${f.market}`, f.headcount);
  }
  return markets.map((market) => ({
    market,
    points: dataset.turns.map((turn) => {
      const v = index.get(`${turn}:${market}`);
      return { turn, value: v === undefined ? null : v };
    }),
  }));
}

/**
 * 営業人員の突き合わせ。
 * 市場別配置の合計＋未配置が、当期に配分可能だった総人数と一致するかを検証する。
 * **UI 側で補正はしない** — 一致しないターンがあれば、そのまま差分を返す。
 */
export interface SalesAllocationReconciliation {
  readonly turn: number;
  readonly companyId: string;
  readonly allocated: number;
  readonly unallocated: number | null;
  readonly total: number | null;
  readonly matches: boolean;
}

export function reconcileSalesAllocation(dataset: SimulationAnalyticsDataset, companyId?: string): readonly SalesAllocationReconciliation[] {
  const totals = new Map<string, number>();
  for (const f of dataset.companyMetrics) {
    if (f.metric === "salesHeadcount" && f.value !== null) totals.set(`${f.turn}:${f.companyId}`, f.value);
  }
  const rows: SalesAllocationReconciliation[] = [];
  for (const company of dataset.companies) {
    if (companyId !== undefined && company.companyId !== companyId) continue;
    for (const turn of dataset.turns) {
      const facts = dataset.salesAllocation.filter((f) => f.companyId === company.companyId && f.turn === turn);
      if (facts.length === 0) continue;
      const allocated = facts.filter((f) => f.market !== "UNALLOCATED").reduce((s, f) => s + f.headcount, 0);
      const unallocatedFact = facts.find((f) => f.market === "UNALLOCATED");
      const unallocated = unallocatedFact ? unallocatedFact.headcount : null;
      const total = totals.get(`${turn}:${company.companyId}`) ?? null;
      const matches = total === null || unallocated === null ? false : Math.abs(allocated + unallocated - total) < 1e-9;
      rows.push({ turn, companyId: company.companyId, allocated, unallocated, total, matches });
    }
  }
  return rows;
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
