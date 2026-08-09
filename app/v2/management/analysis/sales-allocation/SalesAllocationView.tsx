"use client";

// ShrimpX V2 — 各社 市場別 営業人員配置（独立URL）
//
// 【engine の意味論をそのまま使う】営業人員は会社×市場の値であり、
// 同一市場内の全商品で同じ人数を共有する（sales/salesForce.ts が検証している）。
// engine が要求するのは「市場別配置の合計 ≤ 実在人数」だけで、
// **下回ること（未配置が出ること）は正常**である。
//
// 【UI で辻褄合わせをしない】合計が総人数に満たない分は「未配置」として
// そのまま積む。差が説明できない場合は突き合わせ表に不一致として出す。

import { reconcileSalesAllocation, toSalesAllocationSeries } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { StackedAreaChart } from "../../components/StackedAreaChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { Collapsible } from "../../components/Collapsible";
import { RawValuesTable } from "../components/RawValuesTable";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/sales-allocation";

const MARKET_COLORS: Readonly<Record<string, string>> = {
  CN: "#ef4444",
  US: "#3b82f6",
  EU: "#22c55e",
  JP: "#a855f7",
  OTHER: "#f59e0b",
  UNALLOCATED: "#475569",
};

const MARKET_LABELS: Readonly<Record<string, string>> = { UNALLOCATED: "未配置" };

export function SalesAllocationView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  // 選択状態は URL が唯一の情報源。
  const companyId = useQueryParam("company", "");

  const dataset = stored?.dataset ?? null;
  const companies = dataset?.companies ?? [];
  const selectedCompany = companyId || companies[0]?.companyId || "";
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  const selectCompany = (next: string) => replaceQueryParam("company", next);

  const series = dataset ? toSalesAllocationSeries(dataset, selectedCompany) : [];
  const reconciliation = dataset ? reconcileSalesAllocation(dataset, selectedCompany) : [];
  const mismatches = reconciliation.filter((r) => !r.matches);

  return (
    <AnalysisPageShell
      title={`市場別 営業人員配置（${selectedCompany}）`}
      description="営業人員は会社×市場の値で、同一市場内の全商品が同じ人数を共有します。合計が総人数に満たない分は「未配置」としてそのまま積んでおり、画面側で辻褄合わせの補正はしていません。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={{ company: selectedCompany }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="会社の選択">
        <span className="text-xs text-slate-400">会社</span>
        {companies.map((c) => (
          <button
            key={c.companyId}
            type="button"
            onClick={() => selectCompany(c.companyId)}
            aria-pressed={c.companyId === selectedCompany}
            data-testid={`allocation-company-${c.companyId}`}
            className={`rounded px-2.5 py-1 text-xs font-semibold ${c.companyId === selectedCompany ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {c.companyId}
          </button>
        ))}
      </div>

      {dataset ? (
        <div className="flex flex-col gap-3">
          <StackedAreaChart
            title={`${selectedCompany} — 市場別の営業人員配置`}
            series={series.map((s) => ({
              key: s.market,
              label: MARKET_LABELS[s.market] ?? s.market,
              color: MARKET_COLORS[s.market] ?? "#64748b",
              points: s.points,
            }))}
            totalTurns={totalTurns}
            unitLabel="人"
            format={(v) => v.toFixed(0)}
            testId="allocation-chart"
            emptyMessage="この会社の営業配置が記録されていません。"
          />

          {mismatches.length > 0 ? (
            <p className="rounded border border-rose-700 bg-rose-950/40 p-2 text-[11px] text-rose-200" data-testid="allocation-mismatch">
              市場別配置＋未配置が総人数と一致しないターンが {mismatches.length} 件あります（Q
              {mismatches.map((m) => m.turn).join(", Q")}）。画面側で補正はしていません。
            </p>
          ) : (
            <p className="rounded border border-emerald-800 bg-emerald-950/30 p-2 text-[11px] text-emerald-200" data-testid="allocation-reconciled">
              全ターンで「市場別配置の合計 ＋ 未配置 ＝ 当期に配分可能だった総人員数」が成立しています。
            </p>
          )}

          <Collapsible title="突き合わせ表（配置 / 未配置 / 総人数）" testId="allocation-reconciliation-toggle">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-xs" data-testid="allocation-reconciliation-table">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-1 pr-2">Turn</th>
                    <th className="py-1 pr-2 text-right">市場配置合計</th>
                    <th className="py-1 pr-2 text-right">未配置</th>
                    <th className="py-1 pr-2 text-right">総人数</th>
                    <th className="py-1">一致</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.map((r) => (
                    <tr key={r.turn} className="border-b border-slate-800">
                      <td className="py-1 pr-2 tabular-nums">Q{r.turn}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{r.allocated}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{r.unallocated ?? "－"}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{r.total ?? "－"}</td>
                      <td className={`py-1 ${r.matches ? "text-emerald-400" : "text-rose-400"}`}>{r.matches ? "○" : "×"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Collapsible>

          <RawValuesTable
            turns={dataset.turns}
            rows={series.map((s) => ({ label: MARKET_LABELS[s.market] ?? s.market, values: s.points.map((p) => p.value) }))}
            format={(v) => v.toFixed(0)}
            unitNote="単位: 人"
            testId="allocation-raw-toggle"
          />
        </div>
      ) : null}
    </AnalysisPageShell>
  );
}
