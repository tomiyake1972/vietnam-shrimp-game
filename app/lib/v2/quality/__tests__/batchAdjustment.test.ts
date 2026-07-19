// ShrimpX V2 — Phase 7A 品質モジュール batchAdjustment.ts テスト（統合）
//
// production/batches.ts（Phase6）が生成した「品質調整前」バッチに対して、
// applyQualityToBatchesが数量保存・急増産履歴・入力順非依存を正しく満たすかを
// 実際のFactory/FactoryLoadMetrics/ProductionBatchフィクスチャで検証する。
//
// 対応する受入条件:
//   1(再掲). 無負荷ではsaleableRecoveryRatio=1.00 → adjustedFinishedGoodsQuantity=original
//   5(再掲). 初回ターン(rampHistory空)では急増産ペナルティが付かない
//   6. 原料消費＝販売可能完成品＋廃棄等の真の損失（数量保存）
//   12(再掲). 会社・工場・商品入力順を変えても結果が同じ
//   14. 生産がない商品は品質状態を変えない（rampHistoryは0で更新されるが、
//       品質調整結果(adjustments)には出現しない）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdM } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { Factory, FactoryLoadMetrics, ProductionBatch } from "../../production/types";
import { applyQualityToBatches, QualityAdjustmentInput } from "../batchAdjustment";
import { CompanyFactoryProductRampState } from "../types";

const PERIOD = "2015Q1" as PeriodV2;

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(10000),
    hosoCapacity: hosoEqTons(5000),
    pdCapacity: hosoEqTons(5000),
    vapCapacity: hosoEqTons(5000),
    freezingPackagingCapacity: hosoEqTons(10000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeLoadMetrics(overrides: Partial<FactoryLoadMetrics> = {}): FactoryLoadMetrics {
  return {
    factoryId: "F1",
    companyId: "C1",
    period: PERIOD,
    equipmentUtilizationRate: ratio(0.5),
    laborUtilizationRate: ratio(0.5),
    overtimeRate: ratio(0),
    temporaryWorkerShare: ratio(0),
    productMixComplexity: ratio(0),
    averageRawMaterialAgeQuarters: 0,
    productionShortfallRate: ratio(0),
    processingLossRate: ratio(0),
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  const finished = overrides.finishedGoodsQuantity ?? hosoEqTons(1000);
  return {
    batchId: "C1::F1::hoso",
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

function baseAdjustmentInput(overrides: Partial<QualityAdjustmentInput> = {}): QualityAdjustmentInput {
  return {
    batches: [makeBatch()],
    factoryLoadMetrics: [makeLoadMetrics()],
    factories: [makeFactory()],
    rampHistory: [],
    overtimeRateCap: 0.2,
    period: PERIOD,
    turn: 1,
    gameSeed: "batch-adjustment-test-seed",
    ...overrides,
  };
}

test("1: 無負荷(稼働率50%・残業なし等)ではadjustedFinishedGoodsQuantityが元の生産量と一致する(saleableRecoveryRatio=1.00)", () => {
  const result = applyQualityToBatches(baseAdjustmentInput());
  assert.equal(result.adjustments.length, 1);
  const [adj] = result.adjustments;
  assert.equal(unwrapUnit(adj.outcome.saleableRecoveryRatio), 1);
  assert.equal(unwrapUnit(adj.adjustedFinishedGoodsQuantity), unwrapUnit(adj.originalFinishedGoodsQuantity));
  assert.equal(unwrapUnit(adj.discardQuantity), 0);
});

test("5: rampHistoryが空(初回ターン相当)ではproductionRampStress=0になる", () => {
  const result = applyQualityToBatches(baseAdjustmentInput({ rampHistory: [] }));
  assert.equal(result.adjustments[0].risk.productionRampStress, 0);
});

test("5b: 2ターン目以降、rampHistoryに前期実績があれば急増産ストレスが計算に反映される", () => {
  const rampHistory: CompanyFactoryProductRampState[] = [
    { companyId: "C1", factoryId: "F1", product: "hoso", lastQuarterProductionQuantity: hosoEqTons(100) },
  ];
  // 前期100→当期4000は極端な急増産
  const result = applyQualityToBatches(
    baseAdjustmentInput({ batches: [makeBatch({ finishedGoodsQuantity: hosoEqTons(4000) })], rampHistory })
  );
  assert.ok(result.adjustments[0].risk.productionRampStress > 0);
});

test("6: 原料消費量は変更されず、完成品数量+加工損失増分=元の完成品数量を保つ（数量保存）", () => {
  const highLoad = makeLoadMetrics({
    equipmentUtilizationRate: ratio(0.98),
    laborUtilizationRate: ratio(0.95),
    overtimeRate: ratio(0.2),
    temporaryWorkerShare: ratio(0.5),
    productMixComplexity: ratio(0.5),
    averageRawMaterialAgeQuarters: 3,
  });
  const batch = makeBatch({ finishedGoodsQuantity: hosoEqTons(1000), processingLoss: hosoEqTons(50), rawMaterialConsumedTotal: hosoEqTons(1050) });
  const result = applyQualityToBatches(baseAdjustmentInput({ batches: [batch], factoryLoadMetrics: [highLoad] }));
  const [adj] = result.adjustments;
  const adjustedBatch = result.adjustedBatches[0];

  // 廃棄が発生していること（高負荷なので）
  assert.ok(unwrapUnit(adj.discardQuantity) > 0);
  // 原料消費総量は不変
  assert.equal(unwrapUnit(adjustedBatch.rawMaterialConsumedTotal), unwrapUnit(batch.rawMaterialConsumedTotal));
  // 完成品数量 + 加工損失（調整後） = 完成品数量 + 加工損失（調整前） + 追加廃棄量が相殺しあう形で保存される:
  //   adjustedFinished + adjustedProcessingLoss = originalFinished + originalProcessingLoss
  const originalTotal = unwrapUnit(batch.finishedGoodsQuantity) + unwrapUnit(batch.processingLoss);
  const adjustedTotal = unwrapUnit(adjustedBatch.finishedGoodsQuantity) + unwrapUnit(adjustedBatch.processingLoss);
  assert.ok(Math.abs(originalTotal - adjustedTotal) < 0.01, `originalTotal=${originalTotal} adjustedTotal=${adjustedTotal}`);
  // 原料消費 = 完成品(調整後) + 加工損失(調整後) が成立する（原料消費が変わらないケースの検証）
  assert.ok(
    Math.abs(unwrapUnit(adjustedBatch.rawMaterialConsumedTotal) - adjustedTotal) < 0.01,
    "原料消費 = 完成品 + 加工損失（真の数量保存）"
  );
});

test("12: バッチ配列の入力順序を変えても、各バッチの品質調整結果は同じになる", () => {
  const factories: Factory[] = [makeFactory({ factoryId: "F1", companyId: "C1" }), makeFactory({ factoryId: "F2", companyId: "C2" })];
  const loadMetrics: FactoryLoadMetrics[] = [
    makeLoadMetrics({ factoryId: "F1", companyId: "C1", equipmentUtilizationRate: ratio(0.9) }),
    makeLoadMetrics({ factoryId: "F2", companyId: "C2", equipmentUtilizationRate: ratio(0.85), temporaryWorkerShare: ratio(0.3) }),
  ];
  const batches: ProductionBatch[] = [
    makeBatch({ batchId: "b1", companyId: "C1", factoryId: "F1", product: "hoso", finishedGoodsQuantity: hosoEqTons(800) }),
    makeBatch({ batchId: "b2", companyId: "C1", factoryId: "F1", product: "pd", finishedGoodsQuantity: hosoEqTons(600) }),
    makeBatch({ batchId: "b3", companyId: "C2", factoryId: "F2", product: "vap", finishedGoodsQuantity: hosoEqTons(400) }),
  ];

  const resultForward = applyQualityToBatches(
    baseAdjustmentInput({ batches, factoryLoadMetrics: loadMetrics, factories, turn: 7, gameSeed: "order-seed" })
  );
  const resultReversed = applyQualityToBatches(
    baseAdjustmentInput({ batches: [...batches].reverse(), factoryLoadMetrics: loadMetrics, factories, turn: 7, gameSeed: "order-seed" })
  );

  const byIdForward = new Map(resultForward.adjustments.map((a) => [a.batchId, a]));
  const byIdReversed = new Map(resultReversed.adjustments.map((a) => [a.batchId, a]));
  for (const id of byIdForward.keys()) {
    assert.deepEqual(byIdForward.get(id), byIdReversed.get(id), `batchId=${id}`);
  }
  // rampHistoryも順序非依存（ソート済み）で一致する
  assert.deepEqual(resultForward.updatedRampHistory, resultReversed.updatedRampHistory);
});

test("14: 生産量0のバッチは品質調整をスキップする（adjustmentsに現れない）が、rampHistoryは0として記録される", () => {
  const zeroBatch = makeBatch({ finishedGoodsQuantity: hosoEqTons(0), rawMaterialConsumedTotal: hosoEqTons(0) });
  const result = applyQualityToBatches(baseAdjustmentInput({ batches: [zeroBatch] }));
  assert.equal(result.adjustments.length, 0);
  assert.equal(result.adjustedBatches.length, 1);
  assert.equal(unwrapUnit(result.adjustedBatches[0].finishedGoodsQuantity), 0);
  const ramp = result.updatedRampHistory.find((r) => r.companyId === "C1" && r.factoryId === "F1" && r.product === "hoso");
  assert.ok(ramp);
  assert.equal(unwrapUnit(ramp!.lastQuarterProductionQuantity), 0);
});

test("factoryLoadMetricsが欠落している工場のバッチはQualityValidationErrorを投げる", () => {
  assert.throws(() => applyQualityToBatches(baseAdjustmentInput({ factoryLoadMetrics: [] })));
});

test("10/11: 同一gameSeed・同一turnであれば重大事故を含め完全に再現される", () => {
  // 極端に高い負荷で重大事故が起きやすい状況を作り、2回実行して完全一致することを確認する。
  const highLoad = makeLoadMetrics({
    equipmentUtilizationRate: ratio(1.0),
    laborUtilizationRate: ratio(1.0),
    overtimeRate: ratio(0.2),
    temporaryWorkerShare: ratio(1),
    productMixComplexity: ratio(1),
    averageRawMaterialAgeQuarters: 10,
  });
  const input = baseAdjustmentInput({ factoryLoadMetrics: [highLoad], turn: 42, gameSeed: "incident-determinism-seed" });
  const a = applyQualityToBatches(input);
  const b = applyQualityToBatches(input);
  assert.deepEqual(a, b);
});
