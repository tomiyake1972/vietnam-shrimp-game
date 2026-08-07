// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 操業リスク（Phase 7A）
//
// production/loadMetrics.ts（Phase6）が既に出力している工場負荷指標
// （設備稼働率・労働稼働率・残業率・臨時ワーカー比率・商品構成複雑度・
// 原料経過期間）と、当期の生産計画・前期実績（急増産ストレス）から、
// 会社×工場×商品ぶんの操業リスクを算出する純粋関数群。
//
// 本モジュールは一切のHOSO換算数量・契約・在庫を変更しない（リスク値の算出のみ）。
// 数量への反映はqualityOutcome.ts・batchAdjustment.tsの責務。

import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { OperationalRiskFactors } from "./types";

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 設備稼働ストレス。80%以下は追加ストレスなし。上限付近で非線形に悪化する。 */
export function calculateUtilizationStress(utilizationRatio: number, params: QualityParameters = QUALITY_PARAMETERS_V1): number {
  const { utilizationThreshold, utilizationBand, utilizationExponent } = params.operationalRisk;
  const base = clamp01((utilizationRatio - utilizationThreshold) / utilizationBand);
  return Math.pow(base, utilizationExponent);
}

/** 残業ストレス。既存の残業上限（overtimeRateCap）に対する実際の残業率の比率。 */
export function calculateOvertimeStress(actualOvertimeRatio: number, allowedOvertimeRatio: number): number {
  if (!(allowedOvertimeRatio > 0)) return 0;
  return clamp01(actualOvertimeRatio / allowedOvertimeRatio);
}

/** 臨時ワーカーストレス。臨時ワーカー比率をそのまま0〜1へclampする。 */
export function calculateTemporaryWorkerStress(temporaryWorkerRatio: number): number {
  return clamp01(temporaryWorkerRatio);
}

/** 商品構成複雑度ストレス。既存のproductMixComplexity（0〜1）をそのまま使う。 */
export function calculateComplexityStress(productMixComplexity: number): number {
  return clamp01(productMixComplexity);
}

/** 原料経過期間ストレス。データがない（重み0）場合は0とし、推測値を作らない。 */
export function calculateRawMaterialAgeStress(
  weightedAverageAgeQuarters: number,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): number {
  const usableShelfLife = params.operationalRisk.rawMaterialUsableShelfLifeQuarters;
  if (!(usableShelfLife > 0) || !(weightedAverageAgeQuarters > 0)) return 0;
  return clamp01(weightedAverageAgeQuarters / usableShelfLife);
}

/**
 * 急増産ストレス。初回ターンまたは比較可能な前期実績がない場合は0とする。
 * 分母は max(previousActualProduction, 0.25 * productCapacity) で、前期実績が
 * 極端に小さい（0近辺）場合に急増産ストレスが発散しないようにする。
 */
export function calculateProductionRampStress(
  currentPlannedOrAllocatedProduction: number,
  previousActualProduction: number | undefined,
  productCapacity: number
): number {
  if (previousActualProduction === undefined || previousActualProduction <= 0) return 0;
  const denom = Math.max(previousActualProduction, 0.25 * Math.max(0, productCapacity));
  if (!(denom > 0)) return 0;
  return clamp01((currentPlannedOrAllocatedProduction - previousActualProduction) / denom);
}

export interface OperationalRiskInput {
  /** 設備稼働率（0〜1）。 */
  readonly equipmentUtilizationRate: number;
  /** 労働稼働率（0〜1）。設備・労働の両稼働率がある場合は大きい方を使う。 */
  readonly laborUtilizationRate: number;
  /** 適用後残業率（既に上限でクリップ済みの値、production/labor.tsのappliedOvertimeRate等）。 */
  readonly overtimeRate: number;
  /** 残業率の上限（production/parameters.tsのlabor.overtimeRateCap）。 */
  readonly overtimeRateCap: number;
  /** 臨時ワーカー比率（0〜1）。 */
  readonly temporaryWorkerShare: number;
  /** 商品構成複雑度（0〜1）。 */
  readonly productMixComplexity: number;
  /** 消費原料ロットの平均経過期間（四半期数）。 */
  readonly averageRawMaterialAgeQuarters: number;
  /** 当期の計画または配分済み生産量（完成品HOSO換算量）。 */
  readonly currentPlannedOrAllocatedProduction: number;
  /** 前四半期の実績生産量。初回ターン等で比較対象がなければundefined。 */
  readonly previousActualProduction: number | undefined;
  /** 当該商品の有効設備能力（急増産ストレスの分母フォールバックに使う）。 */
  readonly productCapacity: number;
}

/** 6要因を合成し、総合操業リスク（0〜1）を算出する。 */
export function calculateOperationalRisk(input: OperationalRiskInput, params: QualityParameters = QUALITY_PARAMETERS_V1): OperationalRiskFactors {
  const utilizationRatio = Math.max(input.equipmentUtilizationRate, input.laborUtilizationRate);
  const utilizationStress = calculateUtilizationStress(utilizationRatio, params);
  const overtimeStress = calculateOvertimeStress(input.overtimeRate, input.overtimeRateCap);
  const temporaryWorkerStress = calculateTemporaryWorkerStress(input.temporaryWorkerShare);
  const complexityStress = calculateComplexityStress(input.productMixComplexity);
  const rawMaterialAgeStress = calculateRawMaterialAgeStress(input.averageRawMaterialAgeQuarters, params);
  const productionRampStress = calculateProductionRampStress(
    input.currentPlannedOrAllocatedProduction,
    input.previousActualProduction,
    input.productCapacity
  );

  const w = params.operationalRisk.weights;
  const operationalRisk = clamp01(
    w.utilization * utilizationStress +
      w.overtime * overtimeStress +
      w.temporaryWorker * temporaryWorkerStress +
      w.complexity * complexityStress +
      w.rawMaterialAge * rawMaterialAgeStress +
      w.productionRamp * productionRampStress
  );

  return {
    utilizationStress,
    overtimeStress,
    temporaryWorkerStress,
    complexityStress,
    rawMaterialAgeStress,
    productionRampStress,
    operationalRisk,
  };
}
