// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 品質結果（Phase 7A）
//
// 品質結果は「物理歩留まり」ではなく、操業上の品質不良として計算する
// （production/parameters.tsのphysicalYieldRatio・saleableRecoveryRatioの
// 意味を変更しない。本モジュールが算出するsaleableRecoveryRatioは、Phase6の
// 通常操業基準1.00に対する「当期の品質による追加的な廃棄」だけを表す）。
//   - 格落ち: 販売可能数量を減らさないが、観測品質を下げる
//   - 再加工: Phase 7Aでは販売可能数量を減らさず、再加工数量として記録する
//   - 廃棄: 真の数量損失として販売可能数量を減らす（saleableRecoveryRatio経由）
// 通常負荷（operationalRisk=0・重大事故なし）ではsaleableRecoveryRatio=1.00を維持する。

import { ratio, score0to100, Score0to100 } from "../core/units";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { MajorIncidentDraw, QualityOutcome } from "./types";

/** nonConformanceRatio = maximumNonConformanceRatio * operationalRisk ^ exponent。 */
export function calculateNonConformanceRatio(operationalRisk: number, params: QualityParameters = QUALITY_PARAMETERS_V1): number {
  const { maximumNonConformanceRatio, nonConformanceExponent } = params.qualityOutcome;
  const risk = Math.min(1, Math.max(0, operationalRisk));
  return maximumNonConformanceRatio * Math.pow(risk, nonConformanceExponent);
}

/** 重大事故の重大度から追加廃棄率を算出する（発生しなければ0）。 */
export function calculateMajorIncidentDiscardRatio(majorIncident: MajorIncidentDraw, params: QualityParameters = QUALITY_PARAMETERS_V1): number {
  if (!majorIncident.occurred) return 0;
  return Math.max(0, majorIncident.severity) * params.majorIncident.severityToAdditionalDiscardRatio;
}

/** 当期の観測品質スコアを算出する（baseline - リスク減点 - 重大事故減点、0〜100にclamp）。 */
export function calculateObservedQualityScore(
  baselineOperationalQuality: number,
  operationalRisk: number,
  majorIncident: MajorIncidentDraw,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): Score0to100 {
  const riskPenalty = params.qualityOutcome.qualityRiskPenaltyPerUnitRisk * Math.min(1, Math.max(0, operationalRisk));
  const incidentPenalty = majorIncident.occurred ? majorIncident.severity * params.majorIncident.severityToQualityPenalty : 0;
  const raw = baselineOperationalQuality - riskPenalty - incidentPenalty;
  return score0to100(Math.min(100, Math.max(0, raw)));
}

/**
 * 操業リスク・重大事故から、当期のバッチに適用する品質結果一式を算出する
 * 純粋関数。saleableRecoveryRatioは「廃棄」だけを反映し、格落ち・再加工は
 * Phase 7Aでは数量へ反映しない（QualityOutcome.downgradeRatio/reworkRatioに
 * 記録するのみ）。
 */
export function calculateQualityOutcome(
  operationalRisk: number,
  majorIncident: MajorIncidentDraw,
  baselineOperationalQuality: number,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): QualityOutcome {
  const nonConformanceRatio = calculateNonConformanceRatio(operationalRisk, params);
  const { downgradeShare, reworkShare, discardShare, minimumSaleableRecoveryRatio } = params.qualityOutcome;

  const downgradeRatio = nonConformanceRatio * downgradeShare;
  const reworkRatio = nonConformanceRatio * reworkShare;
  const baseDiscardRatio = nonConformanceRatio * discardShare;
  const majorIncidentDiscardRatio = calculateMajorIncidentDiscardRatio(majorIncident, params);
  const discardRatio = Math.max(0, baseDiscardRatio + majorIncidentDiscardRatio);

  const saleableRecoveryRatioRaw = 1 - discardRatio;
  const saleableRecoveryRatio = Math.min(1, Math.max(minimumSaleableRecoveryRatio, saleableRecoveryRatioRaw));

  const observedQualityScore = calculateObservedQualityScore(baselineOperationalQuality, operationalRisk, majorIncident, params);

  return {
    nonConformanceRatio,
    downgradeRatio,
    reworkRatio,
    discardRatio,
    saleableRecoveryRatio: ratio(Math.round(saleableRecoveryRatio * 10000) / 10000),
    observedQualityScore,
    majorIncident,
  };
}
