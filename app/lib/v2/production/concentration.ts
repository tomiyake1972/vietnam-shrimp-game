// ShrimpX V2 — Test16 Stage E: 商品集中生産効率（concentration factor）
//
// 【何を表すか】
// 同じ商品を大量に作るほど、1トンあたりに要する人手が減る（段取り替えが減り、
// ラインが専用化され、習熟が進む）という規模の効果を、労働集約度係数への
// 乗数として表現する。
//
// 【Single Source of Truth】
// concentrationFactor(product, quantity) が唯一の情報源である。
// 労働計算・製造原価計算書・UI・Standard AI診断は必ずこの関数を通す。
// 「その画面だけの代表生産量」を各所で置いてはならない（指示 判断3）。
//
// 【カーブ（線形補間・下限なし）】
//   HOSO   : 8,000t以下 = 1.00 、16,000t = 0.80 、24,000t = 0.60
//   PD/VAP : 4,000t以下 = 1.00 、12,000t = 0.80
// いずれも基準点を超えたあとの傾きは一定（8,000tごとに 0.20 低下）であり、
// 上限数量を超えてもそのまま外挿する（**下限は設けない**）。
//
// 【循環しないこと】
// この関数は「数量 → 係数」の一方向であり、数量を入力として要求する。
// 「人数 → 作れる最大数量」を求める側は、代表生産量を仮定するのではなく
// labor.ts の maxQuantityForAvailableWorkers（二分探索）で逆算する。

import { Product } from "../market/types";

export interface ConcentrationCurve {
  /** この数量までは係数1.00（集中効果なし）。 */
  readonly baselineQuantityTons: number;
  /** 基準数量を超えたぶん、この数量あたり factorDropPerStep だけ係数が下がる。 */
  readonly stepQuantityTons: number;
  /** 1ステップあたりの係数低下幅。 */
  readonly factorDropPerStep: number;
}

/**
 * 商品別の集中効率カーブ。
 * HOSOは 8,000 → 16,000 で 1.00 → 0.80、16,000 → 24,000 で 0.80 → 0.60。
 * 傾きが一定なので「8,000tごとに0.20低下」という1本の直線で表せる。
 */
export const CONCENTRATION_CURVE_BY_PRODUCT: Readonly<Record<Product, ConcentrationCurve>> = {
  hoso: { baselineQuantityTons: 8_000, stepQuantityTons: 8_000, factorDropPerStep: 0.2 },
  pd: { baselineQuantityTons: 4_000, stepQuantityTons: 8_000, factorDropPerStep: 0.2 },
  vap: { baselineQuantityTons: 4_000, stepQuantityTons: 8_000, factorDropPerStep: 0.2 },
};

/**
 * 商品集中効率係数。労働集約度係数へ**乗じる**値。
 *
 * 1.00 なら集中効果なし。小さいほど必要人手が減る。
 * 下限は設けない（指示どおり）が、係数が0以下になると「人手ゼロで作れる」
 * ことになり労働計算が破綻するため、正の下限 EPSILON でのみ保護する。
 * これは設計上の下限（0.70等）ではなく、ゼロ除算を避けるための防御である。
 */
export function concentrationFactor(
  product: Product,
  quantityTons: number,
  curves: Readonly<Record<Product, ConcentrationCurve>> = CONCENTRATION_CURVE_BY_PRODUCT
): number {
  const curve = curves[product];
  if (!curve) return 1;
  if (!Number.isFinite(quantityTons) || quantityTons <= curve.baselineQuantityTons) return 1;
  const excess = quantityTons - curve.baselineQuantityTons;
  const factor = 1 - (excess / curve.stepQuantityTons) * curve.factorDropPerStep;
  return Math.max(1e-6, factor);
}

/**
 * 【Test16 Stage E・重要】必要Worker総数が最大になる数量。
 *
 * 必要Worker ∝ quantity × concentrationFactor(quantity) であり、
 * 係数が線形に下がる（下限なし）ため、この積は
 *   q × (1 + b·d/s) − q²·d/s        （b=基準数量, d=低下幅, s=ステップ）
 * という上に凸の二次関数になる。したがって
 *   q* = (1 + b·d/s) · s / (2d)
 * を超えると「**たくさん作るほど必要人数が減る**」という逆転が起きる。
 *
 * HOSO: q* = 24,000t（＝MAX_HOSO_CAPACITY_TONS と一致するため、ゲーム内では到達しない）
 * PD/VAP: q* = 22,000t（現行の商品別能力・増設単位から見て遠い）
 *
 * 「下限なし」というご指示の数学的な帰結であり、実装上の不具合ではない。
 * ただし二分探索の単調性前提が破れる領域なので、逆算側はここで探索を打ち切る。
 */
export function peakLaborQuantityTons(
  product: Product,
  curves: Readonly<Record<Product, ConcentrationCurve>> = CONCENTRATION_CURVE_BY_PRODUCT
): number {
  const curve = curves[product];
  if (!curve || curve.factorDropPerStep <= 0) return Number.POSITIVE_INFINITY;
  const { baselineQuantityTons: b, stepQuantityTons: s, factorDropPerStep: d } = curve;
  return ((1 + (b * d) / s) * s) / (2 * d);
}
