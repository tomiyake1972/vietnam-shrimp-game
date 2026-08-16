// ShrimpX V2 — 品質管理設備（qualityControlEquipment）の効果計算（Phase QI-I1新設）
//
// 設計方針（docs/v2/quality_control_equipment_design_qi_d1.md、Candidate A）:
//   qualityControlEquipment
//     → 完成済みFactoryのbatch単位operationalRiskを有界な乗算で低減
//     → nonConformanceRatio（downgrade/rework/disposal）・
//       majorIncidentProbabilityの両方が自然に下がる
//     → 結果としてQuality Score（既存の生産量加重平均＋非対称EWMA）が改善
//     → Trust / sales competitiveness / VAP capabilityへ既存経路で波及
//
// 【変えるもの・変えないもの】PD省人化投資（pdMechanization.ts）と同じ規律:
//   - 変えるもの: 対象Factoryのbatchに対して計算されるoperationalRiskだけ
//     （乗算による低減。quality/operationalRisk.tsの計算式自体は変更しない）。
//   - 変えないもの: Quality Scoreへの直接加点（一切行わない）、
//     baselineOperationalQuality、EWMA alpha、downgrade/rework/discardShare、
//     major incidentの確率式・重大度換算係数 — quality/parameters.tsの
//     既存係数は一切変更しない。
//
// 【ランプ】completionRamp = computeLinearRampProgress(...)（capex/pdMechanization.ts
// から再利用。新しい類似ロジックを重複実装しない）。

import { computeLinearRampProgress } from "./pdMechanization";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "../quality/parameters";

/**
 * 稼働開始からの経過四半期数から、品質管理設備の効果乗数（0〜1）を求める。
 * multiplier = 1 − fullEffectRiskReductionRatio × rampProgress。
 *   設備なし（quartersSinceActivation<=0、またはそもそも対象Factoryに
 *   完成済み案件が無い）: multiplier = 1.0（呼び出し側でこの関数自体を
 *   呼ばない、または quartersSinceActivation<=0 を渡すことで1.0になる）。
 *   フルランプ到達後: multiplier = 1 − fullEffectRiskReductionRatio
 *   （fullEffectRiskReductionRatioが1.0未満である限り、リスクを完全には
 *   ゼロ化しない）。
 */
export function computeQualityEquipmentRiskMultiplier(
  quartersSinceActivation: number,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): number {
  const rampProgress = computeLinearRampProgress(quartersSinceActivation, params.qualityControlEquipment.rampQuarters);
  const reduction = params.qualityControlEquipment.fullEffectRiskReductionRatio * rampProgress;
  return Math.max(0, Math.min(1, 1 - reduction));
}
