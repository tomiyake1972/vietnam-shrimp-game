"use client";

// ShrimpX V2 — 32Q Management Console Phase 2: 汎用折れ線チャート
//
// 外部チャートライブラリを追加せず、インラインSVGで描く
// （新しい依存を増やさない・CSP制約を受けない・描画コストが小さい）。
//
// 【TRUE と OBSERVED を同じ系列に見せない】
// dashed を指定した系列は破線で描き、凡例にも別扱いであることを出す。
// 折れ線の見た目だけに頼らず、呼び出し側が凡例ラベル自体へ
// 「TRUE WORLD」「OBSERVABLE」を書けるようにしてある。

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly points: readonly { readonly turn: number; readonly value: number | null }[];
  /** 破線で描く（観測値・遅行情報など、実測と区別したい系列）。 */
  readonly dashed?: boolean;
}

interface Props {
  readonly title: string;
  readonly series: readonly ChartSeries[];
  readonly totalTurns: number;
  readonly unitLabel: string;
  readonly highlightKey?: string | null;
  readonly format?: (v: number) => string;
  readonly emptyMessage?: string;
  readonly testId?: string;
}

const W = 720;
const H = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 62 };

function defaultFormat(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 1) return v.toFixed(0);
  return v.toFixed(2);
}

export function SeriesChart({ title, series, totalTurns, unitLabel, highlightKey = null, format = defaultFormat, emptyMessage, testId }: Props) {
  const values: number[] = [];
  for (const s of series) for (const p of s.points) if (p.value !== null) values.push(p.value);
  const hasData = values.length > 0;
  const rawMin = hasData ? Math.min(...values) : 0;
  const rawMax = hasData ? Math.max(...values) : 1;
  // 0を必ず含めて、赤字と黒字（不足と充足）の位置関係が一目で分かるようにする。
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
    <figure className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid={testId}>
      <figcaption className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">{title}</span>
        <span className="text-xs text-slate-400">{unitLabel}</span>
      </figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[520px]" role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#334155" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-400" fontSize={11}>
                {format(t)}
              </text>
            </g>
          ))}
          {min < 0 && max > 0 ? (
            <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 3" />
          ) : null}

          {/* Q ラベルは間引く（32本すべては描かない）。4Qごと＝年ごとに1本。 */}
          {Array.from({ length: totalTurns }, (_, i) => i + 1)
            .filter((t) => t === 1 || t === totalTurns || t % 4 === 0)
            .map((t) => (
              <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize={10}>
                Q{t}
              </text>
            ))}

          {series.map((s) => {
            const pts = s.points.filter((p): p is { turn: number; value: number } => p.value !== null);
            if (pts.length === 0) return null;
            const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.turn).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
            const dim = highlightKey !== null && highlightKey !== s.key;
            return (
              <g key={s.key}>
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={dim ? 1.2 : 2.4}
                  strokeDasharray={s.dashed ? "6 4" : undefined}
                  opacity={dim ? 0.35 : 1}
                  strokeLinejoin="round"
                />
                {/* tooltip: 各点に当たり判定を置き、ブラウザ標準のツールチップで値を出す
                    （追加のチャートライブラリ・独自オーバーレイを増やさない） */}
                {pts.map((p) => (
                  <circle key={p.turn} cx={x(p.turn)} cy={y(p.value)} r={5} fill="transparent" opacity={0}>
                    <title>{`${s.label} / Q${p.turn}: ${format(p.value)} ${unitLabel}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs text-slate-300">
            <span
              className="inline-block h-0 w-4 border-t-2"
              style={{ borderColor: s.color, borderStyle: s.dashed ? "dashed" : "solid" }}
              aria-hidden
            />
            {s.label}
          </li>
        ))}
      </ul>
      {!hasData ? <p className="mt-2 text-xs text-slate-400">{emptyMessage ?? "まだデータがありません。"}</p> : null}
    </figure>
  );
}
