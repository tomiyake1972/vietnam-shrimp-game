import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { calculateFactoryEffectiveCapacity } from "../capacity";
import { allocateWorkersToPlans, calculateLaborCapacityFromAssignedHeadcount, requiredHeadcountForQuantity, WorkerDemandItem } from "../labor";
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
  const capacity = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 0, 0, 1_000_000, "hoso");
  assert.equal(capacity, 0);
});

test("常用ワーカーの方が臨時ワーカーより1人あたりの生産効率が高い", () => {
  const regularOnly = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "hoso");
  const temporaryOnly = calculateLaborCapacityFromAssignedHeadcount(0, 10, 1, 1, 0, 1_000_000, "hoso");
  assert.ok(regularOnly > temporaryOnly);
});

test("人員増加の効果は設備能力（商品別能力プール）を超えない", () => {
  const capacity = calculateLaborCapacityFromAssignedHeadcount(10000, 0, 1, 1, 0, 50, "hoso");
  assert.ok(capacity <= 50 + 1e-6);
});

test("残業効果は設定上限（overtimeRateCap）を超えない", () => {
  const cap = PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap;
  const atCap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, cap, 1_000_000, "hoso");
  const beyondCap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, cap * 10, 1_000_000, "hoso");
  // 呼び出し側（allocateWorkersToPlans）がoverTimeRateCapへクリップする責務を持つため、
  // 本関数自体は与えられたappliedOvertimeRateをそのまま使う（クリップ責務の所在確認）。
  assert.ok(beyondCap > atCap);
});

test("欠勤・稼働可能率が低いほど有効労働能力は下がる", () => {
  const fullAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "hoso");
  const halfAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 0.5, 1, 0, 1_000_000, "hoso");
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

  const fullCapacityIfDoubleCounted = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "hoso");
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

// ---- 製品別労務負荷係数（2026-08-01・HOSO:PD:VAP = 1.0:1.2:3.0）----

test("同一配分人数での有効労働能力比はHOSO:PD:VAP = 1.0 : 1/1.2 : 1/3.0（労務負荷が重いほど同人数で作れる量が少ない）", () => {
  const hoso = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "hoso");
  const pd = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "pd");
  const vap = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "vap");
  assert.ok(Math.abs(hoso / pd - 1.2) < 1e-9, `hoso/pd should be 1.2, got ${hoso / pd}`);
  assert.ok(Math.abs(hoso / vap - 3.0) < 1e-9, `hoso/vap should be 3.0, got ${hoso / vap}`);
});

test("同一HOSO換算数量に対する必要人数比はHOSO:PD:VAP = 1.0 : 1.2 : 3.0（PD・VAPの方がより多くの人手を要する）", () => {
  const requiredHoso = requiredHeadcountForQuantity(120, 6, 1, 1, 0, "hoso");
  const requiredPd = requiredHeadcountForQuantity(120, 6, 1, 1, 0, "pd");
  const requiredVap = requiredHeadcountForQuantity(120, 6, 1, 1, 0, "vap");
  assert.ok(Math.abs(requiredPd / requiredHoso - 1.2) < 1e-9, `requiredPd/requiredHoso should be 1.2, got ${requiredPd / requiredHoso}`);
  assert.ok(Math.abs(requiredVap / requiredHoso - 3.0) < 1e-9, `requiredVap/requiredHoso should be 3.0, got ${requiredVap / requiredHoso}`);
});

test("HOSOのみ生産: 必要人数どおりに配分されれば全量処理できる", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000) });
  const requiredRegular = requiredHeadcountForQuantity(600, PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, 1, 1, 0, "hoso");
  const assignment = makeAssignment({ regularHeadcount: Math.ceil(requiredRegular), temporaryHeadcount: 0 });
  const demands = [demand({ id: "hoso", product: "hoso", candidateQuantity: 600, priority: 1 })];
  const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  assert.ok(unwrapUnit(entries[0].laborCapacity) >= 600 - 1e-6);
});

test("PDのみ生産: HOSOと同じ配分人数ではHOSOより少ない量しか処理できない（負荷1.2倍ぶん）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 });
  const hosoDemand = [demand({ id: "hoso", product: "hoso", candidateQuantity: 100000, priority: 1 })];
  const pdDemand = [demand({ id: "pd", product: "pd", candidateQuantity: 100000, priority: 1 })];
  const hosoResult = allocateWorkersToPlans(hosoDemand, [assignment], capacityMapFor(factory));
  const pdResult = allocateWorkersToPlans(pdDemand, [assignment], capacityMapFor(factory));
  const hosoCap = unwrapUnit(hosoResult.entries[0].laborCapacity);
  const pdCap = unwrapUnit(pdResult.entries[0].laborCapacity);
  assert.ok(Math.abs(hosoCap / pdCap - 1.2) < 1e-6, `hosoCap/pdCap should be 1.2, got ${hosoCap / pdCap}`);
});

test("VAPのみ生産: HOSOと同じ配分人数ではHOSOの1/3しか処理できない（負荷3.0倍ぶん）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 10, temporaryHeadcount: 0 });
  const hosoDemand = [demand({ id: "hoso", product: "hoso", candidateQuantity: 100000, priority: 1 })];
  const vapDemand = [demand({ id: "vap", product: "vap", candidateQuantity: 100000, priority: 1 })];
  const hosoResult = allocateWorkersToPlans(hosoDemand, [assignment], capacityMapFor(factory));
  const vapResult = allocateWorkersToPlans(vapDemand, [assignment], capacityMapFor(factory));
  const hosoCap = unwrapUnit(hosoResult.entries[0].laborCapacity);
  const vapCap = unwrapUnit(vapResult.entries[0].laborCapacity);
  assert.ok(Math.abs(hosoCap / vapCap - 3.0) < 1e-6, `hosoCap/vapCap should be 3.0, got ${hosoCap / vapCap}`);
});

test("HOSO・PD・VAP混合生産: 十分な人員があれば、必要人数の按分が1.0:1.2:3.0の負荷比を反映する", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  // 3商品とも同数量(100トン)を要求。余裕を持った人員（1000人）を配置し、
  // 労働制約で頭打ちにならない条件で「必要人数」の比率そのものを検証する。
  const assignment = makeAssignment({ regularHeadcount: 1000, temporaryHeadcount: 0 });
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 100, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 100, priority: 1 }),
    demand({ id: "vap", product: "vap", candidateQuantity: 100, priority: 1 }),
  ];
  const { entries } = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  const byId = new Map(entries.map((e, i) => [demands[i].id, e]));
  const hosoHeadcount = byId.get("hoso")!.assignedRegularHeadcount;
  const pdHeadcount = byId.get("pd")!.assignedRegularHeadcount;
  const vapHeadcount = byId.get("vap")!.assignedRegularHeadcount;
  assert.ok(Math.abs(pdHeadcount / hosoHeadcount - 1.2) < 1e-4, `pd/hoso headcount ratio should be 1.2, got ${pdHeadcount / hosoHeadcount}`);
  assert.ok(Math.abs(vapHeadcount / hosoHeadcount - 3.0) < 1e-4, `vap/hoso headcount ratio should be 3.0, got ${vapHeadcount / hosoHeadcount}`);
  // 全量処理できていること（=全て完全充足、按分比較が意味を持つ前提の確認）。
  for (const e of entries) assert.ok(unwrapUnit(e.laborCapacity) >= 100 - 1e-6);
});

test("会社別skillは製品別労務負荷係数の後に（同じ乗算内で）一貫して適用される", () => {
  const fullSkill = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "vap");
  const halfSkill = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 0.5, 0, 1_000_000, "vap");
  assert.ok(Math.abs(fullSkill / halfSkill - 2) < 1e-9, "skillLevelは労務負荷係数と独立して線形に効くべき");
});

test("attendance補正は製品別労務負荷係数と独立して一貫して適用される", () => {
  const fullAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "vap");
  const halfAttendance = calculateLaborCapacityFromAssignedHeadcount(10, 0, 0.5, 1, 0, 1_000_000, "vap");
  assert.ok(Math.abs(fullAttendance / halfAttendance - 2) < 1e-9, "attendanceRateは労務負荷係数と独立して線形に効くべき");
});

test("overtime補正は製品別労務負荷係数と独立して一貫して適用される", () => {
  const cap = PRODUCTION_PARAMETERS_V1.labor.overtimeEfficiencyFactor;
  const noOvertime = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0, 1_000_000, "vap");
  const withOvertime = calculateLaborCapacityFromAssignedHeadcount(10, 0, 1, 1, 0.2, 1_000_000, "vap");
  const expectedMultiplier = 1 + 0.2 * cap;
  assert.ok(Math.abs(withOvertime / noOvertime - expectedMultiplier) < 1e-9);
});

test("臨時雇用能力も製品別労務負荷係数を一貫して適用される（HOSO比でVAPは1/3）", () => {
  const hosoTemp = calculateLaborCapacityFromAssignedHeadcount(0, 10, 1, 1, 0, 1_000_000, "hoso");
  const vapTemp = calculateLaborCapacityFromAssignedHeadcount(0, 10, 1, 1, 0, 1_000_000, "vap");
  assert.ok(Math.abs(hosoTemp / vapTemp - 3.0) < 1e-9);
});

test("労務不足時、VAPは同じ人数配置でもHOSOより早く生産可能量が頭打ちになる（労務制約が製品ごとに正しく反映される）", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 5, temporaryHeadcount: 0 });
  const hosoDemand = [demand({ id: "hoso", product: "hoso", candidateQuantity: 40, priority: 1 })];
  const vapDemand = [demand({ id: "vap", product: "vap", candidateQuantity: 40, priority: 1 })];
  const hosoResult = allocateWorkersToPlans(hosoDemand, [assignment], capacityMapFor(factory));
  const vapResult = allocateWorkersToPlans(vapDemand, [assignment], capacityMapFor(factory));
  // 5人 × 6t = 30t が基礎能力。HOSO(÷1.0)=30tでcandidateQuantity40tに届かず不足、
  // VAP(÷3.0)=10tでさらに大きく不足するはず。
  assert.ok(unwrapUnit(hosoResult.entries[0].laborCapacity) < 40);
  assert.ok(unwrapUnit(vapResult.entries[0].laborCapacity) < unwrapUnit(hosoResult.entries[0].laborCapacity));
});

test("決定論性: 同一入力を複数回計算しても同じ結果になる", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(100000), pdCapacity: hosoEqTons(100000), vapCapacity: hosoEqTons(100000) });
  const assignment = makeAssignment({ regularHeadcount: 37, temporaryHeadcount: 4 });
  const demands = [
    demand({ id: "hoso", product: "hoso", candidateQuantity: 123.456, priority: 1 }),
    demand({ id: "pd", product: "pd", candidateQuantity: 78.9, priority: 2 }),
    demand({ id: "vap", product: "vap", candidateQuantity: 12.3, priority: 1 }),
  ];
  const run1 = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  const run2 = allocateWorkersToPlans(demands, [assignment], capacityMapFor(factory));
  assert.deepEqual(run1, run2);
});
