// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 正規化・丸めヘルパー
//
// core/units.tsのスマートコンストラクタ・丸め関数を必ず経由させ、標準AI独自の
// 丸め処理を新規に作らない（要件: 丸め位置の一元化）。ここでは、標準AIの
// 計算過程で生じうる負値・NaN・Infinityを検証エラーへ落とす前に安全側へ
// クランプするための薄いラッパーだけを提供する。

import { hosoEqTons, HosoEqTons, ratio, Ratio, roundHosoEqTons, roundRatio } from "../../core/units";

/** 有限数でなければ0、負ならば0にクランプしてからHosoEqTonsへ丸める。 */
export function safeHosoEqTons(n: number): HosoEqTons {
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  return hosoEqTons(roundHosoEqTons(safe));
}

/** 有限数でなければ0、[0,1]の範囲外ならクランプしてからRatioへ丸める。 */
export function safeRatio(n: number): Ratio {
  const safe = Number.isFinite(n) ? n : 0;
  const clamped = Math.max(0, Math.min(1, safe));
  return ratio(roundRatio(clamped));
}

/** 有限数でなければ0にクランプする（非負制約の無いプレーンnumberフィールド用）。 */
export function safeFiniteNumber(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** 有限数でなければ0、負ならば0にクランプする整数（人員数等）。 */
export function safeNonNegativeInt(n: number): number {
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  return Math.round(safe);
}
