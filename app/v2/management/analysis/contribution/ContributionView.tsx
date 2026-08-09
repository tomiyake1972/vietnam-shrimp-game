"use client";

// ShrimpX V2 — 各社 × 商品別 限界利益率（独立URL）
//
// 【新しい独自式を作らない】
// 表示する限界利益は finance/quarterClose.ts が出した
// `CompanyFinancialQuarterResult.contributionMargin.byProduct` そのものである。
// 商品別の変動費配賦もそこで既に決まっており、analytics 側で推測配賦はしない。
// 純売上高が0の四半期は engine 側が比率を返さないため「－」と表示する（0で埋めない）。

import { Product } from "../../../../lib/v2/market/types";
import { toContributionRatioSeriesByCompany, toContributionRatioSeriesByProduct } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { Collapsible } from "../../components/Collapsible";
import { RawValuesTable } from "../components/RawValuesTable";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/contribution";

const PRODUCT_COLORS: Readonly<Record<Product, string>> = { hoso: "#38bdf8", pd: "#f59e0b", vap: "#a855f7" };
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

type Mode = "byCompany" | "byProduct";

export function ContributionView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  // 選択状態は URL が唯一の情報源。
  const companyId = useQueryParam("company", "");
  const productParam = useQueryParam("product", "hoso");
  const product: Product = productParam === "pd" || productParam === "vap" ? productParam : "hoso";
  const mode: Mode = useQueryParam("mode", "byCompany") === "byProduct" ? "byProduct" : "byCompany";

  const dataset = stored?.dataset ?? null;
  const companies = dataset?.companies ?? [];
  const selectedCompany = companyId || companies[0]?.companyId || "";
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  const selectCompany = (next: string) => replaceQueryParam("company", next);
  const selectProduct = (next: Product) => replaceQueryParam("product", next);
  const selectMode = (next: Mode) => replaceQueryParam("mode", next);

  const byCompanySeries = dataset ? toContributionRatioSeriesByProduct(dataset, selectedCompany) : [];
  const byProductSeries = dataset ? toContributionRatioSeriesByCompany(dataset, product) : [];

  // 金額（限界利益 USD）は補助表示として数値表に出す。
  const amountRows = dataset
    ? PRODUCTS.map((p) => ({
        label: `${p.toUpperCase()} 限界利益(USD)`,
        values: dataset.turns.map((turn) => dataset.contribution.find((f) => f.companyId === selectedCompany && f.turn === turn && f.product === p)?.contributionMargin ?? null),
      }))
    : [];

  return (
    <AnalysisPageShell
      title="各社 × 商品別 限界利益率"
      description="出所は財務モジュールが出した管理会計レポート（contributionMargin.byProduct）です。商品別の変動費配賦もそこで確定しており、この画面で推測配賦はしていません。純売上高が0の四半期は比率が定義されないため「－」と表示します。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={{ company: selectedCompany, product, mode }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="表示モード">
          <span className="text-xs text-slate-400">表示</span>
          {(
            [
              ["byCompany", "1社の3商品を比較"],
              ["byProduct", "1商品の5社を比較"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => selectMode(key)}
              aria-pressed={mode === key}
              data-testid={`contribution-mode-${key}`}
              className={`rounded px-2.5 py-1 text-xs font-semibold ${mode === key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "byCompany" ? (
          <div className="flex items-center gap-1" role="group" aria-label="会社の選択">
            <span className="text-xs text-slate-400">会社</span>
            {companies.map((c) => (
              <button
                key={c.companyId}
                type="button"
                onClick={() => selectCompany(c.companyId)}
                aria-pressed={c.companyId === selectedCompany}
                data-testid={`contribution-company-${c.companyId}`}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${c.companyId === selectedCompany ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {c.companyId}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1" role="group" aria-label="商品の選択">
            <span className="text-xs text-slate-400">商品</span>
            {PRODUCTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => selectProduct(p)}
                aria-pressed={p === product}
                data-testid={`contribution-product-${p}`}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${p === product ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {dataset ? (
        <div className="flex flex-col gap-3">
          {mode === "byCompany" ? (
            <SeriesChart
              title={`${selectedCompany} — 商品別 限界利益率`}
              series={byCompanySeries.map((s) => ({ key: s.product, label: s.product.toUpperCase(), color: PRODUCT_COLORS[s.product], points: s.points }))}
              totalTurns={totalTurns}
              unitLabel="限界利益率"
              format={(v) => `${(v * 100).toFixed(0)}%`}
              testId="contribution-chart"
              emptyMessage="この会社の限界利益が記録されていません。"
            />
          ) : (
            <SeriesChart
              title={`${product.toUpperCase()} — 5社の限界利益率`}
              series={byProductSeries.map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points }))}
              totalTurns={totalTurns}
              unitLabel="限界利益率"
              format={(v) => `${(v * 100).toFixed(0)}%`}
              testId="contribution-chart"
              emptyMessage="この商品の限界利益が記録されていません。"
            />
          )}

          <RawValuesTable
            turns={dataset.turns}
            rows={
              mode === "byCompany"
                ? byCompanySeries.map((s) => ({ label: `${s.product.toUpperCase()} 限界利益率`, values: s.points.map((p) => p.value) }))
                : byProductSeries.map((s) => ({ label: `${s.companyId} 限界利益率`, values: s.points.map((p) => p.value) }))
            }
            format={(v) => `${(v * 100).toFixed(1)}%`}
            unitNote="限界利益率 = 限界利益 ÷ 純売上高（財務モジュールの算出値）"
            testId="contribution-raw-toggle"
          />

          {mode === "byCompany" ? (
            <Collapsible title="限界利益の金額（USD）を表示" testId="contribution-amount-toggle">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-xs">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="py-1 pr-2 text-left">系列</th>
                      {dataset.turns.map((t) => (
                        <th key={t} className="px-1 py-1 text-right">
                          Q{t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {amountRows.map((row) => (
                      <tr key={row.label} className="border-b border-slate-800">
                        <td className="py-1 pr-2 whitespace-nowrap">{row.label}</td>
                        {row.values.map((v, i) => (
                          <td key={dataset.turns[i]} className={`px-1 py-1 text-right tabular-nums ${v !== null && v < 0 ? "text-rose-400" : ""}`}>
                            {v === null ? "－" : (v / 1_000_000).toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">単位: USD 百万</p>
            </Collapsible>
          ) : null}
        </div>
      ) : null}
    </AnalysisPageShell>
  );
}
