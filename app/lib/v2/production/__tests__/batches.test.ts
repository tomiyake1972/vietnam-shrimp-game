import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { allocateProductionPlans } from "../allocation";
import { buildProductionBatches } from "../batches";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";
import { CompanyProductionPlanEntry, Factory, WorkerAssignment } from "../types";
import { RawMaterialLot } from "../../rawMaterials/types";

const P1 = period(2020, 1);

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(1000),
    hosoCapacity: hosoEqTons(1000),
    pdCapacity: hosoEqTons(1000),
    vapCapacity: hosoEqTons(1000),
    freezingPackagingCapacity: hosoEqTons(1000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "C1",
    regularHeadcount: 1000,
    temporaryHeadcount: 0,
    skills: [
      { product: "hoso", skillLevel: ratio(1) },
      { product: "pd", skillLevel: ratio(1) },
      { product: "vap", skillLevel: ratio(1) },
    ],
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
    ...overrides,
  };
}

function makeLot(overrides: Partial<RawMaterialLot> = {}): RawMaterialLot {
  return {
    lotId: "RM-1",
    companyId: "C1",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: P1,
    originalQuantity: hosoEqTons(500),
    remainingQuantity: hosoEqTons(500),
    unitCost: usdPerHosoEqKg(5),
    availableFromPeriod: P1,
    status: "available",
    ...overrides,
  };
}

function makePlan(overrides: Partial<CompanyProductionPlanEntry> = {}): CompanyProductionPlanEntry {
  return {
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    desiredQuantity: hosoEqTons(100),
    priority: 1,
    ...overrides,
  };
}

test("原料消費量 = 完成品数量 + 加工損失（数量保存）", () => {
  const plans = [makePlan({ product: "vap", desiredQuantity: hosoEqTons(50) })];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(1000), originalQuantity: hosoEqTons(1000) })];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const b = batches[0];
  const consumedTotal = unwrapUnit(b.rawMaterialConsumedTotal);
  const finished = unwrapUnit(b.finishedGoodsQuantity);
  const loss = unwrapUnit(b.processingLoss);
  assert.ok(Math.abs(consumedTotal - (finished + loss)) < 0.02);
});

test("HOSO換算と歩留まりを二重適用しない（理論値と一致する）", () => {
  const plans = [makePlan({ product: "hoso", desiredQuantity: hosoEqTons(92) })];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(1000), originalQuantity: hosoEqTons(1000) })];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const b = batches[0];
  const yieldRatio = PRODUCTION_PARAMETERS_V1.yield.baseYieldRatio.hoso;
  // 完成品92トンを作るための理論原料量 = 92 / yieldRatio。二重適用されていれば
  // 92 / yieldRatio^2 のようなズレた値になる。
  const theoreticalRaw = 92 / yieldRatio;
  assert.ok(Math.abs(unwrapUnit(b.rawMaterialConsumedTotal) - theoreticalRaw) < 0.5);
});

test("原料ロットを二重消費しない（複数計画が同一会社の原料を取り合っても合計消費量が在庫を超えない）", () => {
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(300), priority: 1, factoryId: "F1" }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(300), priority: 1, factoryId: "F1" }),
  ];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(100), originalQuantity: hosoEqTons(100) })];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches, updatedRawMaterialLots } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const totalConsumed = batches.reduce((sum, b) => sum + unwrapUnit(b.rawMaterialConsumedTotal), 0);
  assert.ok(totalConsumed <= 100 + 0.02);
  const remaining = updatedRawMaterialLots.reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  assert.ok(Math.abs(remaining + totalConsumed - 100) < 0.02);
});

test("原料ロット選択条件（selector）を指定すると該当ロットのみ消費する", () => {
  const domesticLot = makeLot({ lotId: "RM-DOM", source: "domestic", remainingQuantity: hosoEqTons(500), originalQuantity: hosoEqTons(500) });
  const importLot = makeLot({ lotId: "RM-IMP", source: "import", originCountry: "EC", remainingQuantity: hosoEqTons(500), originalQuantity: hosoEqTons(500) });
  const plans = [makePlan({ desiredQuantity: hosoEqTons(50), rawMaterialLotSelector: { source: "import" } })];
  const lots = [domesticLot, importLot];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const b = batches[0];
  assert.ok(b.rawMaterialConsumed.every((c) => c.lotId === "RM-IMP"));
});

test("原料取得原価・基準加工費は記録されるが会計計上フィールドは持たない", () => {
  const plans = [makePlan()];
  const lots = [makeLot()];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const b = batches[0];
  assert.ok(unwrapUnit(b.rawMaterialCost) >= 0);
  assert.ok(unwrapUnit(b.baseProcessingCost) >= 0);
  assert.ok(!("revenue" in b));
  assert.ok(!("plAmount" in b));
});

test("入力（plans/entries/rawMaterialLots）を変更しない", () => {
  const plans = [makePlan()];
  const lots = [makeLot()];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const beforePlans = JSON.stringify(plans);
  const beforeLots = JSON.stringify(lots);
  buildProductionBatches(plans, allocation.entries, lots, P1);
  assert.equal(JSON.stringify(plans), beforePlans);
  assert.equal(JSON.stringify(lots), beforeLots);
});

test("バッチIDは決定論的かつ重複しない", () => {
  const plans = [
    makePlan({ product: "hoso", priority: 1 }),
    makePlan({ product: "pd", priority: 2 }),
  ];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches: batches1 } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const { batches: batches2 } = buildProductionBatches(plans, allocation.entries, lots, P1);
  assert.deepEqual(
    batches1.map((b) => b.batchId),
    batches2.map((b) => b.batchId)
  );
  const ids = new Set(batches1.map((b) => b.batchId));
  assert.equal(ids.size, batches1.length);
});
