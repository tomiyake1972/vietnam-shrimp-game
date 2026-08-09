// ShrimpX V2 — 稼働開始した新工場が Standard AI から見えることの検証（§57 事後監査）
//
// 【なぜこのテストが要るのか】
// Standard AI の Observation は従来 fixture.factories ＋ ライン増設ぶんの手計算だけを
// 見ていた。そのため **建てた新工場が Standard AI からは一切見えず**、
// 「建てたのに能力が増えていないと認識し続ける」状態になりえた。
// 新工場を Standard AI の候補にする以上、ここは壊れてはならない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../core/period";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { CapitalProject } from "../../../capex/types";
import { buildNewFactoryId, MAX_FACTORIES_PER_COMPANY } from "../../../capex/factoryConstruction";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { CompanyLabConfig, CompanyOwnState } from "../../types";
import { buildStandardAiObservation } from "../../standardAi/observation";

const TEMPLATE = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;
const CONFIG: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "vision-new-factory-visibility", turns: 8 };

function completedNewFactoryProject(companyId: string, completedIn: ReturnType<typeof period>): CapitalProject {
  return {
    projectId: `${companyId}-CAPEX-1`,
    companyId,
    projectType: "newFactoryConstruction",
    approvedBudgetUsd: TEMPLATE.standardBudgetUsd,
    paymentSchedule: TEMPLATE.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    completedPaymentStagesCount: TEMPLATE.paymentRatios.length,
    cumulativePaidUsd: TEMPLATE.standardBudgetUsd,
    capitalizedAmountUsd: TEMPLATE.standardBudgetUsd,
    elapsedConstructionQuartersWithPayment: 3,
    requiredConstructionQuarters: 3,
    status: "completed",
    completedPeriod: completedIn,
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    priority: 1,
    lastDiagnosticReasons: [],
    futureCapacityEffect: TEMPLATE.futureCapacityEffect,
    newFactoryEffect: TEMPLATE.newFactoryEffect,
  };
}

function observationWithProjects(projects: readonly CapitalProject[]) {
  const { state, fixtures } = initializeCompanyLab(CONFIG);
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const baseOwnState = buildCompanyOwnState(state, fixture);
  const ownState: CompanyOwnState = {
    ...baseOwnState,
    capexState: { ...baseOwnState.capexState, portfolio: { ...baseOwnState.capexState.portfolio, projects } },
  };
  return {
    baseline: buildStandardAiObservation(fixture, baseOwnState, buildPublicMarketInfo(state), state.currentPeriod, 1),
    withProject: buildStandardAiObservation(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1),
    period: state.currentPeriod,
    fixture,
  };
}

test("AUDIT-1: 稼働開始した新工場は Standard AI の観測に現れ、工場数と実効能力が増える", () => {
  // 完成期を「観測期の2四半期前」にすると、操業準備1四半期を経て稼働開始済みになる。
  const { baseline, withProject } = observationWithProjects([completedNewFactoryProject("BAL", period(2014, 3))]);

  assert.equal(baseline.factoryCount, 1, "前提: fixture の工場は1つ");
  assert.equal(withProject.factoryCount, 2, "稼働開始した新工場が観測に現れていない");
  assert.ok(
    withProject.totalEffectiveCapacityByProduct.hoso > baseline.totalEffectiveCapacityByProduct.hoso,
    "新工場ぶんの HOSO 実効能力が増えていない"
  );
  assert.ok(withProject.totalEffectiveCommonProcessingCapacity > baseline.totalEffectiveCommonProcessingCapacity);
  assert.ok(withProject.factories.some((f) => f.factoryId === buildNewFactoryId({ companyId: "BAL", projectId: "BAL-CAPEX-1" })));
});

test("AUDIT-2: 新工場は工場スペースの総量を増やすが、既存工場の使用量には影響しない", () => {
  const { baseline, withProject } = observationWithProjects([completedNewFactoryProject("BAL", period(2014, 3))]);
  assert.ok(withProject.factorySpaceTotalUnits > baseline.factorySpaceTotalUnits, "新工場ぶんのスペース総量が増えていない");
  assert.ok(withProject.factorySpaceRemainingUnits > baseline.factorySpaceRemainingUnits);
});

test("AUDIT-3: 建設中（未稼働）の新工場は能力に一切反映されず、案件としてのみ観測される", () => {
  const underConstruction: CapitalProject = {
    ...completedNewFactoryProject("BAL", period(2014, 3)),
    status: "underConstruction",
    completedPeriod: undefined,
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: TEMPLATE.standardBudgetUsd * 0.3,
  };
  const { baseline, withProject } = observationWithProjects([underConstruction]);

  assert.equal(withProject.factoryCount, baseline.factoryCount, "未稼働の新工場が能力へ先食いされている");
  assert.deepEqual(withProject.totalEffectiveCapacityByProduct, baseline.totalEffectiveCapacityByProduct);
  assert.equal(withProject.pendingNewFactoryProjectCount, 1, "進行中の新工場案件が観測されていない");
  assert.equal(withProject.prospectiveFactoryCount, baseline.factoryCount + 1);
  assert.equal(withProject.maxFactoriesPerCompany, MAX_FACTORIES_PER_COMPANY);
});

test("AUDIT-4: 新工場にはワーカーが自動で付いてこない（人員は別システムが管理する）", () => {
  const { withProject } = observationWithProjects([completedNewFactoryProject("BAL", period(2014, 3))]);
  const newFactory = withProject.factories.find((f) => f.factoryId === buildNewFactoryId({ companyId: "BAL", projectId: "BAL-CAPEX-1" }))!;
  assert.equal(newFactory.currentRegularHeadcount, 0, "工場を建てただけでワーカーが増えてはいけない");
});
