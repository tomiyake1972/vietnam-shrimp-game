// ShrimpX V2 — Standard AI: binding production capacity（唯一の計算箇所）
//
// 【Phase 6D-1で確認された不一致の再発防止】
// 「実際に生産できる量」は 商品別ラインの合計 と 共通前処理能力 の
// min() で決まる（共通前処理がボトルネックになりうるため、商品別ライン合計
// だけでは実際より大きく見積もってしまう）。この計算が
// targetScale.ts・standardAi/decision/newFactory.ts・policy.ts の3箇所に
// 別々に書かれていたため、将来どれか1箇所だけ変更されると値が食い違う
// リスクがあった（Phase 6D-1で実際に一度発生した不整合と同じ種類の事故）。
// 以後はこの1関数だけを唯一の情報源とする。

import { ProductAmount, sumProductAmount } from "./types";

/**
 * 実際に生産できる上限（binding production capacity）。
 * 商品別ライン能力の合計と、共通前処理能力の小さい方を返す。
 */
export function computeBindingProductionCapacityTons(
  effectiveCapacityByProduct: ProductAmount,
  totalEffectiveCommonProcessingCapacity: number
): number {
  return Math.min(sumProductAmount(effectiveCapacityByProduct), totalEffectiveCommonProcessingCapacity);
}
