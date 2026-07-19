import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { calculateFactoryEffectiveCapacity } from "../capacity";
import { calculateEffectiveLaborCapacity, effectiveLaborCapacityForProduct } from "../labor";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";
import { Factory, WorkerAssignment } from "../types";

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(1000),
    hosoCapacity: hosoEqTons(600),
    pdCapacity: hosoEqTons(300),
    vapCapacity: hosoEqTons(200),
    freezingPackagingCapacity: hosoEqTons(900),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "C1",
    regularHeadcount: 10,
    temporaryHeadcount: 0,
    skills: [{ product: "hoso", skillLevel: ratio(1) }],
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
    ...overrides,
  };
}

test("スキルのない商品は有効労働能力0になる", () => {
  const factory = makeFactory();
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const result = calculateEffectiveLaborCapacity(makeAssignment(), capacity);
  assert.equal(effectiveLaborCapacityForProduct(result, "pd"), 0);
  assert.equal(effectiveLaborCapacityForProduct(result, "vap"), 0);
  assert.ok(effectiveLaborCapacityForProduct(result, "hoso") > 0);
});

test("常用ワーカーの方が臨時ワーカーより1人あたりの生産効率が高い", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000) }); // 設備上限に張り付かないよう十分大きくする
  const capacity = calculateFactoryEffectiveCapacity(factory);

  const regularOnly = calculateEffectiveLaborCapacity(makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 }), capacity);
  const temporaryOnly = calculateEffectiveLaborCapacity(makeAssignment({ regularHeadcount: 0, temporaryHeadcount: 10 }), capacity);

  assert.ok(effectiveLaborCapacityForProduct(regularOnly, "hoso") > effectiveLaborCapacityForProduct(temporaryOnly, "hoso"));
});

test("人員増加の効果は設備能力（商品別能力プール）を超えない", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(50) });
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const result = calculateEffectiveLaborCapacity(makeAssignment({ regularHeadcount: 10000 }), capacity);
  assert.ok(effectiveLaborCapacityForProduct(result, "hoso") <= 50 + 1e-6);
});

test("残業効果は設定上限（overtimeRateCap）を超えない", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000) });
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const atCap = calculateEffectiveLaborCapacity(makeAssignment({ overtimeRate: ratio(PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap) }), capacity);
  const beyondCap = calculateEffectiveLaborCapacity(makeAssignment(), capacity, 5); // overtimeRateOverride=5 (上限を大幅に超える)
  assert.ok(Math.abs(effectiveLaborCapacityForProduct(atCap, "hoso") - effectiveLaborCapacityForProduct(beyondCap, "hoso")) < 1e-6);
  assert.ok(unwrapUnit(beyondCap.appliedOvertimeRate) <= PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap + 1e-9);
});

test("欠勤・稼働可能率が低いほど有効労働能力は下がる", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000) });
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const fullAttendance = calculateEffectiveLaborCapacity(makeAssignment({ attendanceRate: ratio(1) }), capacity);
  const halfAttendance = calculateEffectiveLaborCapacity(makeAssignment({ attendanceRate: ratio(0.5) }), capacity);
  assert.ok(effectiveLaborCapacityForProduct(fullAttendance, "hoso") > effectiveLaborCapacityForProduct(halfAttendance, "hoso"));
});

test("臨時ワーカー比率は正しく算出される", () => {
  const factory = makeFactory();
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const result = calculateEffectiveLaborCapacity(makeAssignment({ regularHeadcount: 8, temporaryHeadcount: 2 }), capacity);
  assert.ok(Math.abs(unwrapUnit(result.temporaryWorkerShare) - 0.2) < 1e-6);
});

test("入力を変更しない（不変性）", () => {
  const factory = makeFactory();
  const capacity = calculateFactoryEffectiveCapacity(factory);
  const assignment = makeAssignment();
  const before = JSON.stringify(assignment);
  calculateEffectiveLaborCapacity(assignment, capacity);
  assert.equal(JSON.stringify(assignment), before);
});
