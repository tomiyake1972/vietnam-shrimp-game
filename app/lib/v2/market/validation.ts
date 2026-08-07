// ShrimpX V2 — 市場モジュール共通バリデーション（Phase 1）
//
// NaN/Infinity/範囲外の値が出力へ漏れることを防ぐための小さな共通ヘルパー。
// 数量・価格はcore/units.tsのスマートコンストラクタ（hosoEqTons()等）が
// 既に検証するが、変化率・圧力指標・稼働率のような無次元の診断値
// （branded typeを持たないplain number）にも同様の検証を及ぼすために使う。

import { MarketValidationError } from "./types";

/** 有限な数値であることを検証する（NaN/Infinity/非numberを拒否）。 */
export function assertFinite(n: unknown, label: string): asserts n is number {
  if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new MarketValidationError(
      `${label} は有限数である必要があります（NaN/Infinity/非number不可）。受け取った値: ${JSON.stringify(n)}`
    );
  }
}

/** 値を [min, max] の範囲へ収める。 */
export function clamp(value: number, min: number, max: number): number {
  assertFinite(value, "clamp対象の値");
  if (min > max) {
    throw new MarketValidationError(`clampの範囲が不正です: min(${min}) > max(${max})`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * ゼロ割りを避けるための安全な除算。分母がepsilon未満の場合はepsilonへ
 * 底上げしてから除算する（分母は非負の数量・能力を想定）。
 */
export function safeDivide(numerator: number, denominator: number, epsilon = 1e-6): number {
  assertFinite(numerator, "safeDivideの分子");
  assertFinite(denominator, "safeDivideの分母");
  const safeDenominator = Math.max(denominator, epsilon);
  return numerator / safeDenominator;
}
