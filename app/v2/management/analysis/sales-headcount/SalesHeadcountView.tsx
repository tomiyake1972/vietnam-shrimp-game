"use client";

// ShrimpX V2 — 各社 総営業人員数推移（独立URL）
//
// 表示するのは「その四半期に配分可能だった営業人員数」（採用・減員は次期反映のため、
// 当期処理前の値）。会社ごとに固定色を使う。

import { toCompanySeries } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { Collapsible } from "../../components/Collapsible";
import { RawValuesTable } from "../components/RawValuesTable";
import { useAnalysisRun } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/sales-headcount";

export function SalesHeadcountView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const dataset = stored?.dataset ?? null;
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);
  const series = dataset ? toCompanySeries(dataset, "salesHeadcount") : [];

  return (
    <AnalysisPageShell
      title="各社 総営業人員数推移"
      description="その四半期に配分可能だった営業人員数です（採用・減員は次の四半期から反映されるゲームルールに合わせ、当期処理前の値を表示しています）。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
    >
      {dataset ? (
        <div className="flex flex-col gap-3">
          <SeriesChart
            title={`総営業人員数 — 5社 × ${dataset.turns.length}Q`}
            series={series.map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points }))}
            totalTurns={totalTurns}
            unitLabel="人"
            format={(v) => v.toFixed(0)}
            testId="sales-headcount-chart"
            emptyMessage="営業人員数が記録されていません。"
          />

          <Collapsible title="採用・減員の内訳（各社・各ターン）" testId="sales-hiring-toggle">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs" data-testid="sales-hiring-table">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-1 pr-2">Turn</th>
                    <th className="py-1 pr-2">会社</th>
                    <th className="py-1 pr-2 text-right">採用</th>
                    <th className="py-1 pr-2 text-right">減員</th>
                    <th className="py-1 text-right">当期配分可能人数</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.hiringTrace
                    .filter((h) => h.salesForceHireCount > 0 || h.salesForceLayoffCount > 0)
                    .map((h, i) => (
                      <tr key={`${h.turn}-${h.companyId}-${i}`} className="border-b border-slate-800">
                        <td className="py-1 pr-2 tabular-nums">Q{h.turn}</td>
                        <td className="py-1 pr-2 font-semibold">{h.companyId}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{h.salesForceHireCount}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{h.salesForceLayoffCount}</td>
                        <td className="py-1 text-right tabular-nums">{h.endingSalesHeadcount ?? "－"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {dataset.hiringTrace.every((h) => h.salesForceHireCount === 0 && h.salesForceLayoffCount === 0) ? (
              <p className="mt-1.5 text-[11px] text-slate-500">この実行では採用・減員の意思決定がありませんでした。</p>
            ) : null}
          </Collapsible>

          <RawValuesTable
            turns={dataset.turns}
            rows={series.map((s) => ({ label: `${s.companyId} 営業人員`, values: s.points.map((p) => p.value) }))}
            format={(v) => v.toFixed(0)}
            unitNote="単位: 人"
            testId="sales-headcount-raw-toggle"
          />
        </div>
      ) : null}
    </AnalysisPageShell>
  );
}
