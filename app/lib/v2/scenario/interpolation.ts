// ShrimpX V2 — 長期トレンド補間（Phase 2）
//
// 長期トレンドは段差ではなく徐々に変化させる（実装指示 §6）。
// 補間方式は "linear"（前後キーフレーム間を線形補間）と "step"（直前の
// キーフレームの値を維持し、キーフレームの瞬間だけ切り替わる）の2種類を
// 明示的にサポートする。範囲外（最初のキーフレームより前／最後のキーフレーム
// より後）は、それぞれ最初／最後の値を保持する（外挿はしない）。

import { ScenarioValidationError } from "./types";
import type { LongTermTrend, LongTermTrendKeyframe } from "./types";

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
  const keyframes = trend.keyframes;
  assertSortedKeyframes(keyframes, `trend(${trend.trendId})`);

  if (turn <= keyframes[0].turn) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (turn >= last.turn) return last.value;

  if (trend.interpolation === "step") {
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
  throw new ScenarioValidationError(`trend(${trend.trendId}): turn=${turn} を補間できませんでした。`);
}
