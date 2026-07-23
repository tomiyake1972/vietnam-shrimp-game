// ShrimpX V2 — 設備投資モジュール 新規capex資産のコンポーネント別定額法減価償却
// 単体テスト（Phase 8B-2C）
//
// capex/depreciation.tsのcomputeCapexComponentDepreciationUsdを、finance/
// quarterClose.tsやcompanyLab/runner.tsを経由せず直接検証する。実装指示§11の
// 必須テスト項目のうち「新規案件」区分をここでまとめて行う（機械部分だけが
// 先に償却終了し建物部分だけが残ること・建物/機械比率の合計が1であること等）。
// 既存資産2区分の定額法はfinance/__tests__/depreciation.test.tsが別途担う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { CapexParameters, CapexProjectTemplate, CAPEX_PARAMETERS_V1 } from "../parameters";
import { CapitalProject, CapitalProjectType, FutureCapacityEffectPlaceholder } from "../types";
import { computeCapexComponentDepreciationUsd } from "../depreciation";

const EPS = 1e-6;

function makeProject(overrides: Partial<CapitalProject> & Pick<CapitalProject, "projectType">): CapitalProject {
  return {
    projectId: "P-1",
    companyId: "TEST",
    approvedBudgetUsd: 1_000_000,
    paymentSchedule: [{ stageIndex: 0, plannedRatio: 1 }],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 1_000_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 1,
    status: "completed",
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    completedPeriod: period(2015, 1),
    capitalizedAmountUsd: 1_000_000,
    priority: 1,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

function effect(overrides: Partial<FutureCapacityEffectPlaceholder> = {}): FutureCapacityEffectPlaceholder {
  return { readinessQuartersAfterCompletion: 0, ...overrides };
}

/**
 * 検証を短期間で行うため、小さなコンポーネント別耐用年数を持つ独立の
 * CapexParametersフィクスチャを使う（純粋関数の引数として渡すだけなので、
 * 実パラメータ（建物100四半期・機械40四半期）と切り離して検証できる）。
 */
function testParams(buildingRatio: number, machineryRatio: number, buildingLife: number, machineryLife: number, readinessQuartersAfterCompletion = 0): CapexParameters {
  const tmpl = (projectType: CapitalProjectType): CapexProjectTemplate => ({
    projectType,
    displayName: "test",
    standardBudgetUsd: 1_000_000,
    standardConstructionQuarters: 1,
    paymentRatios: [1],
    assetCategory: "productionEquipment",
    postCompletionReadinessQuarters: readinessQuartersAfterCompletion,
    buildingRatio,
    machineryRatio,
    maintenanceRatePerQuarter: 0,
    futureCapacityEffect: { readinessQuartersAfterCompletion },
  });
  const types: CapitalProjectType[] = [
    "hosoLineExpansion",
    "pdLineExpansion",
    "vapLineExpansion",
    "coldStorageExpansion",
    "qualityControlEquipment",
    "environmentalEquipment",
    "commonProcessingExpansion",
  ];
  const templatesByType = Object.fromEntries(types.map((t) => [t, tmpl(t)])) as Record<CapitalProjectType, CapexProjectTemplate>;
  return {
    parametersVersion: "test",
    templatesByType,
    minimumCashReserveUsd: 0,
    maxConcurrentActiveProjectsPerCompany: 99,
    epsilonUsd: 0.01,
    componentUsefulLifeQuarters: { building: buildingLife, machinery: machineryLife },
  };
}

test("DEP-1: 建設中（underConstruction）の資産は建物・機械とも減価償却費0", () => {
  const params = testParams(0.5, 0.5, 4, 2);
  const p = makeProject({ projectType: "hosoLineExpansion", status: "underConstruction", completedPeriod: undefined, capitalizedAmountUsd: undefined, futureCapacityEffect: effect() });
  const result = computeCapexComponentDepreciationUsd([p], params, period(2016, 1));
  assert.equal(result.buildingUsd, 0);
  assert.equal(result.machineryUsd, 0);
  assert.equal(result.totalUsd, 0);
});

test("DEP-2: 完成四半期そのものは建物・機械とも減価償却費0（稼働開始は必ず翌期以降）", () => {
  const params = testParams(0.5, 0.5, 4, 2);
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const result = computeCapexComponentDepreciationUsd([p], params, period(2015, 1));
  assert.equal(result.totalUsd, 0);
});

test("DEP-3: 稼働開始四半期から建物・機械それぞれの配分額を、それぞれの耐用年数で定額償却する", () => {
  const params = testParams(0.4, 0.6, 4, 2); // coldStorageExpansionと同じ比率、耐用年数だけ短縮
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });
  const opStart = period(2015, 2); // readiness=0 → completedPeriodの翌四半期
  const expectedBuildingPerQuarter = (capitalized * 0.4) / 4; // = 100,000
  const expectedMachineryPerQuarter = (capitalized * 0.6) / 2; // = 300,000

  const atStart = computeCapexComponentDepreciationUsd([p], params, opStart);
  assert.ok(Math.abs(atStart.buildingUsd - expectedBuildingPerQuarter) < EPS);
  assert.ok(Math.abs(atStart.machineryUsd - expectedMachineryPerQuarter) < EPS);
  assert.ok(Math.abs(atStart.totalUsd - (expectedBuildingPerQuarter + expectedMachineryPerQuarter)) < EPS);
});

test("DEP-4: 機械の耐用年数経過後は機械部分だけ0になり、建物部分の償却だけが継続する（実装指示の必須検証項目）", () => {
  const params = testParams(0.4, 0.6, 4, 2);
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });
  const expectedBuildingPerQuarter = (capitalized * 0.4) / 4;

  // 稼働開始（2015Q2）から2四半期目（2015Q3）までは機械も償却中。
  const q2 = computeCapexComponentDepreciationUsd([p], params, period(2015, 3));
  assert.ok(q2.machineryUsd > 0, "機械耐用年数(2四半期)内なので機械分もまだ発生しているはず");

  // 3四半期目（2015Q4）は機械の耐用年数(2四半期)を超えるため、機械部分は0。
  const q3 = computeCapexComponentDepreciationUsd([p], params, period(2015, 4));
  assert.equal(q3.machineryUsd, 0, "機械の耐用年数超過後は機械部分が0のはず");
  assert.ok(Math.abs(q3.buildingUsd - expectedBuildingPerQuarter) < EPS, "建物部分は機械の償却終了後も継続するはず");
  assert.ok(Math.abs(q3.totalUsd - expectedBuildingPerQuarter) < EPS);
});

test("DEP-5: 建物の耐用年数も経過すると案件全体の減価償却費が0になる", () => {
  const params = testParams(0.4, 0.6, 4, 2);
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });

  // 稼働開始（2015Q2）から建物の耐用年数4四半期ぶん＝2015Q2〜2016Q1は建物分が発生する。
  const withinBuildingLife = computeCapexComponentDepreciationUsd([p], params, period(2016, 1));
  assert.ok(withinBuildingLife.buildingUsd > 0);

  // 建物の耐用年数(4四半期)超過後（2016Q2、5四半期目）は建物・機械とも0。
  const afterBuildingLife = computeCapexComponentDepreciationUsd([p], params, period(2016, 2));
  assert.equal(afterBuildingLife.buildingUsd, 0);
  assert.equal(afterBuildingLife.machineryUsd, 0);
  assert.equal(afterBuildingLife.totalUsd, 0);
});

test("DEP-6: 各コンポーネントの累計減価償却は、そのコンポーネントの配分額（取得原価×ratio）を厳密に超えない", () => {
  const params = testParams(0.4, 0.6, 4, 2);
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });

  // 稼働開始（2015Q2）から建物の耐用年数4四半期ぶん（機械はそのうち最初の2四半期のみ）を集計する。
  const quarters = [period(2015, 2), period(2015, 3), period(2015, 4), period(2016, 1)];
  let buildingTotal = 0;
  let machineryTotal = 0;
  for (const q of quarters) {
    const r = computeCapexComponentDepreciationUsd([p], params, q);
    buildingTotal += r.buildingUsd;
    machineryTotal += r.machineryUsd;
  }
  assert.ok(Math.abs(buildingTotal - capitalized * 0.4) < EPS, `建物累計 ${buildingTotal} が配分額 ${capitalized * 0.4} と一致しない`);
  assert.ok(Math.abs(machineryTotal - capitalized * 0.6) < EPS, `機械累計 ${machineryTotal} が配分額 ${capitalized * 0.6} と一致しない`);
  assert.ok(buildingTotal <= capitalized * 0.4 + EPS);
  assert.ok(machineryTotal <= capitalized * 0.6 + EPS);
});

test("DEP-7: 複数案件の減価償却費は案件ごとに独立して計算され合算される", () => {
  const params = testParams(0.4, 0.6, 4, 2);
  const a = makeProject({ projectId: "A", projectType: "coldStorageExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const b = makeProject({ projectId: "B", projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: 500_000, futureCapacityEffect: effect() });
  const result = computeCapexComponentDepreciationUsd([a, b], params, period(2015, 2));
  const expectedBuilding = (1_000_000 * 0.4) / 4 + (500_000 * 0.4) / 4;
  const expectedMachinery = (1_000_000 * 0.6) / 2 + (500_000 * 0.6) / 2;
  assert.ok(Math.abs(result.buildingUsd - expectedBuilding) < EPS);
  assert.ok(Math.abs(result.machineryUsd - expectedMachinery) < EPS);
});

test("DEP-8: 取消済み（cancelled）・支払未完了の資産は建物・機械とも減価償却費0", () => {
  const params = testParams(0.4, 0.6, 4, 2);
  const p = makeProject({ projectType: "coldStorageExpansion", status: "cancelled", completedPeriod: undefined, capitalizedAmountUsd: undefined, cumulativePaidUsd: 0, cancelledPeriod: period(2015, 1), futureCapacityEffect: effect() });
  const result = computeCapexComponentDepreciationUsd([p], params, period(2020, 1));
  assert.equal(result.totalUsd, 0);
});

test("DEP-9: 品質管理設備（buildingRatio=0）は建物部分が常に0で、機械部分だけが発生する", () => {
  const params = testParams(0, 1, 4, 2);
  const p = makeProject({ projectType: "qualityControlEquipment", completedPeriod: period(2015, 1), capitalizedAmountUsd: 1_000_000, futureCapacityEffect: effect() });
  const result = computeCapexComponentDepreciationUsd([p], params, period(2015, 2));
  assert.equal(result.buildingUsd, 0);
  assert.ok(Math.abs(result.machineryUsd - 1_000_000 / 2) < EPS);
});

// ---------------------------------------------------------------------
// 実パラメータ（CAPEX_PARAMETERS_V1）を使った、案件種別ごとのbuilding/machinery
// 構成比の直接確認（実装指示§3・§11「各案件種別の構成比が正しい」「buildingRatioと
// machineryRatioの合計が1」）。
// ---------------------------------------------------------------------

test("PARAM-1: 全案件種別でbuildingRatio + machineryRatio が厳密に1（浮動小数点誤差を許容）", () => {
  for (const t of Object.values(CAPEX_PARAMETERS_V1.templatesByType)) {
    const sum = t.buildingRatio + t.machineryRatio;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${t.projectType}: buildingRatio(${t.buildingRatio}) + machineryRatio(${t.machineryRatio}) が1でない`);
  }
});

test("PARAM-2: 案件種別ごとの構成比が実装指示の暫定値と一致する", () => {
  const t = CAPEX_PARAMETERS_V1.templatesByType;
  assert.deepEqual([t.hosoLineExpansion.buildingRatio, t.hosoLineExpansion.machineryRatio], [0.2, 0.8]);
  assert.deepEqual([t.pdLineExpansion.buildingRatio, t.pdLineExpansion.machineryRatio], [0.2, 0.8]);
  assert.deepEqual([t.vapLineExpansion.buildingRatio, t.vapLineExpansion.machineryRatio], [0.25, 0.75]);
  assert.deepEqual([t.commonProcessingExpansion.buildingRatio, t.commonProcessingExpansion.machineryRatio], [0.2, 0.8]);
  assert.deepEqual([t.coldStorageExpansion.buildingRatio, t.coldStorageExpansion.machineryRatio], [0.4, 0.6]);
  assert.deepEqual([t.qualityControlEquipment.buildingRatio, t.qualityControlEquipment.machineryRatio], [0, 1]);
  assert.deepEqual([t.environmentalEquipment.buildingRatio, t.environmentalEquipment.machineryRatio], [0.3, 0.7]);
});

test("PARAM-3: コンポーネント別耐用年数は建物100四半期・機械40四半期で、案件種別に関わらず共通", () => {
  assert.equal(CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.building, 100);
  assert.equal(CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.machinery, 40);
});

test("実パラメータPARAM-4: 40四半期（実際のmachinery耐用年数）経過後は機械部分だけ0になり、建物部分の償却だけが残る", () => {
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });
  // 稼働開始は2015Q2（readiness=0）。40四半期目は2025Q1（quartersBetween(2015Q2,2025Q1)+1=40）。
  const at40 = computeCapexComponentDepreciationUsd([p], CAPEX_PARAMETERS_V1, period(2025, 1));
  assert.ok(at40.machineryUsd > 0, "40四半期目はまだ機械分が発生するはず");
  // 41四半期目（2025Q2）は機械の耐用年数(40四半期)を超えるため機械部分は0、建物部分だけ残る。
  const at41 = computeCapexComponentDepreciationUsd([p], CAPEX_PARAMETERS_V1, period(2025, 2));
  assert.equal(at41.machineryUsd, 0, "機械の実耐用年数(40四半期)超過後は機械部分が0のはず");
  const expectedBuildingPerQuarter = (capitalized * CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.buildingRatio) / 100;
  assert.ok(Math.abs(at41.buildingUsd - expectedBuildingPerQuarter) < EPS, "建物部分は機械の償却終了後も継続するはず");
});

test("実パラメータPARAM-5: 100四半期（実際のbuilding耐用年数）経過後は案件全体の減価償却費が0になる", () => {
  const capitalized = 1_000_000;
  const p = makeProject({ projectType: "hosoLineExpansion", completedPeriod: period(2015, 1), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect() });
  // 稼働開始は2015Q2。100四半期目は2040Q1（quartersBetween(2015Q2,2040Q1)+1=100）。
  const at100 = computeCapexComponentDepreciationUsd([p], CAPEX_PARAMETERS_V1, period(2040, 1));
  assert.ok(at100.buildingUsd > 0, "100四半期目はまだ建物分が発生するはず");
  // 101四半期目（2040Q2）は建物の耐用年数(100四半期)も超えるため、案件全体が0。
  const at101 = computeCapexComponentDepreciationUsd([p], CAPEX_PARAMETERS_V1, period(2040, 2));
  assert.equal(at101.buildingUsd, 0);
  assert.equal(at101.machineryUsd, 0);
  assert.equal(at101.totalUsd, 0);
});

test("実会社数値検証: coldStorageExpansion（投資額250万ドル）の四半期減価償却費は、旧方式の41,666.67ドルから47,500ドルへ変わる", () => {
  const capitalized = 2_500_000;
  const p = makeProject({ projectType: "coldStorageExpansion", completedPeriod: period(2015, 2), capitalizedAmountUsd: capitalized, futureCapacityEffect: effect({ readinessQuartersAfterCompletion: 1 }) });
  // 稼働開始四半期 = 2015Q2の翌期2015Q3 + readiness1 = 2015Q4。
  const result = computeCapexComponentDepreciationUsd([p], CAPEX_PARAMETERS_V1, period(2015, 4));
  const expectedBuilding = (capitalized * 0.4) / 100; // = 10,000
  const expectedMachinery = (capitalized * 0.6) / 40; // = 37,500
  assert.ok(Math.abs(result.buildingUsd - expectedBuilding) < EPS);
  assert.ok(Math.abs(result.machineryUsd - expectedMachinery) < EPS);
  assert.ok(Math.abs(result.totalUsd - 47_500) < EPS, `合計 ${result.totalUsd} が期待値47,500と一致しない`);
});
