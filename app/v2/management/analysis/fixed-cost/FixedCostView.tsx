"use client";

// ShrimpX V2 — 各社 固定費推移（独立URL）
//
// 【勝手な費用分類をしない】
// 区分は財務モジュールの管理会計レポートが持つ正式な3区分
// （固定製造費 / 固定人件費 / 固定販管費）とその合計だけを使う。
// さらに細かい内訳は ManufacturingCostBreakdown に実在する項目
// （工場固定費・固定ユーティリティ費・減価償却費・正社員労務費）のみを出す。
//
// 【内訳と3区分は合計が一致しない】内訳側は製造原価の内訳であり、
// 固定人件費・固定販管費を含まない。合計が一致するかのような見せ方をしない。

import {
  FIXED_COST_COMPONENT_COLORS,
  FIXED_COST_COMPONENT_KEYS,
  FIXED_COST_COMPONENT_LABELS,
  FIXED_COST_DETAIL_KEYS,
  FIXED_COST_DETAIL_LABELS,
} from "../../../../lib/v2/companyLab/simulation/analytics/types";
import { toFixedCostSeriesByCompany, toFixedCostSeriesByComponent } from "../../../../lib/v2/companyLab/simulation/analytics/views";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { StackedAreaChart } from "../../components/StackedAreaChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { Collapsible } from "../../components/Collapsible";
import { RawValuesTable } from "../components/RawValuesTable";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/fixed-cost";

const DETAIL_COLORS: Readonly<Record<string, string>> = {
  factoryFixedCost: "#3b82f6",
  utilityFixedCost: "#06b6d4",
  depreciationCost: "#8b5cf6",
  regularLaborCost: "#f59e0b",
};

export function FixedCostView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  // 選択状態は URL が唯一の情報源。
  const companyId = useQueryParam("company", "");

  const dataset = stored?.dataset ?? null;
  const companies = dataset?.companies ?? [];
  const selectedCompany = companyId || companies[0]?.companyId || "";
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  const selectCompany = (next: string) => replaceQueryParam("company", next);

  const totalSeries = dataset ? toFixedCostSeriesByCompany(dataset, "totalFixedCost") : [];
  const componentSeries = dataset ? toFixedCostSeriesByComponent(dataset, selectedCompany, FIXED_COST_COMPONENT_KEYS) : [];
  const detailSeries = dataset ? toFixedCostSeriesByComponent(dataset, selectedCompany, FIXED_COST_DETAIL_KEYS) : [];

  const money = (v: number) => `${(v / 1_000_000).toFixed(1)}M`;

  return (
    <AnalysisPageShell
      title="各社 固定費推移"
      description="出所は財務モジュールの管理会計レポート（固定製造費 / 固定人件費 / 固定販管費 とその合計）です。この画面で費用分類を新しく作っていません。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={{ company: selectedCompany }}
    >
      {dataset ? (
        <div className="flex flex-col gap-3">
          {/* まず全社比較（この画面の主役） */}
          <SeriesChart
            title={`固定費合計 — 5社 × ${dataset.turns.length}Q`}
            series={totalSeries.map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points }))}
            totalTurns={totalTurns}
            unitLabel="USD"
            testId="fixed-cost-total-chart"
            emptyMessage="固定費が記録されていません。"
          />

          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="内訳を見る会社の選択">
            <span className="text-xs text-slate-400">内訳を見る会社</span>
            {companies.map((c) => (
              <button
                key={c.companyId}
                type="button"
                onClick={() => selectCompany(c.companyId)}
                aria-pressed={c.companyId === selectedCompany}
                data-testid={`fixed-cost-company-${c.companyId}`}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${c.companyId === selectedCompany ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {c.companyId}
              </button>
            ))}
          </div>

          {/* 内訳・数値表は既定で閉じる */}
          <Collapsible title={`${selectedCompany} の固定費内訳（正式3区分）`} testId="fixed-cost-breakdown-toggle">
            <StackedAreaChart
              title={`${selectedCompany} — 固定費の内訳`}
              series={componentSeries.map((s) => ({
                key: s.component,
                label: FIXED_COST_COMPONENT_LABELS[s.component as keyof typeof FIXED_COST_COMPONENT_LABELS] ?? s.component,
                color: FIXED_COST_COMPONENT_COLORS[s.component as keyof typeof FIXED_COST_COMPONENT_COLORS] ?? "#64748b",
                points: s.points,
              }))}
              totalTurns={totalTurns}
              unitLabel="USD"
              format={money}
              testId="fixed-cost-breakdown-chart"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              この3区分の合計が「固定費合計」と一致します。下の「製造原価側の内訳」は固定製造費の中身であり、固定人件費・固定販管費を含みません（3区分と合計は一致しません）。
            </p>
          </Collapsible>

          <Collapsible title={`${selectedCompany} の製造原価側の内訳（実在する項目のみ）`} testId="fixed-cost-detail-toggle">
            <SeriesChart
              title={`${selectedCompany} — 工場固定費 / 固定ユーティリティ / 減価償却 / 正社員労務費`}
              series={detailSeries.map((s) => ({
                key: s.component,
                label: FIXED_COST_DETAIL_LABELS[s.component as keyof typeof FIXED_COST_DETAIL_LABELS] ?? s.component,
                color: DETAIL_COLORS[s.component] ?? "#64748b",
                points: s.points,
              }))}
              totalTurns={totalTurns}
              unitLabel="USD"
              testId="fixed-cost-detail-chart"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              製造原価の内訳として実在する項目だけを出しています（正社員労務費は未配属分を含む会社全体の総額）。HQ/Admin
              等の分類はゲームエンジンに存在しないため作っていません。
            </p>
          </Collapsible>

          <RawValuesTable
            turns={dataset.turns}
            rows={totalSeries.map((s) => ({ label: `${s.companyId} 固定費合計`, values: s.points.map((p) => p.value) }))}
            format={(v) => (v / 1_000_000).toFixed(2)}
            unitNote="単位: USD 百万"
            testId="fixed-cost-raw-toggle"
          />
        </div>
      ) : null}
    </AnalysisPageShell>
  );
}
