// ShrimpX V2 — Factory Lifecycle Export Consistency（実装指示§8 必須8項目）
//
// Excel / 管理者Export の加工能力セクションが、Engine・Standard AI・Player画面・
// Simulation記録と同じ Factory lifecycle 適用後の実効能力になっていることを固定する。
//
// 【Export専用の判定を作らない】期待値はすべて既存の共有導出
// （computeEffectiveFactories → calculateFactoryEffectiveCapacity、および画面が呼ぶ
//  buildCompanyProcessingCapacityViewModel）から取り、このテストでも status の
// 独自判定は一切行わない。
//
// 【lifecycle stateの出所】履歴エントリの postProcessingStateSnapshot
// （CompanyLabRuntimeSnapshot）が ENG-FAC-1 時点から factoryLifecycleState を
// optional で保持している。schema追加・Redis migration・既存データ書き換えは不要。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../../../lib/v2/companyLab/types";
import { computeEffectiveFactories } from "../../../../lib/v2/capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../../../lib/v2/production/capacity";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { buildExportProcessingCapacity } from "../_lib/dto/processingCapacityDto";
import { buildCompanyProcessingCapacityViewModel } from "../../../../v2/company-lab/processingCapacityViewModel";
import { captureCompanyStateSnapshot } from "../../../../lib/v2/companyLab/simulation/aiPack/capture";
import { buildCompanyInspectorSnapshot } from "../../../../lib/v2/companyLab/simulation/series";
import { createCompanyLabRuntimeSnapshot } from "../../../../lib/v2/companyLab/persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../../../../lib/v2/companyLab/persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../../../../lib/v2/companyLab/persistence/types";

function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

/** Export が実際に読むのと同じ経路（runtime snapshot）から加工能力セクションを組む。 */
function exportFor(state: CompanyLabState, fixtures: readonly CompanyFixture[], companyId: string) {
  const snapshot = createCompanyLabRuntimeSnapshot(state);
  return buildExportProcessingCapacity({
    companyId,
    fixtures,
    capexState: snapshot.capexState,
    asOfPeriod: snapshot.currentPeriod,
    pdMechanizationState: snapshot.pdMechanizationState,
    factoryLifecycleState: snapshot.factoryLifecycleState,
  });
}

/** Export の会社合計（プール別の実効能力）。 */
function exportTotals(cap: ReturnType<typeof buildExportProcessingCapacity>) {
  const row = (key: string) => cap.companyTotals.find((p) => p.poolKey === key)?.currentEffectiveTons ?? 0;
  return {
    hoso: row("hoso"),
    pd: row("pd"),
    vap: row("vap"),
    commonProcessing: row("commonProcessing"),
    freezingPackaging: row("freezingPackaging"),
    factoryCount: cap.factories.length,
  };
}

/** Engine の正本（この検証の基準値）。 */
function engineTotals(state: CompanyLabState, fixtures: readonly CompanyFixture[], companyId: string) {
  const eff = computeEffectiveFactories(
    fixtures.flatMap((f) => f.factories),
    state.capexState,
    state.currentPeriod,
    state.factoryLifecycleState
  ).filter((f) => f.companyId === companyId);
  return eff.reduce(
    (acc, f) => {
      const c = calculateFactoryEffectiveCapacity(f);
      return {
        hoso: acc.hoso + unwrapUnit(c.hoso),
        pd: acc.pd + unwrapUnit(c.pd),
        vap: acc.vap + unwrapUnit(c.vap),
        commonProcessing: acc.commonProcessing + unwrapUnit(c.commonProcessing),
        freezingPackaging: acc.freezingPackaging + unwrapUnit(c.freezingPackaging),
        factoryCount: acc.factoryCount + 1,
      };
    },
    { hoso: 0, pd: 0, vap: 0, commonProcessing: 0, freezingPackaging: 0, factoryCount: 0 }
  );
}

/** Player画面（DecisionStudioが呼ぶのと同じ純粋関数）。 */
function playerVmTotals(state: CompanyLabState, fixtures: readonly CompanyFixture[], companyId: string) {
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const own = buildCompanyOwnState(state, fixture);
  const vm = buildCompanyProcessingCapacityViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [own.capexState] },
    period: state.currentPeriod,
    factoryLifecycleState: own.factoryLifecycleState,
  });
  const row = (key: string) => vm.companyTotals.find((p) => p.poolKey === key)?.currentEffectiveTons ?? 0;
  return {
    hoso: row("hoso"),
    pd: row("pd"),
    vap: row("vap"),
    commonProcessing: row("commonProcessing"),
    freezingPackaging: row("freezingPackaging"),
    factoryCount: vm.factories.length,
  };
}

interface TurnSample {
  readonly turn: number;
  readonly state: CompanyLabState;
  readonly exported: ReturnType<typeof exportTotals>;
  readonly engine: ReturnType<typeof engineTotals>;
  readonly playerVm: ReturnType<typeof playerVmTotals>;
  /** Simulation記録側（AI Pack / series）。freezingPackagingは持たない。 */
  readonly aiPack: { hoso: number; pd: number; vap: number; commonProcessing: number };
  readonly series: { hoso: number; pd: number; vap: number; commonProcessing: number };
  readonly rawExport: ReturnType<typeof buildExportProcessingCapacity>;
}

function runAndSample(
  seed: string,
  turns: number,
  lifecycleByTurn: Readonly<Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]>>,
  addSecondFactory = true
): { readonly samples: readonly TurnSample[]; readonly companyId: string; readonly fixtures: readonly CompanyFixture[] } {
  const init = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed, turns });
  const companyId = init.fixtures[0].companyId;
  const fixtures = addSecondFactory ? withSecondFactory(init.fixtures, companyId) : init.fixtures.map((f) => ({ ...f }));

  let state = init.state;
  const samples: TurnSample[] = [];
  const sample = (turn: number, s: CompanyLabState): TurnSample => {
    const fixture = fixtures.find((f) => f.companyId === companyId)!;
    const pack = captureCompanyStateSnapshot(s, fixture);
    const ins = buildCompanyInspectorSnapshot(s, companyId, fixtures);
    const rawExport = exportFor(s, fixtures, companyId);
    return {
      turn,
      state: s,
      exported: exportTotals(rawExport),
      engine: engineTotals(s, fixtures, companyId),
      playerVm: playerVmTotals(s, fixtures, companyId),
      aiPack: {
        hoso: pack.capacityTonsByProduct.hoso ?? 0,
        pd: pack.capacityTonsByProduct.pd ?? 0,
        vap: pack.capacityTonsByProduct.vap ?? 0,
        commonProcessing: pack.commonProcessingCapacityTons ?? 0,
      },
      series: {
        hoso: ins?.hosoCapacity ?? 0,
        pd: ins?.pdCapacity ?? 0,
        vap: ins?.vapCapacity ?? 0,
        commonProcessing: ins?.commonCapacity ?? 0,
      },
      rawExport,
    };
  };

  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, turn);
    }
    // turn1 は history が空で AI Pack / series の比較対象が作れないため採取しない。
    if (turn > 1) samples.push(sample(turn, state));
    const lc = lifecycleByTurn[turn];
    if (lc) decisions[companyId] = { ...decisions[companyId], factoryLifecycleDecisions: lc };
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
  }
  samples.push(sample(turns + 1, state));
  return { samples, companyId, fixtures };
}

/** Export == Engine == Player VM == Simulation記録 を毎ターン課す。 */
function assertExportAgrees(s: TurnSample, label: string): void {
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.01, `${label} ${what}: ${a} != ${b}`);
  for (const k of ["hoso", "pd", "vap", "commonProcessing", "freezingPackaging"] as const) {
    near(s.exported[k], s.engine[k], `export.${k} vs engine`);
    near(s.exported[k], s.playerVm[k], `export.${k} vs playerVM`);
  }
  for (const k of ["hoso", "pd", "vap", "commonProcessing"] as const) {
    near(s.exported[k], s.aiPack[k], `export.${k} vs aiPack`);
    near(s.exported[k], s.series[k], `export.${k} vs series`);
  }
  assert.equal(s.exported.factoryCount, s.playerVm.factoryCount, `${label} 工場数がPlayer画面と一致しない`);
}

const targetOf = (seed: string) =>
  initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed, turns: 1 }).fixtures[0].companyId;

// =====================================================================
// 1・5・6: OPERATING / MOTHBALLED
// =====================================================================

test("FLEX-1/5/6: MOTHBALLED は Export の能力からも T+1 以降 除外され、Player画面・Simulation記録・Engineと一致する", () => {
  const seed = "flex-mothball";
  const target = targetOf(seed);
  const { samples } = runAndSample(seed, 5, { 2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }] });

  for (const s of samples) assertExportAgrees(s, `T${s.turn}`);

  const t2 = samples.find((s) => s.turn === 2)!; // OPERATING（休止を決めた四半期）
  const t3 = samples.find((s) => s.turn === 3)!; // MOTHBALLED
  assert.ok(t2.exported.commonProcessing > 0, "OPERATING時にExportの能力が0になっている");
  assert.ok(t3.exported.commonProcessing < t2.exported.commonProcessing - 1e-6, "休止後もExportの能力が下がっていない");
  for (const s of samples.filter((x) => x.turn >= 3)) {
    assert.equal(s.exported.commonProcessing, t3.engine.commonProcessing);
    // 休止工場は保有し続けているため、Export の工場行としては残る（能力だけが0）。
    assert.equal(s.exported.factoryCount, 2);
    const f2Row = s.rawExport.factories.find((f) => f.factoryId === `${target}-F2`)!;
    assert.equal(f2Row.status, "idle", "Exportの工場statusが休止を示していない");
  }
});

// =====================================================================
// 2・3: SALE_PENDING / SOLD
// =====================================================================

test("FLEX-2/3: SALE_PENDING は能力0で保有情報を維持し、SOLD は Export の能力・工場数から消える", () => {
  const seed = "flex-sale";
  const target = targetOf(seed);
  const f2 = `${target}-F2`;
  const { samples } = runAndSample(seed, 6, { 2: [{ type: "SELL_FACTORY", factoryId: f2 }] });

  for (const s of samples) assertExportAgrees(s, `T${s.turn}`);

  const t3 = samples.find((s) => s.turn === 3)!; // SALE_PENDING
  const t4 = samples.find((s) => s.turn === 4)!; // SOLD
  const pending = t3.rawExport.factories.find((f) => f.factoryId === f2);
  assert.ok(pending, "SALE_PENDINGの工場がExportから消えている（まだ保有している）");
  assert.equal(pending!.status, "suspended", "SALE_PENDINGのstatusがExportに出ていない");
  assert.equal(
    pending!.pools.reduce((sum, p) => sum + p.currentEffectiveTons, 0),
    0,
    "SALE_PENDINGの工場がExportで能力を持っている"
  );
  assert.equal(t3.exported.factoryCount, 2);

  for (const s of samples.filter((x) => x.turn >= 4)) {
    assert.equal(s.rawExport.factories.find((f) => f.factoryId === f2), undefined, `T${s.turn}: SOLD工場がExportに残っている`);
    assert.equal(s.exported.factoryCount, 1);
    assert.equal(s.exported.commonProcessing, t4.engine.commonProcessing);
  }
});

// =====================================================================
// 4: REACTIVATED
// =====================================================================

test("FLEX-4: REACTIVATE 後は Export の能力も復帰する", () => {
  const seed = "flex-reactivate";
  const target = targetOf(seed);
  const { samples } = runAndSample(seed, 7, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }],
    4: [{ type: "REACTIVATE_FACTORY", factoryId: `${target}-F2` }],
  });

  for (const s of samples) assertExportAgrees(s, `T${s.turn}`);

  const t2 = samples.find((s) => s.turn === 2)!;
  const t4 = samples.find((s) => s.turn === 4)!;
  const t5 = samples.find((s) => s.turn === 5)!;
  assert.ok(t4.exported.commonProcessing < t2.exported.commonProcessing - 1e-6, "休止中のExport能力が下がっていない");
  assert.equal(t5.exported.commonProcessing, t2.exported.commonProcessing, "再稼働後にExport能力が復帰していない");
  assert.deepEqual(t5.exported, t2.exported);
});

// =====================================================================
// 7: lifecycle 未使用時の完全不変
// =====================================================================

test("FLEX-7: lifecycle を使わないRunでは、Export の内容が lifecycle 引数の有無に関わらず完全に一致する", () => {
  const seed = "flex-optin";
  const { samples, companyId, fixtures } = runAndSample(seed, 6, {}, false);
  for (const s of samples) {
    assert.equal(s.state.factoryLifecycleState, undefined, "lifecycle未使用なのにstateへlifecycleが作られている");
    assertExportAgrees(s, `T${s.turn}`);
  }
  // 旧呼び出し（factoryLifecycleStateを渡さない＝この機能導入前に保存されたRunと同じ入力）と、
  // 新呼び出しの出力がまったく同じであること。
  const last = samples[samples.length - 1];
  const snapshot = createCompanyLabRuntimeSnapshot(last.state);
  assert.equal(snapshot.factoryLifecycleState, undefined, "lifecycle未使用のsnapshotにキーが作られている");
  const legacy = buildExportProcessingCapacity({
    companyId,
    fixtures,
    capexState: snapshot.capexState,
    asOfPeriod: snapshot.currentPeriod,
    pdMechanizationState: snapshot.pdMechanizationState,
  });
  const current = exportFor(last.state, fixtures, companyId);
  assert.deepEqual(current, legacy);
});

// =====================================================================
// 8: 保存Runからの Export
// =====================================================================

test("FLEX-8: 保存（encode/decode）した Run から組み立てた Export も、同じ lifecycle 適用後の能力になる", () => {
  const seed = "flex-persist";
  const target = targetOf(seed);
  const { samples, companyId, fixtures } = runAndSample(seed, 4, { 2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target}-F2` }] });
  const saved = samples[samples.length - 1].state;

  const runtime = createCompanyLabRuntimeSnapshot(saved);
  assert.ok(runtime.factoryLifecycleState, "保存snapshotにfactoryLifecycleStateが載っていない");
  const envelope = {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: "test-v2-companyLab-engine-flex",
    labId: "lab-flex",
    playerCompanyId: fixtures[0].companyId,
    config: saved.config,
    fixtures,
    currentState: { runtime, revision: 1, lastProcessedTurnId: "turn-1" },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(envelope));
  const restoredSnapshot = decoded.currentState.runtime;

  const fromSaved = buildExportProcessingCapacity({
    companyId,
    fixtures,
    capexState: restoredSnapshot.capexState,
    asOfPeriod: restoredSnapshot.currentPeriod,
    pdMechanizationState: restoredSnapshot.pdMechanizationState,
    factoryLifecycleState: restoredSnapshot.factoryLifecycleState,
  });
  assert.deepEqual(exportTotals(fromSaved), samples[samples.length - 1].exported);
  assert.deepEqual(exportTotals(fromSaved), samples[samples.length - 1].engine);
});
