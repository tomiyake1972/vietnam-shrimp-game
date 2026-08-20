// ShrimpX V2 — Factory Recovery (ENG-FAC-1) × SAI-CAP-1 統合検証（統合指示§13 必須12項目）
//
// 目的: Standard AI が capacity を計算するとき、**現在実際に利用可能な Factory だけ**を
// 数えていることを実エンジンで固定する。fixture 上に工場が残っているかどうかではなく、
// lifecycle 適用後の実効 Factory state を正本にする。
//
// 【会社・シナリオ固有の分岐を持たない】判定はすべて lifecycle state と実効能力だけで行い、
// テスト側も companyId / scenarioId を引数化して複数の組み合わせで同じ不変条件を課す。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { buildStandardAiObservation } from "../observation";
import { computePhysicalCapacity } from "../bindingCapacity";
import { computeEffectiveFactories } from "../../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../../production/capacity";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { unwrapUnit } from "../../../core/units";
import { PeriodV2 } from "../../../core/period";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../types";
import { StandardAiObservation } from "../types";
import { createCompanyLabRuntimeSnapshot, restoreCompanyLabStateFromRuntimeSnapshot } from "../../persistence/snapshot";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../../persistence/codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../../persistence/types";

const RECOVERY = PRODUCTION_PARAMETERS_V1.yield.saleableRecoveryRatio;
const EPS = 1e-6;

/** 対象会社に2つ目の初期工場を足す（他社は一切変更しない）。 */
function withSecondFactory(fixtures: readonly CompanyFixture[], companyId: string): CompanyFixture[] {
  return fixtures.map((f) => {
    if (f.companyId !== companyId) return { ...f };
    const f1 = f.factories[0];
    return { ...f, factories: [f1, { ...f1, factoryId: `${companyId}-F2` }] };
  });
}

interface TurnProbe {
  readonly turn: number;
  readonly period: PeriodV2;
  /** エンジンが実際にその四半期の生産へ渡す Factory[]（lifecycle適用済み）。 */
  readonly engineFactories: readonly { readonly factoryId: string; readonly status: string }[];
  readonly engineBindingTons: number;
  readonly observation: StandardAiObservation;
  readonly aiBindingTons: number;
  readonly aiNearTermBindingTons: number;
  readonly aiBindingPool: string;
  readonly capexProposalTypes: readonly string[];
  readonly stateAfter: CompanyLabState;
}

function bindingOf(byProduct: { hoso: number; pd: number; vap: number }, common: number, freezing: number) {
  return computePhysicalCapacity({
    effectiveCapacityByProduct: byProduct,
    commonProcessingInputCapacityTons: common,
    freezingPackagingCapacityTons: freezing,
    saleableRecoveryRatioByProduct: RECOVERY,
  });
}

/**
 * Standard AI で turns 四半期進めながら、エンジン側の実効能力と Standard AI 側の
 * 観測能力を同じ四半期・同じ関数で並べて記録する。
 */
function runProbe(
  scenarioId: string,
  seed: string,
  companyIndex: number,
  turns: number,
  lifecycleByTurn: Readonly<Record<number, CompanyDecisionInput["factoryLifecycleDecisions"]>>,
  addSecondFactory = true
): { readonly probes: readonly TurnProbe[]; readonly targetCompanyId: string; readonly fixtures: readonly CompanyFixture[] } {
  const init = initializeCompanyLab({ scenarioId, mode: "canonical", seed, turns });
  const target = init.fixtures[companyIndex].companyId;
  const fixtures = addSecondFactory ? withSecondFactory(init.fixtures, target) : init.fixtures.map((f) => ({ ...f }));
  const baseFactories = fixtures.flatMap((f) => f.factories);

  let state = init.state;
  const probes: TurnProbe[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    let probe: TurnProbe | undefined;
    for (const f of fixtures) {
      const own = buildCompanyOwnState(state, f);
      const out = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo, state.currentPeriod, turn);
      decisions[f.companyId] = out.decision;
      if (f.companyId !== target) continue;

      const engineFactories = computeEffectiveFactories(
        baseFactories,
        state.capexState,
        state.currentPeriod,
        state.factoryLifecycleState
      ).filter((x) => x.companyId === target);
      const eng = { hoso: 0, pd: 0, vap: 0 };
      let engCommon = 0;
      let engFreeze = 0;
      for (const fac of engineFactories) {
        const c = calculateFactoryEffectiveCapacity(fac);
        eng.hoso += unwrapUnit(c.hoso);
        eng.pd += unwrapUnit(c.pd);
        eng.vap += unwrapUnit(c.vap);
        engCommon += unwrapUnit(c.commonProcessing);
        engFreeze += unwrapUnit(c.freezingPackaging);
      }
      const obs = buildStandardAiObservation(f, own, publicInfo, state.currentPeriod, turn);
      const ai = bindingOf(
        obs.totalEffectiveCapacityByProduct,
        obs.totalEffectiveCommonProcessingCapacity,
        obs.totalEffectiveFreezingPackagingCapacity
      );
      const nearTerm = bindingOf(
        obs.nearTermEffectiveCapacityByProduct,
        obs.nearTermEffectiveCommonProcessingCapacity,
        obs.nearTermEffectiveFreezingPackagingCapacity
      );
      probe = {
        turn,
        period: state.currentPeriod,
        engineFactories: engineFactories.map((x) => ({ factoryId: x.factoryId, status: x.status })),
        engineBindingTons: bindingOf(eng, engCommon, engFreeze).bindingPhysicalCapacityTons,
        observation: obs,
        aiBindingTons: ai.bindingPhysicalCapacityTons,
        aiNearTermBindingTons: nearTerm.bindingPhysicalCapacityTons,
        aiBindingPool: ai.bindingPhysicalPool,
        capexProposalTypes: (out.decision.capexDecision?.newProjectProposals ?? []).map((p) => p.projectType),
        stateAfter: state,
      };
    }
    const lc = lifecycleByTurn[turn];
    if (lc) decisions[target] = { ...decisions[target], factoryLifecycleDecisions: lc };
    assert.ok(probe, "対象会社の観測が取れていない");
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    probes.push({ ...probe!, stateAfter: state });
  }
  return { probes, targetCompanyId: target, fixtures };
}

const effectiveCapacityOfFactory = (obs: StandardAiObservation, factoryId: string): number | null => {
  const f = obs.factories.find((x) => x.factoryId === factoryId);
  if (!f) return null;
  return (
    f.effectiveCapacityByProduct.hoso +
    f.effectiveCapacityByProduct.pd +
    f.effectiveCapacityByProduct.vap +
    f.effectiveCommonProcessingCapacity +
    f.effectiveFreezingPackagingCapacity
  );
};

// =====================================================================
// 1〜6: lifecycle state 別の capacity 認識
// =====================================================================

test("FRSAI-1: OPERATING の工場は Standard AI の capacity に含まれる（エンジンの実効能力と一致）", () => {
  const { probes, targetCompanyId } = runProbe("baseline", "frsai-operating", 0, 3, {});
  const f2 = `${targetCompanyId}-F2`;
  for (const p of probes) {
    assert.equal(p.engineFactories.length, 2);
    assert.ok((effectiveCapacityOfFactory(p.observation, f2) ?? 0) > 0, `T${p.turn}: OPERATING工場の能力が0になっている`);
    assert.equal(p.aiBindingTons, p.engineBindingTons, `T${p.turn}: AIとエンジンのbinding capacityが一致しない`);
  }
});

test("FRSAI-2: MOTHBALLED の工場は T+1 から capacity へ含まれない（product-line / common / freezing すべて）", () => {
  const { probes, targetCompanyId } = runProbe("baseline", "frsai-mothball", 0, 5, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${initTarget("baseline", "frsai-mothball", 0)}-F2` }],
  });
  const f2 = `${targetCompanyId}-F2`;

  // T1・T2（決定した四半期そのものを含む）は通常操業。
  assert.ok((effectiveCapacityOfFactory(probes[0].observation, f2) ?? 0) > 0);
  assert.ok((effectiveCapacityOfFactory(probes[1].observation, f2) ?? 0) > 0);
  const beforeBinding = probes[1].aiBindingTons;

  for (const p of probes.slice(2)) {
    assert.equal(effectiveCapacityOfFactory(p.observation, f2), 0, `T${p.turn}: 休止工場の実効能力が0でない`);
    const f = p.observation.factories.find((x) => x.factoryId === f2)!;
    assert.equal(f.effectiveCapacityByProduct.hoso + f.effectiveCapacityByProduct.pd + f.effectiveCapacityByProduct.vap, 0);
    assert.equal(f.effectiveCommonProcessingCapacity, 0);
    assert.equal(f.effectiveFreezingPackagingCapacity, 0);
    assert.equal(p.aiBindingTons, p.engineBindingTons, `T${p.turn}: AIとエンジンのbindingが一致しない`);
    assert.ok(p.aiBindingTons < beforeBinding - EPS, `T${p.turn}: 休止後もbinding capacityが下がっていない`);
  }
});

test("FRSAI-3/4: SALE_PENDING は capacity へ含めず、SOLD は Factory 一覧からも消える", () => {
  const target0 = initTarget("baseline", "frsai-sale", 0);
  const { probes, targetCompanyId } = runProbe("baseline", "frsai-sale", 0, 5, {
    2: [{ type: "SELL_FACTORY", factoryId: `${target0}-F2` }],
  });
  const f2 = `${targetCompanyId}-F2`;

  assert.ok((effectiveCapacityOfFactory(probes[1].observation, f2) ?? 0) > 0, "売却を決めた四半期そのものは通常能力");
  // T+1: SALE_PENDING（保有はしているが能力0）
  assert.equal(probes[2].engineFactories.find((x) => x.factoryId === f2)?.status, "suspended");
  assert.equal(effectiveCapacityOfFactory(probes[2].observation, f2), 0, "SALE_PENDINGがcapacityへ入っている");
  // T+2 以降: SOLD（Factory[]から消える＝ghost capacityが復活しない）
  for (const p of probes.slice(3)) {
    assert.equal(effectiveCapacityOfFactory(p.observation, f2), null, `T${p.turn}: SOLD工場が観測に残っている`);
    assert.equal(p.observation.factories.length, 1);
    assert.equal(p.aiBindingTons, p.engineBindingTons);
  }
});

test("FRSAI-5: REACTIVATE した工場は effective になった Turn から再び capacity に含まれる", () => {
  const target0 = initTarget("baseline", "frsai-reactivate", 0);
  const { probes, targetCompanyId } = runProbe("baseline", "frsai-reactivate", 0, 6, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
    4: [{ type: "REACTIVATE_FACTORY", factoryId: `${target0}-F2` }],
  });
  const f2 = `${targetCompanyId}-F2`;

  assert.equal(effectiveCapacityOfFactory(probes[2].observation, f2), 0, "T3は休止中");
  assert.equal(effectiveCapacityOfFactory(probes[3].observation, f2), 0, "再稼働を決めたT4はまだ休止中");
  assert.equal(
    effectiveCapacityOfFactory(probes[4].observation, f2),
    effectiveCapacityOfFactory(probes[0].observation, f2),
    "T5で能力が元どおり復帰していない"
  );
  assert.equal(probes[4].aiBindingTons, probes[0].aiBindingTons, "再稼働後のbindingが休止前と一致しない");
  // 過去のcapacity snapshotではなく現在stateを読んでいること（T5・T6ともに復帰値）。
  assert.equal(probes[5].aiBindingTons, probes[0].aiBindingTons);
});

test("FRSAI-6: 複数工場の集計が正しい（AI合計＝エンジンの工場別実効能力の合計）", () => {
  const target0 = initTarget("baseline", "frsai-aggregate", 0);
  const { probes } = runProbe("baseline", "frsai-aggregate", 0, 5, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
  });
  for (const p of probes) {
    const perFactorySum = p.observation.factories.reduce(
      (s, f) => s + f.effectiveCapacityByProduct.hoso + f.effectiveCapacityByProduct.pd + f.effectiveCapacityByProduct.vap,
      0
    );
    const total =
      p.observation.totalEffectiveCapacityByProduct.hoso +
      p.observation.totalEffectiveCapacityByProduct.pd +
      p.observation.totalEffectiveCapacityByProduct.vap;
    assert.ok(Math.abs(perFactorySum - total) < EPS, `T${p.turn}: 工場別合計と総計が一致しない`);
    assert.equal(p.aiBindingTons, p.engineBindingTons, `T${p.turn}: 集計後のbindingがエンジンと一致しない`);
  }
});

// =====================================================================
// 7〜8: binding pool 判定 / CAPEX 候補
// =====================================================================

test("FRSAI-7: binding pool 判定が lifecycle 適用後の capacity を使う（near-term も含む）", () => {
  const target0 = initTarget("baseline", "frsai-binding", 0);
  const { probes } = runProbe("baseline", "frsai-binding", 0, 5, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
  });
  for (const p of probes) {
    assert.equal(p.aiBindingTons, p.engineBindingTons, `T${p.turn}: bindingPhysicalCapacityがエンジンと一致しない`);
    assert.ok(p.aiBindingPool !== "NONE", `T${p.turn}: bindingPoolが判定できていない`);
  }
  // 納期（当期＋リードタイム）時点の能力も lifecycle を反映する。
  // T1・T2 は休止決定がまだstateへ入っていない（決定はその四半期の処理で受理される）ため
  // 縮小しないのが正しい。休止が state に入った T3 以降で near-term も縮小していること。
  assert.equal(probes[0].aiNearTermBindingTons, probes[1].aiNearTermBindingTons, "決定前のnear-termが変化している");
  for (const p of probes.slice(2)) {
    assert.ok(
      p.aiNearTermBindingTons < probes[0].aiNearTermBindingTons - EPS,
      `T${p.turn}: near-term能力が休止を反映していない`
    );
    assert.equal(p.aiNearTermBindingTons, p.engineBindingTons, `T${p.turn}: near-termがエンジンの実効能力と一致しない`);
  }
});

test("FRSAI-8: CAPEX 候補の名目→実効換算が、休止工場の名目能力で薄まらない", () => {
  const target0 = initTarget("baseline", "frsai-capex", 0);
  const { probes } = runProbe("baseline", "frsai-capex", 0, 5, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
  });
  // decision/capex.ts の effectiveRateFactor と同じ式（実効能力を生んでいる工場だけを分母にする）。
  const rateOf = (p: TurnProbe): number => {
    const nominal = p.observation.factories
      .filter((f) => f.effectiveCommonProcessingCapacity > EPS)
      .reduce((s, f) => s + f.commonProcessingCapacity, 0);
    return nominal > EPS ? p.observation.totalEffectiveCommonProcessingCapacity / nominal : 1;
  };
  const before = rateOf(probes[0]);
  assert.ok(before > 0 && before <= 1);
  for (const p of probes.slice(2)) {
    assert.ok(Math.abs(rateOf(p) - before) < 1e-9, `T${p.turn}: 休止後に名目→実効換算率が変化している（CAPEX候補の過小評価）`);
  }
});

// =====================================================================
// 9: lifecycle 未使用時の regression（opt-in）
// =====================================================================

test("FRSAI-9: lifecycle 決定を一切使わなければ、Standard AI の意思決定は完全に不変（opt-in）", () => {
  const a = runProbe("baseline", "frsai-optin", 0, 8, {}, false);
  const b = runProbe("baseline", "frsai-optin", 0, 8, {}, false);
  assert.equal(JSON.stringify(a.probes.map((p) => p.observation)), JSON.stringify(b.probes.map((p) => p.observation)));
  for (const p of a.probes) {
    assert.equal(p.aiBindingTons, p.engineBindingTons, `T${p.turn}: lifecycle未使用でもAIとエンジンが食い違う`);
    assert.equal(p.stateAfter.factoryLifecycleState, undefined, "lifecycle未使用なのにstateへlifecycleが作られている");
  }
});

// =====================================================================
// 10: 会社・シナリオのhardcodeが無いこと
// =====================================================================

test("FRSAI-10: 同じ不変条件が会社・シナリオを変えてもそのまま成立する（hardcodeなし）", () => {
  for (const [scenarioId, companyIndex] of [
    ["baseline", 1],
    ["baseline", 2],
    ["dynamic-scenario-1", 0],
    ["dynamic-scenario-2", 1],
  ] as const) {
    const seed = `frsai-generic-${scenarioId}-${companyIndex}`;
    const target0 = initTarget(scenarioId, seed, companyIndex);
    const { probes } = runProbe(scenarioId, seed, companyIndex, 5, {
      2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
    });
    const f2 = `${target0}-F2`;
    for (const p of probes) {
      assert.equal(p.aiBindingTons, p.engineBindingTons, `${scenarioId}/${target0} T${p.turn}: AIとエンジンが一致しない`);
    }
    for (const p of probes.slice(2)) {
      assert.equal(effectiveCapacityOfFactory(p.observation, f2), 0, `${scenarioId}/${target0} T${p.turn}: 休止工場が能力を持っている`);
    }
  }
});

// =====================================================================
// 11〜12: Save/Resume・決定性
// =====================================================================

function buildStoredEnvelope(state: CompanyLabState, fixtures: readonly CompanyFixture[], runtime: unknown): CompanyLabPersistedStateV1 {
  return {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: "test-v2-companyLab-engine-frsai",
    labId: "lab-frsai",
    playerCompanyId: fixtures[0].companyId,
    config: state.config,
    fixtures,
    currentState: { runtime, revision: 1, lastProcessedTurnId: "turn-1" },
    draft: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as CompanyLabPersistedStateV1;
}

test("FRSAI-11: Save/Resume 後も Standard AI は同じ capacity を認識する", () => {
  const target0 = initTarget("baseline", "frsai-persist", 0);
  const { probes, targetCompanyId, fixtures } = runProbe("baseline", "frsai-persist", 0, 4, {
    2: [{ type: "MOTHBALL_FACTORY", factoryId: `${target0}-F2` }],
  });
  const saved = probes[probes.length - 1].stateAfter;
  const runtime = createCompanyLabRuntimeSnapshot(saved);
  const decoded = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(buildStoredEnvelope(saved, fixtures, runtime)));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(saved.config, decoded.currentState.runtime, []);

  const fixture = fixtures.find((f) => f.companyId === targetCompanyId)!;
  const build = (s: CompanyLabState) =>
    buildStandardAiObservation(fixture, buildCompanyOwnState(s, fixture), buildPublicMarketInfo(s), s.currentPeriod, 5);
  const before = build(saved);
  const after = build(restored);

  assert.equal(after.totalEffectiveCommonProcessingCapacity, before.totalEffectiveCommonProcessingCapacity);
  assert.equal(after.totalEffectiveFreezingPackagingCapacity, before.totalEffectiveFreezingPackagingCapacity);
  assert.deepEqual(after.totalEffectiveCapacityByProduct, before.totalEffectiveCapacityByProduct);
  assert.equal(effectiveCapacityOfFactory(after, `${targetCompanyId}-F2`), 0, "Resume後に休止工場の能力が復活している");
});

test("FRSAI-12: 同じ入力からは同じ capacity 認識が得られる（決定的）", () => {
  const target0 = initTarget("baseline", "frsai-deterministic", 0);
  const lifecycle = { 2: [{ type: "MOTHBALL_FACTORY" as const, factoryId: `${target0}-F2` }] };
  const a = runProbe("baseline", "frsai-deterministic", 0, 5, lifecycle);
  const b = runProbe("baseline", "frsai-deterministic", 0, 5, lifecycle);
  assert.deepEqual(
    a.probes.map((p) => [p.aiBindingTons, p.aiNearTermBindingTons, p.aiBindingPool, p.capexProposalTypes]),
    b.probes.map((p) => [p.aiBindingTons, p.aiNearTermBindingTons, p.aiBindingPool, p.capexProposalTypes])
  );
});

/** 対象会社IDだけを先に知るための最小ヘルパー（lifecycle決定のfactoryId生成に使う）。 */
function initTarget(scenarioId: string, seed: string, companyIndex: number): string {
  return initializeCompanyLab({ scenarioId, mode: "canonical", seed, turns: 1 }).fixtures[companyIndex].companyId;
}
