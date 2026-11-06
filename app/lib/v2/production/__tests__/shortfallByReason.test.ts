// ShrimpX V2 — 減産原因の理由別内訳（2026-11 テストプレイ指摘①の修正）
//
// 【守るもの】
//   1. 理由別の減産量の合計が、その計画の減産量（shortfallQuantity）と一致すること。
//   2. 複数の制約に当たった計画で、同じ量が複数の理由へ二重計上されないこと。
//   3. 理由の集合（shortfallReasons）は従来と同じ判定のままであること。
//
// 実エンジン（allocateProductionPlans）に対して検証する。
// ヘルパーの形は既存の allocation.test.ts に合わせてある。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { allocateProductionPlans } from "../allocation";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";
import { CompanyProductionPlanEntry, Factory, ProductionAllocationEntry, WorkerAssignment } from "../types";
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

const sumByReason = (entry: ProductionAllocationEntry): number =>
  Object.values(entry.shortfallByReason).reduce((sum, v) => sum + unwrapUnit(v), 0);

/**
 * 原料・共通設備・商品別設備・人員のどれもが希望量に足りない状況。
 * 1つの計画が複数の制約に当たるため、修正前はここで二重計上が起きていた。
 */
function runMultiConstraintCase() {
  const factory = makeFactory({
    commonProcessingCapacity: hosoEqTons(400),
    freezingPackagingCapacity: hosoEqTons(350),
    hosoCapacity: hosoEqTons(300),
  });
  const lot = makeLot({ remainingQuantity: hosoEqTons(450), originalQuantity: hosoEqTons(450) });
  const assignment = makeAssignment({ regularHeadcount: 20 });
  return allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(1000) })], [factory], [assignment], [lot], P1, PRODUCTION_PARAMETERS_V1);
}

test("SHORTFALL-1【二重計上しない】: 理由別の減産量の合計が、その計画の減産量と一致する", () => {
  const result = runMultiConstraintCase();
  for (const entry of result.entries) {
    const total = unwrapUnit(entry.shortfallQuantity);
    const byReason = sumByReason(entry);
    assert.ok(
      Math.abs(byReason - total) < 0.01,
      `理由別の合計 ${byReason} が減産量 ${total} と一致しない（理由=${entry.shortfallReasons.join(",")}）`
    );
  }
});

test("SHORTFALL-2【同じ量を流用しない】: 複数の制約に当たっても、各理由の値は減産量を超えない", () => {
  const result = runMultiConstraintCase();
  const multi = result.entries.filter((e) => e.shortfallReasons.length >= 2);
  assert.ok(multi.length > 0, "このテストの前提として、複数の制約に当たる計画が1件以上必要");
  for (const entry of multi) {
    const total = unwrapUnit(entry.shortfallQuantity);
    for (const [reason, value] of Object.entries(entry.shortfallByReason)) {
      assert.ok(unwrapUnit(value) <= total + 0.01, `理由 ${reason} の値 ${unwrapUnit(value)} が減産量 ${total} を超えている`);
    }
    // 修正前は「すべての理由が減産量と同額」になっていた。そうなっていないことを確かめる。
    const values = Object.values(entry.shortfallByReason).map((v) => unwrapUnit(v));
    assert.ok(!values.every((v) => Math.abs(v - total) < 0.01), "すべての理由が減産量と同額（＝丸ごと流用）になっている");
  }
});

test("SHORTFALL-3【理由の判定は従来どおり】: shortfallByReason のキーが shortfallReasons と一致する", () => {
  const result = runMultiConstraintCase();
  for (const entry of result.entries) {
    assert.deepEqual(Object.keys(entry.shortfallByReason).sort(), [...entry.shortfallReasons].sort());
  }
});

test("SHORTFALL-4【減産が無ければ空】: 希望どおり生産できた計画では理由別内訳が空になる", () => {
  const result = allocateProductionPlans([makePlan()], [makeFactory()], [makeAssignment()], [makeLot()], P1, PRODUCTION_PARAMETERS_V1);
  for (const entry of result.entries) {
    assert.equal(unwrapUnit(entry.shortfallQuantity), 0);
    assert.deepEqual(entry.shortfallByReason, {});
  }
});

test("SHORTFALL-5【単一の制約】: 原料だけが足りない場合、減産量の全額が原料不足へ入る", () => {
  const lot = makeLot({ remainingQuantity: hosoEqTons(10), originalQuantity: hosoEqTons(10) });
  const result = allocateProductionPlans([makePlan({ desiredQuantity: hosoEqTons(500) })], [makeFactory()], [makeAssignment()], [lot], P1, PRODUCTION_PARAMETERS_V1);
  const entry = result.entries[0];
  assert.deepEqual(entry.shortfallReasons, ["rawMaterialShortage"]);
  assert.ok(Math.abs(unwrapUnit(entry.shortfallByReason.rawMaterialShortage ?? hosoEqTons(0)) - unwrapUnit(entry.shortfallQuantity)) < 0.01);
});
