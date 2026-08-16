// ShrimpX V2 — 意思決定編集の共通入力セル（NumberCell / RatioCell / PriceAdjustmentCell）
//
// DecisionEditor.tsxとProcurement Planning component群（components/procurement/）の
// 両方から使う、計算ロジックを持たない純粋な表示・入力コンポーネント。数値・比率の
// 安全な丸め（NaN・負値の処理）だけを行い、ドメインの計算式は一切持たない。
//
// 【なぜここに切り出したか】元はDecisionEditor.tsx内のprivate関数だったが、
// Procurement Planningの入力セクション（国内買付・輸入・養殖）を独立component化する際、
// 同じ入力セルをコピーせずに済むよう、共有ファイルへ引き上げた。

import { INPUT_CONTROL_CLASS, INPUT_CONTROL_WARN_CLASS } from "./panelStyles";

export function toSafeNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function toSafeRatioNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function NumberCell(props: {
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled: boolean;
  readonly step?: number;
  readonly warn?: boolean;
  readonly testId?: string;
}) {
  return (
    <input
      type="number"
      min={0}
      step={props.step ?? 1}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeNumber(e.target.value))}
      data-testid={props.testId}
      className={`w-24 ${INPUT_CONTROL_CLASS} ${props.warn ? INPUT_CONTROL_WARN_CLASS : ""}`}
    />
  );
}

export function RatioCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeRatioNumber(e.target.value))}
      className={`w-20 ${INPUT_CONTROL_CLASS}`}
    />
  );
}

export function PriceAdjustmentCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      step={0.01}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        props.onChange(Number.isFinite(n) ? n : 0);
      }}
      className={`w-24 ${INPUT_CONTROL_CLASS}`}
    />
  );
}
