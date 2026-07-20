// ShrimpX V2 — 財務モジュール 金額換算（Phase 8A）
//
// 価格はUSD/HOSO換算kg・数量はHOSO換算トンのため、金額換算には必ず
// ×1,000（kg/ton）が必要になる。この換算を各所で手書きすると桁誤り
// （1,000倍/1,000分の1のずれ）の温床になるため、本ファイルの共通関数だけを
// 経由して金額換算を行う（実装指示「×1,000 kg/tonを型または共通関数で明示し、
// 桁誤りを防ぐ」に対応）。

import { HosoEqTons, UsdPerHosoEqKg, unwrapUnit } from "../core/units";
import { Usd, usd } from "./types";

/** HOSO換算トン → kg の換算係数。production/parameters.tsのcost.hosoEqKgPerTonと同一の物理定数。 */
export const KG_PER_HOSO_EQ_TON = 1000;

/**
 * 数量（HOSO換算トン）× 単価（USD/HOSO換算kg）→ 金額（USD）。
 * 金額換算の唯一の正規経路（×1,000を明示）。
 */
export function amountFromTonsAndUnitPrice(quantity: HosoEqTons, unitPrice: UsdPerHosoEqKg): Usd {
  return usd(unwrapUnit(quantity) * KG_PER_HOSO_EQ_TON * unwrapUnit(unitPrice));
}

/**
 * プレーンなトン数 × プレーンなUSD/kg単価 → 金額（USD）。
 * ブランド型を経由できない集計途中の値（比率按分後のトン数等）向け。
 * 呼び出し側で数量がトン・単価がUSD/kgであることを保証すること。
 */
export function amountFromPlainTonsAndUsdPerKg(quantityTons: number, unitPriceUsdPerKg: number): Usd {
  return usd(quantityTons * KG_PER_HOSO_EQ_TON * unitPriceUsdPerKg);
}

/** USD金額 → USD百万（表示用のみ。内部計算では使用しない）。 */
export function usdToMillions(v: Usd): number {
  return (v as unknown as number) / 1_000_000;
}

/** 複数のUSD金額の合計。 */
export function sumUsd(values: readonly Usd[]): Usd {
  let total = 0;
  for (const v of values) total += v as unknown as number;
  return usd(total);
}
