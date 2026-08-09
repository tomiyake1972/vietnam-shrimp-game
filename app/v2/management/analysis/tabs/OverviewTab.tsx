"use client";

// ShrimpX V2 — 32Q Analysis: Overview タブ（Phase 2）
//
// 保存済み dataset だけを見る。ここで engine を呼ばない・再集計しない。

import { useState } from "react";
import { COMPANY_METRIC_KEYS, COMPANY_METRIC_LABELS, COMPANY_METRIC_UNITS, CompanyMetricKey, SimulationAnalyticsDataset } from "../../../../lib/v2/companyLab/simulation/analytics/types";
import { toCompanySeries } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { SeriesChart } from "../../components/SeriesChart";

interface Props {
  readonly dataset: SimulationAnalyticsDataset;
  readonly totalTurns: number;
}

export function OverviewTab({ dataset, totalTurns }: Props) {
  const [metric, setMetric] = useState<CompanyMetricKey>("revenue");
  const series = toCompanySeries(dataset, metric);
  const unit = COMPANY_METRIC_UNITS[metric];
  const isMoney = unit === "USD";
  const isRatio = unit === "ratio";

  const cell = (v: number | null) => {
    if (v === null) return "－";
    if (isMoney) return (v / 1_000_000).toFixed(1);
    if (isRatio) return v.toFixed(2);
    return Math.round(v).toLocaleString();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-400">指標</span>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as CompanyMetricKey)}
          data-testid="overview-metric"
          className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
        >
          {COMPANY_METRIC_KEYS.map((k) => (
            <option key={k} value={k}>
              {COMPANY_METRIC_LABELS[k]}（{COMPANY_METRIC_UNITS[k]}）
            </option>
          ))}
        </select>
      </div>

      <SeriesChart
        title={`${COMPANY_METRIC_LABELS[metric]} — 5社 × ${dataset.turns.length}Q`}
        series={series.map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points }))}
        totalTurns={totalTurns}
        unitLabel={unit}
        testId="overview-chart"
      />

      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h2 className="mb-2 text-sm font-semibold">
          {COMPANY_METRIC_LABELS[metric]}（{isMoney ? "USD 百万" : unit}）
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs" data-testid="analysis-overview-table">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="py-1 pr-2 text-left">会社</th>
                {dataset.turns.map((t) => (
                  <th key={t} className="px-1 py-1 text-right">
                    Q{t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.companyId} className="border-b border-slate-800">
                  <td className="py-1 pr-2">
                    <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: s.color }} aria-hidden />
                    {s.companyId}
                  </td>
                  {s.points.map((p) => (
                    <td key={p.turn} className={`px-1 py-1 text-right tabular-nums ${p.value !== null && p.value < 0 ? "text-rose-400" : ""}`}>
                      {cell(p.value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
