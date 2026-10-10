// ShrimpX V2 — 意思決定編集の共通入力セル（NumberCell / RatioCell / PriceAdjustmentCell）
//
// DecisionEditor.tsxとProcurement Planning component群（components/procurement/）、
// Worker増減パネル（WorkforcePanel.tsx）から使う、計算ロジックを持たない
// 純粋な表示・入力コンポーネント。ドメインの計算式は一切持たない。
//
// 【なぜここに切り出したか】元はDecisionEditor.tsx内のprivate関数だったが、
// Procurement Planningの入力セクション（国内買付・輸入・養殖）を独立component化する際、
// 同じ入力セルをコピーせずに済むよう、共有ファイルへ引き上げた。

import { useState } from "react";
import { INPUT_CONTROL_CLASS, INPUT_CONTROL_WARN_CLASS } from "./panelStyles";

/**
 * 【INT-1 §1（監査後修正）】空欄・不正な数値を、利用者へ知らせずに0として確定しない。
 *
 * 【以前の説明の訂正】以前このファイルには「type="number" の空欄は区別できないので
 * 0にする」と書いていたが、これは誤りだった。onChange が受け取る e.target.value は
 * 文字列であり、Number() へ渡す前に raw === "" を判定できる。
 * 旧実装は Number("") === 0 となる性質にそのまま乗っていたため、
 *   空欄のまま確定         → 0 が「正当な意思決定」として保存される
 *   数値にならない文字を入力 → 0 が保存される
 * という無言の書き換えが起きていた（実測済み）。
 *
 * 【方針】
 *   "0"・"0.0" 等の明示的な0 → 0 を返す（0は正当な意思決定なので必ず受理する）
 *   空欄・数値にならない入力   → NaN を返す（0へ変換しない）
 *   負数・範囲外               → 丸めずそのまま返す
 *
 * NaN・負数・範囲外はいずれも validateDecisionDraftNumbers が「どの項目か」を
 * 示して提出・確定を止める。この検証は
 *   Console内PLAYER     : PlayerWorkspace.tsx の handleConfirm
 *   Independent Player  : /api/v2/play/submit の route.ts
 * の両方が同じ関数を呼ぶため、経路によって厳しさが変わらない。
 * engine へ渡る直前の buildDecisionInputFromDraft のサニタイズ（safeNonNegative 等）は
 * 変更していないため、不正値が engine へ到達することはない（二重の防御のまま）。
 */
export function parseNumberInput(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 比率セル用。範囲（0〜1）の判定は提出前検証が行うため、ここではクランプしない。 */
export function parseRatioInput(raw: string): number {
  return parseNumberInput(raw);
}

/**
 * 【入力途中の削除・打ち直しを妨げない】
 *
 * 下書き側の number だけを value に渡すと、入力途中の文字列が number へ変換された
 * 結果で表示が上書きされ、打ち直しができなくなる（例: "0." は Number で 0 になり
 * 表示が "0" へ戻るため、小数点以下が打てない）。
 * そこで編集中だけ利用者が打った文字列をそのまま保持し、blur で下書き側の値へ戻す。
 * 下書きが NaN（空欄・不正）のときは空欄を表示するので、0 が勝手に現れることはない。
 */
function useNumericInputBuffer(value: number, onChange: (n: number) => void, parse: (raw: string) => number) {
  const [editing, setEditing] = useState<string | null>(null);
  const invalid = !Number.isFinite(value);
  return {
    displayValue: editing !== null ? editing : invalid ? "" : String(value),
    invalid,
    handleChange: (raw: string): void => {
      setEditing(raw);
      onChange(parse(raw));
    },
    handleBlur: (): void => setEditing(null),
  };
}

export function NumberCell(props: {
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled: boolean;
  readonly step?: number;
  readonly warn?: boolean;
  readonly testId?: string;
  /**
   * 下限。既定は0。増減差分のように負値が正当な入力欄では null を渡して下限を外す
   * （min属性はブラウザのスピナー・検証に効くだけで、提出前検証の代わりにはならない）。
   */
  readonly min?: number | null;
  /**
   * 【UI-TRIAL-1 §4】この入力欄が何の値かを、対象（市場・商品・工場）込みで示す読み上げ名。
   * 表の中の数値欄は見出しが離れているため、ラベルが無いと「何の人数か」が分からない。
   */
  readonly ariaLabel?: string;
}) {
  const buffer = useNumericInputBuffer(props.value, props.onChange, parseNumberInput);
  return (
    <input
      type="number"
      {...(props.min === null ? {} : { min: props.min ?? 0 })}
      step={props.step ?? 1}
      value={buffer.displayValue}
      disabled={props.disabled}
      onChange={(e) => buffer.handleChange(e.target.value)}
      onBlur={buffer.handleBlur}
      aria-invalid={buffer.invalid || undefined}
      data-invalid={buffer.invalid ? "true" : undefined}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      className={`w-24 ${INPUT_CONTROL_CLASS} ${props.warn === true || buffer.invalid ? INPUT_CONTROL_WARN_CLASS : ""}`}
    />
  );
}

export function RatioCell(props: {
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled: boolean;
  readonly testId?: string;
  /** 【UI-TRIAL-1 §4】対象込みの読み上げ名（NumberCell と同じ理由）。 */
  readonly ariaLabel?: string;
}) {
  const buffer = useNumericInputBuffer(props.value, props.onChange, parseRatioInput);
  return (
    <input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={buffer.displayValue}
      disabled={props.disabled}
      onChange={(e) => buffer.handleChange(e.target.value)}
      onBlur={buffer.handleBlur}
      aria-invalid={buffer.invalid || undefined}
      data-invalid={buffer.invalid ? "true" : undefined}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      className={`w-20 ${INPUT_CONTROL_CLASS} ${buffer.invalid ? INPUT_CONTROL_WARN_CLASS : ""}`}
    />
  );
}

export function PriceAdjustmentCell(props: {
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled: boolean;
  readonly testId?: string;
  /** 【UI-TRIAL-1 §4】対象込みの読み上げ名（NumberCell と同じ理由）。 */
  readonly ariaLabel?: string;
}) {
  const buffer = useNumericInputBuffer(props.value, props.onChange, parseNumberInput);
  return (
    <input
      type="number"
      step={0.01}
      value={buffer.displayValue}
      disabled={props.disabled}
      onChange={(e) => buffer.handleChange(e.target.value)}
      onBlur={buffer.handleBlur}
      aria-invalid={buffer.invalid || undefined}
      data-invalid={buffer.invalid ? "true" : undefined}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      className={`w-24 ${INPUT_CONTROL_CLASS} ${buffer.invalid ? INPUT_CONTROL_WARN_CLASS : ""}`}
    />
  );
}
