// ShrimpX V2 — ENG-PROD-ALLOC-1 Production Allocation Capacity Enforcement（実装指示§5）
//
// 最終 allocatedQuantity が、段階1〜5（原料 / 共通前処理 / 冷凍・包装 / 商品別ライン / 労働）
// の**すべての**実効制約を満たすことを固定する。
//
// 【修正前の欠陥】allocation.ts は allocated = min(desired, laborLimited) で決めており、
// ワーカーに余力のある工場では冷凍・包装能力や商品ライン能力の取り分を超えて生産できた
// （SAI-EXEC-2 PRE-AUDIT 276bd5e §3-2）。
//
// 【期待値を独自計算しない】各テストは entry.stages（エンジン自身が出した各段階の制約値）
// と allocatedQuantity を突き合わせるだけで、能力式をテスト側で再実装しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { allocateProductionPlans } from "../allocation";
import { CompanyProductionPlanEntry, Factory, ProductionAllocationEntry, WorkerAssignment } from "../types";
import { RawMaterialLot } from "../../rawMaterials/types";

const P1 = period(2020, 1);
/** 丸め（roundHosoEqTons は小数2桁）に由来する差だけを許容する。 */
const TOLERANCE = 0.011;

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(100_000),
    hosoCapacity: hosoEqTons(100_000),
    pdCapacity: hosoEqTons(100_000),
    vapCapacity: hosoEqTons(100_000),
    freezingPackagingCapacity: hosoEqTons(100_000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

/** 設備制約を確実に上回る潤沢なワーカー（「余力があっても設備を突破しない」の検証用）。 */
function makeAssignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "C1",
    regularHeadcount: 100_000,
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
    originalQuantity: hosoEqTons(1_000_000),
    remainingQuantity: hosoEqTons(1_000_000),
    unitCost: usdPerHosoEqKg(5),
    availableFromPeriod: P1,
    status: "available",
    ...overrides,
  };
}

function makePlan(overrides: Partial<CompanyProductionPlanEntry> = {}): CompanyProductionPlanEntry {
  return { companyId: "C1", factoryId: "F1", product: "hoso", desiredQuantity: hosoEqTons(10_000), priority: 1, ...overrides };
}

/** §4 の必須不変条件。すべての entry に対して常に課す。 */
function assertCapacityInvariant(e: ProductionAllocationEntry, label: string): void {
  const a = unwrapUnit(e.allocatedQuantity);
  const s = e.stages;
  const checks: readonly [string, number][] = [
    ["desired", unwrapUnit(e.desiredQuantity)],
    ["rawMaterialLimited", unwrapUnit(s.rawMaterialLimited)],
    ["commonCapacityLimited", unwrapUnit(s.commonCapacityLimited)],
    ["freezingPackagingLimited", unwrapUnit(s.freezingPackagingLimited)],
    ["productCapacityLimited", unwrapUnit(s.productCapacityLimited)],
    ["laborLimited", unwrapUnit(s.laborLimited)],
  ];
  for (const [name, limit] of checks) {
    assert.ok(a <= limit + TOLERANCE, `${label}: allocated ${a} が ${name} ${limit} を超えている`);
  }
  assert.ok(a >= 0, `${label}: allocated が負`);
}

// =====================================================================
// 1〜5: 各制約単独
// =====================================================================

test("ALLOC-1: 共通前処理が不足していれば、その能力を超えて生産しない", () => {
  const r = allocateProductionPlans([makePlan()], [makeFactory({ commonProcessingCapacity: hosoEqTons(3_000) })], [makeAssignment()], [makeLot()], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-1");
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 3_000 + TOLERANCE, "共通前処理能力を超えている");
  assert.ok(e.shortfallReasons.includes("commonCapacityShortage"));
});

test("ALLOC-2: 冷凍・包装が不足していれば、その能力を超えて生産しない（ワーカー余力あり）", () => {
  const r = allocateProductionPlans([makePlan()], [makeFactory({ freezingPackagingCapacity: hosoEqTons(2_500) })], [makeAssignment()], [makeLot()], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-2");
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 2_500 + TOLERANCE, "冷凍・包装能力を超えている");
  assert.ok(e.shortfallReasons.includes("packagingCapacityShortage"));
});

test("ALLOC-3: 商品別ライン能力が不足していれば、その能力を超えて生産しない（ワーカー余力あり）", () => {
  const r = allocateProductionPlans([makePlan()], [makeFactory({ hosoCapacity: hosoEqTons(1_800) })], [makeAssignment()], [makeLot()], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-3");
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 1_800 + TOLERANCE, "商品別ライン能力を超えている");
  assert.ok(e.shortfallReasons.includes("productCapacityShortage"));
});

test("ALLOC-4: 労働が不足していれば、労働能力を超えて生産しない", () => {
  const r = allocateProductionPlans([makePlan()], [makeFactory()], [makeAssignment({ regularHeadcount: 5 })], [makeLot()], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-4");
  assert.equal(unwrapUnit(e.allocatedQuantity), unwrapUnit(e.stages.laborLimited));
  assert.ok(e.shortfallReasons.includes("laborShortage"));
});

test("ALLOC-5: 原料が不足していれば、原料制約を超えて生産しない", () => {
  const lot = makeLot({ originalQuantity: hosoEqTons(1_200), remainingQuantity: hosoEqTons(1_200) });
  const r = allocateProductionPlans([makePlan()], [makeFactory()], [makeAssignment()], [lot], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-5");
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 1_200 + TOLERANCE, "利用可能原料を超えて生産している");
  assert.ok(e.shortfallReasons.includes("rawMaterialShortage"));
});

// =====================================================================
// 6・7: 複数制約 / ワーカー余力
// =====================================================================

test("ALLOC-6: 複数の制約が同時に効く場合、最終生産量は最小値になる", () => {
  const factory = makeFactory({ commonProcessingCapacity: hosoEqTons(6_000), freezingPackagingCapacity: hosoEqTons(4_000), hosoCapacity: hosoEqTons(5_000) });
  const lot = makeLot({ originalQuantity: hosoEqTons(7_000), remainingQuantity: hosoEqTons(7_000) });
  const r = allocateProductionPlans([makePlan()], [factory], [makeAssignment()], [lot], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-6");
  const s = e.stages;
  const expected = Math.min(
    unwrapUnit(e.desiredQuantity),
    unwrapUnit(s.rawMaterialLimited),
    unwrapUnit(s.commonCapacityLimited),
    unwrapUnit(s.freezingPackagingLimited),
    unwrapUnit(s.productCapacityLimited),
    unwrapUnit(s.laborLimited)
  );
  assert.ok(Math.abs(unwrapUnit(e.allocatedQuantity) - expected) <= TOLERANCE, "最小値になっていない");
  // このケースは冷凍・包装(4,000)が最小のはず。
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 4_000 + TOLERANCE);
});

test("ALLOC-7: ワーカーがいくら余っていても設備制約を突破しない（SAI-EXEC-2 の欠陥形）", () => {
  // SAI-EXEC-2 PRE-AUDIT の最大ケース（ds3-f T31 / MASS NEWF-CAPEX-2 / HOSO）と同じ大小関係:
  //   desired 10,846 > labor 9,463 > freezing 9,234
  // 旧実装は allocated = min(desired, labor) = 9,463 となり冷凍・包装能力を 229t 超過していた。
  // 労働能力は labor.ts 側で商品ライン能力プールに頭打ちされるため、
  // hosoCapacity=9,463 / freezingPackagingCapacity=9,234 でこの大小関係を作る。
  // 労働能力が設備能力を上回る実在の条件: 常用と臨時の両方に余力があるとき、
  // labor.ts は「常用だけで候補量を賄う人数」と「臨時だけで賄う人数」を別々に
  // 配分するため、両方が満たされると合成能力が候補量を上回る。
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(9_234), hosoCapacity: hosoEqTons(9_463) });
  const assignment = makeAssignment({ temporaryHeadcount: 100_000 });
  const r = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(10_846) })], [factory], [assignment], [makeLot()], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-7");
  assert.equal(unwrapUnit(e.stages.laborLimited), 9_463, "前提: 労働能力が冷凍・包装能力を上回っていること");
  assert.equal(unwrapUnit(e.stages.freezingPackagingLimited), 9_234);
  assert.ok(unwrapUnit(e.allocatedQuantity) <= 9_234 + TOLERANCE, `冷凍・包装能力9,234tを超えて生産している: ${unwrapUnit(e.allocatedQuantity)}`);
  assert.ok(e.shortfallReasons.includes("packagingCapacityShortage"));
});

test("ALLOC-7b: 同一工場・同一商品を複数計画で分け合う場合も、各計画が自分の取り分を超えない", () => {
  // ライン能力5,000tを priority 1/2 の2計画で奪い合う。ワーカーは潤沢。
  const factory = makeFactory({ hosoCapacity: hosoEqTons(5_000) });
  const plans = [
    makePlan({ desiredQuantity: hosoEqTons(4_000), priority: 1 }),
    makePlan({ desiredQuantity: hosoEqTons(4_000), priority: 2 }),
  ];
  const r = allocateProductionPlans(plans, [factory], [makeAssignment({ temporaryHeadcount: 100_000 })], [makeLot()], P1);
  // 前提: 労働能力が「自分の取り分」を上回っている（旧実装ならここを突破していた）。
  assert.ok(r.entries.some((e) => unwrapUnit(e.stages.laborLimited) > unwrapUnit(e.stages.productCapacityLimited) + TOLERANCE));
  for (const [i, e] of r.entries.entries()) assertCapacityInvariant(e, `ALLOC-7b#${i}`);
  const total = r.entries.reduce((s, e) => s + unwrapUnit(e.allocatedQuantity), 0);
  assert.ok(total <= 5_000 + TOLERANCE, `工場×商品のライン能力プールを超えている: ${total}`);
});

// =====================================================================
// 8・9: 既存 semantics / 決定性
// =====================================================================

test("ALLOC-8: 優先順位の意味が維持される（高優先の計画が先に能力を取る）", () => {
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(3_000) });
  const plans = [
    makePlan({ product: "hoso", desiredQuantity: hosoEqTons(3_000), priority: 1 }),
    makePlan({ product: "pd", desiredQuantity: hosoEqTons(3_000), priority: 2 }),
  ];
  const r = allocateProductionPlans(plans, [factory], [makeAssignment()], [makeLot()], P1);
  for (const [i, e] of r.entries.entries()) assertCapacityInvariant(e, `ALLOC-8#${i}`);
  const hoso = r.entries.find((e) => e.product === "hoso")!;
  const pd = r.entries.find((e) => e.product === "pd")!;
  assert.ok(unwrapUnit(hoso.allocatedQuantity) > unwrapUnit(pd.allocatedQuantity), "優先順位が結果へ反映されていない");
  assert.ok(unwrapUnit(hoso.allocatedQuantity) + unwrapUnit(pd.allocatedQuantity) <= 3_000 + TOLERANCE);
});

test("ALLOC-9: 決定的（同じ入力なら同じ結果。入力順を入れ替えても各計画の結果は不変）", () => {
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(3_500) });
  const a = makePlan({ product: "hoso", desiredQuantity: hosoEqTons(3_000), priority: 1 });
  const b = makePlan({ product: "pd", desiredQuantity: hosoEqTons(3_000), priority: 1 });
  const r1 = allocateProductionPlans([a, b], [factory], [makeAssignment()], [makeLot()], P1);
  const r2 = allocateProductionPlans([a, b], [factory], [makeAssignment()], [makeLot()], P1);
  const r3 = allocateProductionPlans([b, a], [factory], [makeAssignment()], [makeLot()], P1);
  assert.deepEqual(r2.entries, r1.entries);
  const byProduct = (r: typeof r1) => Object.fromEntries(r.entries.map((e) => [e.product, unwrapUnit(e.allocatedQuantity)]));
  assert.deepEqual(byProduct(r3), byProduct(r1));
});

// =====================================================================
// 10: 原料整合（在庫保存の前提）
// =====================================================================

test("ALLOC-10: 必要原料量が、実際に確保できた原料量を超えない", () => {
  const lot = makeLot({ originalQuantity: hosoEqTons(2_000), remainingQuantity: hosoEqTons(2_000) });
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(9_000) });
  const r = allocateProductionPlans([makePlan()], [factory], [makeAssignment()], [lot], P1);
  const e = r.entries[0];
  assertCapacityInvariant(e, "ALLOC-10");
  assert.ok(
    unwrapUnit(e.requiredRawMaterialQuantity) <= 2_000 + TOLERANCE,
    `必要原料量 ${unwrapUnit(e.requiredRawMaterialQuantity)} が在庫 2,000 を超えている`
  );
});
