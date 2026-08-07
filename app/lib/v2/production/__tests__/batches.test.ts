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

test("HOSO換算と歩留まりを二重適用しない（理論値と一致する。saleableRecoveryRatio基準）", () => {
  const recoveryRatio = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio.hoso;
  const desired = 90; // recoveryRatio(0.98)以下の値にして原料供給に余裕を持たせる
  const plans = [makePlan({ product: "hoso", desiredQuantity: hosoEqTons(desired) })];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(1000), originalQuantity: hosoEqTons(1000) })];
  const allocation = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const b = batches[0];
  // 完成品(HOSO換算)desiredトンを作るための理論原料量 = desired / saleableRecoveryRatio。
  // 二重適用（物理歩留まりを追加で掛ける）されていれば desired / recoveryRatio^2 の
  // ようなズレた値、あるいは物理歩留まり(0.92)基準のズレた値になる。
  const theoreticalRaw = desired / recoveryRatio;
  assert.ok(Math.abs(unwrapUnit(b.rawMaterialConsumedTotal) - theoreticalRaw) < 0.5);
});

test("原料100トン(HOSO換算)からPD/VAPを生産しても、物理歩留まり(PD 0.54等)がHOSO換算完成品量へ" +
  "直接適用されない（saleableRecoveryRatioのみが適用される）", () => {
  const pdPlan = makePlan({ product: "pd", factoryId: "F1", desiredQuantity: hosoEqTons(1000), priority: 1 });
  const vapPlan = makePlan({ product: "vap", factoryId: "F2", desiredQuantity: hosoEqTons(1000), priority: 1 });
  const lotsPd = [makeLot({ companyId: "C1", remainingQuantity: hosoEqTons(100), originalQuantity: hosoEqTons(100) })];
  const lotsVap = [makeLot({ companyId: "C1", remainingQuantity: hosoEqTons(100), originalQuantity: hosoEqTons(100) })];

  const pdFactory = makeFactory({ factoryId: "F1", pdCapacity: hosoEqTons(100000), commonProcessingCapacity: hosoEqTons(100000), freezingPackagingCapacity: hosoEqTons(100000) });
  const vapFactory = makeFactory({ factoryId: "F2", vapCapacity: hosoEqTons(100000), commonProcessingCapacity: hosoEqTons(100000), freezingPackagingCapacity: hosoEqTons(100000) });

  const pdAllocation = allocateProductionPlans([pdPlan], [pdFactory], [makeAssignment({ factoryId: "F1" })], lotsPd, P1);
  const { batches: pdBatches } = buildProductionBatches([pdPlan], pdAllocation.entries, lotsPd, P1);

  const vapAllocation = allocateProductionPlans([vapPlan], [vapFactory], [makeAssignment({ factoryId: "F2" })], lotsVap, P1);
  const { batches: vapBatches } = buildProductionBatches([vapPlan], vapAllocation.entries, lotsVap, P1);

  // 原料100トン(HOSO換算)がすべて消費された場合、PD完成品(HOSO換算)は
  // saleableRecoveryRatio.pd(基準1.00)倍の約100トンになるはずで、物理歩留まり
  // physicalYieldRatio.pd(0.54)を直接掛けた54トンにはならない。
  const pdFinished = unwrapUnit(pdBatches[0].finishedGoodsQuantity);
  const pdRecovery = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio.pd;
  const pdPhysical = PRODUCTION_PARAMETERS_V1.yield.physicalYieldRatio.pd!;
  assert.ok(pdFinished > 90, `PD完成品HOSO換算量が物理歩留まりで二重に減らされている: ${pdFinished}`);
  assert.ok(Math.abs(pdFinished - 100 * pdRecovery) < 1, `期待値: 100*${pdRecovery}=${100 * pdRecovery}, 実際: ${pdFinished}`);
  assert.notEqual(Math.round(pdFinished), Math.round(100 * pdPhysical));

  // VAPは物理歩留まりを定義しない（HOSO換算量のみで管理）。完成品HOSO換算量は
  // saleableRecoveryRatio.vap(基準1.00)倍の約100トン。
  const vapFinished = unwrapUnit(vapBatches[0].finishedGoodsQuantity);
  const vapRecovery = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio.vap;
  assert.equal(PRODUCTION_PARAMETERS_V1.yield.physicalYieldRatio.vap, undefined);
  assert.ok(vapFinished > 90, `VAP完成品HOSO換算量が物理歩留まりで二重に減らされている: ${vapFinished}`);
  assert.ok(Math.abs(vapFinished - 100 * vapRecovery) < 1, `期待値: 100*${vapRecovery}=${100 * vapRecovery}, 実際: ${vapFinished}`);
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
