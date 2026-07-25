// ShrimpX V2 — 加工能力表示用データ層（processingCapacityViewModel.ts）単体テスト
//
// 検証の主眼は「エンジンの導出結果を正しく分解して見せているか」であり、
// 能力増加そのものの計算式はcapex/__tests__/capacityEffect.test.tsが担当する。
// ここでは特に以下を確認する:
//   - base + 稼働開始済み加算 = 当期名目能力 という3列の整合
//   - 実効能力が基準稼働率・設備利用可能率を反映していること（独自式でないこと）
//   - 「追加中」に、建設中案件だけでなく「完成したが稼働準備中（readiness待ち）」
//     案件も含まれること
//   - 稼働開始済み案件は「追加中」に二重計上されないこと
//   - 能力増加を持たない案件種別（品質検査・環境設備）が「追加中」に出ないこと
//   - 他社の案件・他社の工場が混入しないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../lib/v2/core/period";
import { hosoEqTons, ratio } from "../../../lib/v2/core/units";
import { Factory } from "../../../lib/v2/production/types";
import { CapexState, CapitalProject, CompanyCapexState, FutureCapacityEffectPlaceholder } from "../../../lib/v2/capex/types";
import { buildCompanyProcessingCapacityViewModel, CapacityPoolBreakdown, CAPACITY_POOL_KEYS } from "../processingCapacityViewModel";

function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  const zero = hosoEqTons(0);
  return {
    status: "active",
    commonProcessingCapacity: zero,
    hosoCapacity: zero,
    pdCapacity: zero,
    vapCapacity: zero,
    freezingPackagingCapacity: zero,
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function effect(overrides: Partial<FutureCapacityEffectPlaceholder> = {}): FutureCapacityEffectPlaceholder {
  return { readinessQuartersAfterCompletion: 0, ...overrides };
}

function makeProject(overrides: Partial<CapitalProject> & Pick<CapitalProject, "projectType">): CapitalProject {
  return {
    projectId: "P-1",
    companyId: "BAL",
    approvedBudgetUsd: 3_000_000,
    paymentSchedule: [{ stageIndex: 0, plannedRatio: 1 }],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 3_000_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 3,
    status: "completed",
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 3_000_000,
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

function companyCapex(companyId: string, projects: readonly CapitalProject[]): CompanyCapexState {
  return { companyId, portfolio: { companyId, projects }, nextProjectSequence: projects.length + 1 };
}

const BASE_FACTORY = factory({
  factoryId: "BAL-F1",
  companyId: "BAL",
  commonProcessingCapacity: hosoEqTons(12_000),
  hosoCapacity: hosoEqTons(6_000),
  pdCapacity: hosoEqTons(4_000),
  vapCapacity: hosoEqTons(2_000),
  freezingPackagingCapacity: hosoEqTons(10_000),
});

function poolOf(pools: readonly CapacityPoolBreakdown[], key: string): CapacityPoolBreakdown {
  const found = pools.find((p) => p.poolKey === key);
  assert.ok(found, `プール ${key} が存在しない`);
  return found;
}

// ---------------------------------------------------------------------
// 1. 当期能力の分解（base / 稼働開始済み加算 / 当期）
// ---------------------------------------------------------------------

test("PCAP-1: 設備投資が一件も無い場合、当期名目能力はfixtureの基礎能力と完全に一致し、加算ぶんは0である", () => {
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [])] },
    period: period(2015, 1),
  });
  assert.equal(vm.factories.length, 1);
  const hoso = poolOf(vm.factories[0].pools, "hoso");
  assert.equal(hoso.baseNominalTons, 6_000);
  assert.equal(hoso.addedByOperationalCapexTons, 0);
  assert.equal(hoso.currentNominalTons, 6_000);
  assert.equal(vm.pendingProjects.length, 0);
});

test("PCAP-2: 5つの能力プールすべてがCAPACITY_POOL_KEYSの順で揃っている", () => {
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [])] },
    period: period(2015, 1),
  });
  assert.deepEqual(
    vm.factories[0].pools.map((p) => p.poolKey),
    [...CAPACITY_POOL_KEYS]
  );
  assert.deepEqual(
    vm.companyTotals.map((p) => p.poolKey),
    [...CAPACITY_POOL_KEYS]
  );
});

test("PCAP-3: 稼働開始済みのHOSOライン増設は、当期名目能力へ加算され、加算ぶんとして分離表示される（base + 加算 = 当期）", () => {
  const project = makeProject({
    projectType: "hosoLineExpansion",
    completedPeriod: period(2015, 1),
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [project])] },
    period: period(2015, 3),
  });
  const hoso = poolOf(vm.factories[0].pools, "hoso");
  assert.equal(hoso.baseNominalTons, 6_000);
  assert.equal(hoso.addedByOperationalCapexTons, 500);
  assert.equal(hoso.currentNominalTons, 6_500);
  assert.equal(hoso.baseNominalTons + hoso.addedByOperationalCapexTons, hoso.currentNominalTons);
  assert.equal(vm.factories[0].receivesCapexCapacity, true);
  assert.equal(vm.pendingProjects.length, 0, "すでに能力へ反映済みの案件は「追加中」に含めてはならない");
});

test("PCAP-4: 実効能力は基準稼働率・設備利用可能率を反映する（名目そのままではない）", () => {
  const base = factory({
    factoryId: "BAL-F1",
    companyId: "BAL",
    hosoCapacity: hosoEqTons(10_000),
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.8),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [base],
    capexState: { companies: [companyCapex("BAL", [])] },
    period: period(2015, 1),
  });
  const hoso = poolOf(vm.factories[0].pools, "hoso");
  assert.equal(hoso.currentNominalTons, 10_000);
  assert.equal(hoso.currentEffectiveTons, 7_200);
});

test("PCAP-5: status!==\"active\"の工場は実効能力が0になる（名目能力は表示上残る）", () => {
  const base = factory({ factoryId: "BAL-F1", companyId: "BAL", status: "idle", hosoCapacity: hosoEqTons(10_000) });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [base],
    capexState: { companies: [companyCapex("BAL", [])] },
    period: period(2015, 1),
  });
  const hoso = poolOf(vm.factories[0].pools, "hoso");
  assert.equal(hoso.currentNominalTons, 10_000);
  assert.equal(hoso.currentEffectiveTons, 0);
  assert.equal(vm.factories[0].status, "idle");
});

// ---------------------------------------------------------------------
// 2.「現在追加中」の判定
// ---------------------------------------------------------------------

test("PCAP-6: 建設中案件は「追加中」として、増強対象プールと増加量つきで出る", () => {
  const project = makeProject({
    projectId: "P-UC",
    projectType: "pdLineExpansion",
    status: "underConstruction",
    completedPeriod: undefined,
    capitalizedAmountUsd: undefined,
    cumulativePaidUsd: 1_200_000,
    approvedBudgetUsd: 4_000_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 3,
    approvedPeriod: period(2015, 2),
    futureCapacityEffect: effect({ targetProduct: "pd", capacityIncreaseTonsPerQuarter: 350 }),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [project])] },
    period: period(2015, 3),
  });
  assert.equal(vm.pendingProjects.length, 1);
  const row = vm.pendingProjects[0];
  assert.equal(row.targetPoolKey, "pd");
  assert.equal(row.capacityIncreaseTonsPerQuarter, 350);
  assert.equal(row.displayStatusLabel, "建設中");
  assert.equal(row.remainingScheduledPaymentUsd, 2_800_000);
  assert.equal(row.isCompletionEstimate, true, "建設中案件の完成四半期は見積りである");
  assert.equal(row.completionPeriod, period(2015, 4), "2015Q2承認・工期3四半期 → 2015Q4完成見込み");
  assert.equal(row.operationalStartPeriod, undefined, "完成前は稼働開始四半期を確定値として出さない");
  assert.equal(vm.pendingTotalsByPool.pd, 350);
  assert.equal(vm.pendingTotalsByPool.hoso, 0);
  // 当期能力側には一切加算されていない
  assert.equal(poolOf(vm.factories[0].pools, "pd").addedByOperationalCapexTons, 0);
});

test("PCAP-7: 完成したがreadiness待ちで稼働前の案件も「追加中」に含まれる（statusホワイトリストでは取りこぼす分）", () => {
  const project = makeProject({
    projectId: "P-READY",
    projectType: "vapLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 3),
    futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [project])] },
    period: period(2015, 4),
  });
  assert.equal(vm.pendingProjects.length, 1);
  const row = vm.pendingProjects[0];
  assert.equal(row.displayStatusLabel, "完成・操業準備中");
  assert.equal(row.isCompletionEstimate, false);
  assert.equal(row.completionPeriod, period(2015, 3));
  assert.equal(row.operationalStartPeriod, period(2016, 2), "2015Q3完成・readiness=2 → 2016Q2稼働開始");
  assert.equal(vm.pendingTotalsByPool.vap, 250);
  assert.equal(poolOf(vm.factories[0].pools, "vap").addedByOperationalCapexTons, 0);
});

test("PCAP-8: 稼働開始四半期に到達すると、同じ案件が「追加中」から外れ、当期能力の加算ぶんへ移る", () => {
  const project = makeProject({
    projectId: "P-READY",
    projectType: "vapLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 3),
    futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }),
  });
  const args = {
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [project])] } as CapexState,
  };
  const before = buildCompanyProcessingCapacityViewModel({ ...args, period: period(2016, 1) });
  const after = buildCompanyProcessingCapacityViewModel({ ...args, period: period(2016, 2) });
  assert.equal(before.pendingProjects.length, 1);
  assert.equal(poolOf(before.factories[0].pools, "vap").addedByOperationalCapexTons, 0);
  assert.equal(after.pendingProjects.length, 0);
  assert.equal(poolOf(after.factories[0].pools, "vap").addedByOperationalCapexTons, 250);
  assert.equal(poolOf(after.factories[0].pools, "vap").currentNominalTons, 2_250);
});

test("PCAP-9: 取消済み案件は「追加中」に出ない", () => {
  const project = makeProject({
    projectId: "P-CANCEL",
    projectType: "hosoLineExpansion",
    status: "cancelled",
    completedPeriod: undefined,
    capitalizedAmountUsd: undefined,
    cumulativePaidUsd: 0,
    cancelledPeriod: period(2015, 2),
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [project])] },
    period: period(2015, 3),
  });
  assert.equal(vm.pendingProjects.length, 0);
});

test("PCAP-10: 能力増加を持たない案件種別（品質検査・環境設備）は「追加中」に出ない", () => {
  const qc = makeProject({ projectId: "P-QC", projectType: "qualityControlEquipment", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ capacityIncreaseTonsPerQuarter: 0 }) });
  const env = makeProject({ projectId: "P-ENV", projectType: "environmentalEquipment", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ capacityIncreaseTonsPerQuarter: 0 }) });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [qc, env])] },
    period: period(2015, 3),
  });
  assert.equal(vm.pendingProjects.length, 0, "生産能力を増やさない投資は加工能力パネルの「追加中」には出さない");
});

test("PCAP-11: 同一プールへの複数の追加中案件は合計される", () => {
  const a = makeProject({ projectId: "P-A", projectType: "hosoLineExpansion", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const b = makeProject({ projectId: "P-B", projectType: "hosoLineExpansion", status: "approved", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY],
    capexState: { companies: [companyCapex("BAL", [a, b])] },
    period: period(2015, 3),
  });
  assert.equal(vm.pendingProjects.length, 2);
  assert.equal(vm.pendingTotalsByPool.hoso, 1_000);
});

// ---------------------------------------------------------------------
// 3. 他社混入の禁止
// ---------------------------------------------------------------------

test("PCAP-12: 他社の工場・他社の投資案件は一切混入しない", () => {
  const massFactory = factory({ factoryId: "MASS-F1", companyId: "MASS", hosoCapacity: hosoEqTons(30_000) });
  const massProject = makeProject({
    projectId: "P-MASS",
    companyId: "MASS",
    projectType: "hosoLineExpansion",
    status: "underConstruction",
    completedPeriod: undefined,
    capitalizedAmountUsd: undefined,
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [BASE_FACTORY, massFactory],
    capexState: { companies: [companyCapex("BAL", []), companyCapex("MASS", [massProject])] },
    period: period(2015, 3),
  });
  assert.deepEqual(
    vm.factories.map((f) => f.factoryId),
    ["BAL-F1"]
  );
  assert.equal(vm.pendingProjects.length, 0);
  assert.equal(poolOf(vm.companyTotals, "hoso").currentNominalTons, 6_000);
});

test("PCAP-13: 会社合計は全工場の合計であり、base+加算の整合が合計レベルでも保たれる", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(6_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", hosoCapacity: hosoEqTons(1_000) });
  const project = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }) });
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId: "BAL",
    baseFactories: [f1, f2],
    capexState: { companies: [companyCapex("BAL", [project])] },
    period: period(2015, 3),
  });
  const total = poolOf(vm.companyTotals, "hoso");
  assert.equal(total.baseNominalTons, 7_000);
  assert.equal(total.addedByOperationalCapexTons, 500);
  assert.equal(total.currentNominalTons, 7_500);
  assert.equal(vm.factories.filter((f) => f.receivesCapexCapacity).map((f) => f.factoryId).join(","), "BAL-F1", "設備投資効果は主工場（factoryId先頭）へ加算される");
});
