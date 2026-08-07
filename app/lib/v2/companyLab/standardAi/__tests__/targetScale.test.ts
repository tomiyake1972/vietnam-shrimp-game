// ShrimpX V2 — Standard AI Target Scale Band 単体テスト（2026-08-05新設）
//
// 三宅さんご指示§5「新しい恣意的なmagic numberを多数追加しないでください。必要な
// 初期係数がある場合は、明示的parameter・文書化・testsを必須としてください」と、
// §18「Target Scaleは毎期激しく変えない」への対応観点をテストする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { CompanyLabConfig } from "../../types";
import { buildStandardAiObservation } from "../observation";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { computeTargetScaleBand } from "../targetScale";
import { BALANCED_GROWTH_STRATEGIC_INTENT_V1 } from "../strategicIntent";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sai-target-scale-unit-001", turns: 8, ...overrides };
}

test("Target Scale BandはBALANCED_GROWTHの倍率（min1.0/preferred1.15/max1.35）を、現在の実効生産能力に適用した値になる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 1);

  const result = computeTargetScaleBand(fixture, observation, BALANCED_GROWTH_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);

  const capacityTons = observation.totalEffectiveCapacityByProduct.hoso + observation.totalEffectiveCapacityByProduct.pd + observation.totalEffectiveCapacityByProduct.vap;
  assert.ok(Math.abs(result.currentSustainableScaleTons - capacityTons) < 1, "targetScaleCapacityWeightInBaseline=1.0のため、現在の持続可能規模は実効生産能力とほぼ一致するはず");
  assert.ok(Math.abs(result.targetScaleBand.quarterlySalesTons.min - capacityTons * 1.0) < 1);
  assert.ok(Math.abs(result.targetScaleBand.quarterlySalesTons.preferred - capacityTons * 1.15) < 1);
  assert.ok(Math.abs(result.targetScaleBand.quarterlySalesTons.max - capacityTons * 1.35) < 1);
});

test("Target Scale Bandは、生産能力が変わらない限りターンをまたいでも同一の値を返す（三宅さんご指示§18「毎期激しく変えない」への対応）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);

  const observationTurn1 = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const observationTurn2 = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 2);

  const resultTurn1 = computeTargetScaleBand(fixture, observationTurn1, BALANCED_GROWTH_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);
  const resultTurn2 = computeTargetScaleBand(fixture, observationTurn2, BALANCED_GROWTH_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);

  assert.deepEqual(resultTurn1.targetScaleBand, resultTurn2.targetScaleBand, "生産能力（fixture・ownStateが同一）が変わらない限り、Target Scale Bandは同一であるべき（実績の四半期変動に引きずられて毎期動いてはならない）");
});

test("成長姿勢がAGGRESSIVE_GROWTHのほうがBALANCED_GROWTHよりTarget Scale Bandが広く・大きくなる（8期先市場の精密予測ではなく、成長姿勢からの逆算であることの確認）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 1);

  const balanced = computeTargetScaleBand(fixture, observation, { ...BALANCED_GROWTH_STRATEGIC_INTENT_V1, growthPosture: "BALANCED_GROWTH" }, STANDARD_AI_PARAMETERS_V1);
  const aggressive = computeTargetScaleBand(fixture, observation, { ...BALANCED_GROWTH_STRATEGIC_INTENT_V1, growthPosture: "AGGRESSIVE_GROWTH" }, STANDARD_AI_PARAMETERS_V1);
  const defensive = computeTargetScaleBand(fixture, observation, { ...BALANCED_GROWTH_STRATEGIC_INTENT_V1, growthPosture: "DEFENSIVE" }, STANDARD_AI_PARAMETERS_V1);

  assert.ok(aggressive.targetScaleBand.quarterlySalesTons.max > balanced.targetScaleBand.quarterlySalesTons.max);
  assert.ok(balanced.targetScaleBand.quarterlySalesTons.max > defensive.targetScaleBand.quarterlySalesTons.max);
});

test("8期先の市場シェア・数量を精密予測しない: marketOpportunityDirectionはGROWING/STABLE/WEAKENINGの大まかな方向性のみで、Target Scale自体の主要因ではない（未接続時はundefined、断定しない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, state.currentPeriod, 1);

  const result = computeTargetScaleBand(fixture, observation, BALANCED_GROWTH_STRATEGIC_INTENT_V1, STANDARD_AI_PARAMETERS_V1);
  // lifecycleTrendByMarketが未接続（SAI-5C機能OFF）の場合、断定せずundefinedであるべき。
  if (observation.lifecycleTrendByMarket === undefined) {
    assert.equal(result.marketOpportunityDirection, undefined);
  } else {
    assert.ok(["GROWING", "STABLE", "WEAKENING"].includes(result.marketOpportunityDirection ?? ""));
  }
});
