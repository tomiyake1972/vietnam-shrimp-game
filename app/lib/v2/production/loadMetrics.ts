// ShrimpX V2 — 工場・ワーカー・生産モジュール 操業負荷指標（Phase 6、Phase 6.1で実配分人数を使うよう修正）
//
// Phase7（品質・信用の変動を扱う想定）へ渡すための、工場・会社別の操業負荷
// 指標を集計する。本Phase自身はこれらの指標から品質・信用を一切変化させない
// （集計・出力のみ）。
//
// 【Phase 6.1修正】労働稼働率・残業率・臨時ワーカー比率は、labor.tsの
// allocateWorkersToPlansが実際に配分した人数（ProductionAllocationEntry.labor）を
// 使って算出する。Phase6初版はワーカーの奪い合いを解決せずに独立して労働能力を
// 再計算していたため、実際の配分と乖離しうる欠陥があった。

import { PeriodV2, toYearQuarter } from "../core/period";
import { ratio, roundRatio, unwrapUnit } from "../core/units";
import { calculateFactoryEffectiveCapacity } from "./capacity";
import { CompanyLoadMetrics, Factory, FactoryLoadMetrics, ProductionAllocationEntry, ProductionBatch } from "./types";

const EPSILON = 1e-6;

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/** 原料ロットのlotId → 入庫四半期 を引けるようにするための最小限のルックアップ入力。 */
export interface RawMaterialLotOrigin {
  readonly lotId: string;
  readonly inboundPeriod: PeriodV2;
}

/**
 * 1工場ぶんの操業負荷指標を算出する。労働関連の指標（労働稼働率・残業率・
 * 臨時ワーカー比率）は、entries（allocateProductionPlansの出力）が保持する
 * 実際の配分結果（labor.assignedRegularHeadcount等・stages.laborLimited）を
 * そのまま使う。ワーカー配分を本関数が独立に再計算することはしない
 * （実際の配分と乖離させないため）。
 */
export function calculateFactoryLoadMetrics(
  factory: Factory,
  entries: readonly ProductionAllocationEntry[],
  batches: readonly ProductionBatch[],
  rawMaterialLotOrigins: readonly RawMaterialLotOrigin[],
  period: PeriodV2
): FactoryLoadMetrics {
  const factoryEntries = entries.filter((e) => e.factoryId === factory.factoryId);
  const factoryBatches = batches.filter((b) => b.factoryId === factory.factoryId);

  const totalProduced = factoryBatches.reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
  const totalDesired = factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.desiredQuantity), 0);
  const totalShortfall = factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.shortfallQuantity), 0);
  const totalRawConsumed = factoryBatches.reduce((sum, b) => sum + unwrapUnit(b.rawMaterialConsumedTotal), 0);
  const totalLoss = factoryBatches.reduce((sum, b) => sum + unwrapUnit(b.processingLoss), 0);

  const capacity = calculateFactoryEffectiveCapacity(factory);
  const equipmentUtilizationRate = unwrapUnit(capacity.commonProcessing) > EPSILON ? totalProduced / unwrapUnit(capacity.commonProcessing) : 0;

  // 労働稼働率: 実際に生産された量 / 実際に配分された労働能力（stages.laborLimited）の合計。
  const totalLaborCapacityAllocated = factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.stages.laborLimited), 0);
  const laborUtilizationRate = totalLaborCapacityAllocated > EPSILON ? totalProduced / totalLaborCapacityAllocated : 0;

  // 残業率: 実際に配分された生産量（allocatedQuantity）で加重した、各計画の適用後残業率の平均。
  const totalAllocated = factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.allocatedQuantity), 0);
  const overtimeRate =
    totalAllocated > EPSILON
      ? factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.labor.appliedOvertimeRate) * unwrapUnit(e.allocatedQuantity), 0) / totalAllocated
      : factoryEntries.length > 0
        ? factoryEntries.reduce((sum, e) => sum + unwrapUnit(e.labor.appliedOvertimeRate), 0) / factoryEntries.length
        : 0;

  // 臨時ワーカー比率: 実際に配分された常用・臨時ワーカー人数の合計から算出する
  // （工場全体で、同じ人数を複数商品へ重複計上していないため、単純合算でよい）。
  const totalAssignedRegular = factoryEntries.reduce((sum, e) => sum + e.labor.assignedRegularHeadcount, 0);
  const totalAssignedTemporary = factoryEntries.reduce((sum, e) => sum + e.labor.assignedTemporaryHeadcount, 0);
  const totalAssignedHeadcount = totalAssignedRegular + totalAssignedTemporary;
  const temporaryWorkerShare = totalAssignedHeadcount > EPSILON ? totalAssignedTemporary / totalAssignedHeadcount : 0;

  const productsProduced = Array.from(new Set(factoryBatches.filter((b) => unwrapUnit(b.finishedGoodsQuantity) > EPSILON).map((b) => b.product)));
  const productMixComplexity = productsProduced.length > 1 ? (productsProduced.length - 1) / 2 : 0;

  const originByLotId = new Map(rawMaterialLotOrigins.map((o) => [o.lotId, o.inboundPeriod]));
  let weightedAgeSum = 0;
  let ageWeightTotal = 0;
  for (const batch of factoryBatches) {
    for (const c of batch.rawMaterialConsumed) {
      const inboundPeriod = originByLotId.get(c.lotId);
      if (!inboundPeriod) continue;
      const age = Math.max(0, quartersBetween(inboundPeriod, period));
      weightedAgeSum += age * unwrapUnit(c.quantity);
      ageWeightTotal += unwrapUnit(c.quantity);
    }
  }
  const averageRawMaterialAgeQuarters = ageWeightTotal > EPSILON ? weightedAgeSum / ageWeightTotal : 0;

  return {
    factoryId: factory.factoryId,
    companyId: factory.companyId,
    period,
    equipmentUtilizationRate: ratio(roundRatio(Math.min(1, Math.max(0, equipmentUtilizationRate)))),
    laborUtilizationRate: ratio(roundRatio(Math.min(1, Math.max(0, laborUtilizationRate)))),
    overtimeRate: ratio(roundRatio(Math.min(1, Math.max(0, overtimeRate)))),
    temporaryWorkerShare: ratio(roundRatio(Math.min(1, Math.max(0, temporaryWorkerShare)))),
    productMixComplexity: ratio(roundRatio(productMixComplexity)),
    averageRawMaterialAgeQuarters: Math.round(averageRawMaterialAgeQuarters * 100) / 100,
    productionShortfallRate: ratio(roundRatio(totalDesired > EPSILON ? Math.min(1, Math.max(0, totalShortfall / totalDesired)) : 0)),
    processingLossRate: ratio(roundRatio(totalRawConsumed > EPSILON ? Math.min(1, Math.max(0, totalLoss / totalRawConsumed)) : 0)),
  };
}

/** 複数工場ぶんの操業負荷指標をまとめて算出する。 */
export function calculateAllFactoryLoadMetrics(
  factories: readonly Factory[],
  entries: readonly ProductionAllocationEntry[],
  batches: readonly ProductionBatch[],
  rawMaterialLotOrigins: readonly RawMaterialLotOrigin[],
  period: PeriodV2
): readonly FactoryLoadMetrics[] {
  return factories.map((f) => calculateFactoryLoadMetrics(f, entries, batches, rawMaterialLotOrigins, period));
}

/** 会社単位に、その会社の全工場のload指標をHOSO換算量で加重集計する。 */
export function calculateCompanyLoadMetrics(factoryMetrics: readonly FactoryLoadMetrics[], batches: readonly ProductionBatch[]): readonly CompanyLoadMetrics[] {
  const companyIds = Array.from(new Set(factoryMetrics.map((m) => m.companyId))).sort();

  return companyIds.map((companyId) => {
    const metrics = factoryMetrics.filter((m) => m.companyId === companyId);
    const companyBatches = batches.filter((b) => b.companyId === companyId);
    const weightByFactory = new Map<string, number>();
    for (const b of companyBatches) {
      weightByFactory.set(b.factoryId, (weightByFactory.get(b.factoryId) ?? 0) + unwrapUnit(b.finishedGoodsQuantity));
    }
    const totalWeight = Array.from(weightByFactory.values()).reduce((s, v) => s + v, 0);

    function weightedAverage(selector: (m: FactoryLoadMetrics) => number): number {
      if (totalWeight <= EPSILON) {
        return metrics.length > 0 ? metrics.reduce((s, m) => s + selector(m), 0) / metrics.length : 0;
      }
      return metrics.reduce((sum, m) => sum + selector(m) * (weightByFactory.get(m.factoryId) ?? 0), 0) / totalWeight;
    }

    return {
      companyId,
      period: metrics[0].period,
      equipmentUtilizationRate: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.equipmentUtilizationRate)))),
      laborUtilizationRate: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.laborUtilizationRate)))),
      overtimeRate: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.overtimeRate)))),
      temporaryWorkerShare: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.temporaryWorkerShare)))),
      productMixComplexity: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.productMixComplexity)))),
      averageRawMaterialAgeQuarters: Math.round(weightedAverage((m) => m.averageRawMaterialAgeQuarters) * 100) / 100,
      productionShortfallRate: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.productionShortfallRate)))),
      processingLossRate: ratio(roundRatio(weightedAverage((m) => unwrapUnit(m.processingLossRate)))),
    };
  });
}
