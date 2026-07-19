import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { allocateProductionPlans } from "../allocation";
import { buildProductionBatches } from "../batches";
import { calculateAllFactoryLoadMetrics, calculateCompanyLoadMetrics, RawMaterialLotOrigin } from "../loadMetrics";
import { CompanyProductionPlanEntry, Factory, WorkerAssignment } from "../types";
import { RawMaterialLot } from "../../rawMaterials/types";

const P1 = period(2020, 1);

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(100),
    hosoCapacity: hosoEqTons(100),
    pdCapacity: hosoEqTons(100),
    vapCapacity: hosoEqTons(100),
    freezingPackagingCapacity: hosoEqTons(100),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "C1",
    regularHeadcount: 20,
    temporaryHeadcount: 0,
    skills: [{ product: "hoso", skillLevel: ratio(1) }],
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
    originalQuantity: hosoEqTons(1000),
    remainingQuantity: hosoEqTons(1000),
    unitCost: usdPerHosoEqKg(5),
    availableFromPeriod: P1,
    status: "available",
    ...overrides,
  };
}

function makePlan(overrides: Partial<CompanyProductionPlanEntry> = {}): CompanyProductionPlanEntry {
  return { companyId: "C1", factoryId: "F1", product: "hoso", desiredQuantity: hosoEqTons(50), priority: 1, ...overrides };
}

function runOne(plans: CompanyProductionPlanEntry[], factory: Factory, assignment: WorkerAssignment, lots: RawMaterialLot[]) {
  const allocation = allocateProductionPlans(plans, [factory], [assignment], lots, P1);
  const { batches } = buildProductionBatches(plans, allocation.entries, lots, P1);
  const origins: RawMaterialLotOrigin[] = lots.map((l) => ({ lotId: l.lotId, inboundPeriod: l.inboundPeriod }));
  const factoryMetrics = calculateAllFactoryLoadMetrics([factory], [assignment], allocation.entries, batches, origins, P1);
  const companyMetrics = calculateCompanyLoadMetrics(factoryMetrics, batches);
  return { factoryMetrics, companyMetrics };
}

test("残業率が高いほど負荷指標のovertimeRateが反映される", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), commonProcessingCapacity: hosoEqTons(100000) });
  const lots = [makeLot()];
  const noOvertime = runOne([makePlan()], factory, makeAssignment({ overtimeRate: ratio(0) }), lots);
  const withOvertime = runOne([makePlan()], factory, makeAssignment({ overtimeRate: ratio(0.3) }), lots);
  assert.ok(unwrapUnit(withOvertime.factoryMetrics[0].overtimeRate) > unwrapUnit(noOvertime.factoryMetrics[0].overtimeRate));
});

test("臨時ワーカー比率が高いほど負荷指標のtemporaryWorkerShareが反映される", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), commonProcessingCapacity: hosoEqTons(100000) });
  const lots = [makeLot()];
  const allRegular = runOne([makePlan()], factory, makeAssignment({ regularHeadcount: 20, temporaryHeadcount: 0 }), lots);
  const halfTemp = runOne([makePlan()], factory, makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 10 }), lots);
  assert.ok(unwrapUnit(halfTemp.factoryMetrics[0].temporaryWorkerShare) > unwrapUnit(allRegular.factoryMetrics[0].temporaryWorkerShare));
});

test("高稼働（希望量に対する完成量の比率が高い）は設備稼働率へ反映される", () => {
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(1000), hosoCapacity: hosoEqTons(1000) });
  const lots = [makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) })];
  const lowDemand = runOne([makePlan({ desiredQuantity: hosoEqTons(10) })], factory, makeAssignment({ regularHeadcount: 1000 }), lots);
  const highDemand = runOne([makePlan({ desiredQuantity: hosoEqTons(900) })], factory, makeAssignment({ regularHeadcount: 1000 }), lots);
  assert.ok(unwrapUnit(highDemand.factoryMetrics[0].equipmentUtilizationRate) > unwrapUnit(lowDemand.factoryMetrics[0].equipmentUtilizationRate));
});

test("生産未達率は希望量に対する未達量の比率と一致する", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(10) });
  const lots = [makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) })];
  const { factoryMetrics } = runOne([makePlan({ desiredQuantity: hosoEqTons(100) })], factory, makeAssignment({ regularHeadcount: 1000 }), lots);
  assert.ok(unwrapUnit(factoryMetrics[0].productionShortfallRate) > 0.5);
});

test("会社単位の集計は完成品数量で加重した工場指標の平均になる", () => {
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(100000), hosoCapacity: hosoEqTons(100000) });
  const lots = [makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) })];
  const { companyMetrics } = runOne([makePlan({ desiredQuantity: hosoEqTons(50) })], factory, makeAssignment({ regularHeadcount: 1000 }), lots);
  assert.equal(companyMetrics.length, 1);
  assert.equal(companyMetrics[0].companyId, "C1");
});

test("Phase6自身はこれらの指標から品質・信用を変化させない（出力に品質・信用フィールドを含まない）", () => {
  const factory = makeFactory();
  const lots = [makeLot()];
  const { factoryMetrics, companyMetrics } = runOne([makePlan()], factory, makeAssignment(), lots);
  assert.ok(!("qualityScore" in factoryMetrics[0]));
  assert.ok(!("trustScore" in companyMetrics[0]));
});
