// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 営業人員（Phase 4）
//
// 営業人員数から「市場カバレッジ（成約配分の競争力ウェイトの一因子）」と
// 「処理能力（成約量の上限）」を導出する純粋関数のみを提供する。
// どちらも Michaelis-Menten型の飽和曲線（x/(x+k)）を採用し、
//   - headcount=0 でも既存顧客ぶんの最低限の値を残す
//   - headcount増加の効果は逓減する（人員を増やすほど追加1人あたりの伸びが減る）
//   - 上限は有限（青天井にならない）
// という実装指示の要件を満たす。将来、営業人員の異動コスト・配置変更の遅延・
// 市場経験による補正を追加する場合は、この2関数のシグネチャに引数を足すだけで
// 拡張できる（本Phaseでは異動コスト・遅延は未実装のまま）。

import { HosoEqTons, hosoEqTons, roundHosoEqTons } from "../core/units";
import { SalesValidationError } from "./types";
import { SalesParameters } from "./parameters";

function assertNonNegativeIntegerHeadcount(headcount: number): void {
  if (!Number.isInteger(headcount) || headcount < 0) {
    throw new SalesValidationError(`salesForceHeadcount は0以上の整数である必要があります。受け取った値: ${headcount}`);
  }
}

/**
 * 営業人員数から市場カバレッジ（0〜1）を導出する。
 * coverage(0) = baselineCoverageAtZeroHeadcount（既存顧客による最低限の成約力）。
 * headcount → ∞ で 1 に漸近する（決して1を超えない）。
 */
export function salesCoverageScore(headcount: number, params: SalesParameters): number {
  assertNonNegativeIntegerHeadcount(headcount);
  const { baselineCoverageAtZeroHeadcount, coverageSaturationHeadcount } = params.salesForce;
  const growth = headcount / (headcount + coverageSaturationHeadcount);
  return baselineCoverageAtZeroHeadcount + (1 - baselineCoverageAtZeroHeadcount) * growth;
}

/**
 * 営業人員数から処理能力（HOSO換算トン、成約量の上限の一因子）を導出する。
 * capacity(0) = baselineCapacityTons（既存顧客ぶん）。
 * headcount → ∞ で baselineCapacityTons + capacityMaxIncrementTons に漸近する。
 */
export function processingCapacity(headcount: number, params: SalesParameters): HosoEqTons {
  assertNonNegativeIntegerHeadcount(headcount);
  const { baselineCapacityTons, capacityMaxIncrementTons, capacitySaturationHeadcount } = params.salesForce;
  const growth = headcount / (headcount + capacitySaturationHeadcount);
  return hosoEqTons(roundHosoEqTons(baselineCapacityTons + capacityMaxIncrementTons * growth));
}
