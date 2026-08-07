import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { allocateProductionPlans } from "../allocation";
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

test("十分な資源があれば希望量どおり生産できる", () => {
  const result = allocateProductionPlans([makePlan()], [makeFactory()], [makeAssignment()], [makeLot()], P1);
  assert.equal(result.entries.length, 1);
  const e = result.entries[0];
  assert.ok(unwrapUnit(e.allocatedQuantity) > 0);
  assert.equal(unwrapUnit(e.shortfallQuantity), 0);
  assert.deepEqual(e.shortfallReasons, []);
});

test("原料不足では原料在庫を超えて生産しない（rawMaterialShortage）", () => {
  const lot = makeLot({ remainingQuantity: hosoEqTons(1), originalQuantity: hosoEqTons(1) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(1000) })], [makeFactory()], [makeAssignment()], [lot], P1);
  const e = result.entries[0];
  assert.ok(unwrapUnit(e.allocatedQuantity) < 1000);
  assert.ok(e.shortfallReasons.includes("rawMaterialShortage"));
});

test("ワーカー不足では設備能力があっても生産できない", () => {
  const assignment = makeAssignment({ regularHeadcount: 0, temporaryHeadcount: 0 });
  const result = allocateProductionPlans([makePlan()], [makeFactory()], [assignment], [makeLot()], P1);
  const e = result.entries[0];
  assert.equal(unwrapUnit(e.allocatedQuantity), 0);
  assert.ok(e.shortfallReasons.includes("laborShortage"));
});

test("共通設備不足はcommonCapacityShortageとして表面化する", () => {
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(1) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(500) })], [factory], [makeAssignment()], [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })], P1);
  const e = result.entries[0];
  assert.ok(e.shortfallReasons.includes("commonCapacityShortage"));
});

test("商品別設備不足はproductCapacityShortageとして表面化する", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(1) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(500) })], [factory], [makeAssignment()], [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })], P1);
  const e = result.entries[0];
  assert.ok(e.shortfallReasons.includes("productCapacityShortage"));
});

test("包装・冷凍能力不足はpackagingCapacityShortageとして表面化する", () => {
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(1) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(500) })], [factory], [makeAssignment()], [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })], P1);
  const e = result.entries[0];
  assert.ok(e.shortfallReasons.includes("packagingCapacityShortage"));
});

test("HOSO・PD・VAPはそれぞれ専用能力を消費し、他商品の専用能力は減らない", () => {
  const factory = makeFactory({ hosoCapacity: hosoEqTons(1), pdCapacity: hosoEqTons(1000), vapCapacity: hosoEqTons(1000) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(500), priority: 1 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(50), priority: 1 }),
  ];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })];
  const result = allocateProductionPlans(plans, [factory], [makeAssignment()], lots, P1);
  const hosoEntry = result.entries.find((e) => e.product === "hoso")!;
  const pdEntry = result.entries.find((e) => e.product === "pd")!;
  assert.ok(unwrapUnit(hosoEntry.allocatedQuantity) < 500); // hoso専用能力(1)に制約される
  assert.ok(unwrapUnit(pdEntry.allocatedQuantity) > 0); // pdはhosoの制約を受けない
});

test("共通能力は商品間で二重使用されない（合計が予算を超えない）", () => {
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(100) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(80), priority: 1 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(80), priority: 1 }),
  ];
  const lots = [makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) })];
  const result = allocateProductionPlans(plans, [factory], [makeAssignment()], lots, P1);
  const total = result.entries.reduce((sum, e) => sum + unwrapUnit(e.stages.commonCapacityLimited), 0);
  assert.ok(total <= 100 + 0.02);
});

test("優先順位が高い計画から先に資源が割り当てられる（原料不足時）", () => {
  const lot = makeLot({ remainingQuantity: hosoEqTons(50), originalQuantity: hosoEqTons(50) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(100), priority: 2 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(100), priority: 1 }),
  ];
  const result = allocateProductionPlans(plans, [makeFactory()], [makeAssignment()], [lot], P1);
  const highPriority = result.entries.find((e) => e.product === "pd")!;
  const lowPriority = result.entries.find((e) => e.product === "hoso")!;
  assert.ok(unwrapUnit(highPriority.allocatedQuantity) > 0);
  // 高優先度が希望量を満たしきれる資源があるため、低優先度への配分はより厳しく制約される
  assert.ok(unwrapUnit(highPriority.allocatedQuantity) >= unwrapUnit(lowPriority.allocatedQuantity));
});

test("同順位では入力順に依存しない決定論的配分になる", () => {
  const lot = makeLot({ remainingQuantity: hosoEqTons(50), originalQuantity: hosoEqTons(50) });
  const planA = makePlan({ product: "hoso", desiredQuantity: hosoEqTons(100), priority: 1 });
  const planB = makePlan({ product: "pd", desiredQuantity: hosoEqTons(50), priority: 1 });

  const result1 = allocateProductionPlans([planA, planB], [makeFactory()], [makeAssignment()], [lot], P1);
  const result2 = allocateProductionPlans([planB, planA], [makeFactory()], [makeAssignment()], [lot], P1);

  const a1 = result1.entries.find((e) => e.product === "hoso")!;
  const a2 = result2.entries.find((e) => e.product === "hoso")!;
  const b1 = result1.entries.find((e) => e.product === "pd")!;
  const b2 = result2.entries.find((e) => e.product === "pd")!;
  assert.ok(Math.abs(unwrapUnit(a1.allocatedQuantity) - unwrapUnit(a2.allocatedQuantity)) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(b1.allocatedQuantity) - unwrapUnit(b2.allocatedQuantity)) < 1e-6);
});

test("いずれの制約も超えない（希望量・原料・共通設備・商品別設備・包装/冷凍・労働の最小値）", () => {
  const factory = makeFactory({
    commonProcessingCapacity: hosoEqTons(40),
    hosoCapacity: hosoEqTons(1000),
    freezingPackagingCapacity: hosoEqTons(1000),
  });
  const lot = makeLot({ remainingQuantity: hosoEqTons(1000), originalQuantity: hosoEqTons(1000) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(1000) })], [factory], [makeAssignment()], [lot], P1);
  const e = result.entries[0];
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 40 + 0.02);
});

test("通常操業時（saleableRecoveryRatio=1.00基準）はPD/VAPとも必要原料量=完成品HOSO換算量となり、" +
  "回収率を下げた場合のみ必要原料量が増える（Phase 7向けの構造フック）", () => {
  const factory = makeFactory();
  const lot = makeLot({ remainingQuantity: hosoEqTons(10000), originalQuantity: hosoEqTons(10000) });
  const plans = [
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(80), priority: 1 }),
    makePlan({ product: "vap", desiredQuantity: hosoEqTons(80), priority: 1 }),
  ];
  // 基準（1.00）: 正常な頭・殻の除去ではHOSO換算量を減らさないため、必要原料量=完成品量。
  const result = allocateProductionPlans(plans, [factory], [makeAssignment()], [lot], P1);
  const pd = result.entries.find((e) => e.product === "pd")!;
  const vap = result.entries.find((e) => e.product === "vap")!;
  assert.ok(Math.abs(unwrapUnit(pd.requiredRawMaterialQuantity) - 80) < 0.5);
  assert.ok(Math.abs(unwrapUnit(vap.requiredRawMaterialQuantity) - 80) < 0.5);

  // Phase 7向け構造フック: 真の損失（品質不良・廃棄等）を回収率で与えると必要原料量が増える。
  const lossyParams = {
    ...PRODUCTION_PARAMETERS_V1,
    yield: {
      ...PRODUCTION_PARAMETERS_V1.yield,
      saleableRecoveryRatio: { hoso: 1.0, pd: 1.0, vap: 0.9 },
    },
  };
  const lossyResult = allocateProductionPlans(plans, [factory], [makeAssignment()], [lot], P1, lossyParams);
  const lossyVap = lossyResult.entries.find((e) => e.product === "vap")!;
  assert.ok(unwrapUnit(lossyVap.requiredRawMaterialQuantity) > unwrapUnit(vap.requiredRawMaterialQuantity));
});

test("100人しかいない工場でHOSO+PD+VAPの合計配分人数が100を超えない（Phase6.1: ワーカー共有プール）", () => {
  const factory = makeFactory({
    commonProcessingCapacity: hosoEqTons(100000),
    hosoCapacity: hosoEqTons(100000),
    pdCapacity: hosoEqTons(100000),
    vapCapacity: hosoEqTons(100000),
    freezingPackagingCapacity: hosoEqTons(100000),
  });
  const assignment = makeAssignment({ regularHeadcount: 100, temporaryHeadcount: 0 });
  const lot = makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(10000), priority: 1 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(10000), priority: 1 }),
    makePlan({ product: "vap", desiredQuantity: hosoEqTons(10000), priority: 1 }),
  ];
  const result = allocateProductionPlans(plans, [factory], [assignment], [lot], P1);

  const totalRegular = result.entries.reduce((sum, e) => sum + e.labor.assignedRegularHeadcount, 0);
  const totalTemporary = result.entries.reduce((sum, e) => sum + e.labor.assignedTemporaryHeadcount, 0);
  assert.ok(totalRegular <= 100 + 1e-6, `同じ100人が複数商品へ重複計上されている: ${totalRegular}`);
  assert.equal(totalTemporary, 0);

  assert.equal(result.factoryWorkerSummaries.length, 1);
  const summary = result.factoryWorkerSummaries[0];
  assert.ok(Math.abs(totalRegular + summary.unassignedRegularHeadcount - 100) < 1e-6, "配分済み+未配分=配置人数の保存則が崩れている");
});

test("常用・臨時ワーカーは別々に保存される（工場全体でのentries.labor集計）", () => {
  const factory = makeFactory({
    commonProcessingCapacity: hosoEqTons(100000),
    hosoCapacity: hosoEqTons(100000),
    pdCapacity: hosoEqTons(100000),
    freezingPackagingCapacity: hosoEqTons(100000),
  });
  const assignment = makeAssignment({ regularHeadcount: 15, temporaryHeadcount: 8 });
  const lot = makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(10000), priority: 1 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(10000), priority: 1 }),
  ];
  const result = allocateProductionPlans(plans, [factory], [assignment], [lot], P1);

  const totalRegular = result.entries.reduce((sum, e) => sum + e.labor.assignedRegularHeadcount, 0);
  const totalTemporary = result.entries.reduce((sum, e) => sum + e.labor.assignedTemporaryHeadcount, 0);
  assert.ok(totalRegular <= 15 + 1e-6);
  assert.ok(totalTemporary <= 8 + 1e-6);

  const summary = result.factoryWorkerSummaries[0];
  assert.ok(Math.abs(totalRegular + summary.unassignedRegularHeadcount - 15) < 1e-6);
  assert.ok(Math.abs(totalTemporary + summary.unassignedTemporaryHeadcount - 8) < 1e-6);
});

test("工場共通処理能力は原料投入側の数量で制約される（完成品側の物理歩留まりを二重に掛けない）", () => {
  // commonProcessingCapacity=100を原料投入HOSO換算量の上限として設定。PDの
  // saleableRecoveryRatio(0.97)適用後の完成品量は、100 * 0.97 ≈ 97 に近い値に
  // なるはずで、物理歩留まり(0.80)を掛けた80や、二重適用による80*0.97のような
  // 値にはならない。
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(100), pdCapacity: hosoEqTons(100000), freezingPackagingCapacity: hosoEqTons(100000) });
  const lot = makeLot({ remainingQuantity: hosoEqTons(100000), originalQuantity: hosoEqTons(100000) });
  const plans = [makePlan({ product: "pd", desiredQuantity: hosoEqTons(1000), priority: 1 })];
  const result = allocateProductionPlans(plans, [factory], [makeAssignment()], [lot], P1);
  const e = result.entries[0];
  assert.ok(unwrapUnit(e.stages.commonCapacityLimited) > 90, `commonCapacityLimitedが物理歩留まりで二重に減らされている: ${unwrapUnit(e.stages.commonCapacityLimited)}`);
  assert.ok(unwrapUnit(e.stages.commonCapacityLimited) <= 100 + 0.02);
});

test("入力（plans/factories/workerAssignments/rawMaterialLots）を変更しない", () => {
  const plans = [makePlan()];
  const factories = [makeFactory()];
  const assignments = [makeAssignment()];
  const lots = [makeLot()];
  const before = JSON.stringify({ plans, factories, assignments, lots });
  allocateProductionPlans(plans, factories, assignments, lots, P1);
  assert.equal(JSON.stringify({ plans, factories, assignments, lots }), before);
});
