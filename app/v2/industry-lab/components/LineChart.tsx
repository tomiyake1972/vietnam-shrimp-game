// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 軽量SVG折れ線グラフ
//
// 既存プロジェクトにグラフライブラリが無いため（package.jsonにグラフ系
// 依存なし）、今回のためだけに大きな依存を追加せず、SVGだけで折れ線グラフを
// 実装する（実装指示 §8）。凡例・軸・単位・対象期間を表示し、色だけでなく
// 線種（実線/破線/点線）とラベルでも系列を識別できるようにする。

export interface LineChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
}

interface LineChartProps {
  readonly title: string;
  readonly xLabels: readonly string[];
  readonly series: readonly LineChartSeries[];
  readonly unit: string;
  readonly height?: number;
}

const DASH_PATTERNS = ["none", "6,4", "2,3", "10,3,2,3", "1,4"];

const VIEW_WIDTH = 640;
const PADDING_LEFT = 56;
const PADDING_RIGHT = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 28;

export default function LineChart({ title, xLabels, series, unit, height = 220 }: LineChartProps) {
  const plotWidth = VIEW_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = height - PADDING_TOP - PADDING_BOTTOM;
  const pointCount = xLabels.length;

  const allValues = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const rawMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  const rawMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  const span = rawMax - rawMin;
  const padding = span > 0 ? span * 0.1 : Math.abs(rawMax) * 0.1 || 1;
  const yMin = rawMin - padding;
  const yMax = rawMax + padding;
  const ySpan = yMax - yMin || 1;

  function xForIndex(index: number): number {
    if (pointCount <= 1) return PADDING_LEFT + plotWidth / 2;
    return PADDING_LEFT + (plotWidth * index) / (pointCount - 1);
  }
  function yForValue(value: number): number {
    return PADDING_TOP + plotHeight - ((value - yMin) / ySpan) * plotHeight;
  }

  const yTicks = [yMin, yMin + ySpan / 2, yMax];
  const xTickIndices =
    pointCount <= 1 ? [0] : pointCount <= 6 ? xLabels.map((_, i) => i) : [0, Math.floor((pointCount - 1) / 2), pointCount - 1];

  const hasData = pointCount > 0 && series.length > 0;

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        <span className="text-xs text-gray-400">
          単位: {unit}　対象期間: {pointCount > 0 ? `${xLabels[0]} 〜 ${xLabels[pointCount - 1]}` : "—"}
        </span>
      </div>
      {!hasData ? (
        <div className="h-40 flex items-center justify-center text-gray-500 text-sm bg-gray-800/50 rounded-lg">
          データがありません
        </div>
      ) : (
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${height}`} className="w-full" role="img" aria-label={title}>
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={PADDING_LEFT}
                x2={VIEW_WIDTH - PADDING_RIGHT}
                y1={yForValue(tick)}
                y2={yForValue(tick)}
                stroke="#374151"
                strokeWidth={1}
              />
              <text x={PADDING_LEFT - 6} y={yForValue(tick) + 3} textAnchor="end" fontSize={9} fill="#9ca3af">
                {formatAxisNumber(tick)}
              </text>
            </g>
          ))}

          {xTickIndices.map((idx) => (
            <text
              key={idx}
              x={xForIndex(idx)}
              y={height - 8}
              textAnchor="middle"
              fontSize={9}
              fill="#9ca3af"
            >
              {xLabels[idx]}
            </text>
          ))}

          {series.map((s, seriesIndex) => {
            const points = s.values.map((v, i) => `${xForIndex(i)},${yForValue(v)}`).join(" ");
            return (
              <polyline
                key={s.key}
                points={points}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={DASH_PATTERNS[seriesIndex % DASH_PATTERNS.length]}
              />
            );
          })}
        </svg>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {series.map((s, seriesIndex) => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs text-gray-300">
            <svg width={18} height={8} aria-hidden="true">
              <line
                x1={0}
                x2={18}
                y1={4}
                y2={4}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={DASH_PATTERNS[seriesIndex % DASH_PATTERNS.length]}
              />
            </svg>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatAxisNumber(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString("ja-JP");
  return n.toFixed(2);
}
