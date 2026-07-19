// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール スコア更新（Phase 7A）
//
// 品質・納期信頼性・顧客信頼はいずれも「急落しやすく、回復は遅い」非対称alpha
// で更新する（悪化時のalpha > 改善時のalpha）。すべて0〜100スケール
// （core/units.tsのScore0to100）で管理し、常に[0,100]へ制限する。

import { score0to100, Score0to100, unwrapUnit } from "../core/units";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";

/** 悪化時・改善時で異なるalphaを使う指数移動平均的な更新（EWMA、非対称）。 */
export function updateScoreAsymmetric(previous: Score0to100, observed: Score0to100, alphaDown: number, alphaUp: number): Score0to100 {
  const prev = unwrapUnit(previous);
  const obs = unwrapUnit(observed);
  const alpha = obs < prev ? alphaDown : alphaUp;
  const next = prev + alpha * (obs - prev);
  return score0to100(Math.min(100, Math.max(0, Math.round(next * 100) / 100)));
}

/** 品質スコアの更新（悪化速い・回復遅い）。生産実績がない場合は呼び出し側が更新をスキップする。 */
export function updateQualityScore(previous: Score0to100, observedQualityScore: Score0to100, params: QualityParameters = QUALITY_PARAMETERS_V1): Score0to100 {
  return updateScoreAsymmetric(previous, observedQualityScore, params.qualityScoreUpdate.alphaDown, params.qualityScoreUpdate.alphaUp);
}

/**
 * 納期信頼性の更新。dueQuantityが0（当期に評価対象となる納期数量がない）の
 * 場合は呼び出し側が更新をスキップする（本関数はスキップ判断そのものは行わない。
 * 純粋な数値更新のみを担う）。continuingOverdueQuantityがある場合は、
 * observedOnTimeScoreへ小さな追加ペナルティを適用する（過年度からの持ち越し分を
 * 「毎期新しい失敗」として無制限に重複加算しないよう、上限付き・小さめの係数のみ使う）。
 */
export function updateDeliveryReliabilityScore(
  previous: Score0to100,
  dueQuantity: number,
  onTimeQuantity: number,
  continuingOverdueQuantity: number,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): Score0to100 {
  const observedOnTimeScoreRaw = dueQuantity > 0 ? (100 * onTimeQuantity) / dueQuantity : 100;
  const continuingRatio = dueQuantity > 0 ? continuingOverdueQuantity / dueQuantity : 0;
  const { continuingOverduePenaltyPerRatio, continuingOverduePenaltyCap } = params.deliveryReliabilityUpdate;
  const continuingPenalty = Math.min(continuingOverduePenaltyCap, continuingOverduePenaltyPerRatio * continuingRatio);
  const observedOnTimeScore = score0to100(Math.min(100, Math.max(0, observedOnTimeScoreRaw - continuingPenalty)));
  return updateScoreAsymmetric(previous, observedOnTimeScore, params.deliveryReliabilityUpdate.alphaDown, params.deliveryReliabilityUpdate.alphaUp);
}

/**
 * 顧客信頼の更新。品質・納期信頼性の当期観測値から合成した
 * customerExperienceScoreを使う。対象市場に当期の観測がない場合は呼び出し側が
 * 更新をスキップする。
 */
export function updateCustomerTrustScore(
  previous: Score0to100,
  deliveredQualityScore: Score0to100,
  observedDeliveryScore: Score0to100,
  majorIncidentTrustPenalty: number,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): Score0to100 {
  const { qualityWeight, deliveryWeight } = params.customerTrustUpdate;
  const raw = qualityWeight * unwrapUnit(deliveredQualityScore) + deliveryWeight * unwrapUnit(observedDeliveryScore) - Math.max(0, majorIncidentTrustPenalty);
  const customerExperienceScore = score0to100(Math.min(100, Math.max(0, raw)));
  return updateScoreAsymmetric(previous, customerExperienceScore, params.customerTrustUpdate.alphaDown, params.customerTrustUpdate.alphaUp);
}
