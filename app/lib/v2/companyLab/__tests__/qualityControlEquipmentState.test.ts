// ShrimpX V2 — Phase QI-I1: 品質管理設備のFactory別リスク低減乗数（companyLab配線）テスト
//
// 対応する指示§11の項目: 5(factory-specificにのみ作用)・6(他factoryへ漏れない)・
// 17(persistence)・18(migration/backward compatibility)・19(deterministic)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period, nextPeriod } from "../../core/period";
import { hosoEqTons, ratio } from "../../core/units";
import { Factory } from "../../production/types";
import { CapexState, CapitalProject } from "../../capex/types";
import { QUALITY_PARAMETERS_V1 } from "../../quality/parameters";
import { buildQualityEquipmentRiskMultiplierByFactory } from "../qualityControlEquipmentState";

const P1 = period(2020, 1);
const P2 = nextPeriod(P1);
const P3 = nextPeriod(P2);

function makeFactory(factoryId: string, companyId = "BAL"): Factory {
  return {
    factoryId,
    companyId,
    status: "active",
    commonProcessingCapacity: hosoEqTons(1000),
    hosoCapacity: hosoEqTons(1000),
    pdCapacity: hosoEqTons(1000),
    vapCapacity: hosoEqTons(1000),
    freezingPackagingCapacity: hosoEqTons(1000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
  };
}

function makeQualityEquipmentProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "PROJ-Q1",
    companyId: "BAL",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.6 },
      { stageIndex: 1, plannedRatio: 0.4 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 1_200_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: P1,
    approvedPeriod: P1,
    completedPeriod: P1,
    capitalizedAmountUsd: 1_200_000,
    targetFactoryId: "BAL-F1",
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [],
    priority: 1,
    ...overrides,
  } as CapitalProject;
}

function capexStateWith(projects: readonly CapitalProject[]): CapexState {
  return { companies: [{ companyId: "BAL", portfolio: { companyId: "BAL", projects }, nextProjectSequence: projects.length + 1 }] };
}

test("QI1-STATE-5: qualityControlEquipmentはtargetFactoryIdへだけ乗数を返す（factory-specific）", () => {
  const factories = [makeFactory("BAL-F1"), makeFactory("BAL-F2")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: "BAL-F1" })]);
  const result = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  assert.ok(result.has("BAL-F1"), "対象Factory（BAL-F1）には乗数が設定されるはず");
  assert.ok(result.get("BAL-F1")! < 1, "対象Factoryの乗数は1未満（リスク低減あり）のはず");
});

test("QI1-STATE-6: 対象外Factoryには一切乗数が漏れない", () => {
  const factories = [makeFactory("BAL-F1"), makeFactory("BAL-F2")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: "BAL-F1" })]);
  const result = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  assert.ok(!result.has("BAL-F2"), "BAL-F2は対象外なのでエントリ自体が存在しないはず");
});

test("QI1-STATE: 稼働開始前（completedPeriod > period）の案件は乗数を返さない", () => {
  const factories = [makeFactory("BAL-F1")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: "BAL-F1", completedPeriod: P3, status: "completed" })]);
  const result = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P1);
  assert.ok(!result.has("BAL-F1"), "まだ稼働開始していない案件は効果を持たないはず");
});

test("QI1-STATE: targetFactoryId省略時は主工場（factories配列の先頭）へ適用される", () => {
  const factories = [makeFactory("BAL-F1"), makeFactory("BAL-F2")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: undefined })]);
  const result = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  assert.ok(result.has("BAL-F1"), "targetFactoryId省略時は主工場（配列先頭のBAL-F1）へ適用されるはず");
  assert.ok(!result.has("BAL-F2"), "主工場以外へは適用されないはず");
});

test("QI1-STATE-17: capexStateのJSON往復（永続化を模す）後も同じ結果を返す（新しい非直列化可能な状態を持たない）", () => {
  const factories = [makeFactory("BAL-F1")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: "BAL-F1" })]);
  const roundTripped = JSON.parse(JSON.stringify(capexState)) as CapexState;
  const before = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  const after = buildQualityEquipmentRiskMultiplierByFactory(roundTripped, factories, P3);
  assert.deepEqual(Array.from(after.entries()), Array.from(before.entries()), "JSON往復後も同一の乗数が得られるべき（既存の汎用CapexState経路だけを使うため）");
});

test("QI1-STATE-19: 同一入力に対して決定論的（再実行しても同じ結果）", () => {
  const factories = [makeFactory("BAL-F1"), makeFactory("BAL-F2")];
  const capexState = capexStateWith([makeQualityEquipmentProject({ targetFactoryId: "BAL-F1" })]);
  const run1 = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  const run2 = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P3);
  assert.deepEqual(Array.from(run1.entries()), Array.from(run2.entries()));
});

test("QI1-STATE: 未完成（承認済みだが未完成）案件は効果を持たない", () => {
  const factories = [makeFactory("BAL-F1")];
  const capexState = capexStateWith([
    makeQualityEquipmentProject({ targetFactoryId: "BAL-F1", status: "underConstruction", completedPeriod: undefined }),
  ]);
  const result = buildQualityEquipmentRiskMultiplierByFactory(capexState, factories, P1, QUALITY_PARAMETERS_V1);
  assert.ok(!result.has("BAL-F1"), "未完成案件はまだ効果を持たないはず");
});
