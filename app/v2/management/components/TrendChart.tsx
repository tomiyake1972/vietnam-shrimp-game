"use client";

// ShrimpX V2 — 32Q Management Console: 折れ線チャート（Phase 1）
//
// 外部チャートライブラリを追加せず、インラインSVGで描く
// （新しい依存を増やさない・CSP制約を受けない・描画コストが小さい）。

import { CompanySeries } from "../../../lib/v2/companyLab/simulation/series";

interface TrendChartProps {
  readonly title: string;
  readonly series: readonly CompanySeries[];
  readonly pick: (p: CompanySeries["points"][number]) => number | null;
  readonly totalTurns: number;
  /** 強調表示する会社（選択中の会社）。 */
  readonly highlightCompanyId: string | null;
  readonly unitLabel: string;
}

const W = 720;
const H = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 56 };

function formatMillions(v: number): string {
  return `${(v / 1_000_000).toFixed(0)}M`;
}

export function TrendChart({ title, series, pick, totalTurns, highlightCompanyId, unitLabel }: TrendChartProps) {
  const values: number[] = [];
  for (const s of series) for (const p of s.points) {
    const v = pick(p);
    if (v !== null) values.push(v);
  }
  const hasData = values.length > 0;
  const rawMin = hasData ? Math.min(...values) : 0;
  const rawMax = hasData ? Math.max(...values) : 1;
  // 0を必ず含めて、赤字と黒字の位置関係が一目で分かるようにする。
  const min = Math.min(0, rawMin);
  const max = Math.max(0, rawMax);
  const span = max - min || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (turn: number) => PAD.left + (plotW * (turn - 1)) / Math.max(1, totalTurns - 1);
  const y = (v: number) => PAD.top + plotH - (plotH * (v - min)) / span;

  const ticks = [min, min + span / 2, max];
  const zeroY = y(0);

  return (
    <figure className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <figcaption className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        <span className="text-xs text-slate-400">{unitLabel}</span>
      </figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[520px]" role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#334155" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-400" fontSize={11}>
                {formatMillions(t)}
              </text>
            </g>
          ))}
          {min < 0 && max > 0 ? (
            <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 3" />
          ) : null}

          {[1, Math.ceil(totalTurns / 2), totalTurns].map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize={11}>
              Q{t}
            </text>
          ))}

          {series.map((s) => {
            const pts = s.points
              .map((p) => ({ turn: p.turn, v: pick(p) }))
              .filter((p): p is { turn: number; v: number } => p.v !== null);
            if (pts.length === 0) return null;
            const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.turn).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
            const dim = highlightCompanyId !== null && highlightCompanyId !== s.companyId;
            return (
              <path
                key={s.companyId}
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={dim ? 1.2 : 2.4}
                opacity={dim ? 0.35 : 1}
                strokeLinejoin="round"
              />
            );
          })}
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <li key={s.companyId} className="flex items-center gap-1.5 text-xs text-slate-300">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
            {s.companyId}
          </li>
        ))}
      </ul>
      {!hasData ? <p className="mt-2 text-xs text-slate-400">まだデータがありません。ターンを進めてください。</p> : null}
    </figure>
  );
}
