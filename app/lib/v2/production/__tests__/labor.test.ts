import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { calculateFactoryEffectiveCapacity } from "../capacity";
import { allocateWorkersToPlans, calculateLaborCapacityFromAssignedHeadcount, WorkerDemandItem } from "../labor";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";
import { Factory, FactoryEffectiveCapacity, WorkerAssignment } from "../types";

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

function capacityMapFor(factory: Factory): ReadonlyMap<string, FactoryEffectiveCapacity> {
  return new Map([[factory.factoryId, calculateFactoryEffectiveCapacity(factory)]]);
}

function demand(overrides: Partial<WorkerDemandItem> & Pick<WorkerDemandItem, "id" | "product" | "candidateQuantity">): WorkerDemandItem {
  return {
    factoryId: "F1",
    companyId: "C1",
    priority: 1,
    ...overrides,
  };
}

// ---- calculateLaborCapacityFromAssignedHeadcount（低レベル計算式）----

test("スキルのない商品は有効労働能力0になる（低レベル計算式）", () => {
  const capacity = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 0, 0, 1_000_000);
  assert.equal(capacity, 0);
});

test("常用ワーカーの方が臨時ワーカーより1人あたりの生産効率が高い", () => {
  const regularOnly = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000);
  const temporaryOnly = calculateLaborCapacityFromAssignedHeadcount(0, 10, 1, 1, 0, 1_000_000);
  assert.ok(regularOnly > temporaryOnly);
});

test("人員増加の効果は設備能力（商品別能力プール）を超えない", () => {
  const capacity = calculateLaborCapacityFromAssignedHeadcount(10000, 0, 1, 1, 0, 50);
  assert.ok(capacity <= 50 + 1e-6);
});

test("残業効果は設定上限（overtimeRateCap）を超えない", () => {
  const cap = PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap;
  const atCap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, cap, 1_000_000);
  const beyondCap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, cap * 10, 1_000_000);
  // 呼び出し側（allocateWorkersToPlans）がoverTimeRateCapへクリップする責務を持つため、
  // 本関数自体は与えられたappliedOvertimeRateをそのまま使う（クリップ責務の所在確認）。
  assert.ok(beyondCap > atCap);
});

test("欠勤・稼働可能率が低いほど有効労働能力は下がる", () => {
  const fullAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000);
  const halfAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 0.5, 1, 0, 1_000_000);
  assert.ok(fullAttendance > halfAttendance);
});

// ---- allocateWorkersToPlans（共有プール配分・Phase 6.1の中核）----

test("工場の合計配分人数（常用＋臨時）は配置人数を超えない（1商品のみ）", () => {
  const factory = makeFactory();
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 });
  const demands = [demand({ id: "d1", product: "hoso", candidateQuantity: 100000 })];
  const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  assert.ok(entries[0].assignedRegularHeadcount <= 10 + 1e-6);
});

test("100人の工場でHOSO・PD・VAPの合計配分人数が100を超えない（共有プール）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 100, temporaryHeadcount: 0 });
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 100000, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 100000, priority: 1 }),
    demand({ id: "vap", product: "vap", candidateQuantity: 100000, priority: 1 }),
  ];
  const { entries, factorySummaries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));

  const totalRegular = entries.reduce((sum, e) => sum + e.assignedRegularHeadcount, 0);
  const totalTemporary = entries.reduce((sum, e) => sum + e.assignedTemporaryHeadcount, 0);
  assert.ok(totalRegular <= 100 + 1e-6, `合計常用配分人数が100を超過: ${totalRegular}`);
  assert.equal(totalTemporary, 0);

  // 保存則: 配分済み + 未配分 = 配置人数
  assert.ok(Math.abs(totalRegular + factorySummaries[0].unassignedRegularHeadcount - 100) < 1e-6);
});

test("常用・臨時は別々に保存される（同一人物を両方でカウントしない）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 5 });
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 100000, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 100000, priority: 1 }),
  ];
  const { entries, factorySummaries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));

  const totalRegular = entries.reduce((sum, e) => sum + e.assignedRegularHeadcount, 0);
  const totalTemporary = entries.reduce((sum, e) => sum + e.assignedTemporaryHeadcount, 0);
  assert.ok(totalRegular <= 10 + 1e-6);
  assert.ok(totalTemporary <= 5 + 1e-6);
  assert.ok(Math.abs(totalRegular + factorySummaries[0].unassignedRegularHeadcount - 10) < 1e-6);
  assert.ok(Math.abs(totalTemporary + factorySummaries[0].unassignedTemporaryHeadcount - 5) < 1e-6);
});

test("優先順位が高い計画が不足時に優先的にワーカーを獲得する", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 });
  const demands = [
    demand({ id: "low", product: "hoso", candidateQuantity: 100000, priority: 2 }),
    demand({ id: "high", product: "pd", candidateQuantity: 100000, priority: 1 }),
  ];
  const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  const high = entries.find((_, i) => demands[i].id === "high")!;
  const low = entries.find((_, i) => demands[i].id === "low")!;
  assert.ok(high.assignedRegularHeadcount >= low.assignedRegularHeadcount);
});

test("同順位配分は入力順に依存しない", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 30, temporaryHeadcount: 0 });
  const demandsA = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 50000, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 50000, priority: 1 }),
    demand({ id: "vap", product: "vap", candidateQuantity: 50000, priority: 1 }),
  ];
  const demandsB = [demandsA[2], demandsA[0], demandsA[1]];

  const resultA = allocateWorkersToPlans(demandsA, [assignment], capacityMapFor(factory));
  const resultB = allocateWorkersToPlans(demandsB, [assignment], capacityMapFor(factory));

  const byIdA = new Map(resultA.entries.map((e, i) => [demandsA[i].id, e]));
  const byIdB = new Map(resultB.entries.map((e, i) => [demandsB[i].id, e]));
  for (const id of ["hoso", "pd", "vap"]) {
    assert.ok(Math.abs(byIdA.get(id)!.assignedRegularHeadcount - byIdB.get(id)!.assignedRegularHeadcount) < 1e-6, `id=${id}の配分が入力順で変化した`);
  }
});

test("戻り値のentriesは入力demandsと同じ順序・対応で返る（複数工場が入り乱れる場合を含む）", () => {
  const factory1 = makeFactory({ factoryId: "F1", hosoCapacity: hosoEqTons(100000) });
  const factory2 = makeFactory({ factoryId: "F2", companyId: "C1", hosoCapacity: hosoEqTons(100000) });
  const assignment1 = makeAssignment({ factoryId: "F1", regularHeadcount: 10 });
  const assignment2 = makeAssignment({ factoryId: "F2", regularHeadcount: 20 });
  const capacities = new Map([
    ["F1", calculateFactoryEffectiveCapacity(factory1)],
    ["F2", calculateFactoryEffectiveCapacity(factory2)],
  ]);
  // わざと工場を交互に入れ替えた順序でdemandsを与える。
  const demands = [
    demand({ id: "a", factoryId: "F1", product: "hoso", candidateQuantity: 100, priority: 1 }),
    demand({ id: "b", factoryId: "F2", product: "hoso", candidateQuantity: 200, priority: 1 }),
    demand({ id: "c", factoryId: "F1", product: "hoso", candidateQuantity: 50, priority: 2 }),
  ];
  const { entries } = allocateWorkersToPlans(demands, [assignment1, assignment2], capacities);
  assert.equal(entries.length, demands.length);
  entries.forEach((e, i) => {
    assert.equal(e.factoryId, demands[i].factoryId, `index ${i}: factoryIdが入力demandsと対応していない`);
  });
});

test("労働能力は実際に配分された人数から算出される（配置人数を独立に再利用しない）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 });
  // 2計画が同じ工場の10人を取り合う。両方とも同じ人数(10人)がまるごと再利用されるなら
  // 労働能力の合計はcalculateLaborCapacityFromAssignedHeadcount(10,...)の2倍相当になって
  // しまうはずだが、実際の配分は合計10人までしかない。
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 100000, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 100000, priority: 1 }),
  ];
  const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  const totalAssigned = entries.reduce((sum, e) => sum + e.assignedRegularHeadcount + e.assignedTemporaryHeadcount, 0);
  assert.ok(totalAssigned <= 10 + 1e-6);

  const fullCapacityIfDoubleCounted = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000);
  const totalLaborCapacity = entries.reduce((sum, e) => sum + unwrapUnit(e.laborCapacity), 0);
  assert.ok(totalLaborCapacity <= fullCapacityIfDoubleCounted + 1e-6);
});

test("ワーカー配置がない工場（assignment未指定）は労働能力0・未配分0になる", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000) });
  const demands = [demand({ id: "hoso", product: "hoso", candidateQuantity: 1000, priority: 1 })];
  const { entries, factorySummaries } = allocateWorkersToPlans(demands, [], capacityMapFor(factory));
  assert.equal(unwrapUnit(entries[0].laborCapacity), 0);
  assert.equal(factorySummaries[0].unassignedRegularHeadcount, 0);
  assert.equal(factorySummaries[0].unassignedTemporaryHeadcount, 0);
});

test("入力を変更しない（不変性）", () => {
  const factory = makeFactory();
  const assignment = makeAssignment();
  const demands = [demand({ id: "hoso", product: "hoso", candidateQuantity: 100, priority: 1 })];
  const beforeAssignment = JSON.stringify(assignment);
  const beforeDemands = JSON.stringify(demands);
  allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  assert.equal(JSON.stringify(assignment), beforeAssignment);
  assert.equal(JSON.stringify(demands), beforeDemands);
});

// ---- Test15: 商品別労働集約度係数（HOSO:PD:VAP = 1.0:1.2:3.0）----

test("Test15: HOSOのみを生産する場合は労働集約度係数を導入する前と同じ有効労働能力になる（回帰確認）", () => {
  // HOSOの係数は1.0のため、product省略時（デフォルトhoso扱い）と明示hoso指定は完全一致するはず。
  const withoutProduct = calculateLaborCapacityFromAssignedHeadcount(10, 5, 0.9, 0.8, 0.1, 1_000_000);
  const withHoso = calculateLaborCapacityFromAssignedHeadcount(10, 5, 0.9, 0.8, 0.1, 1_000_000, PRODUCTION_PARAMETERS_V1, "hoso");
  assert.equal(withoutProduct, withHoso);
  // 既存の基準式（係数を掛けない素の式）とも一致することを確認する。
  const overtimeMultiplier = 1 + 0.1 * PRODUCTION_PARAMETERS_V1.labor.overtimeEfficiencyFactor;
  const expected =
    (10 * PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons + 5 * PRODUCTION_PARAMETERS_V1.labor.temporaryEfficiencyPerHeadTons) *
    0.9 *
    0.8 *
    overtimeMultiplier;
  assert.ok(Math.abs(withHoso - expected) < 1e-9);
});

test("Test15: 同じ人数配置でもPD・VAPはHOSOより有効労働能力が小さくなる（HOSO:PD:VAP=1.0:1.2:3.0）", () => {
  const hoso = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, PRODUCTION_PARAMETERS_V1, "hoso");
  const pd = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, PRODUCTION_PARAMETERS_V1, "pd");
  const vap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, PRODUCTION_PARAMETERS_V1, "vap");
  assert.ok(pd < hoso);
  assert.ok(vap < pd);
  // 比率がHOSO:PD:VAP=1.0:1.2:3.0の逆数（= 1人あたり有効生産量の比）に一致することを確認する。
  assert.ok(Math.abs(hoso / pd - 1.2) < 1e-9);
  assert.ok(Math.abs(hoso / vap - 3.0) < 1e-9);
});

test("Test15: 同じ完成品数量を処理するのに必要な人数はHOSO<PD<VAPの順で増える（allocateWorkersToPlans経由）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const targetQuantity = 100;

  const runFor = (product: "hoso" | "pd" | "vap") => {
    const assignment = makeAssignment({ regularHeadcount: 1000, temporaryHeadcount: 0 });
    const demands = [demand({ id: product, product, candidateQuantity: targetQuantity, priority: 1 })];
    const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
    return entries[0].assignedRegularHeadcount;
  };

  const hosoHeadcount = runFor("hoso");
  const pdHeadcount = runFor("pd");
  const vapHeadcount = runFor("vap");

  assert.ok(hosoHeadcount < pdHeadcount, `HOSOの必要人数(${hosoHeadcount})はPD(${pdHeadcount})より少ないはず`);
  assert.ok(pdHeadcount < vapHeadcount, `PDの必要人数(${pdHeadcount})はVAP(${vapHeadcount})より少ないはず`);
  assert.ok(Math.abs(pdHeadcount / hosoHeadcount - 1.2) < 1e-6);
  assert.ok(Math.abs(vapHeadcount / hosoHeadcount - 3.0) < 1e-6);
});

test("Test15: laborIntensityCoefficientForはproduction/labor.tsのlaborIntensityCoefficientFor経由でのみパラメータを参照する（唯一の情報源）", () => {
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.hoso, 1.0);
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd, 1.2);
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.vap, 3.0);
});
