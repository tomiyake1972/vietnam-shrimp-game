// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.3） PD/VAP最低受注プレミアム
//
// 実装指示 §9: 供給過剰でも加工会社が採算を無視して無制限に値下げしない構造。
// 会社×商品（PD/VAP）について、目標プレミアム（フル原価＋目標マージン）と
// 最低受注プレミアム（回避可能費＋最低貢献利益）を区別し、市場プレミアムとの
// 比較で受注量を決める。
//
//   - 市場プレミアム >= 目標水準: 通常受注（係数1.0）
//   - 目標未満・最低受注水準以上: 稼働率・顧客維持等を考慮した縮小受注
//     （係数を最低受注水準到達時0.4まで線形に縮小）
//   - 最低受注水準未満: 販売提案を出さない（係数0）
//
// これにより供給過剰時は「プレミアム低下 → 経済的下限へ到達 → それ以上は
// 価格ではなく稼働率低下で調整」となる（受注を止めた会社の生産希望量が下がり、
// PD/VAP供給シグナル経由で翌期以降のプレミアムが自己修正される）。
// 高コスト会社（最低受注水準が高い会社）から先に退出し、効率的な会社は
// 受注を続けられる。プレミアム下限付近の配分では、既存Phase4の非価格競争
// （顧客関係・品質・納期信頼性・営業カバレッジ、上限付き飽和型の価格効果）を
// そのまま使う（本ファイルは配分ロジックへ一切手を入れない）。
//
// Phase 8の正式原価計算は未実装のため、構成要素はフィクスチャの暫定値
// （CompanyPremiumEconomics）から与える（実原価へ交換可能）。

import { CompanyPremiumEconomics } from "./types";

/** 目標プレミアム（フル原価＋目標マージン。これ以上なら通常受注）。 */
export function targetPremium(econ: CompanyPremiumEconomics): number {
  return (
    econ.expectedVariableProcessingCostUsdPerHosoEqKg +
    econ.allocatedFixedCostUsdPerHosoEqKg +
    econ.sellingAndLogisticsCostUsdPerHosoEqKg +
    econ.targetMarginUsdPerHosoEqKg
  );
}

/** 最低受注プレミアム（回避可能費＋最低貢献利益。これ未満では販売提案を出さない）。 */
export function minimumAcceptablePremium(econ: CompanyPremiumEconomics): number {
  return (
    econ.avoidableVariableProcessingCostUsdPerHosoEqKg +
    econ.incrementalSellingAndLogisticsCostUsdPerHosoEqKg +
    econ.minimumContributionMarginUsdPerHosoEqKg
  );
}

/** 縮小受注時の下限係数（最低受注水準ちょうどのときの受注量係数。暫定値・要校正）。 */
export const REDUCED_ORDER_FLOOR_FACTOR = 0.4;

/**
 * 市場プレミアム（前期実績の公開情報）に対する受注量係数（0〜1）を返す。
 * marketPremiumがundefined（turn 1等、前期実績が未知）の場合は、目標水準が
 * 満たされる想定で通常受注（1.0）とする。
 */
export function orderQuantityFactor(econ: CompanyPremiumEconomics, marketPremium: number | undefined): number {
  if (marketPremium === undefined) return 1;
  const target = targetPremium(econ);
  const minimum = minimumAcceptablePremium(econ);
  if (marketPremium >= target) return 1;
  if (marketPremium < minimum) return 0;
  const span = Math.max(target - minimum, 1e-9);
  const position = (marketPremium - minimum) / span; // 0（最低受注水準）〜1（目標水準）
  return REDUCED_ORDER_FLOOR_FACTOR + (1 - REDUCED_ORDER_FLOOR_FACTOR) * position;
}
