"use client";

// ShrimpX V2 — Vision と戦略成長（独立URL）
//
// 【この画面が答える問い】
//   ・この会社は何を目指しているのか（Vision）。
//   ・志に対して今どこにいるのか（参考成長軌道 vs 現在の持続可能規模）。
//   ・新工場を建てたのか、建てなかったのか。そしてなぜか。
//
// 【捏造しない】記録が無い実行では「記録がありません」と出す。
// Vision を導入する前に保存された Simulation Run では、架空の Vision を作らない。

import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { SeriesChart } from "../../components/SeriesChart";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { replaceQueryParam, useAnalysisRun, useQueryParam } from "../lib/useAnalysisRun";
import { describeNewFactoryBlocker } from "../../../../lib/v2/companyLab/standardAi/decision/newFactory";

const PATH = "/v2/management/analysis/strategy";

const GROWTH_PRESSURE_LABELS: Readonly<Record<string, string>> = {
  LOW: "低",
  MODERATE: "中",
  HIGH: "高",
  URGENT: "切迫",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  NOT_CONSIDERED: "検討対象外",
  MONITORING: "監視中",
  CONSIDERING: "検討中",
  READY_TO_BUILD: "提案",
  DEFERRED: "見送り",
  APPROVED: "承認済み・建設中",
};

const DASH = "－";
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()}t`);

export function StrategyView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();

  const captures = stored?.packCapture?.companyTurns ?? [];
  const companyIds = [...new Set(captures.map((c) => c.companyId))];
  const companyParam = useQueryParam("company", companyIds[0] ?? "");
  const company = companyIds.includes(companyParam) ? companyParam : (companyIds[0] ?? "");

  const rows = captures.filter((c) => c.companyId === company).sort((a, b) => a.turn - b.turn);
  const turns = rows.map((r) => r.turn);
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, stored?.dataset.turns.length ?? 0);
  const latestVision = [...rows].reverse().find((r) => r.strategy.vision !== null)?.strategy.vision ?? null;

  const series = [
    {
      key: "reference",
      label: "参考成長軌道（Vision）",
      color: "#a855f7",
      points: rows.map((r) => ({ turn: r.turn, value: r.strategy.visionTargetScaleAtCurrentTurn })),
    },
    {
      key: "sustainable",
      label: "現在の持続可能規模",
      color: "#38bdf8",
      points: rows.map((r) => ({ turn: r.turn, value: r.strategy.currentSustainableScaleTons })),
    },
  ];

  return (
    <AnalysisPageShell
      title="Vision と戦略成長（新工場を建てる／建てない判断）"
      description="Vision は人間の経営者が外から与えるものです。Standard AI は成長目標を自分で作らず、志と現在地の差（戦略ギャップ）に反応します。参考成長軌道は REFERENCE PATH であり、達成義務ではありません。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
      extraQuery={company ? { company } : undefined}
    >
      {companyIds.length === 0 ? (
        <p className="text-sm text-slate-400" data-testid="strategy-empty">
          この Simulation Run には Vision・戦略成長の記録がありません（Vision 導入より前に保存された実行です）。値を推測で補完することはしません。
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="会社の選択">
            <span className="text-xs text-slate-400">会社</span>
            {companyIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => replaceQueryParam("company", id)}
                aria-pressed={id === company}
                data-testid={`strategy-company-${id}`}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${id === company ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {id}
              </button>
            ))}
          </div>

          {latestVision ? (
            <section className="mb-3 rounded-md border border-slate-700 bg-slate-900/50 p-3" data-testid="strategy-vision-card">
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-300">Vision（経営者の志）</h2>
              <p className="text-sm leading-relaxed text-slate-100">{latestVision.longTermNarrative}</p>
              <p className="mt-1.5 text-xs text-slate-400">
                Q32で目指す規模 <span className="font-semibold text-slate-200">{latestVision.targetScaleTonsPerQuarterAtQ32.toLocaleString()} t/期</span>
                {" ・ "}目指す会社像 {latestVision.preferredEndState}
                {" ・ "}成長意欲 {latestVision.growthAmbition}
                {" ・ "}工場建設 {latestVision.willingnessToBuildFactories}
                {" ・ "}財務リスク許容度 {latestVision.financialRiskTolerance}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-amber-300/80">
                Vision を設定するのは人間の経営者の仕事です。この数値は「目指す姿」であって、達成できないことは異常ではありません。
              </p>
            </section>
          ) : null}

          <SeriesChart
            title="参考成長軌道 vs 現在の持続可能規模"
            series={series}
            totalTurns={totalTurns}
            unitLabel="HOSO換算トン / 四半期"
            format={(v) => Math.round(v).toLocaleString()}
            testId="strategy-gap-chart"
            emptyMessage="戦略ギャップの記録がありません。"
          />

          <section className="mt-3 overflow-x-auto rounded-md border border-slate-700">
            <table className="w-full min-w-[720px] text-left text-[11px]" data-testid="strategy-table">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-2 py-1">Q</th>
                  <th className="px-2 py-1">参考規模</th>
                  <th className="px-2 py-1">持続可能規模</th>
                  <th className="px-2 py-1">戦略ギャップ</th>
                  <th className="px-2 py-1">成長圧力</th>
                  <th className="px-2 py-1">新工場</th>
                  <th className="px-2 py-1">止まったゲート</th>
                  <th className="px-2 py-1">理由コード</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.strategy;
                  // 【Phase 6D】MONITORING は「提案圧力未達」で止まっており、失敗した gate は
                  // 記録上存在しない。従来の「（全通過）」表示は誤解を招くため SSoT を使う。
                  const blocker = s.newFactory ? describeNewFactoryBlocker(s.newFactory) : null;
                  return (
                    <tr key={r.turn} className="border-t border-slate-800 text-slate-300">
                      <td className="px-2 py-1 tabular-nums">{r.turn}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(s.visionTargetScaleAtCurrentTurn)}</td>
                      <td className="px-2 py-1 tabular-nums">{tons(s.currentSustainableScaleTons)}</td>
                      <td className="px-2 py-1 tabular-nums">
                        {s.strategicScaleGapTons === null ? DASH : `${tons(s.strategicScaleGapTons)}（${((s.strategicScaleGapRatio ?? 0) * 100).toFixed(1)}%）`}
                      </td>
                      <td className="px-2 py-1">{s.growthPressure === null ? DASH : (GROWTH_PRESSURE_LABELS[s.growthPressure] ?? s.growthPressure)}</td>
                      <td className="px-2 py-1">{s.newFactory === null ? DASH : (STATUS_LABELS[s.newFactory.status] ?? s.newFactory.status)}</td>
                      <td className="px-2 py-1 font-mono text-slate-400">{blocker ?? (s.newFactory ? "（全ゲート通過・提案）" : DASH)}</td>
                      <td className="px-2 py-1 font-mono text-slate-500">{s.newFactory ? s.newFactory.reasonCodes.join(", ") : DASH}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            「建てなかった」四半期も記録された経営判断です（{turns.length} 四半期ぶん）。単一の不透明なスコアではなく、ゲートごとの値と閾値が
            AI Analysis Pack の 14d_New_Factory_Gates シートに残っています。
          </p>
        </>
      )}
    </AnalysisPageShell>
  );
}
