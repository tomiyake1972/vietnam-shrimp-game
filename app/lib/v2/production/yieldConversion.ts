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
 *
 * 【Phase 6.3】物理歩留まりが定義されていない商品（VAP: 衣・ソース・加熱等で
 * 仕様差が大きく一律の換算が成立しない）については undefined を返す。
 * VAPの主数量は投入エビ原料のHOSO換算量で管理する。
 */
export function calculatePhysicalOutputTons(
  rawMaterialConsumedHosoEqTons: number,
  product: Product,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): number | undefined {
  const ratio = params.yield.physicalYieldRatio[product];
  if (ratio === undefined) return undefined;
  return rawMaterialConsumedHosoEqTons * ratio;
}

/**
 * 商品のHOSO換算kgあたり価格から、物理製品重量kgあたり価格を参考値として算出する
 * （Phase 8の原料費比率校正・診断用。実装指示 §10）。
 * 例: PDのHOSO換算価格 $5.32/kg → 物理kgあたり $5.32 / 0.54 ≈ $9.85/kg
 * （PDはHOSO原料100トンから約54物理トンしか取れないため、物理kg単価はHOSO換算
 * 単価より高くなる）。物理歩留まりが未定義の商品（VAP）は undefined を返す。
 */
export function toPhysicalWeightPrice(
  hosoEqPriceUsdPerKg: number,
  product: Product,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): number | undefined {
  const ratio = params.yield.physicalYieldRatio[product];
  if (ratio === undefined || ratio <= 0) return undefined;
  return hosoEqPriceUsdPerKg / ratio;
}
