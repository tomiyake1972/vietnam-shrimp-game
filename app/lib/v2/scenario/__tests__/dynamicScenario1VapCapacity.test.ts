// ShrimpX V2 — Dynamic Scenario 1 の VAP 加工能力構造のテスト（External VAP Capacity Recalibration）
//
// 守りたいのは次の3点。
//  (a) DS1 では産地ごとにVAP能力が違う（生産量 × 共通比率ではない）。
//  (b) DS1 のベトナムは5社の保有設備が world capacity になり、生産計画ではない。
//  (c) 上記はすべて DS1 だけの話で、baseline 等・共有フィクスチャは一切変わらない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyFixtures } from "../../companyLab/fixtures";
import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../../companyLab/runner";
import { generateStandardAiDecision } from "../../companyLab/standardAi/policy";
import { initializeScenario, getScenarioTurnInput } from "../scenarioEngine";
import { DYNAMIC_SCENARIO_1 } from "../definitions/dynamicScenario1";
import { BASELINE_SCENARIO } from "../definitions/baseline";
import { DS1_INITIAL_COMPANY_VAP_CAPACITY_TONS } from "../definitions/dynamicScenario1Parameters";
import { SCENARIO_ENGINE_PARAMETERS_V1 } from "../parameters";
import { unwrapUnit } from "../../core/units";
import { computeFactoryUsedSpaceUnits, resolveFactoryTotalSpaceUnits, computeProjectRequiredSpaceUnits } from "../../production/factorySpace";
import { PeriodV2 } from "../../core/period";
import { Factory } from "../../production/types";

const DS1 = DYNAMIC_SCENARIO_1.scenarioId;
const EXPECTED = { BAL: 1500, MASS: 1500, JPQ: 1500, CONSV: 1500, VAP: 2000 } as const;
const EXPECTED_TOTAL = Object.values(EXPECTED).reduce((a, b) => a + b, 0);

function ds1Lab(seed = "ds1-vap-test") {
  return initializeCompanyLab({ scenarioId: DS1, mode: "canonical", seed, turns: 32 });
}

function vapCapacityOf(fixtures: ReturnType<typeof ds1Lab>["fixtures"], companyId: string): number {
  const f = fixtures.find((x) => x.companyId === companyId);
  assert.ok(f, `${companyId} が見つからない`);
  return f.factories.reduce((sum, fac) => sum + unwrapUnit(fac.vapCapacity), 0);
}

// ---------------------------------------------------------------------
// Vietnam 5社の初期VAP設備
// ---------------------------------------------------------------------

test("DS1-VAP-1: DS1のベトナム5社の初期VAP能力は宣言値どおり（合計8,000t）", () => {
  const { fixtures } = ds1Lab();
  for (const [companyId, tons] of Object.entries(EXPECTED)) {
    assert.equal(vapCapacityOf(fixtures, companyId), tons, `${companyId} の初期VAP能力`);
  }
  const total = fixtures.reduce((sum, f) => sum + f.factories.reduce((s, fac) => s + unwrapUnit(fac.vapCapacity), 0), 0);
  assert.equal(total, EXPECTED_TOTAL);
  // シナリオ定義の宣言とフィクスチャ適用結果が食い違わないこと。
  assert.deepEqual({ ...DS1_INITIAL_COMPANY_VAP_CAPACITY_TONS }, { ...EXPECTED });
});

test("DS1-VAP-2: 共有フィクスチャとbaselineは一切変わらない（DS1限定の上書き）", () => {
  const shared = buildCompanyFixtures("Y1Q1" as unknown as PeriodV2);
  const sharedVap = Object.fromEntries(shared.map((f) => [f.companyId, f.factories.reduce((s, fac) => s + unwrapUnit(fac.vapCapacity), 0)]));
  assert.deepEqual(sharedVap, { BAL: 5000, MASS: 4000, JPQ: 5000, VAP: 6000, CONSV: 4000 });

  const baseline = initializeCompanyLab({ scenarioId: BASELINE_SCENARIO.scenarioId, mode: "canonical", seed: "s", turns: 8 });
  const baselineVap = Object.fromEntries(
    baseline.fixtures.map((f) => [f.companyId, f.factories.reduce((s, fac) => s + unwrapUnit(fac.vapCapacity), 0)])
  );
  assert.deepEqual(baselineVap, sharedVap, "baseline は共有フィクスチャのまま");
  assert.equal(BASELINE_SCENARIO.initialCompanyVapCapacityTons, undefined);
  assert.equal(BASELINE_SCENARIO.vapCapacitySignal, undefined);
});

test("DS1-VAP-3: VAP以外の能力は変わらない（Common/HOSO/PD/Frozen/Cold storage）", () => {
  const shared = buildCompanyFixtures("Y1Q1" as unknown as PeriodV2);
  const { fixtures } = ds1Lab();
  for (const sharedFixture of shared) {
    const ds1Fixture = fixtures.find((f) => f.companyId === sharedFixture.companyId);
    assert.ok(ds1Fixture);
    for (let i = 0; i < sharedFixture.factories.length; i++) {
      const a: Factory = sharedFixture.factories[i];
      const b: Factory = ds1Fixture.factories[i];
      assert.equal(unwrapUnit(b.commonProcessingCapacity), unwrapUnit(a.commonProcessingCapacity), "common");
      assert.equal(unwrapUnit(b.hosoCapacity), unwrapUnit(a.hosoCapacity), "hoso");
      assert.equal(unwrapUnit(b.pdCapacity), unwrapUnit(a.pdCapacity), "pd");
      assert.equal(unwrapUnit(b.freezingPackagingCapacity), unwrapUnit(a.freezingPackagingCapacity), "freezing");
      assert.equal(
        b.coldStorageCapacity === undefined ? null : unwrapUnit(b.coldStorageCapacity),
        a.coldStorageCapacity === undefined ? null : unwrapUnit(a.coldStorageCapacity),
        "coldStorage"
      );
    }
  }
});

// ---------------------------------------------------------------------
// Factory space（建屋は縮まず、空きが増える）
// ---------------------------------------------------------------------

test("DS1-VAP-4: 建屋の広さは据え置かれ、VAP設備を減らしたぶん空きスペースが増える", () => {
  const shared = buildCompanyFixtures("Y1Q1" as unknown as PeriodV2);
  const { fixtures } = ds1Lab();
  const vapLineSpace = computeProjectRequiredSpaceUnits({ projectType: "vapLineExpansion", targetPool: "vap", capacityIncreaseTons: 250 });

  for (const sharedFixture of shared) {
    const ds1Fixture = fixtures.find((f) => f.companyId === sharedFixture.companyId);
    assert.ok(ds1Fixture);
    const a = sharedFixture.factories[0];
    const b = ds1Fixture.factories[0];

    assert.equal(resolveFactoryTotalSpaceUnits(b), resolveFactoryTotalSpaceUnits(a), "建屋の総面積は据え置き");
    const freeBefore = resolveFactoryTotalSpaceUnits(a) - computeFactoryUsedSpaceUnits(a);
    const freeAfter = resolveFactoryTotalSpaceUnits(b) - computeFactoryUsedSpaceUnits(b);
    assert.ok(freeAfter > freeBefore, `${sharedFixture.companyId}: 空きスペースが増えること (${freeBefore} → ${freeAfter})`);
    assert.ok(freeAfter >= vapLineSpace, "VAPライン増設1件ぶんのスペースが残ること");
  }
});

// ---------------------------------------------------------------------
// 産地別 VAP 能力
// ---------------------------------------------------------------------

test("DS1-VAP-5: DS1のEC/IN/IDのVAP能力は産地別で、生産量×共通比率ではない", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "vap-origin");
  const ratio = SCENARIO_ENGINE_PARAMETERS_V1.defaultVapCapacityRatioOfProduction;

  for (const turn of [1, 8, 16, 24, 32]) {
    const input = getScenarioTurnInput(state, turn);
    for (const country of ["EC", "IN", "ID"] as const) {
      const capacity = unwrapUnit(input.countries[country].vapProcessingCapacity);
      const production = unwrapUnit(input.countries[country].production);
      assert.notEqual(capacity, production * ratio, `${country} T${turn}: 共通比率の導出から外れていること`);
      // 生産量に比例していない＝加工能力が生産量より明確に小さい水準にある。
      assert.ok(capacity < production * ratio, `${country} T${turn}: 共通比率より低いこと`);
    }
  }
});

test("DS1-VAP-6: EC/INは終盤まで低水準、IDは緩やかに増える（産地の性格）", () => {
  const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "vap-origin-path");
  const at = (turn: number, country: "EC" | "IN" | "ID") =>
    unwrapUnit(getScenarioTurnInput(state, turn).countries[country].vapProcessingCapacity);

  // EC: T13以降に生産が伸びてもVAP能力はほぼ横ばい（32ターンで+15%未満）。
  assert.ok(at(32, "EC") / at(1, "EC") < 1.15, "EC は横ばい〜緩やか");
  assert.ok(at(32, "IN") / at(1, "IN") < 1.15, "IN は低水準維持");
  // ID: 緩やかに増える（増えるが倍にはしない）。
  assert.ok(at(32, "ID") > at(1, "ID") * 1.15, "ID は緩やかに増える");
  assert.ok(at(32, "ID") < at(1, "ID") * 2, "ID も世界需要を常に上回る規模にはしない");
  // ID が EC・IN より厚いVAP産地であること。
  assert.ok(at(1, "ID") > at(1, "EC") && at(1, "ID") > at(1, "IN"), "ID が最もVAP能力を持つ外部産地");
});

test("DS1-VAP-7: baselineシナリオのEC/IN/IDは従来どおり生産量×共通比率のまま", () => {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "baseline-vap");
  const ratio = SCENARIO_ENGINE_PARAMETERS_V1.defaultVapCapacityRatioOfProduction;
  const input = getScenarioTurnInput(state, 1);
  for (const country of ["EC", "IN", "ID"] as const) {
    const capacity = unwrapUnit(input.countries[country].vapProcessingCapacity);
    const production = unwrapUnit(input.countries[country].production);
    assert.ok(Math.abs(capacity - production * ratio) < 1, `${country}: baseline は共通比率のまま`);
  }
});

// ---------------------------------------------------------------------
// VN の world capacity シグナル
// ---------------------------------------------------------------------

test("DS1-VAP-8: DS1のworld VAP capacityのVN分は保有設備であり、生産計画ではない", () => {
  const { state: initialState, fixtures } = ds1Lab("vn-signal");
  const publicInfo = buildPublicMarketInfo(initialState);
  const decisions = fixtures.map((f) =>
    generateStandardAiDecision(f, buildCompanyOwnState(initialState, f), publicInfo, initialState.currentPeriod, initialState.scenarioState.currentTurn)
  );
  const plannedVap = decisions.reduce(
    (sum, d) => sum + d.productionPlans.filter((p) => p.product === "vap").reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0),
    0
  );
  const nominalVap = fixtures.reduce((sum, f) => sum + f.factories.reduce((s, fac) => s + unwrapUnit(fac.vapCapacity), 0), 0);

  const next = advanceCompanyLabQuarter(initialState, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
  const record = next.history[next.history.length - 1];
  const worldCapacity = unwrapUnit(record.marketResult.vapPremium.globalCapacity);

  const scenarioState = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "vn-signal");
  const turn1 = getScenarioTurnInput(scenarioState, 1);
  const external = (["EC", "IN", "ID"] as const).reduce((sum, c) => sum + unwrapUnit(turn1.countries[c].vapProcessingCapacity), 0);

  assert.equal(Math.round(worldCapacity - external), nominalVap, "world capacity の VN 分＝5社の保有設備合計");
  assert.notEqual(Math.round(worldCapacity - external), Math.round(plannedVap), "生産計画ではないこと");
});

test("DS1-VAP-9: Turn1のworld VAP稼働率が、設備過剰一辺倒でも極端な不足でもない範囲に入る", () => {
  const { state: initialState, fixtures } = ds1Lab("util-check");
  const publicInfo = buildPublicMarketInfo(initialState);
  const decisions = fixtures.map((f) =>
    generateStandardAiDecision(f, buildCompanyOwnState(initialState, f), publicInfo, initialState.currentPeriod, initialState.scenarioState.currentTurn)
  );
  const next = advanceCompanyLabQuarter(initialState, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
  const vap = next.history[next.history.length - 1].marketResult.vapPremium;

  // 変更前は 27.8%（設備過剰が支配的）。数値そのものを固定はしないが、
  // 「30%前後の低稼働」からは明確に上がり、かつ逼迫（>100%）ではないこと。
  assert.ok(vap.globalUtilization > 0.45, `Turn1稼働率が低すぎる: ${vap.globalUtilization}`);
  assert.ok(vap.globalUtilization < 0.95, `Turn1稼働率が高すぎる: ${vap.globalUtilization}`);
  assert.equal(vap.drivers.includes("VAP_CAPACITY_TIGHTNESS"), false, "Turn1から能力逼迫にはしない");
});
