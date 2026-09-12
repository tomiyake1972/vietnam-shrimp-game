// ShrimpX V2 — 長期トレンド補間（Phase 2）
//
// 長期トレンドは段差ではなく徐々に変化させる（実装指示 §6）。
// 補間方式は "linear"（前後キーフレーム間を線形補間）と "step"（直前の
// キーフレームの値を維持し、キーフレームの瞬間だけ切り替わる）の2種類を
// 明示的にサポートする。範囲外（最初のキーフレームより前／最後のキーフレーム
// より後）は、それぞれ最初／最後の値を保持する（外挿はしない）。

import { ScenarioValidationError } from "./types";
import type { LongTermTrend, LongTermTrendKeyframe, TrendInterpolation } from "./types";

/**
 * 【ENG-DS2-COST-FOUNDATION-1】補間方式の全列挙（この1箇所が正典）。
 *
 * interpolateKeyframeValue は "step" を判定したあと残りを linear として扱うため、
 * 未知の文字列が runtime に入ると **黙って linear になる**。型はコンパイル時にしか
 * 効かないので、runtime入力（JSON復元・外部数表）を受ける経路では
 * validation 側が isTrendInterpolation で弾く責務を持つ。
 */
export const TREND_INTERPOLATIONS: readonly TrendInterpolation[] = ["linear", "step"];

/** runtime値が TrendInterpolation かどうかを判定する（validation から使う）。 */
export function isTrendInterpolation(value: unknown): value is TrendInterpolation {
  return typeof value === "string" && (TREND_INTERPOLATIONS as readonly string[]).includes(value);
}

/** キーフレームがturn昇順であることを検証する（重複turnも不可）。 */
export function assertSortedKeyframes(keyframes: readonly LongTermTrendKeyframe[], label: string): void {
  if (keyframes.length < 2) {
    throw new ScenarioValidationError(`${label}: キーフレームは2点以上必要です。`);
  }
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].turn <= keyframes[i - 1].turn) {
      throw new ScenarioValidationError(
        `${label}: キーフレームはturn昇順である必要があります（重複turnも不可）。index=${i} turn=${keyframes[i].turn} <= 直前turn=${keyframes[i - 1].turn}`
      );
    }
  }
}

/**
 * 指定したturnにおけるトレンド値を補間する。
 * - turnが最初のキーフレームより前: 最初の値を保持
 * - turnが最後のキーフレームより後: 最後の値を保持
 * - それ以外: interpolationに応じて線形補間または直前値を保持
 */
export function interpolateTrendValue(trend: LongTermTrend, turn: number): number {
  return interpolateKeyframeValue(trend.keyframes, trend.interpolation, turn, `trend(${trend.trendId})`);
}

/**
 * 【ENG-DS2-COST-FOUNDATION-1】キーフレーム列そのものに対する補間。
 *
 * interpolateTrendValue の中身をそのまま切り出したものであり、補間規則
 * （範囲外は端点保持・"step" は直前値・"linear" は線形）はこの1関数にしかない。
 * LongTermTrend（trendId/variable/scope を持つ）以外の用途
 * （Turn別費用指数・建設費指数・原料捕捉指数）から、規則を二重定義せずに
 * 同じ補間を使うための入口である。
 */
export function interpolateKeyframeValue(
  keyframes: readonly LongTermTrendKeyframe[],
  interpolation: TrendInterpolation,
  turn: number,
  label: string
): number {
  assertSortedKeyframes(keyframes, label);

  if (turn <= keyframes[0].turn) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (turn >= last.turn) return last.value;

  if (interpolation === "step") {
    // turn以下で最も新しいキーフレームの値を返す（キーフレームのturnに到達した
    // 瞬間に値が切り替わる。境界turn自体はすでに新しい値を持つ）。
    let current = keyframes[0];
    for (const kf of keyframes) {
      if (kf.turn > turn) break;
      current = kf;
    }
    return current.value;
  }

  // linear
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (turn >= a.turn && turn <= b.turn) {
      const t = (turn - a.turn) / (b.turn - a.turn);
      return a.value + t * (b.value - a.value);
    }
  }

  // assertSortedKeyframesを通過していれば到達しないが、念のため防御する。
  throw new ScenarioValidationError(`${label}: turn=${turn} を補間できませんでした。`);
}
