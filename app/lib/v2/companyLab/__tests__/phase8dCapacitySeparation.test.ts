// ShrimpX V2 — Phase 8D-3/8D-5 統合テスト
//   - 凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック）の分離
//   - 工場スペース不足による新規案件の承認拒否
//   - 設備投資は完成前に能力へ加算されない／完成・稼働開始後にのみ増える
//
// いずれも実際のエンジン（allocateProductionPlans・advanceCompanyLabQuarter・
// applyCapexCapacityToFactories）を通して検証し、テスト側で計算式を再実装しない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period, PeriodV2 } from "../../core/period";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { Factory, WorkerAssignment, CompanyProductionPlanEntry } from "../../production/types";
import { RawMaterialLot } from "../../rawMaterials/types";
import { allocateProductionPlans } from "../../production/allocation";
import {
  buildCompanyColdStorageState,
  computeColdStorageUsageTons,
  deriveDefaultColdStorageCapacityTons,
  resolveFactoryColdStorageCapacityTons,
} from "../../production/coldStorage";
import { applyCapexCapacityToFactories, isCapexProjectOperationalAt } from "../../capex/capacityEffect";
import { buildCompanyFactorySpaceState, computeCandidateProjectSpaceUnits } from "../../capex/factorySpace";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { CapexState, CapitalProject, FutureCapacityEffectPlaceholder } from "../../capex/types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../types";

const PLAYER = "BAL";
const EPS = 1e-6;

function baseConfig(seed: string, turns = 6): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns };
}

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "TEST",
    status: "active",
    commonProcessingCapacity: hosoEqTons(10_000),
    hosoCapacity: hosoEqTons(10_000),
    pdCapacity: hosoEqTons(10_000),
    vapCapacity: hosoEqTons(10_000),
    freezingPackagingCapacity: hosoEqTons(10_000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function makeWorkers(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "F1",
    companyId: "TEST",
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

function makeLot(quantity: number): RawMaterialLot {
  return {
    lotId: "L1",
    companyId: "TEST",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: period(2015, 1),
    originalQuantity: hosoEqTons(quantity),
    remainingQuantity: hosoEqTons(quantity),
    unitCost: usdPerHosoEqKg(4),
    availableFromPeriod: period(2015, 1),
    status: "available",
  };
}

function makePlan(product: "hoso" | "pd" | "vap", desired: number, priority: number): CompanyProductionPlanEntry {
  return { companyId: "TEST", factoryId: "F1", product, desiredQuantity: hosoEqTons(desired), priority };
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

function stepOnce(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  overrideForPlayer?: (auto: CompanyDecisionInput) => CompanyDecisionInput
): CompanyLabState {
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    decisionsByCompanyId[f.companyId] = f.companyId === PLAYER && overrideForPlayer ? overrideForPlayer(auto) : auto;
  }
  return advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
}

// ---------------------------------------------------------------------
// テスト項目9: 凍結・包装処理能力が生産上限として働く
// ---------------------------------------------------------------------

test("CS-1（必須9）: 凍結・包装処理能力（フロー）は、生産量の上限として実際に働く", () => {
  // 他の制約はすべて十分に大きくし、凍結・包装能力だけを絞る。
  const factory = makeFactory({ freezingPackagingCapacity: hosoEqTons(3_000) });
  const result = allocateProductionPlans(
    [makePlan("hoso", 5_000, 1)],
    [factory],
    [makeWorkers()],
    [makeLot(50_000)],
    period(2015, 1)
  );
  const entry = result.entries[0];
  assert.ok(Math.abs(unwrapUnit(entry.allocatedQuantity) - 3_000) < EPS, `凍結・包装処理能力3,000tで頭打ちになるはず（実際: ${unwrapUnit(entry.allocatedQuantity)}）`);
  assert.ok(entry.shortfallReasons.includes("packagingCapacityShortage"), "不足理由に冷凍・包装能力が現れるはず");
});

test("CS-2（必須9）: 冷凍・冷蔵保管能力（ストック）は、生産量の上限として働かない", () => {
  // 保管能力を極端に小さくしても、当四半期の生産量は変わらない
  // （保管能力は生産エンジンへ未接続であることの確認）。
  const withoutStorage = makeFactory({ freezingPackagingCapacity: hosoEqTons(3_000) });
  const withTinyStorage = makeFactory({ freezingPackagingCapacity: hosoEqTons(3_000), coldStorageCapacity: hosoEqTons(1) });
  const args = [[makePlan("hoso", 5_000, 1)], undefined, [makeWorkers()], [makeLot(50_000)], period(2015, 1)] as const;
  const a = allocateProductionPlans(args[0], [withoutStorage], args[2], args[3], args[4]);
  const b = allocateProductionPlans(args[0], [withTinyStorage], args[2], args[3], args[4]);
  assert.equal(unwrapUnit(b.entries[0].allocatedQuantity), unwrapUnit(a.entries[0].allocatedQuantity));
});

// ---------------------------------------------------------------------
// テスト項目10: 冷凍保管能力が未接続の場合、勝手な廃棄や入庫拒否が発生しない
// ---------------------------------------------------------------------

test("CS-3（必須10）: 保管能力を超えても、在庫の自動廃棄・入庫拒否・強制販売は起きない", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("phase8d-coldstorage-001", 4));
  let state = initialState;
  for (let i = 0; i < 4; i++) state = stepOnce(state, fixtures);

  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;
  const ownState = buildCompanyOwnState(state, playerFixture);
  const lotsBefore = ownState.finishedGoodsLots.map((l) => ({ lotId: l.lotId, remaining: unwrapUnit(l.remainingQuantity), status: l.status }));
  const usageBefore = computeColdStorageUsageTons(ownState.finishedGoodsLots);

  // 保管能力を極端に小さくした工場で状態を組み立てる（＝確実に超過している状況）。
  const tinyStorageFactories = playerFixture.factories.map((f) => ({ ...f, coldStorageCapacity: hosoEqTons(1) }));
  const storageState = buildCompanyColdStorageState({
    companyId: PLAYER,
    currentFactories: tinyStorageFactories,
    finishedGoodsLots: ownState.finishedGoodsLots,
  });

  assert.ok(storageState.usedTons >= 0, "保管使用量が負になっていません");
  if (usageBefore > 1) {
    assert.equal(storageState.isOverCapacity, true, "超過しているなら超過フラグが立つ");
    assert.ok(storageState.overCapacityTons > 0);
  }
  assert.equal(storageState.freeTons, Math.max(0, storageState.totalCapacityTons - storageState.usedTons));

  // 在庫は1トンも減っていない（状態を書き換えていない＝強制制約が未接続である証拠）。
  const ownStateAfter = buildCompanyOwnState(state, playerFixture);
  const lotsAfter = ownStateAfter.finishedGoodsLots.map((l) => ({ lotId: l.lotId, remaining: unwrapUnit(l.remainingQuantity), status: l.status }));
  assert.deepEqual(lotsAfter, lotsBefore, "保管能力の超過を理由に在庫が変化してはいけません");
  assert.ok(storageState.engineConnectionNote.includes("未接続"), "エンジン未接続であることの注記が含まれるはず");
});

test("CS-4: 保管能力が未設定の工場でも、凍結・包装処理能力から決定論的に既定値が導出される", () => {
  const f = makeFactory({ freezingPackagingCapacity: hosoEqTons(20_000) });
  const derived = deriveDefaultColdStorageCapacityTons(f);
  assert.ok(derived > 0);
  assert.equal(resolveFactoryColdStorageCapacityTons(f), derived);
  assert.equal(deriveDefaultColdStorageCapacityTons(f), derived, "何度呼んでも同じ値（決定論性）");
  // 明示値があればそちらが優先される。
  assert.equal(resolveFactoryColdStorageCapacityTons({ ...f, coldStorageCapacity: hosoEqTons(123) }), 123);
});

// ---------------------------------------------------------------------
// テスト項目4・5: 完成前は加算されない／完成・稼働開始後にのみ増える
// ---------------------------------------------------------------------

test("CS-5（必須4）: 設備投資は完成前に現在能力へ加算されない", () => {
  const base = makeFactory();
  const building = makeProject({
    projectType: "hosoLineExpansion",
    status: "underConstruction",
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500 }),
  });
  const current = applyCapexCapacityToFactories([base], capexStateOf([building]), period(2016, 1));
  assert.equal(unwrapUnit(current[0].hosoCapacity), unwrapUnit(base.hosoCapacity));
  assert.equal(isCapexProjectOperationalAt(building, period(2016, 1)), false);
});

test("CS-6（必須5）: 設備完成・稼働開始後にのみ能力が増える（完成四半期そのものではまだ増えない）", () => {
  const base = makeFactory();
  const completed = makeProject({
    projectType: "hosoLineExpansion",
    status: "completed",
    completedPeriod: period(2015, 4),
    capitalizedAmountUsd: 1_000_000,
    futureCapacityEffect: effect({ targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 0 }),
  });
  const capexState = capexStateOf([completed]);

  const atCompletion = applyCapexCapacityToFactories([base], capexState, period(2015, 4));
  assert.equal(unwrapUnit(atCompletion[0].hosoCapacity), unwrapUnit(base.hosoCapacity), "完成四半期そのものではまだ増えない");

  const atOperationalStart = applyCapexCapacityToFactories([base], capexState, period(2016, 1));
  assert.ok(Math.abs(unwrapUnit(atOperationalStart[0].hosoCapacity) - (unwrapUnit(base.hosoCapacity) + 500)) < EPS, "稼働開始四半期からは増える");
});

// ---------------------------------------------------------------------
// テスト項目7: スペース不足案件を正常に確定できない
// ---------------------------------------------------------------------

test("CS-7（必須7）: 工場スペースが足りない新規案件は、正常な案件として確定せず理由つきで却下される", () => {
  const { state: initialState, fixtures: gameFixtures } = initializeCompanyLab(baseConfig("phase8d-space-001", 4));

  // 【2026-08-08・Test16】このテストが守りたいのは
  // 「工場スペースが足りないとき、新規案件が理由つきで却下される」ことであり、
  // ゲームの初期工場サイズがいくつかは本質ではない。
  //
  // Test16で共通処理能力が30,000へ拡大した結果、既定のfixtureでは2件とも
  // 入ってしまい「スペース不足」という前提そのものが作れなくなった。
  // 指示どおり**工場スペース係数（factorySpace.tsのparams）は一切変更せず**、
  // Factory.totalFactorySpaceUnits を明示して
  // 「1件は入るが2件は入らない」状況を意図的に作る。
  //
  // totalFactorySpaceUnits は Factory の正式なフィールドであり、未設定のときだけ
  // 基礎能力から導出される（factorySpace.ts resolveFactoryTotalSpaceUnits）。
  // つまりこれは係数の書き換えではなく、正規の入力による状況設定である。
  const perProjectSpaceForSetup = computeCandidateProjectSpaceUnits("coldStorageExpansion");
  // 稼働中の能力が既に占有しているスペースを実測してから、その上に
  // 「1件ぶん + 半分」だけの空きを与える（2件目は必ず入らない）。
  const basePlayerFixture = gameFixtures.find((f) => f.companyId === PLAYER)!;
  const usedByOperations = buildCompanyFactorySpaceState({
    companyId: PLAYER,
    baseFactories: basePlayerFixture.factories,
    currentFactories: basePlayerFixture.factories,
    capexState: initialState.capexState,
    period: initialState.currentPeriod,
  }).usedAfterPendingSpaceUnits;
  const fixtures = gameFixtures.map((f) =>
    f.companyId !== PLAYER
      ? f
      : {
          ...f,
          factories: f.factories.map((factory) => ({
            ...factory,
            totalFactorySpaceUnits: usedByOperations + perProjectSpaceForSetup * 1.5,
          })),
        }
  );
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;

  // 冷凍保管庫増設は1件あたり最も広いスペースを必要とする（1,250t × 2.0 = 2,500）。
  const perProjectSpace = computeCandidateProjectSpaceUnits("coldStorageExpansion");
  const spaceState = buildCompanyFactorySpaceState({
    companyId: PLAYER,
    baseFactories: playerFixture.factories,
    currentFactories: playerFixture.factories,
    capexState: initialState.capexState,
    period: initialState.currentPeriod,
  });
  const free = spaceState.totalSpaceUnits - spaceState.usedAfterPendingSpaceUnits;
  assert.ok(free > perProjectSpace, "前提: 1件ぶんは入る空きがある");
  assert.ok(free < perProjectSpace * 2, "前提: 2件ぶんは入らない（この前提が崩れたらスペース係数の校正を見直すこと）");

  // 同じ四半期に2件提案する。1件目は承認、2件目はスペース不足で却下されるはず。
  const state = stepOnce(initialState, fixtures, (auto) => ({
    ...auto,
    capexDecision: {
      ...auto.capexDecision,
      newProjectProposals: [{ projectType: "coldStorageExpansion" }, { projectType: "coldStorageExpansion" }],
    },
  }));

  const record = state.history[state.history.length - 1];
  const capexResult = record.capexResults.find((r) => r.companyId === PLAYER)!;

  assert.equal(capexResult.rejectedProposals.length, 1, "2件目はスペース不足で却下されるはず");
  assert.ok(
    capexResult.rejectedProposals[0].reasons.some((r) => r.includes("工場スペース")),
    `却下理由に工場スペース不足が含まれるはず（実際: ${capexResult.rejectedProposals[0].reasons.join(" / ")}）`
  );

  const ownState = buildCompanyOwnState(state, playerFixture);
  assert.equal(ownState.capexState.portfolio.projects.length, 1, "却下された案件はポートフォリオへ登録されない（＝正常な案件として確定しない）");
});

test("CS-8: スペースに余裕があれば、同じ四半期の複数案件でも承認される（スペース判定が過剰に拒否しない）", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("phase8d-space-002", 4));
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;

  // HOSO増設(500)＋凍結包装増設(480) は、BALの空きスペースに十分収まる。
  const total =
    computeCandidateProjectSpaceUnits("hosoLineExpansion") + computeCandidateProjectSpaceUnits("freezingPackagingExpansion");
  const spaceState = buildCompanyFactorySpaceState({
    companyId: PLAYER,
    baseFactories: playerFixture.factories,
    currentFactories: playerFixture.factories,
    capexState: initialState.capexState,
    period: initialState.currentPeriod,
  });
  assert.ok(spaceState.totalSpaceUnits - spaceState.usedAfterPendingSpaceUnits > total, "前提: 2件ぶんの空きがある");

  const state = stepOnce(initialState, fixtures, (auto) => ({
    ...auto,
    capexDecision: {
      ...auto.capexDecision,
      newProjectProposals: [{ projectType: "hosoLineExpansion" }, { projectType: "freezingPackagingExpansion" }],
    },
  }));

  const capexResult = state.history[state.history.length - 1].capexResults.find((r) => r.companyId === PLAYER)!;
  assert.equal(capexResult.rejectedProposals.length, 0, `却下があってはいけません: ${JSON.stringify(capexResult.rejectedProposals)}`);
  assert.equal(buildCompanyOwnState(state, playerFixture).capexState.portfolio.projects.length, 2);
});

test("CS-9: 投資案件テンプレートの保管単価が、実装指示の目安（USD 1,500〜2,500/保管トン）に収まっている", () => {
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const tons = template.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0;
  assert.ok(tons > 0);
  const usdPerStorageTon = template.standardBudgetUsd / tons;
  assert.ok(usdPerStorageTon >= 1_500 && usdPerStorageTon <= 2_500, `保管1トンあたり ${usdPerStorageTon} USD は目安の範囲外です`);
  assert.equal(template.futureCapacityEffect.targetProduct, "coldStorage");
});

test("CS-10: 既存の承認済み案件（旧仕様のスナップショット）は、Phase 8D後もこれまでどおり凍結・包装処理能力を増やす", () => {
  // Phase 8D以前に承認された coldStorageExpansion は
  // futureCapacityEffect.targetProduct === "freezingPackaging" を保持している。
  // 承認時スナップショット方式のため、テンプレートを変更しても遡って挙動が変わらない。
  const base = makeFactory();
  const legacy = makeProject({
    projectId: "P-LEGACY",
    projectType: "coldStorageExpansion",
    status: "completed",
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 2_500_000,
    futureCapacityEffect: effect({ targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 }),
  });
  const current = applyCapexCapacityToFactories([base], capexStateOf([legacy]), period(2016, 1));
  assert.ok(Math.abs(unwrapUnit(current[0].freezingPackagingCapacity) - (unwrapUnit(base.freezingPackagingCapacity) + 500)) < EPS);
});

test("CS-11: 保管能力・スペースを追加しても、期間の型（PeriodV2）や数量に不正値が入らない", () => {
  const p: PeriodV2 = period(2016, 1);
  const base = makeFactory();
  const current = applyCapexCapacityToFactories([base], capexStateOf([]), p);
  assert.ok(Number.isFinite(resolveFactoryColdStorageCapacityTons(current[0])));
  assert.ok(resolveFactoryColdStorageCapacityTons(current[0]) >= 0);
});
