// ShrimpX V2 — Export DTO / §5 品質・生産・原料の明細
//
// 【データ源（すべて既存の確定履歴に保存済み。エンジン・永続化形式は変更しない）】
//   1. 商品別品質スコア         → record.qualityStateAfter.qualityByCompanyProduct
//   2. 商品別オペレーショナルリスク → record.qualityAdjustments[].risk
//   3. 市場別顧客信頼           → record.qualityStateAfter.trustByCompanyMarket[].customerTrustScore
//   4. 市場別納期信頼性         → record.qualityStateAfter.trustByCompanyMarket[].deliveryReliabilityScore
//                                 ＋ record.deliveryObservations（当期の納期観測実績）
//   5. 工場別ランプアップ警告   → record.qualityStateAfter.rampHistory
//                                 ＋ qualityAdjustments[].risk.productionRampStress
//   6. 生産バッチ明細           → record.batches
//   7. 工場別・商品別の生産配分 → record.productionAllocation.entries
//                                 ＋ productionAllocation.factoryWorkerSummaries
//   8. 工場別稼働実績           → record.factoryLoadMetrics（会社別は companyLoadMetrics）
//   9. 原料要求量               → record.rawMaterialRequirements
//  10. 国内買付希望量と配分結果 → record.decisions[].domesticPurchasePlan（希望）
//                                 ＋ record.domesticAllocation（配分結果）
//  11. 原料ロットの期首・期末状態 → pre/postProcessingStateSnapshot.rawMaterialLots
//  12. 完成品ロットの期首・生産・消費・期末状態
//        期首 → preProcessingStateSnapshot.productionState.finishedGoodsLots
//        生産 → record.newFinishedGoodsLots
//        消費 → record.fulfillmentPlan.usage（contractDto.ts の
//               buildExportContractFulfillmentUsage* を再利用）
//        期末 → postProcessingStateSnapshot.productionState.finishedGoodsLots
//
// 【許可フィールドの明示的組み立て】内部型をそのままspreadせず、フィールドを
// 1つずつ列挙する（三宅さんの指示 §4・§5）。オプショナルはすべて `?? null` で
// 明示的にnullへ落とし、readonly配列はスプレッドで複製する。
//
// 【再計算しない】期首＋生産−消費＝期末の検算、稼働率の再導出、増減差額などは
// すべてExcel側の数式で組み立てる。保存済み確定値をここで再計算して置き換えない。
//
// 【スコープ隔離】会社スコープのビルダーは companyId で絞り込む。ここで扱う型は
// すべて companyId を持つため、絞り込みは型レベルで確実に行える。
// domesticAllocation は市場レベルの公開情報（marketPrice・availableSupply・
// unallocatedSupply）と会社別内訳（companies[]）に分かれており、会社スコープでは
// companies[] のみを絞り込む（§3のallocationsと同じ扱い）。
//
// 【決定性】§10「同じ確定履歴から再生成して結果が一致する」を満たすため、
// すべての配列は明示的な比較関数でソートする。

import { CompanyId } from "../../../../../lib/v2/sales/types";
import { CompanyLabQuarterHistoryEntry } from "../../../../../lib/v2/companyLab/persistence/types";
import {
  FactoryLoadMetrics,
  CompanyLoadMetrics,
  FinishedGoodsLot,
  ProductionAllocationEntry,
  ProductionBatch,
  ProductionBatchRawMaterialConsumption,
  FactoryWorkerAllocationSummary,
} from "../../../../../lib/v2/production/types";
import {
  CompanyDomesticPurchaseAllocationEntry,
  DomesticPurchaseAllocationResult,
  DomesticPurchasePlanEntry,
  RawMaterialLot,
  RawMaterialRequirementEntry,
} from "../../../../../lib/v2/rawMaterials/types";
import {
  BatchQualityAdjustment,
  CompanyFactoryProductRampState,
  CompanyMarketTrustState,
  CompanyProductQualityState,
  MajorIncidentDraw,
  MarketDeliveryObservation,
  OperationalRiskFactors,
  QualityOutcome,
} from "../../../../../lib/v2/quality/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";

// ---------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------

function byCompanyThen<T extends { readonly companyId: CompanyId }>(
  rest: (a: T, b: T) => number,
): (a: T, b: T) => number {
  return (a, b) => (a.companyId !== b.companyId ? a.companyId.localeCompare(b.companyId) : rest(a, b));
}

// ---------------------------------------------------------------------
// §5-1 商品別品質スコア / §5-3・§5-4 市場別顧客信頼・納期信頼性 / §5-5 増産履歴
// ---------------------------------------------------------------------

/** 会社×商品の期末品質スコア（CompanyProductQualityState の許可項目）。 */
export interface ExportCompanyProductQuality {
  readonly companyId: CompanyId;
  readonly product: string;
  /** 期末の蓄積品質スコア（0〜100）。 */
  readonly qualityScore: number;
}

function buildExportCompanyProductQuality(state: CompanyProductQualityState): ExportCompanyProductQuality {
  return {
    companyId: state.companyId,
    product: state.product,
    qualityScore: state.qualityScore,
  };
}

/** 会社×市場の期末顧客信頼・納期信頼性（CompanyMarketTrustState の許可項目）。 */
export interface ExportCompanyMarketTrust {
  readonly companyId: CompanyId;
  readonly market: string;
  /** 期末の顧客信頼スコア（0〜100）。 */
  readonly customerTrustScore: number;
  /** 期末の納期信頼性スコア（0〜100）。 */
  readonly deliveryReliabilityScore: number;
}

function buildExportCompanyMarketTrust(state: CompanyMarketTrustState): ExportCompanyMarketTrust {
  return {
    companyId: state.companyId,
    market: state.market,
    customerTrustScore: state.customerTrustScore,
    deliveryReliabilityScore: state.deliveryReliabilityScore,
  };
}

/** 会社×工場×商品の増産履歴（CompanyFactoryProductRampState の許可項目）。 */
export interface ExportFactoryProductRamp {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  /** 前四半期の実生産量（HOSO換算トン、品質調整前）。 */
  readonly lastQuarterProductionQuantity: number;
}

function buildExportFactoryProductRamp(state: CompanyFactoryProductRampState): ExportFactoryProductRamp {
  return {
    companyId: state.companyId,
    factoryId: state.factoryId,
    product: state.product,
    lastQuarterProductionQuantity: state.lastQuarterProductionQuantity,
  };
}

/** 品質・信頼・増産履歴の期末状態一式（QualityReliabilityState の許可項目）。 */
export interface ExportQualityState {
  readonly qualityByCompanyProduct: readonly ExportCompanyProductQuality[];
  readonly trustByCompanyMarket: readonly ExportCompanyMarketTrust[];
  readonly rampHistory: readonly ExportFactoryProductRamp[];
}

export function buildExportQualityState(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportQualityState {
  const state = entry.record.qualityStateAfter;
  const inScope = <T extends { readonly companyId: CompanyId }>(rows: readonly T[]): readonly T[] =>
    scopedCompanyId === undefined ? rows : rows.filter((r) => r.companyId === scopedCompanyId);
  return {
    qualityByCompanyProduct: inScope(state.qualityByCompanyProduct)
      .map(buildExportCompanyProductQuality)
      .sort(byCompanyThen((a, b) => a.product.localeCompare(b.product))),
    trustByCompanyMarket: inScope(state.trustByCompanyMarket)
      .map(buildExportCompanyMarketTrust)
      .sort(byCompanyThen((a, b) => a.market.localeCompare(b.market))),
    rampHistory: inScope(state.rampHistory)
      .map(buildExportFactoryProductRamp)
      .sort(
        byCompanyThen((a, b) =>
          a.factoryId !== b.factoryId ? a.factoryId.localeCompare(b.factoryId) : a.product.localeCompare(b.product),
        ),
      ),
  };
}

// ---------------------------------------------------------------------
// §5-2 商品別オペレーショナルリスク（バッチ品質調整結果）
// ---------------------------------------------------------------------

/** 操業ストレス要因一式（OperationalRiskFactors の許可項目）。 */
export interface ExportOperationalRisk {
  readonly utilizationStress: number;
  readonly overtimeStress: number;
  readonly temporaryWorkerStress: number;
  readonly complexityStress: number;
  readonly rawMaterialAgeStress: number;
  readonly productionRampStress: number;
  /** 上記6要因の加重合計（0〜1）。 */
  readonly operationalRisk: number;
}

function buildExportOperationalRisk(risk: OperationalRiskFactors): ExportOperationalRisk {
  return {
    utilizationStress: risk.utilizationStress,
    overtimeStress: risk.overtimeStress,
    temporaryWorkerStress: risk.temporaryWorkerStress,
    complexityStress: risk.complexityStress,
    rawMaterialAgeStress: risk.rawMaterialAgeStress,
    productionRampStress: risk.productionRampStress,
    operationalRisk: risk.operationalRisk,
  };
}

/** 重大品質事故判定（MajorIncidentDraw の許可項目。seedは監査値であり秘密情報ではない）。 */
export interface ExportMajorIncident {
  readonly occurred: boolean;
  readonly severity: number;
  readonly probability: number;
  readonly seed: string;
}

function buildExportMajorIncident(draw: MajorIncidentDraw): ExportMajorIncident {
  return {
    occurred: draw.occurred,
    severity: draw.severity,
    probability: draw.probability,
    seed: draw.seed,
  };
}

/** 当期の品質結果（QualityOutcome の許可項目）。 */
export interface ExportQualityOutcome {
  readonly nonConformanceRatio: number;
  readonly downgradeRatio: number;
  readonly reworkRatio: number;
  readonly discardRatio: number;
  readonly saleableRecoveryRatio: number;
  readonly observedQualityScore: number;
  readonly majorIncident: ExportMajorIncident;
}

function buildExportQualityOutcome(outcome: QualityOutcome): ExportQualityOutcome {
  return {
    nonConformanceRatio: outcome.nonConformanceRatio,
    downgradeRatio: outcome.downgradeRatio,
    reworkRatio: outcome.reworkRatio,
    discardRatio: outcome.discardRatio,
    saleableRecoveryRatio: outcome.saleableRecoveryRatio,
    observedQualityScore: outcome.observedQualityScore,
    majorIncident: buildExportMajorIncident(outcome.majorIncident),
  };
}

/** 1バッチぶんの品質調整結果（BatchQualityAdjustment の許可項目）。 */
export interface ExportBatchQualityAdjustment {
  readonly batchId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  readonly period: PeriodV2;
  readonly risk: ExportOperationalRisk;
  readonly outcome: ExportQualityOutcome;
  /** 品質調整前の完成品HOSO換算量。 */
  readonly originalFinishedGoodsQuantity: number;
  /** 廃棄分だけを差し引いた後の完成品HOSO換算量。 */
  readonly adjustedFinishedGoodsQuantity: number;
  /** 格落ち量（記録用。数量は減らさない）。 */
  readonly downgradeQuantity: number;
  /** 再加工量（記録用。数量は減らさない）。 */
  readonly reworkQuantity: number;
  /** 廃棄量（真の数量損失）。 */
  readonly discardQuantity: number;
}

function buildExportBatchQualityAdjustment(adjustment: BatchQualityAdjustment): ExportBatchQualityAdjustment {
  return {
    batchId: adjustment.batchId,
    companyId: adjustment.companyId,
    factoryId: adjustment.factoryId,
    product: adjustment.product,
    period: adjustment.period,
    risk: buildExportOperationalRisk(adjustment.risk),
    outcome: buildExportQualityOutcome(adjustment.outcome),
    originalFinishedGoodsQuantity: adjustment.originalFinishedGoodsQuantity,
    adjustedFinishedGoodsQuantity: adjustment.adjustedFinishedGoodsQuantity,
    downgradeQuantity: adjustment.downgradeQuantity,
    reworkQuantity: adjustment.reworkQuantity,
    discardQuantity: adjustment.discardQuantity,
  };
}

export function buildExportQualityAdjustments(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportBatchQualityAdjustment[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.qualityAdjustments
      : entry.record.qualityAdjustments.filter((a) => a.companyId === scopedCompanyId);
  return rows.map(buildExportBatchQualityAdjustment).sort(byCompanyThen((a, b) => a.batchId.localeCompare(b.batchId)));
}

// ---------------------------------------------------------------------
// §5-4 市場別納期観測
// ---------------------------------------------------------------------

/** 会社×市場の当期納期観測（MarketDeliveryObservation の許可項目）。 */
export interface ExportDeliveryObservation {
  readonly companyId: CompanyId;
  readonly market: string;
  /** 当期が納期の契約の合計数量（HOSO換算トン）。 */
  readonly dueQuantity: number;
  /** そのうち当期中に履行された数量（HOSO換算トン）。 */
  readonly onTimeQuantity: number;
  /** そのうち当期末時点で納期超過になった数量（HOSO換算トン）。 */
  readonly newlyOverdueQuantity: number;
  /** 過年度から持ち越された、なお納期超過のままの数量（HOSO換算トン）。 */
  readonly continuingOverdueQuantity: number;
}

function buildExportDeliveryObservation(observation: MarketDeliveryObservation): ExportDeliveryObservation {
  return {
    companyId: observation.companyId,
    market: observation.market,
    dueQuantity: observation.dueQuantity,
    onTimeQuantity: observation.onTimeQuantity,
    newlyOverdueQuantity: observation.newlyOverdueQuantity,
    continuingOverdueQuantity: observation.continuingOverdueQuantity,
  };
}

export function buildExportDeliveryObservations(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportDeliveryObservation[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.deliveryObservations
      : entry.record.deliveryObservations.filter((o) => o.companyId === scopedCompanyId);
  return rows.map(buildExportDeliveryObservation).sort(byCompanyThen((a, b) => a.market.localeCompare(b.market)));
}

// ---------------------------------------------------------------------
// §5-6 生産バッチ明細
// ---------------------------------------------------------------------

/** 原料消費内訳1件（ProductionBatchRawMaterialConsumption の許可項目）。 */
export interface ExportRawMaterialConsumption {
  readonly lotId: string;
  /** 消費量（HOSO換算トン）。 */
  readonly quantity: number;
  /** 単位取得原価（USD/HOSO換算kg）。 */
  readonly unitCost: number;
  readonly originCountry: string;
}

function buildExportRawMaterialConsumption(
  consumption: ProductionBatchRawMaterialConsumption,
): ExportRawMaterialConsumption {
  return {
    lotId: consumption.lotId,
    quantity: consumption.quantity,
    unitCost: consumption.unitCost,
    originCountry: consumption.originCountry,
  };
}

/** 1生産バッチ（ProductionBatch の許可項目）。 */
export interface ExportProductionBatch {
  readonly batchId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  readonly period: PeriodV2;
  readonly rawMaterialConsumed: readonly ExportRawMaterialConsumption[];
  /** 原料消費量合計（HOSO換算トン）。 */
  readonly rawMaterialConsumedTotal: number;
  /** 完成品数量（HOSO換算トン、品質調整前）。 */
  readonly finishedGoodsQuantity: number;
  /** 加工損失（HOSO換算トン）。 */
  readonly processingLoss: number;
  /** 原料取得原価（USD、記録用・非会計計上）。 */
  readonly rawMaterialCost: number;
  /** 基準加工費（USD、記録用・非会計計上）。 */
  readonly baseProcessingCost: number;
  /** 生産達成率（finishedGoodsQuantity / desiredQuantity）。 */
  readonly capacityUtilizationIndex: number;
  /** 生産できなかった量（HOSO換算トン）。 */
  readonly shortfallQuantity: number;
  readonly shortfallReasons: readonly string[];
}

function buildExportProductionBatch(batch: ProductionBatch): ExportProductionBatch {
  return {
    batchId: batch.batchId,
    companyId: batch.companyId,
    factoryId: batch.factoryId,
    product: batch.product,
    period: batch.period,
    rawMaterialConsumed: batch.rawMaterialConsumed
      .map(buildExportRawMaterialConsumption)
      .sort((a, b) => a.lotId.localeCompare(b.lotId)),
    rawMaterialConsumedTotal: batch.rawMaterialConsumedTotal,
    finishedGoodsQuantity: batch.finishedGoodsQuantity,
    processingLoss: batch.processingLoss,
    rawMaterialCost: batch.rawMaterialCost,
    baseProcessingCost: batch.baseProcessingCost,
    capacityUtilizationIndex: batch.capacityUtilizationIndex,
    shortfallQuantity: batch.shortfallQuantity,
    shortfallReasons: [...batch.shortfallReasons],
  };
}

export function buildExportProductionBatches(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportProductionBatch[] {
  const rows =
    scopedCompanyId === undefined ? entry.record.batches : entry.record.batches.filter((b) => b.companyId === scopedCompanyId);
  return rows.map(buildExportProductionBatch).sort(byCompanyThen((a, b) => a.batchId.localeCompare(b.batchId)));
}

// ---------------------------------------------------------------------
// §5-7 工場別・商品別の生産配分
// ---------------------------------------------------------------------

/** 1件の生産配分（ProductionAllocationEntry の許可項目。stages・laborは平坦化する）。 */
export interface ExportProductionAllocationEntry {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  readonly priority: number;
  /** 生産希望量（HOSO換算トン）。 */
  readonly desiredQuantity: number;
  /** 生産可能と判定された完成品数量（各制約の最小値、HOSO換算トン）。 */
  readonly allocatedQuantity: number;
  /** 生産できなかった量（HOSO換算トン）。 */
  readonly shortfallQuantity: number;
  readonly shortfallReasons: readonly string[];
  /** この配分が要求する原料消費量（HOSO換算トン）。 */
  readonly requiredRawMaterialQuantity: number;
  /** 制約段階：原料制約後の上限（HOSO換算トン）。 */
  readonly stageRawMaterialLimited: number;
  /** 制約段階：工場共通処理能力制約後の上限（HOSO換算トン）。 */
  readonly stageCommonCapacityLimited: number;
  /** 制約段階：凍結・包装能力制約後の上限（HOSO換算トン）。 */
  readonly stageFreezingPackagingLimited: number;
  /** 制約段階：商品別能力制約後の上限（HOSO換算トン）。 */
  readonly stageProductCapacityLimited: number;
  /** 制約段階：労働能力制約後の上限（HOSO換算トン）。 */
  readonly stageLaborLimited: number;
  readonly assignedRegularHeadcount: number;
  readonly assignedTemporaryHeadcount: number;
  readonly appliedOvertimeRate: number;
}

function buildExportProductionAllocationEntry(entry: ProductionAllocationEntry): ExportProductionAllocationEntry {
  return {
    companyId: entry.companyId,
    factoryId: entry.factoryId,
    product: entry.product,
    priority: entry.priority,
    desiredQuantity: entry.desiredQuantity,
    allocatedQuantity: entry.allocatedQuantity,
    shortfallQuantity: entry.shortfallQuantity,
    shortfallReasons: [...entry.shortfallReasons],
    requiredRawMaterialQuantity: entry.requiredRawMaterialQuantity,
    stageRawMaterialLimited: entry.stages.rawMaterialLimited,
    stageCommonCapacityLimited: entry.stages.commonCapacityLimited,
    stageFreezingPackagingLimited: entry.stages.freezingPackagingLimited,
    stageProductCapacityLimited: entry.stages.productCapacityLimited,
    stageLaborLimited: entry.stages.laborLimited,
    assignedRegularHeadcount: entry.labor.assignedRegularHeadcount,
    assignedTemporaryHeadcount: entry.labor.assignedTemporaryHeadcount,
    appliedOvertimeRate: entry.labor.appliedOvertimeRate,
  };
}

/** 工場ごとの未配置ワーカー人数（FactoryWorkerAllocationSummary の許可項目）。 */
export interface ExportFactoryWorkerSummary {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly unassignedRegularHeadcount: number;
  readonly unassignedTemporaryHeadcount: number;
}

function buildExportFactoryWorkerSummary(summary: FactoryWorkerAllocationSummary): ExportFactoryWorkerSummary {
  return {
    factoryId: summary.factoryId,
    companyId: summary.companyId,
    unassignedRegularHeadcount: summary.unassignedRegularHeadcount,
    unassignedTemporaryHeadcount: summary.unassignedTemporaryHeadcount,
  };
}

/** 当期の生産配分結果（ProductionAllocationResult の許可項目）。 */
export interface ExportProductionAllocation {
  readonly period: PeriodV2;
  readonly entries: readonly ExportProductionAllocationEntry[];
  readonly factoryWorkerSummaries: readonly ExportFactoryWorkerSummary[];
}

export function buildExportProductionAllocation(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportProductionAllocation {
  const allocation = entry.record.productionAllocation;
  const entries =
    scopedCompanyId === undefined ? allocation.entries : allocation.entries.filter((e) => e.companyId === scopedCompanyId);
  const summaries =
    scopedCompanyId === undefined
      ? allocation.factoryWorkerSummaries
      : allocation.factoryWorkerSummaries.filter((s) => s.companyId === scopedCompanyId);
  return {
    period: allocation.period,
    entries: entries.map(buildExportProductionAllocationEntry).sort(
      byCompanyThen((a, b) =>
        a.factoryId !== b.factoryId ? a.factoryId.localeCompare(b.factoryId) : a.product.localeCompare(b.product),
      ),
    ),
    factoryWorkerSummaries: summaries
      .map(buildExportFactoryWorkerSummary)
      .sort(byCompanyThen((a, b) => a.factoryId.localeCompare(b.factoryId))),
  };
}

// ---------------------------------------------------------------------
// §5-8 工場別・会社別稼働実績
// ---------------------------------------------------------------------

/** 工場別稼働実績（FactoryLoadMetrics の許可項目）。 */
export interface ExportFactoryLoadMetrics {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly overtimeRate: number;
  readonly temporaryWorkerShare: number;
  readonly productMixComplexity: number;
  readonly averageRawMaterialAgeQuarters: number;
  readonly productionShortfallRate: number;
  readonly processingLossRate: number;
}

function buildExportFactoryLoadMetrics(metrics: FactoryLoadMetrics): ExportFactoryLoadMetrics {
  return {
    factoryId: metrics.factoryId,
    companyId: metrics.companyId,
    period: metrics.period,
    equipmentUtilizationRate: metrics.equipmentUtilizationRate,
    laborUtilizationRate: metrics.laborUtilizationRate,
    overtimeRate: metrics.overtimeRate,
    temporaryWorkerShare: metrics.temporaryWorkerShare,
    productMixComplexity: metrics.productMixComplexity,
    averageRawMaterialAgeQuarters: metrics.averageRawMaterialAgeQuarters,
    productionShortfallRate: metrics.productionShortfallRate,
    processingLossRate: metrics.processingLossRate,
  };
}

/** 会社別稼働実績（CompanyLoadMetrics の許可項目）。 */
export interface ExportCompanyLoadMetrics {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly equipmentUtilizationRate: number;
  readonly laborUtilizationRate: number;
  readonly overtimeRate: number;
  readonly temporaryWorkerShare: number;
  readonly productMixComplexity: number;
  readonly averageRawMaterialAgeQuarters: number;
  readonly productionShortfallRate: number;
  readonly processingLossRate: number;
}

function buildExportCompanyLoadMetrics(metrics: CompanyLoadMetrics): ExportCompanyLoadMetrics {
  return {
    companyId: metrics.companyId,
    period: metrics.period,
    equipmentUtilizationRate: metrics.equipmentUtilizationRate,
    laborUtilizationRate: metrics.laborUtilizationRate,
    overtimeRate: metrics.overtimeRate,
    temporaryWorkerShare: metrics.temporaryWorkerShare,
    productMixComplexity: metrics.productMixComplexity,
    averageRawMaterialAgeQuarters: metrics.averageRawMaterialAgeQuarters,
    productionShortfallRate: metrics.productionShortfallRate,
    processingLossRate: metrics.processingLossRate,
  };
}

export function buildExportFactoryLoadMetricsList(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportFactoryLoadMetrics[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.factoryLoadMetrics
      : entry.record.factoryLoadMetrics.filter((m) => m.companyId === scopedCompanyId);
  return rows.map(buildExportFactoryLoadMetrics).sort(byCompanyThen((a, b) => a.factoryId.localeCompare(b.factoryId)));
}

export function buildExportCompanyLoadMetricsList(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportCompanyLoadMetrics[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.companyLoadMetrics
      : entry.record.companyLoadMetrics.filter((m) => m.companyId === scopedCompanyId);
  return rows.map(buildExportCompanyLoadMetrics).sort((a, b) => a.companyId.localeCompare(b.companyId));
}

// ---------------------------------------------------------------------
// §5-9 原料要求量
// ---------------------------------------------------------------------

/** 契約から逆算した原料要求量（RawMaterialRequirementEntry の許可項目）。 */
export interface ExportRawMaterialRequirement {
  readonly companyId: CompanyId;
  readonly dueDate: PeriodV2;
  readonly product: string;
  /** 対象契約（open/partiallyFulfilled）の未履行数量合計（HOSO換算トン）。 */
  readonly requiredQuantity: number;
}

function buildExportRawMaterialRequirement(entry: RawMaterialRequirementEntry): ExportRawMaterialRequirement {
  return {
    companyId: entry.companyId,
    dueDate: entry.dueDate,
    product: entry.product,
    requiredQuantity: entry.requiredQuantity,
  };
}

export function buildExportRawMaterialRequirements(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportRawMaterialRequirement[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.rawMaterialRequirements
      : entry.record.rawMaterialRequirements.filter((r) => r.companyId === scopedCompanyId);
  return rows.map(buildExportRawMaterialRequirement).sort(
    byCompanyThen((a, b) => (a.dueDate !== b.dueDate ? a.dueDate.localeCompare(b.dueDate) : a.product.localeCompare(b.product))),
  );
}

// ---------------------------------------------------------------------
// §5-10 国内買付希望量と配分結果
// ---------------------------------------------------------------------

/** 国内原料買付の希望（DomesticPurchasePlanEntry の許可項目）。 */
export interface ExportDomesticPurchasePlan {
  readonly companyId: CompanyId;
  /** 国内買付希望量（HOSO換算トン）。 */
  readonly desiredQuantity: number;
  /** 国内原料価格に対する提示価格の調整額（USD/HOSO換算kg）。 */
  readonly priceAdjustmentUsdPerHosoEqKg: number;
  readonly procurementHeadcount: number;
  readonly factoryCommonProcessingCapacityTons: number | null;
  readonly farmerRelationship: number | null;
  readonly paymentReliability: number | null;
  readonly approvedPurchaseCap: number | null;
}

export function buildExportDomesticPurchasePlan(plan: DomesticPurchasePlanEntry): ExportDomesticPurchasePlan {
  return {
    companyId: plan.companyId,
    desiredQuantity: plan.desiredQuantity,
    priceAdjustmentUsdPerHosoEqKg: plan.priceAdjustmentUsdPerHosoEqKg,
    procurementHeadcount: plan.procurementHeadcount,
    factoryCommonProcessingCapacityTons: plan.factoryCommonProcessingCapacityTons ?? null,
    farmerRelationship: plan.farmerRelationship ?? null,
    paymentReliability: plan.paymentReliability ?? null,
    approvedPurchaseCap: plan.approvedPurchaseCap ?? null,
  };
}

/** 1社ぶんの国内買付配分結果（CompanyDomesticPurchaseAllocationEntry の許可項目）。 */
export interface ExportDomesticPurchaseAllocationEntry {
  readonly companyId: CompanyId;
  /** 提示買付価格（USD/HOSO換算kg）。 */
  readonly bidPrice: number;
  /** 調達人員から導出した調達カバレッジ（0〜1）。 */
  readonly coverageScore: number;
  readonly competitivenessWeight: number;
  /** 実際に配分された買付量（HOSO換算トン）。 */
  readonly allocatedQuantity: number;
}

function buildExportDomesticPurchaseAllocationEntry(
  entry: CompanyDomesticPurchaseAllocationEntry,
): ExportDomesticPurchaseAllocationEntry {
  return {
    companyId: entry.companyId,
    bidPrice: entry.bidPrice,
    coverageScore: entry.coverageScore,
    competitivenessWeight: entry.competitivenessWeight,
    allocatedQuantity: entry.allocatedQuantity,
  };
}

/**
 * 当期の国内原料市場の配分結果（DomesticPurchaseAllocationResult の許可項目）。
 * marketPrice・availableSupply・unallocatedSupply は公開情報。companies[] は
 * 会社スコープでは対象会社のみへ絞り込む（他社の提示価格を混入させない）。
 */
export interface ExportDomesticPurchaseAllocation {
  readonly period: PeriodV2;
  /** 国内原料市場価格（USD/HOSO換算kg、公開情報）。 */
  readonly marketPrice: number;
  /** 今期配分できる供給総量（HOSO換算トン、公開情報）。 */
  readonly availableSupply: number;
  readonly companies: readonly ExportDomesticPurchaseAllocationEntry[];
  /** どの会社にも配分されなかった残余供給（HOSO換算トン、公開情報）。 */
  readonly unallocatedSupply: number;
}

function buildExportDomesticPurchaseAllocationResult(
  allocation: DomesticPurchaseAllocationResult,
  scopedCompanyId?: CompanyId,
): ExportDomesticPurchaseAllocation {
  const companies =
    scopedCompanyId === undefined ? allocation.companies : allocation.companies.filter((c) => c.companyId === scopedCompanyId);
  return {
    period: allocation.period,
    marketPrice: allocation.marketPrice,
    availableSupply: allocation.availableSupply,
    companies: companies
      .map(buildExportDomesticPurchaseAllocationEntry)
      .sort((a, b) => a.companyId.localeCompare(b.companyId)),
    unallocatedSupply: allocation.unallocatedSupply,
  };
}

export function buildExportDomesticPurchaseAllocation(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportDomesticPurchaseAllocation {
  return buildExportDomesticPurchaseAllocationResult(entry.record.domesticAllocation, scopedCompanyId);
}

/** 指定会社の国内買付希望（会社スコープAPI用）。存在しなければnull。 */
export function buildExportDomesticPurchasePlanForCompany(
  entry: CompanyLabQuarterHistoryEntry,
  companyId: CompanyId,
): ExportDomesticPurchasePlan | null {
  const decision = entry.record.decisions.find((d) => d.companyId === companyId);
  if (!decision) return null;
  return buildExportDomesticPurchasePlan(decision.domesticPurchasePlan);
}

/** 全社の国内買付希望（GMフルスコープのみ）。 */
export function buildExportDomesticPurchasePlansAllCompanies(
  entry: CompanyLabQuarterHistoryEntry,
): readonly ExportDomesticPurchasePlan[] {
  return entry.record.decisions
    .map((d) => buildExportDomesticPurchasePlan(d.domesticPurchasePlan))
    .sort((a, b) => a.companyId.localeCompare(b.companyId));
}

// ---------------------------------------------------------------------
// §5-11 原料ロットの期首・期末状態
// ---------------------------------------------------------------------

/** 原料ロット1件（RawMaterialLot の許可項目）。 */
export interface ExportRawMaterialLot {
  readonly lotId: string;
  readonly companyId: CompanyId;
  /** 調達源（domesticPurchase / import / aquaculture 等）。 */
  readonly source: string;
  readonly originCountry: string;
  readonly inboundPeriod: PeriodV2;
  /** 当初数量（HOSO換算トン）。 */
  readonly originalQuantity: number;
  /** 残数量（HOSO換算トン）。 */
  readonly remainingQuantity: number;
  /** 単位取得原価（USD/HOSO換算kg）。 */
  readonly unitCost: number;
  readonly availableFromPeriod: PeriodV2;
  readonly expiryPeriod: PeriodV2 | null;
  readonly status: string;
  /** 養殖中ロットの池入れ計画由来情報（他sourceではnull）。 */
  readonly pendingAquacultureIntensity: number | null;
  readonly pendingBioSecurityLevel: number | null;
  readonly pendingPlannedStockingQuantity: number | null;
}

function buildExportRawMaterialLot(lot: RawMaterialLot): ExportRawMaterialLot {
  return {
    lotId: lot.lotId,
    companyId: lot.companyId,
    source: lot.source,
    originCountry: lot.originCountry,
    inboundPeriod: lot.inboundPeriod,
    originalQuantity: lot.originalQuantity,
    remainingQuantity: lot.remainingQuantity,
    unitCost: lot.unitCost,
    availableFromPeriod: lot.availableFromPeriod,
    expiryPeriod: lot.expiryPeriod ?? null,
    status: lot.status,
    pendingAquacultureIntensity: lot.pendingAquacultureIntensity ?? null,
    pendingBioSecurityLevel: lot.pendingBioSecurityLevel ?? null,
    pendingPlannedStockingQuantity: lot.pendingPlannedStockingQuantity ?? null,
  };
}

function sortRawMaterialLots(lots: readonly ExportRawMaterialLot[]): readonly ExportRawMaterialLot[] {
  return [...lots].sort(byCompanyThen((a, b) => a.lotId.localeCompare(b.lotId)));
}

/**
 * 原料ロットの期首・期末状態。期首は preProcessingStateSnapshot.rawMaterialLots、
 * 期末は postProcessingStateSnapshot.rawMaterialLots。増減はExcel側の数式で突合する。
 */
export interface ExportRawMaterialLotStates {
  readonly beginning: readonly ExportRawMaterialLot[];
  readonly ending: readonly ExportRawMaterialLot[];
}

export function buildExportRawMaterialLotStates(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportRawMaterialLotStates {
  const convert = (lots: readonly RawMaterialLot[]): readonly ExportRawMaterialLot[] =>
    sortRawMaterialLots(
      (scopedCompanyId === undefined ? lots : lots.filter((l) => l.companyId === scopedCompanyId)).map(
        buildExportRawMaterialLot,
      ),
    );
  return {
    beginning: convert(entry.preProcessingStateSnapshot.rawMaterialLots),
    ending: convert(entry.postProcessingStateSnapshot.rawMaterialLots),
  };
}

// ---------------------------------------------------------------------
// §5-12 完成品ロットの期首・生産・消費・期末状態
// ---------------------------------------------------------------------

/** 完成品ロットの品質情報（FinishedGoodsLotQualityInfo の許可項目）。 */
export interface ExportFinishedGoodsQualityInfo {
  /** 生産時の観測品質スコア（0〜100）。 */
  readonly qualityScore: number;
  /** 格落ち率（0〜1、記録用）。 */
  readonly downgradeRatio: number;
  readonly majorIncidentId: string | null;
  readonly majorIncidentSeverity: number | null;
  readonly producedPeriod: PeriodV2;
}

/** 完成品ロット1件（FinishedGoodsLot の許可項目）。 */
export interface ExportFinishedGoodsLot {
  readonly lotId: string;
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  readonly producedPeriod: PeriodV2;
  /** 当初数量（HOSO換算トン）。 */
  readonly originalQuantity: number;
  /** 残数量（HOSO換算トン）。 */
  readonly remainingQuantity: number;
  readonly sourceRawMaterialLots: readonly ExportRawMaterialConsumption[];
  readonly rawMaterialOriginCountries: readonly string[];
  /** 原料単価（消費原料の加重平均、USD/HOSO換算kg）。 */
  readonly rawMaterialUnitCost: number;
  /** 基準加工費（USD、記録用・非会計計上）。 */
  readonly baseProcessingCost: number;
  readonly availableFromPeriod: PeriodV2;
  readonly expiryPeriod: PeriodV2 | null;
  readonly status: string;
  readonly qualityInfo: ExportFinishedGoodsQualityInfo | null;
}

function buildExportFinishedGoodsLot(lot: FinishedGoodsLot): ExportFinishedGoodsLot {
  return {
    lotId: lot.lotId,
    companyId: lot.companyId,
    factoryId: lot.factoryId,
    product: lot.product,
    producedPeriod: lot.producedPeriod,
    originalQuantity: lot.originalQuantity,
    remainingQuantity: lot.remainingQuantity,
    sourceRawMaterialLots: lot.sourceRawMaterialLots
      .map(buildExportRawMaterialConsumption)
      .sort((a, b) => a.lotId.localeCompare(b.lotId)),
    rawMaterialOriginCountries: [...lot.rawMaterialOriginCountries],
    rawMaterialUnitCost: lot.rawMaterialUnitCost,
    baseProcessingCost: lot.baseProcessingCost,
    availableFromPeriod: lot.availableFromPeriod,
    expiryPeriod: lot.expiryPeriod ?? null,
    status: lot.status,
    qualityInfo: lot.qualityInfo
      ? {
          qualityScore: lot.qualityInfo.qualityScore,
          downgradeRatio: lot.qualityInfo.downgradeRatio,
          majorIncidentId: lot.qualityInfo.majorIncidentId ?? null,
          majorIncidentSeverity: lot.qualityInfo.majorIncidentSeverity ?? null,
          producedPeriod: lot.qualityInfo.producedPeriod,
        }
      : null,
  };
}

function sortFinishedGoodsLots(lots: readonly ExportFinishedGoodsLot[]): readonly ExportFinishedGoodsLot[] {
  return [...lots].sort(byCompanyThen((a, b) => a.lotId.localeCompare(b.lotId)));
}

/**
 * 完成品ロットの期首・当期生産・期末状態。
 *   期首 → preProcessingStateSnapshot.productionState.finishedGoodsLots
 *   生産 → record.newFinishedGoodsLots
 *   期末 → postProcessingStateSnapshot.productionState.finishedGoodsLots
 * 当期消費は record.fulfillmentPlan.usage（contractDto.ts の
 * buildExportContractFulfillmentUsage* ）を使う。期首＋生産−消費＝期末の
 * 検算はExcel側の数式で行う。
 */
export interface ExportFinishedGoodsLotStates {
  readonly beginning: readonly ExportFinishedGoodsLot[];
  readonly produced: readonly ExportFinishedGoodsLot[];
  readonly ending: readonly ExportFinishedGoodsLot[];
}

export function buildExportFinishedGoodsLotStates(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): ExportFinishedGoodsLotStates {
  const convert = (lots: readonly FinishedGoodsLot[]): readonly ExportFinishedGoodsLot[] =>
    sortFinishedGoodsLots(
      (scopedCompanyId === undefined ? lots : lots.filter((l) => l.companyId === scopedCompanyId)).map(
        buildExportFinishedGoodsLot,
      ),
    );
  return {
    beginning: convert(entry.preProcessingStateSnapshot.productionState.finishedGoodsLots),
    produced: convert(entry.record.newFinishedGoodsLots),
    ending: convert(entry.postProcessingStateSnapshot.productionState.finishedGoodsLots),
  };
}
