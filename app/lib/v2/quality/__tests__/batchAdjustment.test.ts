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

test("受入確認1: operationalRisk=0・事故なしでは、HOSO/PD/VAPいずれも厳密にsaleableRecoveryRatio=1.00・廃棄/格落ち/再加工=0になる（100トン投入→販売可能完成品100トン）", () => {
  // 稼働率50%（閾値0.80未満）・残業/臨時ワーカー/複雑度/原料経過期間すべて0という、
  // makeLoadMetrics()の既定値そのものが「純粋な無負荷」ケースに相当する
  // （実際のcompanyLab実行時は工場稼働率が0.80近辺まで上がることが多く、その場合は
  // わずかでもutilizationStressが生じるため、報告書の「≈0.99超」はその通常実行時の
  // 非ゼロリスクを指しており、本テストの「純粋無負荷」ケースとは区別する）。
  for (const product of ["hoso", "pd", "vap"] as const) {
    const batch = makeBatch({
      batchId: `zero-risk-${product}`,
      product,
      finishedGoodsQuantity: hosoEqTons(100),
      rawMaterialConsumedTotal: hosoEqTons(100),
      processingLoss: hosoEqTons(0),
    });
    const result = applyQualityToBatches(baseAdjustmentInput({ batches: [batch] }));
    assert.equal(result.adjustments.length, 1, product);
    const [adj] = result.adjustments;

    assert.equal(adj.risk.operationalRisk, 0, `${product}: operationalRisk`);
    assert.equal(adj.outcome.majorIncident.occurred, false, `${product}: majorIncident`);
    assert.equal(adj.outcome.nonConformanceRatio, 0, `${product}: nonConformanceRatio`);
    assert.equal(unwrapUnit(adj.downgradeQuantity), 0, `${product}: downgradeQuantity`);
    assert.equal(unwrapUnit(adj.reworkQuantity), 0, `${product}: reworkQuantity`);
    assert.equal(unwrapUnit(adj.discardQuantity), 0, `${product}: discardQuantity`);
    // 浮動小数点誤差を除き厳密に1.00（丸め後の値でstrict equalが成立することを確認）。
    assert.equal(unwrapUnit(adj.outcome.saleableRecoveryRatio), 1, `${product}: saleableRecoveryRatio`);
    assert.equal(unwrapUnit(adj.adjustedFinishedGoodsQuantity), 100, `${product}: adjustedFinishedGoodsQuantity`);

    const adjustedBatch = result.adjustedBatches[0];
    assert.equal(unwrapUnit(adjustedBatch.finishedGoodsQuantity), 100, `${product}: 販売可能完成品=100`);
    assert.equal(unwrapUnit(adjustedBatch.processingLoss), 0, `${product}: 廃棄=0`);
    // 物理歩留まり（physicalYieldRatio）は品質モジュールでは一切参照・適用されない
    // （HOSO/PD/VAPいずれも同じ100トン→100トンになることがその直接証拠）。
  }
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

test("受入確認3: 数量保存の実測例（基準完成品数量=販売可能完成品数量+廃棄数量、格落ち/再加工の二重計上なし、原料消費量は不変）", () => {
  const highLoad = makeLoadMetrics({
    equipmentUtilizationRate: ratio(0.9),
    laborUtilizationRate: ratio(0.85),
    overtimeRate: ratio(0),
    temporaryWorkerShare: ratio(0),
    productMixComplexity: ratio(0),
    averageRawMaterialAgeQuarters: 0,
  });
  // Phase6由来の既存の物理歩留まり損失(50トン)を明示的に持たせ、品質調整がこれに加算される形で
  // 追加の廃棄だけを載せる（物理歩留まりを品質モジュール側で書き換えないことも同時に確認する）。
  const batch = makeBatch({
    finishedGoodsQuantity: hosoEqTons(1000),
    processingLoss: hosoEqTons(50),
    rawMaterialConsumedTotal: hosoEqTons(1050),
  });
  const result = applyQualityToBatches(baseAdjustmentInput({ batches: [batch], factoryLoadMetrics: [highLoad] }));
  const [adj] = result.adjustments;
  const adjustedBatch = result.adjustedBatches[0];

  // 事故なし・utilizationStress=((0.90-0.80)/0.20)^2=0.25 → operationalRisk=0.35*0.25=0.0875
  assert.ok(Math.abs(adj.risk.operationalRisk - 0.0875) < 1e-9, `operationalRisk=${adj.risk.operationalRisk}`);
  assert.equal(adj.outcome.majorIncident.occurred, false);

  const originalFinished = unwrapUnit(adj.originalFinishedGoodsQuantity);
  const adjustedFinished = unwrapUnit(adj.adjustedFinishedGoodsQuantity);
  const discard = unwrapUnit(adj.discardQuantity);
  const downgrade = unwrapUnit(adj.downgradeQuantity);
  const rework = unwrapUnit(adj.reworkQuantity);

  // 基準完成品数量 = 販売可能完成品数量 + 廃棄数量（格落ち・再加工は別途加算しない＝二重計上なし）。
  assert.ok(Math.abs(originalFinished - (adjustedFinished + discard)) < 0.01, `original=${originalFinished} adjusted=${adjustedFinished} discard=${discard}`);
  // 格落ち・再加工は販売可能完成品数量(adjustedFinished)に含まれたままであり、discardには含まれない。
  assert.ok(downgrade > 0 && rework > 0, "格落ち・再加工が発生する負荷であることを確認");
  assert.ok(Math.abs(originalFinished - (adjustedFinished + discard + downgrade + rework - downgrade - rework)) < 0.01);

  // 原料消費量は品質調整によって一切変更されない。
  assert.equal(unwrapUnit(adjustedBatch.rawMaterialConsumedTotal), unwrapUnit(batch.rawMaterialConsumedTotal));
  // 加工損失(processingLoss)は「既存の物理歩留まり損失(50) + 追加の品質廃棄(discard)」。
  assert.ok(Math.abs(unwrapUnit(adjustedBatch.processingLoss) - (50 + discard)) < 0.01);
  // 原料消費 = 完成品(調整後) + 加工損失(調整後)。
  assert.ok(
    Math.abs(unwrapUnit(adjustedBatch.rawMaterialConsumedTotal) - (unwrapUnit(adjustedBatch.finishedGoodsQuantity) + unwrapUnit(adjustedBatch.processingLoss))) < 0.01
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

test("受入確認2: 生産量0の会社×工場×商品は、乱数値(シード)に関わらず重大事故を一切発生させない・品質スコアを変化させない・廃棄/格落ち/再加工を発生させない", () => {
  // baseIncidentProbability=0.002は「発生確率」であって「発生量」ではないため、シード次第では
  // 理論上いつでも発生しうる値に見えるが、applyQualityToBatchesの実装は
  // currentProduction<=EPSILONの時点でdrawMajorIncident自体を一切呼ばずに次のバッチへ進む
  // （continueが乱数消費より前にある）。これを多数のシード・ターンで横断的に確認する。
  const zeroBatch = makeBatch({ finishedGoodsQuantity: hosoEqTons(0), rawMaterialConsumedTotal: hosoEqTons(0), processingLoss: hosoEqTons(0) });

  for (let turn = 1; turn <= 50; turn++) {
    const result = applyQualityToBatches(baseAdjustmentInput({ batches: [zeroBatch], turn, gameSeed: `zero-production-incident-check-${turn}` }));

    // adjustments自体が生成されない = 重大事故・品質観測・廃棄/格落ち/再加工のいずれも発生しようがない。
    assert.equal(result.adjustments.length, 0, `turn=${turn}: 生産量0のバッチは調整結果を持たないはず`);

    // バッチ自体は完全に元のまま（廃棄・格落ち・再加工が一切適用されていない）。
    const adjustedBatch = result.adjustedBatches[0];
    assert.equal(unwrapUnit(adjustedBatch.finishedGoodsQuantity), 0, `turn=${turn}`);
    assert.equal(unwrapUnit(adjustedBatch.processingLoss), 0, `turn=${turn}: 廃棄が発生していない`);
    assert.deepEqual(adjustedBatch, zeroBatch, `turn=${turn}: バッチが完全に不変`);

    // rampHistoryは「当期実績0」として記録されるが、品質スコア自体（quality/stateUpdate.ts側）は
    // adjustmentsが空である限りweight=0となり、updateQualityByCompanyProductが据え置く
    // （stateUpdate.test.tsの「14」で確認済み）。
    const ramp = result.updatedRampHistory.find((r) => r.companyId === zeroBatch.companyId && r.factoryId === zeroBatch.factoryId && r.product === zeroBatch.product);
    assert.ok(ramp);
    assert.equal(unwrapUnit(ramp!.lastQuarterProductionQuantity), 0, `turn=${turn}`);
  }
});

test("受入確認2b: 生産量0のバッチはcreateFinishedGoodsLots段階でロット自体が作られないため、事故対象ロットが存在せず顧客信頼への事故ペナルティも発生しえない", () => {
  const zeroBatch = makeBatch({ finishedGoodsQuantity: hosoEqTons(0) });
  const { adjustedBatches } = applyQualityToBatches(baseAdjustmentInput({ batches: [zeroBatch] }));
  // production/finishedGoods.tsのcreateFinishedGoodsLotsは finishedGoodsQuantity>EPSILON でフィルタするため、
  // 生産量0のバッチからはロットが1件も生成されない（quality/finishedGoodsQuality.tsの
  // attachQualityInfoToFinishedGoodsLotsが対応付けるqualityInfo自体が存在し得ない）。
  const producingBatches = adjustedBatches.filter((b) => unwrapUnit(b.finishedGoodsQuantity) > 1e-6);
  assert.equal(producingBatches.length, 0);
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
