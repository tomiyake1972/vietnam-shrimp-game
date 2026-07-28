// ShrimpX V2 — 標準AI（SAI-1）既定設定
//
// 5社すべてが同じインスタンスを参照する、単一の設定。会社ごとに異なる値を
// 持たせる仕組み自体を用意しない（アーキタイプ別設定は autoPolicy.ts 側の
// 概念であり、標準AIには存在しない）。

import { StandardAiConfig } from "./types";

/** 標準AI（SAI-1）の既定設定。 */
export const DEFAULT_STANDARD_AI_CONFIG_V1: StandardAiConfig = {
  productionTargetRatio: 0.75,
  finishedGoodsExcessQuarters: 0.5,
  finishedGoodsExcessMaxDamping: 0.6,

  sourcingMix: { domestic: 0.55, import: 0.2, aquaculture: 0.25 },
  rawInventoryTargetQuarters: 0.5,
  inventoryCorrectionDamping: 0.5,
  minDomesticPurchaseRatioOfMix: 0.2,
  rawMaterialShortageMaxBoostRatio: 0.5,
  expectedAquacultureHarvestRatio: 0.9,

  laborShortageUtilizationThreshold: 0.9,
  baseOvertimeRate: 0.05,
  maxOvertimeRate: 0.3,
  overtimeStepUp: 0.1,
  baseTemporaryWorkerRatio: 0.05,
  maxTemporaryWorkerRatio: 0.3,
  temporaryWorkerStepUp: 0.1,

  targetMinimumCashUsd: 40_000_000,
  voluntaryPrepaymentThresholdCashUsd: 100_000_000,
  desiredTermQuarters: 4,
  emergencyAcceptable: true,
  minProcurementThrottleRatio: 0.5,
};
