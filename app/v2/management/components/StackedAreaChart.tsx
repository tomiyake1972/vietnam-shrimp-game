"use client";

// ShrimpX V2 — 積み上げ面グラフ（営業配置・固定費内訳）
//
// 外部チャートライブラリを増やさず、インラインSVGで描く。
// 「総量の増減」と「内訳の変化」を同時に見るための形。
//
// 【捏造しない】値が無いターンは 0 として積まず、その系列の面を途切れさせる
// （欠測を0と描いて「減った」ように見せない）。

export interface StackSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly points: readonly { readonly turn: number; readonly value: number | null }[];
}

interface Props {
  readonly title: string;
  readonly series: readonly StackSeries[];
  readonly totalTurns: number;
  readonly unitLabel: string;
  readonly format?: (v: number) => string;
  readonly emptyMessage?: string;
  readonly testId?: string;
}

const W = 720;
const H = 260;
const PAD = { top: 16, right: 12, bottom: 26, left: 62 };

function defaultFormat(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

export function StackedAreaChart({ title, series, totalTurns, unitLabel, format = defaultFormat, emptyMessage, testId }: Props) {
  const turns = series[0]?.points.map((p) => p.turn) ?? [];

  // 各ターンの合計（値がある系列だけを積む）。
  const totals = turns.map((_, i) => series.reduce((sum, s) => sum + (s.points[i]?.value ?? 0), 0));
  const hasData = totals.some((t) => t > 0);
  const max = Math.max(1, ...totals);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (turn: number) => PAD.left + (plotW * (turn - 1)) / Math.max(1, totalTurns - 1);
  const y = (v: number) => PAD.top + plotH - (plotH * v) / max;

  // 下から積む。各系列の上端・下端を作る。
  const cumulative = turns.map(() => 0);
  const bands = series.map((s) => {
    const lower = [...cumulative];
    const upper = turns.map((_, i) => {
      const v = s.points[i]?.value;
      const next = cumulative[i] + (v ?? 0);
      cumulative[i] = next;
      return v === null || v === undefined ? null : next;
    });
    return { series: s, lower, upper };
  });

  return (
    <figure className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid={testId}>
      <figcaption className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        <span className="text-xs text-slate-400">{unitLabel}</span>
      </figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[520px]" role="img" aria-label={title}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#334155" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-400" fontSize={11}>
                {format(t)}
              </text>
            </g>
          ))}

          {Array.from({ length: totalTurns }, (_, i) => i + 1)
            .filter((t) => t === 1 || t === totalTurns || t % 4 === 0)
            .map((t) => (
              <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize={10}>
                Q{t}
              </text>
            ))}

          {bands.map((band) => {
            const segments: string[] = [];
            let current: { top: string[]; bottom: string[] } | null = null;
            band.upper.forEach((upperValue, i) => {
              const turn = turns[i];
              if (upperValue === null) {
                if (current) {
                  segments.push(`M${current.top.join("L")}L${current.bottom.reverse().join("L")}Z`);
                  current = null;
                }
                return;
              }
              if (!current) current = { top: [], bottom: [] };
              current.top.push(`${x(turn).toFixed(1)},${y(upperValue).toFixed(1)}`);
              current.bottom.push(`${x(turn).toFixed(1)},${y(band.lower[i]).toFixed(1)}`);
            });
            if (current) {
              const c = current as { top: string[]; bottom: string[] };
              segments.push(`M${c.top.join("L")}L${c.bottom.reverse().join("L")}Z`);
            }
            return (
              <g key={band.series.key}>
                {segments.map((d, i) => (
                  <path key={i} d={d} fill={band.series.color} opacity={0.75} stroke={band.series.color} strokeWidth={0.5} />
                ))}
                {band.upper.map((upperValue, i) =>
                  upperValue === null ? null : (
                    <circle key={turns[i]} cx={x(turns[i])} cy={y(upperValue)} r={5} fill="transparent" opacity={0}>
                      <title>{`${band.series.label} / Q${turns[i]}: ${format(band.series.points[i]?.value ?? 0)} ${unitLabel}`}</title>
                    </circle>
                  )
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs text-slate-300">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      {!hasData ? <p className="mt-2 text-xs text-slate-400">{emptyMessage ?? "まだデータがありません。"}</p> : null}
    </figure>
  );
}
