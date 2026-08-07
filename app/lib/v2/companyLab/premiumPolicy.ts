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
import { Score0to100, unwrapUnit } from "../core/units";

// ---------------------------------------------------------------------
// 【Test15新設】VAP商品開発投資の販売効果 — 会社VAP能力の合成係数
// ---------------------------------------------------------------------
//
// productDevelopmentState.ts（VAP商品開発スコア）・salesBase.ts（VAP営業基盤）・
// quality（品質評価）・trust（納期信頼性）という既存の別々のストックから、
// sales/allocation.tsのvapCapability競争力ウェイトへ渡す単一の合成スコア
// （0〜100）を作る。marketPremiumByProduct.vapや他の共有市場観測データには
// 一切書き込まない（読み取り専用の合成のみ）。

/** calculateCompanyCapabilityCoefficientへの入力（すべて任意。未接続時は中立値50）。 */
export interface CompanyVapCapabilityInputs {
  /** 前四半期末までのVAP商品開発スコア（companyLab/productDevelopmentState.ts）。 */
  readonly productDevelopmentScore?: Score0to100;
  /** 前四半期末までのVAP営業基盤スコア（companyLab/salesBase.ts、market非依存の代表値）。 */
  readonly salesBaseScore?: Score0to100;
  /** 前四半期末までのVAP品質評価スコア。 */
  readonly qualityScore?: Score0to100;
  /** 前四半期末までの納期信頼性スコア（市場横断の代表値）。 */
  readonly deliveryReliabilityScore?: Score0to100;
}

/** 【Test15暫定値・要校正】各入力の合成ウェイト（合計1.0）。 */
export interface VapCapabilityWeights {
  readonly productDevelopment: number;
  readonly salesBase: number;
  readonly quality: number;
  readonly deliveryReliability: number;
}

export const VAP_CAPABILITY_WEIGHTS_V1: VapCapabilityWeights = {
  // 【Test15暫定値・要校正】VAP商品開発スコアを主要因（0.4）とし、既存の営業基盤・
  // 品質・納期信頼性を補助シグナルとして合算する（重複計上を避けるため、既存の
  // 価格競争力・顧客関係等とは独立に、この合成係数だけをvapCapabilityへ渡す）。
  productDevelopment: 0.4,
  salesBase: 0.3,
  quality: 0.2,
  deliveryReliability: 0.1,
};

const CAPABILITY_NEUTRAL_SCORE = 50;

/**
 * 会社のVAP能力合成係数（0〜100スケール）を算出する。未接続の入力は中立値50を
 * 使う（sales/allocation.tsのsalesBaseScore等と同じ「未接続=中立」規約）。
 */
export function calculateCompanyCapabilityCoefficient(
  inputs: CompanyVapCapabilityInputs,
  weights: VapCapabilityWeights = VAP_CAPABILITY_WEIGHTS_V1
): number {
  const pd = inputs.productDevelopmentScore !== undefined ? unwrapUnit(inputs.productDevelopmentScore) : CAPABILITY_NEUTRAL_SCORE;
  const sb = inputs.salesBaseScore !== undefined ? unwrapUnit(inputs.salesBaseScore) : CAPABILITY_NEUTRAL_SCORE;
  const q = inputs.qualityScore !== undefined ? unwrapUnit(inputs.qualityScore) : CAPABILITY_NEUTRAL_SCORE;
  const dr = inputs.deliveryReliabilityScore !== undefined ? unwrapUnit(inputs.deliveryReliabilityScore) : CAPABILITY_NEUTRAL_SCORE;

  const weightTotal = weights.productDevelopment + weights.salesBase + weights.quality + weights.deliveryReliability;
  if (!(weightTotal > 0)) return CAPABILITY_NEUTRAL_SCORE;

  const weightedSum = weights.productDevelopment * pd + weights.salesBase * sb + weights.quality * q + weights.deliveryReliability * dr;
  return Math.max(0, Math.min(100, weightedSum / weightTotal));
}

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
