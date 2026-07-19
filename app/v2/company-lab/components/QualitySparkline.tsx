// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） 軽量スパークライン
//
// グラフライブラリを新規導入せず、素のSVGだけで1系列の推移を表示する。
// 表示専用の純粋コンポーネントで、値の計算・変換は一切行わない
// （undefined/NaN/Infinityはそのまま「欠測」として点を打たないだけで、
// 補間・置換はしない）。

interface QualitySparklineProps {
  readonly points: readonly { readonly turn: number; readonly value: number | undefined }[];
  readonly color?: string;
  readonly height?: number;
  readonly width?: number;
  readonly fixedMin?: number;
  readonly fixedMax?: number;
}

export default function QualitySparkline(props: QualitySparklineProps) {
  const { points, color = "#2dd4bf", height = 40, width = 220, fixedMin, fixedMax } = props;

  const finiteValues = points.map((p) => p.value).filter((v): v is number => v !== undefined && Number.isFinite(v));

  if (finiteValues.length === 0) {
    return <div style={{ height }} className="flex items-center justify-center text-[10px] text-gray-600">データなし</div>;
  }

  const min = fixedMin !== undefined ? fixedMin : Math.min(...finiteValues);
  const max = fixedMax !== undefined ? fixedMax : Math.max(...finiteValues);
  const span = max - min;

  const n = points.length;
  const stepX = n > 1 ? width / (n - 1) : 0;

  const coords = points.map((p, i) => {
    if (p.value === undefined || !Number.isFinite(p.value)) return null;
    const x = n > 1 ? i * stepX : width / 2;
    const y = span > 1e-9 ? height - ((p.value - min) / span) * height : height / 2;
    return { x, y };
  });

  const segments: string[] = [];
  let currentSegment: string[] = [];
  for (const c of coords) {
    if (c === null) {
      if (currentSegment.length > 1) segments.push(currentSegment.join(" "));
      currentSegment = [];
      continue;
    }
    currentSegment.push(`${c.x.toFixed(1)},${c.y.toFixed(1)}`);
  }
  if (currentSegment.length > 1) segments.push(currentSegment.join(" "));

  const lastValid = [...coords].reverse().find((c) => c !== null);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {segments.map((seg, idx) => (
        <polyline key={idx} points={seg} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {coords.map((c, idx) =>
        c ? <circle key={idx} cx={c.x} cy={c.y} r={1.4} fill={color} /> : null
      )}
      {lastValid && <circle cx={lastValid.x} cy={lastValid.y} r={2.6} fill={color} stroke="#111827" strokeWidth={0.8} />}
    </svg>
  );
}
