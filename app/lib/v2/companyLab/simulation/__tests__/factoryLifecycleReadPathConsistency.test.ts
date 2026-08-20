// ShrimpX V2 — Factory Lifecycle Read-Path Consistency（実装指示§7 必須12項目）
//
// Engine / Standard AI / Simulation記録 / Simulation series / AI Analysis Pack /
// Player View Model（3本）の **6つの read path が、同じ四半期・同じ state に対して
// 同じ Factory lifecycle 適用後の実効能力を返す** ことを固定する。
//
// 【新しい能力計算を作らない】比較対象はすべて既存の canonical path
// （capex/factoryConstruction.ts::computeEffectiveFactories →
//   production/capacity.ts::calculateFactoryEffectiveCapacity）を通った値であり、
// このテスト側でも status の独自判定は一切行わない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { buildStandardAiObservation } from "../../standardAi/observation";
import { computeEffectiveFactories } from "../../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../../production/capacity";
import { unwrapUnit } from "../../../core/units";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../types";
import { buildCompanyInspectorSnapshot } from "../series";
import { captureCompanyStateSnapshot } from "../aiPack/capture";
import { createSimulationSession, advanceSimulationTurn } from "../engine";
import { buildCompanyProcessingCapacityViewModel } from "../../../../../v2/company-lab/processingCapacityViewModel";
import { buildCompanyProcessingForecast } from "../../../../../v2/company-lab/processingForecastViewModel";
import { buildCompanyInvestmentPlanningViewModel } from "../../../../../v2/company-lab/investmentPlanningViewModel";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../../persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../../persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../../persistence/types";

const EPS = 1e-6;

/** 5つの能力プールの合計（比較の共通単位）。 */
interface PoolTotals {
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly commonProcessing: number;
  readonly freezingPackaging: number;
}
const ZERO: PoolTotals = { hoso: 0, pd: 0, vap: 0, commonProcessing: 0, freezingPackaging: 0 };

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

/** Engine の正本（このテストの基準値）。 */
function engineTotals(state: CompanyLabState, fixtures: readonly CompanyFixture[], companyId: string): PoolTotals {
  const base = fixtures.flatMap((f) => f.factories);
  const effective = computeEffectiveFactories(base, state.capexState, state.currentPeriod, state.factoryLifecycleState).filter(
    (f) => f.companyId === companyId
  );
  return effective.reduce((acc, f) => {
    const c = calculateFactoryEffectiveCapacity(f);
    return {
      hoso: acc.hoso + unwrapUnit(c.hoso),
      pd: acc.pd + unwrapUnit(c.pd),
      vap: acc.vap + unwrapUnit(c.vap),
      commonProcessing: acc.commonProcessing + unwrapUnit(c.commonProcessing),
      freezingPackaging: acc.freezingPackaging + unwrapUnit(c.freezingPackaging),
    };
  }, ZERO);
}

interface ReadPathSample {
  readonly turn: number;
  readonly engine: PoolTotals;
  readonly standardAi: PoolTotals;
  readonly series: Omit<PoolTotals, "freezingPackaging">;
  readonly aiPack: Omit<PoolTotals, "freezingPackaging">;
  readonly capacityVm: PoolTotals;
  readonly forecastVm: PoolTotals;
  readonly planningVm: PoolTotals;
  /** Player VM が表示する工場行数（SOLD が消えることの確認に使う）。 */
  readonly capacityVmFactoryCount: number;
  readonly planningVmFactorySpaceUnits: number;
  readonly state: CompanyLabState;
}

/** 1つの state について、6つの read path をまとめて読む。 */
function sampleAllReadPaths(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  companyId: string,
  turn: number
): ReadPathSample {
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const own = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);

  const obs = buildStandardAiObservation(fixture, own, publicInfo, state.currentPeriod, turn);
  const standardAi: PoolTotals = {
    hoso: obs.totalEffectiveCapacityByProduct.hoso,
    pd: obs.totalEffectiveCapacityByProduct.pd,
    vap: obs.totalEffectiveCapacityByProduct.vap,
    commonProcessing: obs.totalEffectiveCommonProcessingCapacity,
    freezingPackaging: obs.totalEffectiveFreezingPackagingCapacity,
  };

  const inspector = buildCompanyInspectorSnapshot(state, companyId, fixtures)!;
  const series = {
    hoso: inspector.hosoCapacity ?? 0,
    pd: inspector.pdCapacity ?? 0,
    vap: inspector.vapCapacity ?? 0,
    commonProcessing: inspector.commonCapacity ?? 0,
  };

  const pack = captureCompanyStateSnapshot(state, fixture);
  const aiPack = {
    hoso: pack.capacityTonsByProduct.hoso ?? 0,
    pd: pack.capacityTonsByProduct.pd ?? 0,
    vap: pack.capacityTonsByProduct.vap ?? 0,
    commonProcessing: pack.commonProcessingCapacityTons ?? 0,
  };

  const capexStateForCompany = { companies: [own.capexState] };
  const capacityVmRaw = buildCompanyProcessingCapacityViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: capexStateForCompany,
    period: state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
  });
  const poolTons = (rows: readonly { poolKey: string; currentEffectiveTons: number }[]): PoolTotals => ({
    hoso: rows.find((r) => r.poolKey === "hoso")?.currentEffectiveTons ?? 0,
    pd: rows.find((r) => r.poolKey === "pd")?.currentEffectiveTons ?? 0,
    vap: rows.find((r) => r.poolKey === "vap")?.currentEffectiveTons ?? 0,
    commonProcessing: rows.find((r) => r.poolKey === "commonProcessing")?.currentEffectiveTons ?? 0,
    freezingPackaging: rows.find((r) => r.poolKey === "freezingPackaging")?.currentEffectiveTons ?? 0,
  });

  const forecast = buildCompanyProcessingForecast({
    companyId,
    baseFactories: fixture.factories,
    capexState: capexStateForCompany,
    period: state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
    productionPlans: [],
    workerAssignments: [],
    rawMaterialLots: own.rawMaterialLots,
  });
  const rateTons = (rows: readonly { poolKey: string; effectiveTons: number }[]): PoolTotals => ({
    hoso: rows.find((r) => r.poolKey === "hoso")?.effectiveTons ?? 0,
    pd: rows.find((r) => r.poolKey === "pd")?.effectiveTons ?? 0,
    vap: rows.find((r) => r.poolKey === "vap")?.effectiveTons ?? 0,
    commonProcessing: rows.find((r) => r.poolKey === "commonProcessing")?.effectiveTons ?? 0,
    freezingPackaging: rows.find((r) => r.poolKey === "freezingPackaging")?.effectiveTons ?? 0,
  });

  const planning = buildCompanyInvestmentPlanningViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: capexStateForCompany,
    period: state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
    productionPlans: [],
    workerAssignments: [],
    workforceState: own.workforceState,
    rawMaterialLots: own.rawMaterialLots,
    finishedGoodsLots: own.finishedGoodsLots,
  });

  return {
    turn,
    engine: engineTotals(state, fixtures, companyId),
    standardAi,
    series,
    aiPack,
    capacityVm: poolTons(capacityVmRaw.companyTotals),
    forecastVm: rateTons(forecast.companyRateTable.rows),
    planningVm: rateTons(planning.forecast.companyRateTable.rows),
    capacityVmFactoryCount: capacityVmRaw.factories.length,
    planningVmFactorySpaceUnits: planning.factorySpace.totalSpaceUnits,
    state,
  };
}

/** 6 read path すべてが Engine の正本と一致していることを課す。 */
function assertAllAgree(s: ReadPathSample, label: string): void {
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.01, `${label} ${what}: ${a} != ${b}`);
  for (const k of ["hoso", "pd", "vap", "commonProcessing", "freezingPackaging"] as const) {
    near(s.standardAi[k], s.engine[k], `standardAi.${k}`);
    near(s.capacityVm[k], s.engine[k], `capacityVm.${k}`);
    near(s.forecastVm[k], s.engine[k], `forecastVm.${k}`);
    near(s.planningVm[k], s.engine[k], `planningVm.${k}`);
  }
  for (const k of ["hoso", "pd", "vap", "commonProcessing"] as const) {
    near(s.series[k], s.engine[k], `series.${k}`);
    near(s.aiPack[k], s.engine[k], `aiPack.${k}`);
  }
}

/** turns四半期進めながら、各四半期の開始時点で6 read pathを採取する。 */
function runAndSample(
  seed: string,
  turns: number,
  lifecycleByTurn: Readonly<Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]>>,
  addSecondFactory = true
): { readonly samples: readonly ReadPathSample[]; readonly companyId: string; readonly fixtures: readonly CompanyFixture[] } {
  const init = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed, turns });
  const companyId = init.fixtures[0].companyId;
  const fixtures = addSecondFactory ? withSecondFactory(init.fixtures, companyId) : init.fixtures.map((f) => ({ ...f }));

  let state = init.state;
  const samples: ReadPathSample[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn);
    }
    // turn1 は history が空で series/aiPack の snapshot が作れないため採取しない。
    if (turn > 1) samples.push(sampleAllReadPaths(state, fixtures, companyId, turn));
    const lc = lifecycleByTurn[turn];
    if (lc) decisions[companyId] = { ...decisions[companyId], factoryLifecycleDecisions: lc };
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  samples.push(sampleAllReadPaths(state, fixtures, companyId, turns + 1));
  return { samples, companyId, fixtures };
}

const targetOf = (seed: string) =>
  initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed, turns: 1 }).fixtures[0].companyId;

// =====================================================================
// 1・4・5・6・7・8・9・12: MOTHBALLED と 6 read path の一致
// =====================================================================

test("FRRP-1/5/6/7/8/9/12: MOTHBALLED は 6つの read path すべてで capacity から除外され、Engine・Standard AI と一致する", () => {
  const seed = "frrp-mothball";
  const target = targetOf(seed);
  const { samples } = runAndSample(seed, 5, { 2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }] });

  for (const s of samples) assertAllAgree(s, `T${s.turn}`);

  // 休止決定(T2)の翌四半期から能力が半減していること（2工場→1工場ぶん）。
  const before = samples.find((s) => s.turn === 2)!;
  const after = samples.find((s) => s.turn === 3)!;
  assert.ok(after.engine.commonProcessing < before.engine.commonProcessing - EPS, "休止後もEngine能力が下がっていない");
  for (const s of samples.filter((x) => x.turn >= 3)) {
    assert.equal(s.capacityVm.commonProcessing, after.engine.commonProcessing);
    assert.equal(s.forecastVm.commonProcessing, after.engine.commonProcessing);
    assert.equal(s.planningVm.commonProcessing, after.engine.commonProcessing);
    assert.equal(s.series.commonProcessing, after.engine.commonProcessing);
    assert.equal(s.aiPack.commonProcessing, after.engine.commonProcessing);
    // 休止工場は保有し続けているため、表示行としては残る（能力だけが0）。
    assert.equal(s.capacityVmFactoryCount, 2);
  }
});

// =====================================================================
// 2・3: SALE_PENDING 除外 / SOLD ghost capacity なし
// =====================================================================

test("FRRP-2/3: SALE_PENDING は除外され、SOLD 後も 6つの read path のどこからも ghost capacity が復活しない", () => {
  const seed = "frrp-sale";
  const target = targetOf(seed);
  const { samples } = runAndSample(seed, 6, { 2: [{ type: "SELL_FACTORY", factoryId: `${target}-F2` }] });

  for (const s of samples) assertAllAgree(s, `T${s.turn}`);

  const t2 = samples.find((s) => s.turn === 2)!;
  const t3 = samples.find((s) => s.turn === 3)!; // SALE_PENDING
  const t4 = samples.find((s) => s.turn === 4)!; // SOLD
  assert.ok(t3.engine.commonProcessing < t2.engine.commonProcessing - EPS, "SALE_PENDINGで能力が下がっていない");
  assert.equal(t3.capacityVmFactoryCount, 2, "SALE_PENDINGはまだ保有＝表示行は残る");

  // SOLD 後は保有工場そのものが減る。fixture.factories を再走査して復活させないこと。
  for (const s of samples.filter((x) => x.turn >= 4)) {
    assert.equal(s.capacityVmFactoryCount, 1, `T${s.turn}: SOLD工場がPlayer表示に残っている`);
    assert.equal(s.capacityVm.commonProcessing, t4.engine.commonProcessing);
    assert.equal(s.series.commonProcessing, t4.engine.commonProcessing);
    assert.equal(s.aiPack.commonProcessing, t4.engine.commonProcessing);
    assert.ok(s.planningVmFactorySpaceUnits < t2.planningVmFactorySpaceUnits, `T${s.turn}: 売却後も工場スペースが減っていない`);
  }
});

// =====================================================================
// 4: REACTIVATED
// =====================================================================

test("FRRP-4: REACTIVATE 後は 6つの read path すべてで capacity が復帰する", () => {
  const seed = "frrp-reactivate";
  const target = targetOf(seed);
  const { samples } = runAndSample(seed, 7, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }],
    4: [{ type: "REACTIVATE_FACTORY", factoryId: `${target}-F2` }],
  });

  for (const s of samples) assertAllAgree(s, `T${s.turn}`);

  const t2 = samples.find((s) => s.turn === 2)!;
  const t4 = samples.find((s) => s.turn === 4)!;
  const t5 = samples.find((s) => s.turn === 5)!;
  assert.ok(t4.engine.commonProcessing < t2.engine.commonProcessing - EPS, "休止中の能力が下がっていない");
  assert.equal(t5.engine.commonProcessing, t2.engine.commonProcessing, "再稼働後に能力が復帰していない");
  assert.equal(t5.capacityVm.commonProcessing, t2.capacityVm.commonProcessing);
  assert.equal(t5.forecastVm.commonProcessing, t2.forecastVm.commonProcessing);
  assert.equal(t5.planningVm.commonProcessing, t2.planningVm.commonProcessing);
  assert.equal(t5.series.commonProcessing, t2.series.commonProcessing);
  assert.equal(t5.aiPack.commonProcessing, t2.aiPack.commonProcessing);
});

// =====================================================================
// Simulation capacity snapshot（simulation/engine.ts::captureCapacities）
// =====================================================================

test("FRRP-SIM: simulation の capacityByTurn が Mothball を反映し、SOLD後も ghost capacity を持たない", () => {
  // scenario fixture は1社1工場のため、唯一の工場を休止する（最低1工場ルールは売却のみに課される）。
  const session0 = createSimulationSession({
    simulationRunId: "frrp-sim",
    scenarioId: "baseline",
    seed: "frrp-sim-seed",
    requestedTurns: 4,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const targetCompany = session0.fixtures[0].companyId;
  const targetFactory = session0.fixtures[0].factories[0].factoryId;

  let session = session0;
  for (let turn = 1; turn <= 4; turn++) {
    const playerDecisions =
      turn === 2
        ? {
            [targetCompany]: {
              ...buildEmptyDecisionFor(session, targetCompany, turn),
              factoryLifecycleDecisions: [{ type: "MOTHBALL_FACTORY" as const, factoryId: targetFactory }],
            },
          }
        : undefined;
    const outcome = advanceSimulationTurn(session, "2026-01-01T00:00:00.000Z", playerDecisions);
    assert.equal(outcome.error, null, `T${turn}: ${String(outcome.error)}`);
    session = outcome.session;
  }

  const rows = session.capacityByTurn.filter((c) => c.companyId === targetCompany);
  const commonAt = (turn: number) => rows.find((r) => r.turn === turn)?.commonProcessing ?? null;
  assert.ok((commonAt(1) ?? 0) > 0, "T1は通常操業");
  // capacityByTurn は「その四半期の処理後 state」で採取されるため、休止を決めたT2の行が
  // 既に休止後（T3期首）の能力を示す。以降0のまま復活しない。
  assert.equal(commonAt(2), 0, "休止がcapacity snapshotへ反映されていない");
  assert.equal(commonAt(3), 0);
  assert.equal(commonAt(4), 0, "capacity snapshotにghost capacityが復活している");
});

/** simulation の player decision 差し替え用に、その会社の自動方針決定をそのまま作る。 */
function buildEmptyDecisionFor(session: ReturnType<typeof createSimulationSession>, companyId: string, turn: number): CompanyDecisionInput {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  return generateAutoPolicyDecision(
    fixture,
    buildCompanyOwnState(session.state, fixture),
    buildPublicMarketInfo(session.state),
    session.state.currentPeriod,
    turn
  );
}

// =====================================================================
// 10: lifecycle 未使用時の完全不変
// =====================================================================

test("FRRP-10: lifecycle 決定を一切使わなければ、6つの read path すべてが lifecycle 導入前と完全に一致する", () => {
  const seed = "frrp-optin";
  const { samples, companyId, fixtures } = runAndSample(seed, 6, {}, false);
  for (const s of samples) {
    assert.equal(s.state.factoryLifecycleState, undefined, "lifecycle未使用なのにstateへlifecycleが作られている");
    assertAllAgree(s, `T${s.turn}`);
  }
  // lifecycle state を渡さない旧呼び出し（3引数相当）と、渡す新呼び出しが同値であること。
  const last = samples[samples.length - 1];
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const own = buildCompanyOwnState(last.state, fixture);
  const withoutLifecycle = buildCompanyProcessingCapacityViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [own.capexState] },
    period: last.state.currentPeriod,
  });
  const withLifecycle = buildCompanyProcessingCapacityViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [own.capexState] },
    period: last.state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
  });
  assert.deepEqual(withLifecycle, withoutLifecycle);
});

// =====================================================================
// 11: Save / Resume
// =====================================================================

function roundTrip(state: CompanyLabState, fixtures: readonly CompanyFixture[]): CompanyLabState {
  const runtime = createCompanyLabRuntimeSnapshot(state);
  const envelope = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: "test-v2-companyLab-engine-frrp",
    labId: "lab-frrp",
    playerCompanyId: fixtures[0].companyId,
    config: state.config,
    fixtures,
    currentState: { runtime, revision: 1, lastProcessedTurnId: "turn-1" },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(envelope));
  return restoreCompanyLabStateFromRuntimeSnapshot(state.config, decoded.currentState.runtime, state.history);
}

test("FRRP-11: Mothball 状態で Save→Resume しても、6つの read path すべてが同じ capacity を返す", () => {
  const seed = "frrp-persist";
  const target = targetOf(seed);
  const { samples, companyId, fixtures } = runAndSample(seed, 4, { 2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }] });
  const saved = samples[samples.length - 1].state;

  const before = sampleAllReadPaths(saved, fixtures, companyId, 99);
  const after = sampleAllReadPaths(roundTrip(saved, fixtures), fixtures, companyId, 99);

  assert.deepEqual(after.engine, before.engine);
  assert.deepEqual(after.standardAi, before.standardAi);
  assert.deepEqual(after.series, before.series);
  assert.deepEqual(after.aiPack, before.aiPack);
  assert.deepEqual(after.capacityVm, before.capacityVm);
  assert.deepEqual(after.forecastVm, before.forecastVm);
  assert.deepEqual(after.planningVm, before.planningVm);
  assertAllAgree(after, "resume");
});
