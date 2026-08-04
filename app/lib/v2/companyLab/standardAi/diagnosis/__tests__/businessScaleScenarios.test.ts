// ShrimpX V2 — 2026-08-04 Conservative / Base / Growth Scenario 生成のテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { buildStandardAiObservation } from "../../observation";
import { computePressureScores } from "../../pressures";
import { buildStandardAiSalesPlans } from "../../decision/sales";
import { CompanyLabConfig } from "../../../types";
import { buildBusinessScaleScenarioComparison } from "../businessScaleScenarios";

function setupTurn2(companyId = "BAL", seed = "business-scale-001") {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed, turns: 8 } as CompanyLabConfig);
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo1 = buildPublicMarketInfo(state);
  const decisionsTurn1: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisionsTurn1[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsTurn1);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2 = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  const pressures2 = computePressureScores(observation2, fixture);
  const salesResult2 = buildStandardAiSalesPlans(fixture, observation2, pressures2);
  return { fixture, observation2, pressures2, salesResult2 };
}

test("Growth Scenarioは最大成長ではない（Sales/Labor headcountは物理上限ではなく暫定の適度な増分）", () => {
  const { fixture, observation2, pressures2, salesResult2 } = setupTurn2();
  const comparison = buildBusinessScaleScenarioComparison(
    fixture,
    observation2,
    pressures2,
    salesResult2.salesPlans,
    salesResult2.desiredByProduct
  );
  assert.ok(comparison.growth.assumptions.some((a) => a.isProvisionalIllustration));
  // Growth Scenarioのsales軸は、Conservative/Baseより大きいか等しいはず（headcountを増やしたため）。
  const growthSales = comparison.growth.profile.axes.find((a) => a.axis === "sales")!;
  const baseSales = comparison.base.profile.axes.find((a) => a.axis === "sales")!;
  assert.ok(growthSales.supportedScaleTons! >= baseSales.supportedScaleTons! - 1e-6);
});

test("Conservative/Base/Growthのいずれも、5軸を単一値へ潰していない", () => {
  const { fixture, observation2, pressures2, salesResult2 } = setupTurn2();
  const comparison = buildBusinessScaleScenarioComparison(
    fixture,
    observation2,
    pressures2,
    salesResult2.salesPlans,
    salesResult2.desiredByProduct
  );
  for (const scenario of [comparison.conservative, comparison.base, comparison.growth]) {
    assert.equal(scenario.profile.axes.length, 5);
  }
});

test("bindingAxesは実際に最小のsupportedScaleTonsを持つ軸と一致する", () => {
  const { fixture, observation2, pressures2, salesResult2 } = setupTurn2();
  const comparison = buildBusinessScaleScenarioComparison(
    fixture,
    observation2,
    pressures2,
    salesResult2.salesPlans,
    salesResult2.desiredByProduct
  );
  for (const scenario of [comparison.conservative, comparison.base, comparison.growth]) {
    const known = scenario.profile.axes.filter((a) => a.supportedScaleTons !== null);
    const trueMin = Math.min(...known.map((a) => a.supportedScaleTons!));
    assert.ok(Math.abs(scenario.bindingScaleTons! - trueMin) < 1e-6);
    for (const axis of scenario.bindingAxes) {
      const found = known.find((a) => a.axis === axis)!;
      assert.ok(Math.abs(found.supportedScaleTons! - trueMin) < 1e-6);
    }
  }
});

test("会社IDが一致し、他社データが混入しない", () => {
  const { fixture, observation2, pressures2, salesResult2 } = setupTurn2("MASS");
  const comparison = buildBusinessScaleScenarioComparison(
    fixture,
    observation2,
    pressures2,
    salesResult2.salesPlans,
    salesResult2.desiredByProduct
  );
  assert.equal(comparison.companyId, "MASS");
  assert.equal(comparison.growth.profile.companyId, "MASS");
});
