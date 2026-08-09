"use client";

// ShrimpX V2 — 32Q Analysis: Market タブ（Phase 2）
//
// 【TRUE WORLD と OBSERVABLE を同じ系列に見せない】
//   TRUE WORLD  … その四半期に実際に成立した対象需要（salesRecord.allocations.targetDemand）
//   OBSERVABLE  … プレイヤー・Standard AI が実際に見られる2四半期遅行の公開需要
// この2つは意味が違う（同じ量を精度違いで測ったものではない）ため、
//   - 既定では片方だけを表示する
//   - 重ねて表示するときは OBSERVABLE を破線にし、凡例へ明示する
//   - 説明文で「遅行公開情報であること」を必ず書く
// という3点で区別する。
//
// 【analytics 用の独自価格計算をしない】価格は配分結果の basePrice をそのまま出す。
//
// 【GLOBAL PRODUCER DATA】産地国の生産・輸出データであり、
// 「どの消費市場をどの産地国が何％取ったか」ではない。ゲームエンジンは
// 市場×産地国の供給内訳を持たないため、その数字を作らない。

import { useState } from "react";
import { Product } from "../../../../lib/v2/market/types";
import { PRODUCER_COUNTRY_METRIC_LABELS, ProducerCountryMetricKey, SimulationAnalyticsDataset } from "../../../../lib/v2/companyLab/simulation/analytics/types";
import { toMarketSeries, toProducerCountrySeries } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { SeriesChart } from "../../components/SeriesChart";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
  readonly totalTurns: number;
}

const MARKET_COLORS: Readonly<Record<string, string>> = {
  CN: "#ef4444",
  US: "#3b82f6",
  EU: "#22c55e",
  JP: "#a855f7",
  OTHER: "#f59e0b",
};

const COUNTRY_COLORS: Readonly<Record<string, string>> = {
  VN: "#22c55e",
  EC: "#3b82f6",
  IN: "#f59e0b",
  ID: "#a855f7",
};

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
type DemandView = "trueWorld" | "observable" | "both";

const PRODUCER_METRICS: readonly ProducerCountryMetricKey[] = ["production", "exportableSupply", "allocatedDemand", "utilizationRatio", "hosoFobPrice"];

export function MarketTab({ dataset, totalTurns }: Props) {
  const [product, setProduct] = useState<Product>("hoso");
  const [demandView, setDemandView] = useState<DemandView>("trueWorld");
  const [producerMetric, setProducerMetric] = useState<ProducerCountryMetricKey>("production");

  const trueSeries = toMarketSeries(dataset, "demandQuantity", product, "trueWorld").map((s) => ({
    key: `true-${s.market}`,
    label: `${s.market}（TRUE WORLD）`,
    color: MARKET_COLORS[s.market] ?? "#64748b",
    points: s.points,
  }));
  const observableSeries = toMarketSeries(dataset, "demandQuantity", product, "observable").map((s) => ({
    key: `obs-${s.market}`,
    label: `${s.market}（OBSERVABLE・2Q遅行）`,
    color: MARKET_COLORS[s.market] ?? "#64748b",
    points: s.points,
    dashed: true,
  }));
  const demandSeries = demandView === "trueWorld" ? trueSeries : demandView === "observable" ? observableSeries : [...trueSeries, ...observableSeries];

  const priceSeries = toMarketSeries(dataset, "price", product, "trueWorld").map((s) => ({
    key: `price-${s.market}`,
    label: s.market,
    color: MARKET_COLORS[s.market] ?? "#64748b",
    points: s.points,
  }));

  const producerSeries = toProducerCountrySeries(dataset, producerMetric).map((s) => ({
    key: s.country,
    label: s.country,
    color: COUNTRY_COLORS[s.country] ?? "#64748b",
    points: s.points,
  }));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-slate-400">商品</span>
          <select
            value={product}
            onChange={(e) => setProduct(e.target.value as Product)}
            data-testid="market-product"
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          >
            {PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1" role="group" aria-label="需要の見え方">
          <span className="text-xs text-slate-400">需要の見え方</span>
          {(
            [
              ["trueWorld", "TRUE WORLD"],
              ["observable", "OBSERVABLE"],
              ["both", "両方を重ねる"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDemandView(key)}
              aria-pressed={demandView === key}
              data-testid={`market-visibility-${key}`}
              className={`rounded px-2 py-1 text-xs font-semibold ${demandView === key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-slate-700 bg-slate-900/40 p-2 text-[11px] leading-relaxed text-slate-400" data-testid="market-visibility-note">
        <strong className="text-amber-300">TRUE WORLD</strong>{" "}
        はその四半期に実際に成立した対象需要（Game Owner だけが見られる値）です。
        <strong className="ml-2 text-sky-300">OBSERVABLE</strong>{" "}
        はプレイヤーと Standard AI が実際に見ている
        <strong> 2四半期前の実績</strong>で、同じ量を精度違いで測ったものではありません（時点が違います）。
        重ねて表示した場合、OBSERVABLE は破線で描かれます。Standard AI へは TRUE WORLD を一切渡していません。
      </div>

      <SeriesChart
        title={`市場別需要 — ${product.toUpperCase()}`}
        series={demandSeries}
        totalTurns={totalTurns}
        unitLabel="HOSO換算 t"
        testId="market-demand-chart"
        emptyMessage="この見え方のデータが記録されていません。"
      />

      <SeriesChart
        title={`市場別価格 — ${product.toUpperCase()}（配分に使われた基準価格）`}
        series={priceSeries}
        totalTurns={totalTurns}
        unitLabel="USD / HOSO換算kg"
        format={(v) => v.toFixed(2)}
        testId="market-price-chart"
      />

      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="global-producer-data">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">GLOBAL PRODUCER DATA（産地国データ）</h2>
          <select
            value={producerMetric}
            onChange={(e) => setProducerMetric(e.target.value as ProducerCountryMetricKey)}
            data-testid="producer-metric"
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          >
            {PRODUCER_METRICS.map((m) => (
              <option key={m} value={m}>
                {PRODUCER_COUNTRY_METRIC_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        <p className="mb-2 rounded border border-rose-800/60 bg-rose-950/30 p-2 text-[11px] leading-relaxed text-rose-200">
          これは<strong>産地国（VN / EC / IN / ID）の生産・輸出データ</strong>です。
          <strong>「どの消費市場を、どの産地国が何％取ったか」（consumer-market supply share）ではありません。</strong>
          ゲームエンジンは市場×産地国の供給内訳を持っていないため、その数字は作っていません。
        </p>

        <SeriesChart
          title={PRODUCER_COUNTRY_METRIC_LABELS[producerMetric]}
          series={producerSeries}
          totalTurns={totalTurns}
          unitLabel={producerMetric === "hosoFobPrice" ? "USD/kg" : producerMetric === "utilizationRatio" ? "ratio" : "HOSO換算 t"}
          format={producerMetric === "hosoFobPrice" || producerMetric === "utilizationRatio" ? (v) => v.toFixed(2) : undefined}
          testId="producer-chart"
        />

        <details className="mt-2 rounded border border-slate-700 bg-slate-900/40 p-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-300">
            ENVIRONMENT CANDIDATE — 市場×産地国の供給フロー／シェア（未実装・#04 への申し送り）
          </summary>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            「CN市場のHOSO需要のうち、ベトナム産が何％・エクアドル産が何％を占めたか」という
            market × producer-country の供給フローは、現在のゲームエンジンには存在しません。
            市場側は <code>targetDemand</code>（ベトナム産5社が獲得対象にできた需要）しか持たず、
            産地国側は <code>exportableSupply</code> / <code>allocatedDemand</code>（世界合計に対する配分）
            しか持たないため、両者を結ぶ行列がどこにも定義されていないためです。
            <br />
            <strong className="text-slate-300">環境モデル候補として #04 へ申し送る事項：</strong>{" "}
            市場×産地国の需要配分行列（各市場の需要を産地国別に配分し、その結果として
            <code>targetDemand</code> がベトナム産の取り分として導かれる構造）を市場モジュールへ導入するかどうか。
            導入すると、産地国の品質・信頼性・価格差が市場ごとのシェアへ効く因果が表現できます。
            本Phaseでは、この行列を持たないまま推定値を表示することはしません。
          </p>
        </details>
      </section>
    </section>
  );
}
