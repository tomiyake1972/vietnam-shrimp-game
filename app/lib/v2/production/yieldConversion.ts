// ShrimpX V2 — 工場・ワーカー・生産モジュール HOSO換算量と物理歩留まりの分離（Phase 6.1）
//
// すべての契約数量・原料数量・完成品在庫・能力・供給シグナルはHOSO換算トンで
// 統一されている。HOSO換算という単位変換は、殻・頭の除去といった通常の物理的
// 重量減少を既に織り込んでいるため、物理歩留まり（physicalYieldRatio）を
// HOSO換算済みの数量へさらに掛けてはならない（正常な加工を「加工損失」として
// 二重計上することになる）。
//
// 本ファイルは、原料消費量（HOSO換算）から商品の物理重量（トン）を求めるための
// 参考情報・非永続の変換関数のみを提供する。この関数の戻り値は、
// ProductionBatch・FinishedGoodsLotのいずれの永続フィールドにも書き込まれない
// （呼び出し側が表示・分析目的で必要な時にだけ呼び出す想定）。
// HOSO換算数量側の真の損失（不適合・破損・廃棄）はallocation.ts/batches.tsが
// saleableRecoveryRatioを使って算出する（本ファイルの関数とは完全に独立した
// 計算経路であり、互いの値を混ぜて使わない）。

import { Product } from "../market/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";

/**
 * 原料消費量（HOSO換算トン）から、商品の物理重量（トン）を参考値として算出する。
 * この値はHOSO換算上の完成品数量（saleableFinishedHosoEq）とは別の軸の情報であり、
 * 契約履行・在庫管理・能力判定のいずれにも使わない（参考情報専用）。
 */
export function calculatePhysicalOutputTons(
  rawMaterialConsumedHosoEqTons: number,
  product: Product,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): number {
  return rawMaterialConsumedHosoEqTons * params.yield.physicalYieldRatio[product];
}
