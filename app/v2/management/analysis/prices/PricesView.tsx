"use client";

// ShrimpX V2 — 市場別 × 商品別 価格推移（独立URL）
//
// 【analytics 用の独自価格計算をしない】表示する価格は、成約配分が実際に使った
// 基準価格（sales の MarketProductAllocationResult.basePrice）そのものである。
//
// 【URL に市場選択を持つ】`?run=XXX&market=JP` とすることで、
// 日本・中国・米国の価格を別々のブラウザタブとして同時に開ける。

import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../../../lib/v2/market/types";
import { toMarketSeries } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { RawValuesTable } from "../components/RawValuesTable";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/prices";

const PRODUCT_COLORS: Readonly<Record<Product, string>> = {
  hoso: "#38bdf8",
  pd: "#f59e0b",
  vap: "#a855f7",
};

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function isMarket(value: string | null): value is DemandMarketId {
  return value !== null && (DEMAND_MARKET_IDS as readonly string[]).includes(value);
}

export function PricesView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  // 選択状態は URL が唯一の情報源（画面のローカル state に二重に持たない）。
  const marketParam = useQueryParam("market", DEMAND_MARKET_IDS[0]);
  const market: DemandMarketId = isMarket(marketParam) ? marketParam : DEMAND_MARKET_IDS[0];

  const selectMarket = (next: DemandMarketId) => replaceQueryParam("market", next);

  const dataset = stored?.dataset ?? null;
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  const seriesByProduct = dataset
    ? PRODUCTS.map((product) => {
        const marketSeries = toMarketSeries(dataset, "price", product, "trueWorld").find((s) => s.market === market);
        return { product, points: marketSeries?.points ?? dataset.turns.map((turn) => ({ turn, value: null })) };
      })
    : [];

  return (
    <AnalysisPageShell
      title={`市場別 × 商品別 価格推移（${market}）`}
      description="成約配分が実際に使った基準価格（USD / HOSO換算kg）をそのまま表示しています。analytics 側で価格を計算し直していません。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={{ market }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="市場の選択">
        <span className="text-xs text-slate-400">市場</span>
        {DEMAND_MARKET_IDS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => selectMarket(m)}
            aria-pressed={m === market}
            data-testid={`price-market-${m}`}
            className={`rounded px-2.5 py-1 text-xs font-semibold ${m === market ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {m}
          </button>
        ))}
      </div>

      {dataset ? (
        <div className="flex flex-col gap-3">
          <SeriesChart
            title={`${market} — HOSO / PD / VAP 価格`}
            series={seriesByProduct.map((s) => ({
              key: s.product,
              label: s.product.toUpperCase(),
              color: PRODUCT_COLORS[s.product],
              points: s.points,
            }))}
            totalTurns={totalTurns}
            unitLabel="USD / HOSO換算kg"
            format={(v) => v.toFixed(2)}
            testId="price-chart"
            emptyMessage="この市場の価格が記録されていません。"
          />

          <RawValuesTable
            turns={dataset.turns}
            rows={seriesByProduct.map((s) => ({ label: s.product.toUpperCase(), values: s.points.map((p) => p.value) }))}
            format={(v) => v.toFixed(3)}
            unitNote="単位: USD / HOSO換算kg"
            testId="price-raw-toggle"
          />
        </div>
      ) : null}
    </AnalysisPageShell>
  );
}
