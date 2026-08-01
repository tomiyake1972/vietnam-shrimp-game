// ShrimpX V2 — 商品戦略プロファイル検証用「環境」（市場条件）定義のテスト
//
// 検証すること：
// 1. NORMAL環境はBASELINE_SCENARIOと（scenarioId/テキスト以外）パラメータが
//    ビット単位で一致する（純粋な追加であることの確認）。
// 2. 各追い風環境の差分が、コメントで説明した意図どおりになっている
//    （需要成長率・PD/VAP処理能力トレンドの数値検証）。
// 3. 検証を通る（validateScenarioDefinition）。
// 4. findScenarioDefinitionForCompanyLab() 経由で解決でき、
//    runAutoplayCase() で数ターンのスモークランが例外なく完走する。
// 5. 既存の代表5シナリオ一覧（ALL_SCENARIO_DEFINITIONS）には一切追加されて
//    いない（industryLab側の既存テストが5件固定を検証しているため）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenarioDefinition } from "../../../../scenario/validation";
import { getScenarioTurnInput, initializeScenario } from "../../../../scenario/scenarioEngine";
import { ALL_SCENARIO_DEFINITIONS, BASELINE_SCENARIO } from "../../../../scenario/definitions";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../../../../market/types";
import { unwrapUnit } from "../../../../core/units";
import {
  STRATEGY_VERIFICATION_ENVIRONMENT_IDS,
  STRATEGY_VERIFICATION_ENVIRONMENTS,
  STRATEGY_VERIFICATION_HOSO_TAILWIND_ENVIRONMENT,
  STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT,
  STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT,
  STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT,
  resolveStrategyVerificationEnvironment,
} from "../strategyVerificationEnvironments";
import { findScenarioDefinitionForCompanyLab } from "../../../runner";
import { runAutoplayCase } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

test("4環境すべてが検証（validateScenarioDefinition）を通る", () => {
  for (const id of STRATEGY_VERIFICATION_ENVIRONMENT_IDS) {
    const definition = STRATEGY_VERIFICATION_ENVIRONMENTS[id];
    const result = validateScenarioDefinition(definition);
    assert.equal(result.valid, true, `${id}(${definition.scenarioId}): ${result.errors.join(", ")}`);
  }
});

test("4環境すべてが標準の32ターン（8年）", () => {
  for (const id of STRATEGY_VERIFICATION_ENVIRONMENT_IDS) {
    assert.equal(STRATEGY_VERIFICATION_ENVIRONMENTS[id].durationTurns, 32, id);
  }
});

test("4環境のscenarioIdはすべて異なり、代表5シナリオのIDとも重複しない", () => {
  const ids = STRATEGY_VERIFICATION_ENVIRONMENT_IDS.map((id) => STRATEGY_VERIFICATION_ENVIRONMENTS[id].scenarioId);
  assert.equal(new Set(ids).size, ids.length);
  const baselineIds = new Set(ALL_SCENARIO_DEFINITIONS.map((d) => d.scenarioId));
  for (const id of ids) {
    assert.ok(!baselineIds.has(id), `${id} が代表5シナリオのIDと衝突している`);
  }
});

test("代表5シナリオ一覧（ALL_SCENARIO_DEFINITIONS）は4検証環境の追加によって変化しない（純粋な追加であることの確認）", () => {
  assert.equal(ALL_SCENARIO_DEFINITIONS.length, 5);
});

// ---------------------------------------------------------------------
// NORMAL — ベースラインとビット単位で一致すること
// ---------------------------------------------------------------------

test("NORMAL環境: 全32ターンのScenarioTurnInputがBASELINE_SCENARIOと数値的にビット単位で一致する", () => {
  const normalState = initializeScenario(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT, "canonical", "seed-normal-vs-baseline");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-normal-vs-baseline");

  for (let turn = 1; turn <= 32; turn++) {
    const normalInput = getScenarioTurnInput(normalState, turn);
    const baselineInput = getScenarioTurnInput(baselineState, turn);

    for (const c of COUNTRY_IDS) {
      assert.deepEqual(normalInput.countries[c], baselineInput.countries[c], `turn${turn} country ${c}`);
    }
    for (const m of DEMAND_MARKET_IDS) {
      assert.deepEqual(normalInput.demandMarkets[m], baselineInput.demandMarkets[m], `turn${turn} market ${m}`);
    }
    assert.deepEqual(normalInput.pdVapDemand, baselineInput.pdVapDemand, `turn${turn} pdVapDemand`);
    assert.deepEqual(normalInput.vietnamProcessingEconomics, baselineInput.vietnamProcessingEconomics, `turn${turn}`);
    assert.equal(
      unwrapUnit(normalInput.vietnamDomesticRawSupply),
      unwrapUnit(baselineInput.vietnamDomesticRawSupply),
      `turn${turn}`
    );
    assert.deepEqual(normalInput.activeEventIds, baselineInput.activeEventIds, `turn${turn}`);
  }
});

test("NORMAL環境: 長期トレンド・イベント・前史・初期状態オブジェクトがBASELINE_SCENARIOと同一参照である", () => {
  assert.equal(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.longTermTrends, BASELINE_SCENARIO.longTermTrends);
  assert.equal(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.scheduledEvents, BASELINE_SCENARIO.scheduledEvents);
  assert.equal(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.informationReleases, BASELINE_SCENARIO.informationReleases);
  assert.equal(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.prehistory, BASELINE_SCENARIO.prehistory);
  assert.equal(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.initialStateOverrides, BASELINE_SCENARIO.initialStateOverrides);
  // scenarioIdだけは意図的に異なる（環境として区別するため）。
  assert.notEqual(STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.scenarioId, BASELINE_SCENARIO.scenarioId);
});

// ---------------------------------------------------------------------
// HOSO_TAILWIND — 需要成長 + 供給抑制の意図どおりの差分
// ---------------------------------------------------------------------

test("HOSO_TAILWIND: CN/OTHERの地域別潜在需要ターン32時点がベースラインより高い", () => {
  const hosoState = initializeScenario(STRATEGY_VERIFICATION_HOSO_TAILWIND_ENVIRONMENT, "canonical", "seed-hoso");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-hoso");
  const hosoTurn32 = getScenarioTurnInput(hosoState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  for (const m of ["CN", "OTHER"] as const) {
    assert.ok(
      unwrapUnit(hosoTurn32.demandMarkets[m].priorPeriodConsumption) >
        unwrapUnit(baselineTurn32.demandMarkets[m].priorPeriodConsumption),
      `${m}: HOSO_TAILWINDの需要がベースライン以下`
    );
  }
  // US/EU/JPはベースライン据え置き（HOSO_SCALE戦略が主戦場とする市場だけを動かす）。
  for (const m of ["US", "EU", "JP"] as const) {
    assert.equal(
      unwrapUnit(hosoTurn32.demandMarkets[m].priorPeriodConsumption),
      unwrapUnit(baselineTurn32.demandMarkets[m].priorPeriodConsumption),
      `${m}: ベースラインから変化してはいけない`
    );
  }
});

test("HOSO_TAILWIND: 4か国とも養殖能力(COUNTRY_CAPACITY起点のproduction)の伸びがベースラインより緩やか", () => {
  const hosoState = initializeScenario(STRATEGY_VERIFICATION_HOSO_TAILWIND_ENVIRONMENT, "canonical", "seed-hoso-capacity");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-hoso-capacity");
  const hosoTurn32 = getScenarioTurnInput(hosoState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  for (const c of COUNTRY_IDS) {
    assert.ok(
      unwrapUnit(hosoTurn32.countries[c].production) < unwrapUnit(baselineTurn32.countries[c].production),
      `${c}: HOSO_TAILWINDの生産量がベースライン以上（供給抑制になっていない）`
    );
  }
});

// ---------------------------------------------------------------------
// PD_TAILWIND — 需要底堅い成長 + PD処理能力横ばい + イベントなし
// ---------------------------------------------------------------------

test("PD_TAILWIND: 全5市場の需要ターン32時点がベースラインより高い（偏りのない底堅い成長）", () => {
  const pdState = initializeScenario(STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT, "canonical", "seed-pd");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-pd");
  const pdTurn32 = getScenarioTurnInput(pdState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  for (const m of DEMAND_MARKET_IDS) {
    assert.ok(
      unwrapUnit(pdTurn32.demandMarkets[m].priorPeriodConsumption) >
        unwrapUnit(baselineTurn32.demandMarkets[m].priorPeriodConsumption),
      `${m}: PD_TAILWINDの需要がベースライン以下`
    );
  }
});

test("PD_TAILWIND: PD処理能力の伸びがVAP処理能力・ベースラインより明確に緩やかである（PD稼働率だけを引き締める）", () => {
  const pdState = initializeScenario(STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT, "canonical", "seed-pd-capacity");
  const turn1 = getScenarioTurnInput(pdState, 1);
  const turn32 = getScenarioTurnInput(pdState, 32);

  for (const c of COUNTRY_IDS) {
    const pdGrowthRatio = unwrapUnit(turn32.countries[c].pdProcessingCapacity) / unwrapUnit(turn1.countries[c].pdProcessingCapacity);
    const vapGrowthRatio =
      unwrapUnit(turn32.countries[c].vapProcessingCapacity) / unwrapUnit(turn1.countries[c].vapProcessingCapacity);
    const productionGrowthRatio = unwrapUnit(turn32.countries[c].production) / unwrapUnit(turn1.countries[c].production);

    assert.ok(pdGrowthRatio < 1.1, `${c}: PD処理能力がほぼ横ばいになっていない（成長率 ${pdGrowthRatio}）`);
    assert.ok(pdGrowthRatio < vapGrowthRatio, `${c}: PD処理能力の伸びがVAPより緩やかになっていない`);
    assert.ok(pdGrowthRatio < productionGrowthRatio, `${c}: PD処理能力の伸びがproductionより緩やかになっていない（需給が引き締まらない）`);
  }
});

test("PD_TAILWIND: ベースラインの疾病・景気減速イベントを含まない（低ボラティリティ）", () => {
  assert.equal(STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT.scheduledEvents.length, 0);
  assert.ok(BASELINE_SCENARIO.scheduledEvents.length > 0, "比較対象のベースラインにイベントが無い（テスト前提の確認）");
});

test("PD_TAILWIND: VN/IDの品質評価(QUALITY_SCORE)がターン32でベースラインより高い", () => {
  const pdState = initializeScenario(STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT, "canonical", "seed-pd-quality");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-pd-quality");
  const pdTurn32 = getScenarioTurnInput(pdState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  for (const c of ["VN", "ID"] as const) {
    assert.ok(
      unwrapUnit(pdTurn32.countries[c].qualityScore) > unwrapUnit(baselineTurn32.countries[c].qualityScore),
      `${c}: PD_TAILWINDの品質評価がベースライン以下`
    );
  }
});

// ---------------------------------------------------------------------
// VAP_TAILWIND — 高付加価値市場の需要成長 + VAP処理能力横ばい
// ---------------------------------------------------------------------

test("VAP_TAILWIND: US/EU/JP/CNの地域別潜在需要ターン32時点がベースラインより高い", () => {
  const vapState = initializeScenario(STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT, "canonical", "seed-vap");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-vap");
  const vapTurn32 = getScenarioTurnInput(vapState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  for (const m of ["US", "EU", "JP", "CN"] as const) {
    assert.ok(
      unwrapUnit(vapTurn32.demandMarkets[m].priorPeriodConsumption) >
        unwrapUnit(baselineTurn32.demandMarkets[m].priorPeriodConsumption),
      `${m}: VAP_TAILWINDの需要がベースライン以下`
    );
  }
  assert.equal(
    unwrapUnit(vapTurn32.demandMarkets.OTHER.priorPeriodConsumption),
    unwrapUnit(baselineTurn32.demandMarkets.OTHER.priorPeriodConsumption),
    "OTHER: ベースラインから変化してはいけない"
  );
});

test("VAP_TAILWIND: VAP処理能力の伸びがPD処理能力・ベースラインより明確に緩やかである（VAP稼働率だけを引き締める）", () => {
  const vapState = initializeScenario(STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT, "canonical", "seed-vap-capacity");
  const turn1 = getScenarioTurnInput(vapState, 1);
  const turn32 = getScenarioTurnInput(vapState, 32);

  for (const c of COUNTRY_IDS) {
    const pdGrowthRatio = unwrapUnit(turn32.countries[c].pdProcessingCapacity) / unwrapUnit(turn1.countries[c].pdProcessingCapacity);
    const vapGrowthRatio =
      unwrapUnit(turn32.countries[c].vapProcessingCapacity) / unwrapUnit(turn1.countries[c].vapProcessingCapacity);
    const productionGrowthRatio = unwrapUnit(turn32.countries[c].production) / unwrapUnit(turn1.countries[c].production);

    assert.ok(vapGrowthRatio < 1.15, `${c}: VAP処理能力がほぼ横ばいになっていない（成長率 ${vapGrowthRatio}）`);
    assert.ok(vapGrowthRatio < pdGrowthRatio, `${c}: VAP処理能力の伸びがPDより緩やかになっていない`);
    assert.ok(vapGrowthRatio < productionGrowthRatio, `${c}: VAP処理能力の伸びがproductionより緩やかになっていない（需給が引き締まらない）`);
  }
});

test("VAP_TAILWIND: 世界VAP需要(pdVapDemand.vapDemand)のターン32時点がベースラインより高い", () => {
  const vapState = initializeScenario(STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT, "canonical", "seed-vap-demand");
  const baselineState = initializeScenario(BASELINE_SCENARIO, "canonical", "seed-vap-demand");
  const vapTurn32 = getScenarioTurnInput(vapState, 32);
  const baselineTurn32 = getScenarioTurnInput(baselineState, 32);

  assert.ok(
    unwrapUnit(vapTurn32.pdVapDemand.vapDemand) > unwrapUnit(baselineTurn32.pdVapDemand.vapDemand),
    "VAP_TAILWINDの世界VAP需要がベースライン以下"
  );
});

// ---------------------------------------------------------------------
// findScenarioDefinitionForCompanyLab() 経由の解決 + スモークラン
// ---------------------------------------------------------------------

test("resolveStrategyVerificationEnvironment: 4環境すべてscenarioIdから解決でき、代表シナリオのID・未知のIDでは解決しない", () => {
  for (const id of STRATEGY_VERIFICATION_ENVIRONMENT_IDS) {
    const definition = STRATEGY_VERIFICATION_ENVIRONMENTS[id];
    assert.equal(resolveStrategyVerificationEnvironment(definition.scenarioId), definition);
  }
  assert.equal(resolveStrategyVerificationEnvironment("baseline-v0.1"), undefined);
  assert.equal(resolveStrategyVerificationEnvironment("no-such-scenario"), undefined);
});

test("findScenarioDefinitionForCompanyLab: 4環境すべてscenarioIdから解決でき、既存の代表5シナリオの解決も従来どおり機能する", () => {
  for (const id of STRATEGY_VERIFICATION_ENVIRONMENT_IDS) {
    const definition = STRATEGY_VERIFICATION_ENVIRONMENTS[id];
    assert.equal(findScenarioDefinitionForCompanyLab(definition.scenarioId), definition);
  }
  // 既存の短縮形解決（industryLabのCLIエイリアス）が壊れていないことの確認。
  assert.equal(findScenarioDefinitionForCompanyLab("baseline").scenarioId, BASELINE_SCENARIO.scenarioId);
});

test("findScenarioDefinitionForCompanyLab: 未知のscenarioIdは例外を投げる", () => {
  assert.throws(() => findScenarioDefinitionForCompanyLab("no-such-scenario-id"));
});

test("runAutoplayCase: 4環境すべてで数ターンのスモークランが例外なく完走する（32ターンの本番実行は別タスクの責務）", () => {
  for (const id of STRATEGY_VERIFICATION_ENVIRONMENT_IDS) {
    const definition = STRATEGY_VERIFICATION_ENVIRONMENTS[id];
    const result = runAutoplayCase({
      scenarioId: definition.scenarioId,
      seed: `strategy-verification-smoke-${id}`,
      quarters: 3,
      companyIds: ALL_COMPANY_IDS,
      candidate,
      strategyProfilesEnabled: true,
    });
    assert.equal(result.completedTurns, 3, id);
    assert.equal(result.history.length, 3, id);
    assert.equal(result.companies.length, 5, id);
  }
});

test("runAutoplayCase: NORMAL環境かつstrategyProfilesEnabled未指定なら、'baseline'エイリアスで実行した既存経路と同一結果になる", () => {
  const normalResult = runAutoplayCase({
    scenarioId: STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT.scenarioId,
    seed: "strategy-verification-normal-vs-baseline-alias",
    quarters: 3,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  const baselineResult = runAutoplayCase({
    scenarioId: "baseline",
    seed: "strategy-verification-normal-vs-baseline-alias",
    quarters: 3,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  assert.equal(JSON.stringify(normalResult.history), JSON.stringify(baselineResult.history));
});
