// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール エントリポイント（Phase 7A）
//
// UI・Redis・API・生成AIから完全に独立した純粋関数群。会社ラボ
// （app/lib/v2/companyLab/runner.ts）が本モジュールをアダプターとして呼び出す。

export * from "./types";
export { QUALITY_PARAMETERS_V1 } from "./parameters";
export type { QualityParameters } from "./parameters";
export {
  calculateUtilizationStress,
  calculateOvertimeStress,
  calculateTemporaryWorkerStress,
  calculateComplexityStress,
  calculateRawMaterialAgeStress,
  calculateProductionRampStress,
  calculateOperationalRisk,
} from "./operationalRisk";
export type { OperationalRiskInput } from "./operationalRisk";
export { deriveQualityIncidentSeed, calculateMajorIncidentProbability, drawMajorIncident } from "./majorIncident";
export { calculateNonConformanceRatio, calculateMajorIncidentDiscardRatio, calculateObservedQualityScore, calculateQualityOutcome } from "./qualityOutcome";
export { updateScoreAsymmetric, updateQualityScore, updateDeliveryReliabilityScore, updateCustomerTrustScore } from "./scoreUpdates";
export { computeMarketDeliveryObservations } from "./deliveryObservation";
export { computeMarketTrustObservations } from "./trustObservation";
export { applyQualityToBatches, adjustmentsByBatchId } from "./batchAdjustment";
export type { QualityAdjustmentInput, QualityAdjustmentResult } from "./batchAdjustment";
export { attachQualityInfoToFinishedGoodsLots } from "./finishedGoodsQuality";
export { updateQualityByCompanyProduct, updateTrustByCompanyMarket, initializeQualityReliabilityState } from "./stateUpdate";
