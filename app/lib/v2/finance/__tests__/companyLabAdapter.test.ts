// ShrimpX V2 — 財務モジュール 会社ラボ実績アダプター 接続テスト
// （feature/v2-labor-cost-allocation-bridge, 1コミット目）
//
// productionRecord.allocation.entries（商品別の実労務配分データ）が、
// buildCompanyQuarterBusinessActuals経由でProductionBatchActualへ正しく
// 橋渡しされること、および不整合な入力を早期に拒否することを検証する。
// この時点ではquarterClose.tsの会計計算式はまだ変更していないため、
// 労務費の按分結果自体はここでは検証しない（それは次コミットのテストで扱う）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, ratio, usdM } from "../../core/units";
import { ProductionAllocationEntry, ProductionBatch, WorkerAssignment } from "../../production/types";
import { buildCompanyQuarterBusinessActuals, CompanyActualsSource } from "../companyLabAdapter";
import { resolveLaborAllocationMode } from "../quarterClose";
import { FinanceValidationError } from "../types";

const P1 = period(2015, 3);

function makeAllocationEntry(overrides: Partial<ProductionAllocationEntry> = {}): ProductionAllocationEntry {
  const zeroStage = hosoEqTons(0);
  return {
    companyId: "BAL",
    factoryId: "BAL-F1",
    product: "hoso",
    priority: 1,
    desiredQuantity: hosoEqTons(100),
    allocatedQuantity: hosoEqTons(100),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    requiredRawMaterialQuantity: hosoEqTons(100),
    stages: {
      rawMaterialLimited: zeroStage,
      commonCapacityLimited: zeroStage,
      freezingPackagingLimited: zeroStage,
      productCapacityLimited: zeroStage,
      laborLimited: zeroStage,
    },
    labor: {
      assignedRegularHeadcount: 0,
      assignedTemporaryHeadcount: 0,
      appliedOvertimeRate: ratio(0),
    },
    ...overrides,
  };
}

function makeProductionBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  return {
    batchId: "BAL-F1-hoso-2015Q3-1",
    companyId: "BAL",
    factoryId: "BAL-F1",
    product: "hoso",
    period: P1,
    rawMaterialConsumed: [],
    rawMaterialConsumedTotal: hosoEqTons(100),
    finishedGoodsQuantity: hosoEqTons(100),
    processingLoss: hosoEqTons(0),
    rawMaterialCost: usdM(0),
    baseProcessingCost: usdM(0),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

function makeWorkerAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "BAL-F1",
    companyId: "BAL",
    regularHeadcount: 6000,
    temporaryHeadcount: 540,
    skills: [
      { product: "hoso", skillLevel: ratio(0.85) },
      { product: "pd", skillLevel: ratio(0.8) },
      { product: "vap", skillLevel: ratio(0.75) },
    ],
    overtimeRate: ratio(0.09),
    attendanceRate: ratio(0.95),
    ...overrides,
  };
}

function makeSource(overrides: Partial<CompanyActualsSource> = {}): CompanyActualsSource {
  return {
    companyId: "BAL",
    period: P1,
    usage: [],
    contracts: [],
    adjustedBatches: [makeProductionBatch()],
    qualityAdjustments: [],
    newFinishedGoodsLots: [],
    allRawMaterialLotsAfterTurn: [],
    newImportLots: [],
    harvestedLots: [],
    rawMaterialLotsAtStart: [],
    rawMaterialLotsAtEnd: [],
    finishedGoodsLotsBeforeConsumption: [],
    finishedGoodsLotsAtEnd: [],
    workerAssignments: [makeWorkerAssignment()],
    appliedOvertimeRate: 0.09,
    activeFactoryCount: 1,
    salesForceHeadcount: 18,
    procurementHeadcount: 12,
    ...overrides,
  };
}

test("接続A: productionAllocationEntriesを渡すと、対応するバッチへ実配分常用/臨時人員・適用残業率が結合される", () => {
  const hosoBatch = makeProductionBatch({ batchId: "b-hoso", factoryId: "BAL-F1", product: "hoso", finishedGoodsQuantity: hosoEqTons(3068.69) });
  const vapBatch = makeProductionBatch({ batchId: "b-vap", factoryId: "BAL-F1", product: "vap", finishedGoodsQuantity: hosoEqTons(5063.82) });
  const hosoEntry = makeAllocationEntry({
    product: "hoso",
    labor: { assignedRegularHeadcount: 612.28, assignedTemporaryHeadcount: 0, appliedOvertimeRate: ratio(0.09) },
  });
  const vapEntry = makeAllocationEntry({
    product: "vap",
    labor: { assignedRegularHeadcount: 1148.33, assignedTemporaryHeadcount: 540, appliedOvertimeRate: ratio(0.09) },
  });

  const actuals = buildCompanyQuarterBusinessActuals(
    makeSource({ adjustedBatches: [hosoBatch, vapBatch], productionAllocationEntries: [hosoEntry, vapEntry] })
  );

  const gotHoso = actuals.batches.find((b) => b.product === "hoso")!;
  const gotVap = actuals.batches.find((b) => b.product === "vap")!;
  assert.equal(gotHoso.assignedRegularHeadcount, 612.28);
  assert.equal(gotHoso.assignedTemporaryHeadcount, 0);
  assert.equal(gotHoso.appliedOvertimeRate, 0.09);
  assert.equal(gotVap.assignedRegularHeadcount, 1148.33);
  assert.equal(gotVap.assignedTemporaryHeadcount, 540);
  assert.equal(gotVap.appliedOvertimeRate, 0.09);
});

test("接続B: productionAllocationEntriesを省略すると、労務3項目はいずれもundefinedのまま（従来経路との後方互換）", () => {
  const actuals = buildCompanyQuarterBusinessActuals(makeSource({ productionAllocationEntries: undefined }));
  const b = actuals.batches[0];
  assert.equal(b.assignedRegularHeadcount, undefined);
  assert.equal(b.assignedTemporaryHeadcount, undefined);
  assert.equal(b.appliedOvertimeRate, undefined);
});

test("接続C: 他社のproductionAllocationEntriesが混ざっていても無視され、自社ぶんだけが結合される", () => {
  const otherCompanyEntry = makeAllocationEntry({ companyId: "MASS", product: "hoso", labor: { assignedRegularHeadcount: 999, assignedTemporaryHeadcount: 0, appliedOvertimeRate: ratio(0) } });
  const ownEntry = makeAllocationEntry({ companyId: "BAL", product: "hoso", labor: { assignedRegularHeadcount: 612.28, assignedTemporaryHeadcount: 0, appliedOvertimeRate: ratio(0.09) } });
  const actuals = buildCompanyQuarterBusinessActuals(makeSource({ productionAllocationEntries: [otherCompanyEntry, ownEntry] }));
  assert.equal(actuals.batches[0].assignedRegularHeadcount, 612.28);
});

test("validation A: 対応するproductionAllocationEntryが1件も無いバッチがあるとFinanceValidationError", () => {
  assert.throws(
    () => buildCompanyQuarterBusinessActuals(makeSource({ productionAllocationEntries: [] })),
    FinanceValidationError
  );
});

test("validation B: factoryId+productが重複するproductionAllocationEntryがあるとFinanceValidationError", () => {
  const e1 = makeAllocationEntry({ product: "hoso" });
  const e2 = makeAllocationEntry({ product: "hoso" });
  assert.throws(
    () => buildCompanyQuarterBusinessActuals(makeSource({ productionAllocationEntries: [e1, e2] })),
    FinanceValidationError
  );
});

test("validation C: factoryId+productが重複する生産バッチ（adjustedBatches）が2件あるとFinanceValidationError（同じ配分エントリが二重結合されるのを防ぐ）", () => {
  const dup1 = makeProductionBatch({ batchId: "b-hoso-1", factoryId: "BAL-F1", product: "hoso" });
  const dup2 = makeProductionBatch({ batchId: "b-hoso-2", factoryId: "BAL-F1", product: "hoso" });
  const entry = makeAllocationEntry({ product: "hoso" });
  assert.throws(
    () => buildCompanyQuarterBusinessActuals(makeSource({ adjustedBatches: [dup1, dup2], productionAllocationEntries: [entry] })),
    FinanceValidationError
  );
});

test("validation C(補): productionAllocationEntriesを渡さない経路では、重複バッチがあってもこのチェックは発生しない（労務結合が起きないため対象外）", () => {
  const dup1 = makeProductionBatch({ batchId: "b-hoso-1", factoryId: "BAL-F1", product: "hoso" });
  const dup2 = makeProductionBatch({ batchId: "b-hoso-2", factoryId: "BAL-F1", product: "hoso" });
  const actuals = buildCompanyQuarterBusinessActuals(
    makeSource({ adjustedBatches: [dup1, dup2], productionAllocationEntries: undefined })
  );
  assert.equal(actuals.batches.length, 2);
});

// --- 統合確認: 実際のcompanyLab実行経路（runner.ts）を模したケースが常に'actual'モードへ解決されること ---
//
// runner.tsはproductionRecord.allocation.entries（型上、常に存在しoptionalではない。各エントリの
// labor.assignedRegularHeadcount等も型上必須）をそのままproductionAllocationEntriesへ渡す。
// つまり実行経路では「省略」というケース自体が型システム上あり得ず、resolveLaborAllocationMode
// は常に'actual'を返すはずである。'legacy'フォールバックは、productionAllocationEntriesを
// 渡さない後方互換の旧テスト経路でのみ発生する。この境界を明示的に固定する。

test("統合確認A: 実行経路どおりproductionAllocationEntriesを（全バッチぶん漏れなく）渡すと、resolveLaborAllocationModeは常に'actual'を返す", () => {
  const hosoBatch = makeProductionBatch({ batchId: "b-hoso", factoryId: "BAL-F1", product: "hoso" });
  const pdBatch = makeProductionBatch({ batchId: "b-pd", factoryId: "BAL-F1", product: "pd" });
  const vapBatch = makeProductionBatch({ batchId: "b-vap", factoryId: "BAL-F1", product: "vap" });
  const entries = [
    makeAllocationEntry({ product: "hoso", labor: { assignedRegularHeadcount: 612.28, assignedTemporaryHeadcount: 0, appliedOvertimeRate: ratio(0.09) } }),
    makeAllocationEntry({ product: "pd", labor: { assignedRegularHeadcount: 1435.41, assignedTemporaryHeadcount: 0, appliedOvertimeRate: ratio(0.09) } }),
    makeAllocationEntry({ product: "vap", labor: { assignedRegularHeadcount: 1148.33, assignedTemporaryHeadcount: 540, appliedOvertimeRate: ratio(0.09) } }),
  ];
  const actuals = buildCompanyQuarterBusinessActuals(
    makeSource({ adjustedBatches: [hosoBatch, pdBatch, vapBatch], productionAllocationEntries: entries })
  );
  assert.equal(resolveLaborAllocationMode(actuals.batches), "actual");
});

test("統合確認B: productionAllocationEntriesを渡さない（旧テスト経路を模した）場合のみ、resolveLaborAllocationModeは'legacy'を返す", () => {
  const actuals = buildCompanyQuarterBusinessActuals(makeSource({ productionAllocationEntries: undefined }));
  assert.equal(resolveLaborAllocationMode(actuals.batches), "legacy");
});
