// ShrimpX V2 — Phase 7A 品質モジュール finishedGoodsQuality.ts テスト
//
// 完成品ロットへの品質情報付与（位置対応のzip）が正しく機能すること、および
// createFinishedGoodsLotsの内部フィルタ条件と食い違った場合に安全に検出されること
// （黙って誤ったロットへ品質情報を付けない）を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdM } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { createFinishedGoodsLots } from "../../production/finishedGoods";
import { ProductionBatch } from "../../production/types";
import { applyQualityToBatches } from "../batchAdjustment";
import { adjustmentsByBatchId } from "../batchAdjustment";
import { attachQualityInfoToFinishedGoodsLots } from "../finishedGoodsQuality";

const PERIOD = "2015Q1" as PeriodV2;

function makeBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  const finished = overrides.finishedGoodsQuantity ?? hosoEqTons(1000);
  return {
    batchId: "b1",
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    period: PERIOD,
    rawMaterialConsumed: [],
    rawMaterialConsumedTotal: hosoEqTons(unwrapUnit(finished)),
    finishedGoodsQuantity: finished,
    processingLoss: hosoEqTons(0),
    rawMaterialCost: usdM(0),
    baseProcessingCost: usdM(0),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

test("品質調整後のバッチからロットを生成すると、対応するqualityInfoが正しく付与される", () => {
  const batches: ProductionBatch[] = [
    makeBatch({ batchId: "b1", product: "hoso", finishedGoodsQuantity: hosoEqTons(1000) }),
    makeBatch({ batchId: "b2", product: "pd", finishedGoodsQuantity: hosoEqTons(0) }), // スキップされるバッチ
    makeBatch({ batchId: "b3", product: "vap", finishedGoodsQuantity: hosoEqTons(500) }),
  ];

  const highRiskInput = {
    batches,
    factoryLoadMetrics: [
      {
        factoryId: "F1",
        companyId: "C1" as const,
        period: PERIOD,
        equipmentUtilizationRate: ratio(0.95),
        laborUtilizationRate: ratio(0.9),
        overtimeRate: ratio(0.2),
        temporaryWorkerShare: ratio(0.5),
        productMixComplexity: ratio(0.5),
        averageRawMaterialAgeQuarters: 2,
        productionShortfallRate: ratio(0),
        processingLossRate: ratio(0),
      },
    ],
    factories: [
      {
        factoryId: "F1",
        companyId: "C1" as const,
        status: "active" as const,
        commonProcessingCapacity: hosoEqTons(10000),
        hosoCapacity: hosoEqTons(5000),
        pdCapacity: hosoEqTons(5000),
        vapCapacity: hosoEqTons(5000),
        freezingPackagingCapacity: hosoEqTons(10000),
        baseUtilizationRate: ratio(1),
        equipmentAvailabilityRate: ratio(1),
      },
    ],
    rampHistory: [],
    overtimeRateCap: 0.2,
    period: PERIOD,
    turn: 1,
    gameSeed: "finished-goods-quality-test",
  };

  const { adjustedBatches, adjustments } = applyQualityToBatches(highRiskInput);
  const lots = createFinishedGoodsLots(adjustedBatches);
  const withQuality = attachQualityInfoToFinishedGoodsLots(lots, adjustedBatches, adjustmentsByBatchId(adjustments));

  // b2（生産量0）はcreateFinishedGoodsLotsのフィルタで除外されるため、ロット数は2件。
  assert.equal(withQuality.length, 2);
  for (const lot of withQuality) {
    assert.ok(lot.qualityInfo, `lot(${lot.factoryId}/${lot.product})にqualityInfoが付与されているはず`);
    assert.ok(unwrapUnit(lot.qualityInfo!.qualityScore) >= 0 && unwrapUnit(lot.qualityInfo!.qualityScore) <= 100);
    assert.ok(unwrapUnit(lot.qualityInfo!.downgradeRatio) >= 0 && unwrapUnit(lot.qualityInfo!.downgradeRatio) <= 1);
    assert.equal(lot.qualityInfo!.producedPeriod, PERIOD);
  }
});

test("adjustmentsに対応するバッチが存在しない場合、そのロットにはqualityInfoを付与しない", () => {
  const batches: ProductionBatch[] = [makeBatch({ batchId: "b1", finishedGoodsQuantity: hosoEqTons(1000) })];
  const lots = createFinishedGoodsLots(batches);
  const withQuality = attachQualityInfoToFinishedGoodsLots(lots, batches, new Map()); // 空のadjustments
  assert.equal(withQuality.length, 1);
  assert.equal(withQuality[0].qualityInfo, undefined);
});

test("ロット数と品質調整後の生産バッチ数が食い違う場合は例外を投げる（誤った位置対応を防止）", () => {
  const batches: ProductionBatch[] = [makeBatch({ batchId: "b1", finishedGoodsQuantity: hosoEqTons(1000) })];
  const lots = createFinishedGoodsLots(batches);
  const mismatchedBatches: ProductionBatch[] = [
    makeBatch({ batchId: "b1", finishedGoodsQuantity: hosoEqTons(1000) }),
    makeBatch({ batchId: "b2", finishedGoodsQuantity: hosoEqTons(500) }), // ロット数と食い違う
  ];
  assert.throws(() => attachQualityInfoToFinishedGoodsLots(lots, mismatchedBatches, new Map()));
});
