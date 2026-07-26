// ShrimpX V2 — Phase 8D-3 工場スペース制約の単体テスト
//
// production/factorySpace.ts の純粋関数と、capex/factorySpace.ts（設備投資との接続）を
// 直接検証する。エンジンの計算式をテスト側で再実装しないため、期待値は
// 「係数×数量」という定義そのものと、状態間の恒等式（総量＝稼働中＋予約＋空き）で
// 表現する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, ratio } from "../../core/units";
import { Factory } from "../types";
import {
  aggregateCompanyFactorySpaceState,
  buildFactorySpaceState,
  computeFactoryUsedSpaceUnits,
  computeProjectRequiredSpaceUnits,
  deriveDefaultFactorySpaceUnits,
  FACTORY_SPACE_PARAMETERS_V1,
  readCapacityQuantities,
  resolveFactoryTotalSpaceUnits,
  SPACE_CONSUMING_POOL_KEYS,
} from "../factorySpace";
import { applyCapexCapacityToFactories } from "../../capex/capacityEffect";
import {
  buildCompanyFactorySpaceState,
  buildFactorySpaceApprovalBudget,
  buildPendingSpaceReservations,
  computeApprovedProjectSpaceUnits,
  computeCandidateProjectSpaceUnits,
} from "../../capex/factorySpace";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { CapexState, CapitalProject, FutureCapacityEffectPlaceholder } from "../../capex/types";
import { createInitialPersistedGameState } from "../../persistence/builder";
import { encodePersistedGameState, decodePersistedGameState } from "../../persistence/codec";

const EPS = 1e-6;

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "TEST",
    status: "active",
    commonProcessingCapacity: hosoEqTons(20_000),
    hosoCapacity: hosoEqTons(10_000),
    pdCapacity: hosoEqTons(5_000),
    vapCapacity: hosoEqTons(4_000),
    freezingPackagingCapacity: hosoEqTons(18_000),
    coldStorageCapacity: hosoEqTons(9_000),
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
    ...overrides,
  };
}

function makeProject(overrides: Partial<CapitalProject> & Pick<CapitalProject, "projectType">): CapitalProject {
  return {
    projectId: "P-1",
    companyId: "TEST",
    approvedBudgetUsd: 1_000_000,
    paymentSchedule: [{ stageIndex: 0, plannedRatio: 1 }],
    completedPaymentStagesCount: 0,
    cumulativePaidUsd: 0,
    elapsedConstructionQuartersWithPayment: 0,
    requiredConstructionQuarters: 1,
    status: "underConstruction",
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

function effect(overrides: Partial<FutureCapacityEffectPlaceholder> = {}): FutureCapacityEffectPlaceholder {
  return { readinessQuartersAfterCompletion: 0, ...overrides };
}

function capexStateOf(projects: readonly CapitalProject[]): CapexState {
  return { companies: [{ companyId: "TEST", portfolio: { companyId: "TEST", projects }, nextProjectSequence: projects.length + 1 }] };
}

// ---------------------------------------------------------------------
// 1. 係数と使用量
// ---------------------------------------------------------------------

test("SP-1: 占有スペースは「プール別の名目能力 × 係数」の合計である（実効能力ではなく名目能力を使う）", () => {
  const f = makeFactory();
  const q = readCapacityQuantities(f);
  const expected = SPACE_CONSUMING_POOL_KEYS.reduce((sum, pool) => sum + q[pool] * FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon[pool], 0);
  assert.ok(Math.abs(computeFactoryUsedSpaceUnits(f) - expected) < EPS);
});

test("SP-2: 基準稼働率・設備利用可能率を変えても占有スペースは変わらない（床面積は稼働率で増減しない）", () => {
  const a = computeFactoryUsedSpaceUnits(makeFactory({ baseUtilizationRate: ratio(0.9), equipmentAvailabilityRate: ratio(0.95) }));
  const b = computeFactoryUsedSpaceUnits(makeFactory({ baseUtilizationRate: ratio(0.5), equipmentAvailabilityRate: ratio(0.5) }));
  assert.equal(a, b);
});

test("SP-3: スペース総量が未設定でも、基礎能力から決定論的に導出される（既存保存データとの後方互換）", () => {
  const withoutTotal = makeFactory();
  const derived = deriveDefaultFactorySpaceUnits(withoutTotal);
  assert.equal(resolveFactoryTotalSpaceUnits(withoutTotal), derived);
  assert.ok(derived > computeFactoryUsedSpaceUnits(withoutTotal), "余裕率のぶん、総量は現在の占有量より大きい");
  // 何度呼んでも同じ値（決定論性）。
  assert.equal(deriveDefaultFactorySpaceUnits(withoutTotal), derived);
});

test("SP-4: スペース総量が明示されていればそちらが優先される", () => {
  const explicit = makeFactory({ totalFactorySpaceUnits: 123_456 });
  assert.equal(resolveFactoryTotalSpaceUnits(explicit), 123_456);
});

// ---------------------------------------------------------------------
// 2. 案件のスペース所要量
// ---------------------------------------------------------------------

test("SP-5: 能力を増やす案件のスペース所要量は「増加能力 × プール別係数」である", () => {
  const required = computeProjectRequiredSpaceUnits({ projectType: "vapLineExpansion", targetPool: "vap", capacityIncreaseTons: 250 });
  assert.ok(Math.abs(required - 250 * FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.vap) < EPS);
});

test("SP-6: 能力を増やさない案件（品質・環境設備）にも固定のスペース所要量がある", () => {
  const qc = computeProjectRequiredSpaceUnits({ projectType: "qualityControlEquipment", capacityIncreaseTons: 0 });
  const env = computeProjectRequiredSpaceUnits({ projectType: "environmentalEquipment", capacityIncreaseTons: 0 });
  assert.equal(qc, FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.qualityControlEquipment);
  assert.equal(env, FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.environmentalEquipment);
  assert.ok(qc > 0 && env > 0, "設備を置く場所は必要である");
});

test("SP-7: 承認済み案件と候補で、同じ案件種別のスペース所要量が一致する（カードの表示と承認判定が食い違わない）", () => {
  for (const projectType of Object.keys(CAPEX_PARAMETERS_V1.templatesByType) as (keyof typeof CAPEX_PARAMETERS_V1.templatesByType)[]) {
    const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
    const approved = makeProject({ projectType, futureCapacityEffect: template.futureCapacityEffect });
    assert.equal(
      computeApprovedProjectSpaceUnits(approved),
      computeCandidateProjectSpaceUnits(projectType),
      `${projectType}: 承認済み案件と候補でスペース所要量が一致しません`
    );
  }
});

// ---------------------------------------------------------------------
// 3. 二重計上の防止（テスト項目6）
// ---------------------------------------------------------------------

test("SP-8（必須6）: 稼働中設備・建設中案件・今回選択案件のスペースが二重計上されない", () => {
  const base = makeFactory();
  const now = period(2016, 1);

  // 稼働開始済みの案件（2015Q1完成・readiness 0 → 2015Q2から稼働）と、建設中の案件。
  const operational = makeProject({
    projectId: "P-DONE",
    projectType: "hosoLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_000_000,
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });
  const building = makeProject({
    projectId: "P-BUILD",
    projectType: "vapLineExpansion",
    status: "underConstruction",
    futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250 }),
  });

  const capexState = capexStateOf([operational, building]);
  const currentFactories = applyCapexCapacityToFactories([base], capexState, now);

  // 稼働開始済み案件は、当期Factoryの能力へ反映されているので予約一覧には現れない。
  const reservations = buildPendingSpaceReservations([operational, building], now);
  assert.deepEqual(
    reservations.map((r) => r.projectId),
    ["P-BUILD"],
    "稼働開始済みの案件が予約として二重に数えられています"
  );

  const state = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories,
    capexState,
    period: now,
  });

  // 稼働中使用量は「基礎 ＋ 稼働開始済み案件ぶん」に一致する（案件としては数えていない）。
  const expectedOperational = computeFactoryUsedSpaceUnits(base) + 500 * FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.hoso;
  assert.ok(Math.abs(state.usedByOperationalSpaceUnits - expectedOperational) < EPS);

  // 予約量は建設中案件1件ぶんだけ。
  assert.ok(Math.abs(state.reservedByPendingSpaceUnits - 250 * FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.vap) < EPS);

  // 恒等式: 使用量（完成後） ＝ 稼働中 ＋ 予約。
  assert.ok(Math.abs(state.usedAfterPendingSpaceUnits - (state.usedByOperationalSpaceUnits + state.reservedByPendingSpaceUnits)) < EPS);
});

test("SP-9: 取消済みの案件はスペースを予約しない", () => {
  const cancelled = makeProject({
    projectId: "P-CANCEL",
    projectType: "vapLineExpansion",
    status: "cancelled",
    cancelledPeriod: period(2015, 3),
    futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250 }),
  });
  assert.deepEqual(buildPendingSpaceReservations([cancelled], period(2016, 1)), []);
});

test("SP-10: 完成したが稼働開始前（readiness待ち）の案件は、予約として数える", () => {
  // 2015Q4完成・readiness 2 → 稼働開始は 2016Q3。2016Q1時点ではまだ稼働していない。
  const completedNotOperational = makeProject({
    projectId: "P-READY",
    projectType: "vapLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 4),
    capitalizedAmountUsd: 1_000_000,
    futureCapacityEffect: effect({ targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }),
  });
  const reservations = buildPendingSpaceReservations([completedNotOperational], period(2016, 1));
  assert.equal(reservations.length, 1, "完成しても稼働前ならスペースは予約済みである");
});

// ---------------------------------------------------------------------
// 4. 空き・不足・承認枠
// ---------------------------------------------------------------------

test("SP-11: スペースが足りている場合、空き＝総量−（稼働中＋予約）で、不足は0", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const state = buildFactorySpaceState({ baseFactory: base, currentFactory: base, pendingReservations: [] });
  assert.equal(state.totalSpaceUnits, 200_000);
  assert.ok(Math.abs(state.freeSpaceUnits - (200_000 - state.usedByOperationalSpaceUnits)) < EPS);
  assert.equal(state.shortfallSpaceUnits, 0);
  assert.equal(state.isShortage, false);
});

test("SP-12: 予約を含めた使用量が総量を超えると、不足量が算出され警告フラグが立つ", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 1_000 });
  const state = buildFactorySpaceState({
    baseFactory: base,
    currentFactory: base,
    pendingReservations: [{ projectId: "P", projectType: "vapLineExpansion", requiredSpaceUnits: 5_000 }],
  });
  assert.ok(state.isShortage, "不足しているのに警告フラグが立っていません");
  assert.ok(state.shortfallSpaceUnits > 0);
  assert.equal(state.freeSpaceUnits, 0, "空きは負にせず0で表す");
});

test("SP-13: 既存設備の能力は、スペース不足を理由に遡って減らされない", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 1 });
  const state = buildFactorySpaceState({ baseFactory: base, currentFactory: base, pendingReservations: [] });
  assert.ok(state.isShortage);
  // 能力そのものは一切変わっていない（buildFactorySpaceStateはFactoryを返さず、判定だけを行う）。
  assert.equal(base.hosoCapacity as number, 10_000);
  assert.ok(state.usedByOperationalSpaceUnits > state.totalSpaceUnits);
});

test("SP-14: 承認枠は「総量 −（稼働中＋予約）」であり、負にはならない", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 1_000 });
  const state = aggregateCompanyFactorySpaceState("TEST", [
    buildFactorySpaceState({ baseFactory: base, currentFactory: base, pendingReservations: [] }),
  ]);
  const budget = buildFactorySpaceApprovalBudget(state);
  assert.equal(budget.totalSpaceUnits, 1_000);
  assert.ok(budget.remainingSpaceUnits >= 0);
});

test("SP-15: スペース関連の数値に NaN・Infinity・不正な負値が発生しない", () => {
  const base = makeFactory();
  const state = buildFactorySpaceState({
    baseFactory: base,
    currentFactory: base,
    pendingReservations: [{ projectId: "P", projectType: "hosoLineExpansion", requiredSpaceUnits: 500 }],
  });
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "number") continue;
    assert.ok(Number.isFinite(value), `${key} が有限の数値ではありません: ${value}`);
  }
  assert.ok(state.totalSpaceUnits >= 0);
  assert.ok(state.usedByOperationalSpaceUnits >= 0);
  assert.ok(state.reservedByPendingSpaceUnits >= 0);
  assert.ok(state.freeSpaceUnits >= 0);
  assert.ok(state.shortfallSpaceUnits >= 0);
});

// ---------------------------------------------------------------------
// 6. 固定スペース案件の稼働後占有（Phase 8D監査M-1修正）
//
// 品質管理設備（600）・排水環境設備（900）は能力プールを増やさないため、
// 稼働開始した瞬間にbuildPendingSpaceReservationsの予約からは外れる一方、
// computeFactoryUsedSpaceUnits（能力プール由来）にも現れず、占有スペースが
// 消失していたバグの回帰テスト。
// ---------------------------------------------------------------------

test("SP-16（M-1a）: 品質管理設備600が建設中から稼働開始へ移っても、総使用スペース（稼働中＋予約）は減らない", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const now = period(2016, 1);
  const qcTemplate = CAPEX_PARAMETERS_V1.templatesByType.qualityControlEquipment;

  const building = makeProject({
    projectId: "P-QC",
    projectType: "qualityControlEquipment",
    status: "underConstruction",
    futureCapacityEffect: qcTemplate.futureCapacityEffect,
  });
  const capexStateBefore = capexStateOf([building]);
  const stateBefore = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories: applyCapexCapacityToFactories([base], capexStateBefore, now),
    capexState: capexStateBefore,
    period: now,
  });
  assert.ok(
    Math.abs(stateBefore.reservedByPendingSpaceUnits - FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.qualityControlEquipment) < EPS,
    "建設中は予約(usedByPending相当)へ計上されるはず"
  );

  const operational: CapitalProject = { ...building, status: "completed", completedPeriod: period(2015, 4), capitalizedAmountUsd: 1_200_000 };
  const capexStateAfter = capexStateOf([operational]);
  const stateAfter = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories: applyCapexCapacityToFactories([base], capexStateAfter, now),
    capexState: capexStateAfter,
    period: now,
  });

  assert.equal(stateAfter.reservedByPendingSpaceUnits, 0, "稼働開始済みなので、もう予約には現れないはず");
  assert.ok(
    Math.abs(
      stateAfter.usedByOperationalSpaceUnits - stateBefore.usedByOperationalSpaceUnits - FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.qualityControlEquipment
    ) < EPS,
    "稼働開始後、品質管理設備600が稼働中使用量(usedByOperational)へ計上されるはず"
  );
  assert.ok(
    stateAfter.usedAfterPendingSpaceUnits >= stateBefore.usedAfterPendingSpaceUnits - EPS,
    "稼働開始の前後で総使用スペース（稼働中＋予約）が減ってはいけない"
  );
});

test("SP-17（M-1b）: 排水環境設備900は、稼働開始後の複数四半期にわたって使用スペースへ計上され続ける", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const envTemplate = CAPEX_PARAMETERS_V1.templatesByType.environmentalEquipment;

  const operational = makeProject({
    projectId: "P-ENV",
    projectType: "environmentalEquipment",
    status: "completed",
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_800_000,
    futureCapacityEffect: envTemplate.futureCapacityEffect,
  });
  const capexState = capexStateOf([operational]);

  for (const q of [period(2015, 2), period(2015, 4), period(2017, 3)]) {
    const state = buildCompanyFactorySpaceState({
      companyId: "TEST",
      baseFactories: [base],
      currentFactories: applyCapexCapacityToFactories([base], capexState, q),
      capexState,
      period: q,
    });
    assert.ok(
      Math.abs(state.usedByOperationalSpaceUnits - computeFactoryUsedSpaceUnits(base) - FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.environmentalEquipment) <
        EPS,
      `${q}: 排水環境設備900が占有し続けるはず`
    );
    assert.equal(state.reservedByPendingSpaceUnits, 0);
  }
});

test("SP-18（M-1c）: 稼働中の能力増設案件と固定スペース案件が混在しても、能力増設案件のスペースは二重計上されない", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const now = period(2016, 1);
  const envTemplate = CAPEX_PARAMETERS_V1.templatesByType.environmentalEquipment;

  const fixedSpaceProject = makeProject({
    projectId: "P-ENV",
    projectType: "environmentalEquipment",
    status: "completed",
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_800_000,
    futureCapacityEffect: envTemplate.futureCapacityEffect,
  });
  const capacityProject = makeProject({
    projectId: "P-HOSO",
    projectType: "hosoLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 3_000_000,
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });

  const capexState = capexStateOf([fixedSpaceProject, capacityProject]);
  const currentFactories = applyCapexCapacityToFactories([base], capexState, now);
  const state = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories,
    capexState,
    period: now,
  });

  const expected =
    computeFactoryUsedSpaceUnits(base) +
    500 * FACTORY_SPACE_PARAMETERS_V1.spaceUnitsPerCapacityTon.hoso + // 能力増設ぶん（能力プール経由で一度だけ）
    FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.environmentalEquipment; // 固定スペースぶん（一度だけ）
  assert.ok(
    Math.abs(state.usedByOperationalSpaceUnits - expected) < EPS,
    "能力増設案件のスペースは能力プール経由の1回だけ、固定スペース案件の900は別枠で1回だけ計上されるはず（二重計上なし）"
  );
});

test("SP-19（M-1d）: encode→decode→restore後も、稼働開始済み品質管理設備600の占有スペースが維持される", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const now = period(2016, 1);
  const qcTemplate = CAPEX_PARAMETERS_V1.templatesByType.qualityControlEquipment;

  const operational = makeProject({
    projectId: "P-QC",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    status: "completed",
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 1_200_000,
    elapsedConstructionQuartersWithPayment: 1,
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_200_000,
    futureCapacityEffect: qcTemplate.futureCapacityEffect,
  });
  const capexState = capexStateOf([operational]);

  const persisted = createInitialPersistedGameState({
    gameId: "game-sp19",
    scenarioId: "baseline-v0.1",
    initialPeriod: period(2015, 1),
    seed: "sp19-seed",
    initialContracts: [],
    initialRawMaterialLots: [],
    initialCapexStates: capexState.companies,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const decoded = decodePersistedGameState(encodePersistedGameState(persisted));
  const restoredCapexState: CapexState = { companies: decoded.capexStates };

  const stateAfterRestore = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories: applyCapexCapacityToFactories([base], restoredCapexState, now),
    capexState: restoredCapexState,
    period: now,
  });

  assert.ok(
    Math.abs(
      stateAfterRestore.usedByOperationalSpaceUnits - computeFactoryUsedSpaceUnits(base) - FACTORY_SPACE_PARAMETERS_V1.fixedSpaceUnitsByProjectType.qualityControlEquipment
    ) < EPS,
    "保存・復元後も、稼働開始済み品質管理設備600の占有スペースが維持されるはず"
  );
  assert.equal(stateAfterRestore.reservedByPendingSpaceUnits, 0, "稼働開始済みなので復元後も予約には現れないはず");
});

test("SP-20: 取消済みの固定スペース案件は、稼働開始条件を満たしていても占有しない", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const now = period(2016, 1);
  const qcTemplate = CAPEX_PARAMETERS_V1.templatesByType.qualityControlEquipment;

  // ステータスがcancelledの案件（completedPeriod自体を持たないのが通常だが、
  // ここでは「取消済みは占有しない」というフィルタ条件そのものを検証するため、
  // あえてcompletedPeriodも設定した不自然なデータで確認する）。
  const cancelled = makeProject({
    projectId: "P-QC-CANCEL",
    projectType: "qualityControlEquipment",
    status: "cancelled",
    cancelledPeriod: period(2015, 3),
    futureCapacityEffect: qcTemplate.futureCapacityEffect,
  });
  const capexState = capexStateOf([cancelled]);
  const state = buildCompanyFactorySpaceState({
    companyId: "TEST",
    baseFactories: [base],
    currentFactories: applyCapexCapacityToFactories([base], capexState, now),
    capexState,
    period: now,
  });

  assert.equal(state.reservedByPendingSpaceUnits, 0);
  assert.ok(Math.abs(state.usedByOperationalSpaceUnits - computeFactoryUsedSpaceUnits(base)) < EPS, "取消済み案件は稼働中使用量にも計上されないはず");
});

// ---------------------------------------------------------------------
// 7. 「現在の空き」と「投資完成後の空き」の区別（Phase 8D監査L-2修正）
//
// FactorySpacePanel.tsxの表示値が、次の2つの意味で明確に区別されることを確認する。
//   現在の空き　　　　＝ 総スペース − 稼働中設備の使用スペース
//   投資完成後の空き　＝ 総スペース − 稼働中設備の使用スペース − 建設中案件の予約スペース
// 承認判定（buildFactorySpaceApprovalBudget）は usedAfterPendingSpaceUnits を
// そのまま使っており、この修正で変更しない（SP-14で別途確認済み）。
// ---------------------------------------------------------------------

test("SP-21（L-2）: 建設中案件があるとき、「現在の空き」と「投資完成後の空き」は異なる値になる", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const building = { projectId: "P-BUILD", projectType: "vapLineExpansion", requiredSpaceUnits: 5_000 };

  const state = buildFactorySpaceState({
    baseFactory: base,
    currentFactory: base,
    pendingReservations: [building],
  });

  // 現在の空き＝総量−稼働中使用量のみ（予約は差し引かない）。
  assert.ok(Math.abs(state.freeSpaceUnits - (state.totalSpaceUnits - state.usedByOperationalSpaceUnits)) < EPS);
  // 投資完成後の空き＝総量−（稼働中＋予約）。
  assert.ok(Math.abs(state.freeAfterPendingSpaceUnits - (state.totalSpaceUnits - state.usedAfterPendingSpaceUnits)) < EPS);
  // 建設中案件（予約>0）があるので、2つの値は一致しない。
  assert.ok(state.freeSpaceUnits > state.freeAfterPendingSpaceUnits, "建設中案件がある場合、現在の空きは投資完成後の空きより大きいはず");
  assert.ok(Math.abs(state.freeSpaceUnits - state.freeAfterPendingSpaceUnits - building.requiredSpaceUnits) < EPS, "差は建設中案件の予約スペースぶんに一致するはず");
});

test("SP-22（L-2）: 建設中案件が無ければ、「現在の空き」と「投資完成後の空き」は一致する", () => {
  const base = makeFactory({ totalFactorySpaceUnits: 200_000 });
  const state = buildFactorySpaceState({ baseFactory: base, currentFactory: base, pendingReservations: [] });
  assert.equal(state.reservedByPendingSpaceUnits, 0);
  assert.ok(Math.abs(state.freeSpaceUnits - state.freeAfterPendingSpaceUnits) < EPS);
});
