// ShrimpX V2 — Phase SAI-GROW-3A: Adaptive Growth Step テスト
//
// GROW3A-1〜12。step limitは削除しておらず、observable evidenceが揃ったときだけ
// 連続的に拡大することを固定する。Sales Hiring / Vision / Sales Capacity Engine は無変更。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGrowthPressureCore, GrowthPressureCoreInput, GROWTH_PRESSURE_PARAMETERS_V1 } from "../growth";
import { computeCommercialAmbition, COMMERCIAL_AMBITION_PARAMETERS_V1, CommercialAmbitionInput } from "../../vision/commercialAmbition";
import { STRATEGIC_GROWTH_PARAMETERS_V1 } from "../../vision/strategicGrowth";
import { defaultVisionDocumentFor } from "../../vision/defaults";
import { StandardAiObservation } from "../types";
import { SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1 } from "../../../sales/salesCapacityModel";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { period } from "../../../core/period";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { DYNAMIC_SCENARIO_2 } from "../../../scenario/definitions/dynamicScenario2";

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    lastQuarterActualProductionByProduct: { hoso: 10000, pd: 0, vap: 0 },
    lifecycleTrendByMarket: undefined,
    productSupplyPressureByProduct: undefined,
    markets: [],
    ...overrides,
  } as unknown as StandardAiObservation;
}

/** 既定は「市場headroomが大きく、成約・採算・在庫・財務すべて良好」＝拡大する状況。 */
function core(overrides: Partial<GrowthPressureCoreInput> = {}) {
  const attainable = overrides.attainableProfitableTons ?? 100000;
  return computeGrowthPressureCore({
    companyId: "BAL",
    period: period(2015, 2),
    observation: observation(),
    contracts: [],
    visionReferenceScaleTons: 60000,
    growthAmbition: "MEDIUM",
    strategicPosture: null,
    financialRiskTolerance: null,
    currentRelevantScaleTons: 15000,
    attainableProfitableTons: attainable,
    orientationWeightedOpportunityTons: overrides.orientationWeightedOpportunityTons ?? attainable,
    weightedContributionUsdPerKg: 1.0,
    priceObservationMissing: false,
    observedConversionRatio: 0.95,
    finishedGoodsExcessRatioByProduct: { hoso: 0.5, pd: 0.5, vap: 0.5 },
    crisisState: "NORMAL",
    lastQuarterFinancialHealthTier: "healthy",
    ...overrides,
  });
}

function ambitionInput(multiplier: number, overrides: Partial<CommercialAmbitionInput> = {}): CommercialAmbitionInput {
  const vision = defaultVisionDocumentFor("MASS")!.visions[0];
  return {
    vision,
    strategicGrowth: {
      visionId: vision.visionId,
      visionTargetScaleAtCurrentTurn: 60000,
      visionTargetScaleAtQ32: vision.targetScaleTonsPerQuarterAtQ32,
      currentSustainableScaleTons: 15000,
      strategicScaleGapTons: 45000,
      strategicScaleGapRatio: 0.75,
      ambitionAdjustedGapRatio: 0.9,
      growthPressure: "URGENT",
      onTrack: false,
    },
    capacityAnchorTons: 15000,
    recentActualScaleTons: 14000,
    attainableProfitableTons: 100000,
    weightedContributionUsdPerKg: 1.0,
    priceObservationMissing: false,
    maxFinishedGoodsExcessRatio: 0.5,
    stepLimitMultiplier: multiplier,
    ...overrides,
  };
}

// ---------------------------------------------------------------------

test("GROW3A-1: step limitは削除されていない（倍率1で従来と完全に同一）", () => {
  const base = computeCommercialAmbition(ambitionInput(1));
  const explicitLegacy = computeCommercialAmbition({ ...ambitionInput(1), stepLimitMultiplier: undefined });
  assert.deepEqual(base, explicitLegacy);
  // MASSはHIGH ambition（maxStep 0.12）× URGENT（intensity 1.0）＝ +12%。
  assert.equal(Number(base.baseStepRatio.toFixed(4)), 0.12);
  assert.equal(Number(base.effectiveStepRatio.toFixed(4)), 0.12);
  assert.equal(Math.round(base.ambitionTons), Math.round(15000 * 1.12));
  assert.equal(base.limiter, "STEP_LIMIT");
});

test("GROW3A-2: Growth Pressure LOWでは倍率1（＝現行挙動と完全同一）", () => {
  // Vision gapが無い＝LOW。
  const onTrack = core({ visionReferenceScaleTons: 15000 });
  assert.equal(onTrack.level, "LOW");
  assert.equal(onTrack.growthStepExpansionRatio, 0);
  assert.equal(onTrack.growthEvidenceMultiplier, 1);
  const ambition = computeCommercialAmbition(ambitionInput(onTrack.growthEvidenceMultiplier));
  assert.equal(Number(ambition.effectiveStepRatio.toFixed(6)), Number(ambition.baseStepRatio.toFixed(6)));
});

test("GROW3A-3: evidenceが強いほどstepが単調に拡大し、上限を超えない", () => {
  const weak = core({ visionReferenceScaleTons: 20000 });
  const strong = core({ visionReferenceScaleTons: 60000 });
  assert.ok(strong.growthEvidenceMultiplier > weak.growthEvidenceMultiplier);
  assert.ok(strong.growthEvidenceMultiplier <= GROWTH_PRESSURE_PARAMETERS_V1.maxGrowthStepMultiplier + 1e-9);
  assert.ok(weak.growthEvidenceMultiplier >= 1);
  // 1四半期で倍増しない（HIGH ambition × URGENT の +12% に対して上限倍率でも +36%）。
  const maxStepped = computeCommercialAmbition(ambitionInput(GROWTH_PRESSURE_PARAMETERS_V1.maxGrowthStepMultiplier));
  assert.ok(maxStepped.effectiveStepRatio < 1, `effectiveStepRatio=${maxStepped.effectiveStepRatio}`);
  assert.ok(maxStepped.ambitionTons < 15000 * 2);
});

test("GROW3A-4: 成約率の悪化はstep拡大を止める", () => {
  const good = core({ observedConversionRatio: 0.95 });
  const poor = core({ observedConversionRatio: 0.5 });
  const veryPoor = core({ observedConversionRatio: 0.3 });
  assert.ok(poor.growthEvidenceMultiplier < good.growthEvidenceMultiplier);
  assert.equal(veryPoor.growthEvidenceMultiplier, 1);
});

test("GROW3A-5: 採算の悪化はstep拡大を止める", () => {
  const thin = core({ weightedContributionUsdPerKg: 0.1 });
  const negative = core({ weightedContributionUsdPerKg: 0.04 });
  assert.ok(thin.growthEvidenceMultiplier < core().growthEvidenceMultiplier);
  assert.equal(negative.growthEvidenceMultiplier, 1);
});

test("GROW3A-6: 在庫過剰はstep拡大を止める", () => {
  const excess = core({ finishedGoodsExcessRatioByProduct: { hoso: 1.6, pd: 0.2, vap: 0.2 } });
  assert.equal(excess.growthEvidenceMultiplier, 1);
});

test("GROW3A-7: crisis / finance distressはstep拡大を止める", () => {
  assert.equal(core({ crisisState: "SEVERE_DISTRESS" }).growthEvidenceMultiplier, 1);
  assert.equal(core({ lastQuarterFinancialHealthTier: "insolvent" }).growthEvidenceMultiplier, 1);
  const stressed = core({ crisisState: "LIQUIDITY_STRESS" });
  assert.ok(stressed.growthEvidenceMultiplier < core().growthEvidenceMultiplier);
});

test("GROW3A-8: 市場機会が無ければstepは拡大しない", () => {
  const none = core({ attainableProfitableTons: 0, orientationWeightedOpportunityTons: 0 });
  assert.equal(none.growthEvidenceMultiplier, 1);
});

test("GROW3A-9: value志向（VAP相当）はVolume Gapだけでは大きくstep拡大しない", () => {
  const shared = { visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 0.1 } as const;
  const neutral = core({ ...shared, strategicPosture: "DEMAND_CONFIRMED" });
  const valueFirst = core({ ...shared, strategicPosture: "VALUE_FIRST" });
  assert.ok(valueFirst.growthEvidenceMultiplier < neutral.growthEvidenceMultiplier);
  // VAPは growthAmbition=LOW でもある（既存Vision）。会社IDのhardcodeは使っていない。
  const vapVision = defaultVisionDocumentFor("VAP")!.visions[0];
  assert.equal(vapVision.strategicPosture, "VALUE_FIRST");
  assert.equal(vapVision.growthAmbition, "LOW");
  assert.equal(STRATEGIC_GROWTH_PARAMETERS_V1.ambitionSensitivity.LOW, 0.7);
});

test("GROW3A-10: 財務規律の強い会社（CONSV相当）はstep拡大が小さい", () => {
  const shared = { visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 0.12, lastQuarterFinancialHealthTier: "watch" } as const;
  const tolerant = core({ ...shared, financialRiskTolerance: "HIGH" });
  const disciplined = core({ ...shared, financialRiskTolerance: "LOW" });
  assert.ok(disciplined.growthEvidenceMultiplier < tolerant.growthEvidenceMultiplier);
  const consvVision = defaultVisionDocumentFor("CONSV")!.visions[0];
  assert.equal(consvVision.financialRiskTolerance, "LOW");
});

test("GROW3A-11: Sales Capacity Engine / Vision / Sales Hiringは変更していない", () => {
  const model = SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1;
  assert.equal(model.companyBaselineCapacityTons, 1000);
  assert.equal(model.companyCapacityMaxIncrementTons, 95000);
  assert.equal(SALES_PARAMETERS_V1.maximumSupplierShare, 0.35);
  // 正式Vision値（Q32）。BAL/JPQ/CONSV は SAI-VISION-1（夜間sensitivity Case A1）で
  // 正式に更新済み（34,000→60,000 / 30,000→50,000 / 27,000→45,000）。
  // MASS 80,000・VAP 17,000 は据え置き。このテストは「意図しないdrift」を検知する
  // ための固定値であり、正式変更に合わせて更新している（挙動の緩和ではない）。
  assert.equal(defaultVisionDocumentFor("MASS")!.visions[0].targetScaleTonsPerQuarterAtQ32, 80000);
  assert.equal(defaultVisionDocumentFor("BAL")!.visions[0].targetScaleTonsPerQuarterAtQ32, 60000);
  assert.equal(defaultVisionDocumentFor("JPQ")!.visions[0].targetScaleTonsPerQuarterAtQ32, 50000);
  assert.equal(defaultVisionDocumentFor("VAP")!.visions[0].targetScaleTonsPerQuarterAtQ32, 17000);
  assert.equal(defaultVisionDocumentFor("CONSV")!.visions[0].targetScaleTonsPerQuarterAtQ32, 45000);
  // base step ratio（HIGH .12 / MEDIUM .07 / LOW .03）も変更していない。
  assert.deepEqual(COMMERCIAL_AMBITION_PARAMETERS_V1.maxStepRatioByAmbition, { HIGH: 0.12, MEDIUM: 0.07, LOW: 0.03 });
});

test("GROW3A-12: 同一入力なら同一decision（決定論）で、step診断が必ず出る", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "g3a-det", turns: 32 });
  const publicInfo = buildPublicMarketInfo(state);
  const run = () =>
    fixtures.map((f) =>
      generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
    );
  const a = run();
  const b = run();
  assert.deepEqual(
    b.map((r) => r.decision),
    a.map((r) => r.decision)
  );
  for (const r of a) {
    const g = r.diagnostics.growthPressure!;
    assert.ok(Number.isFinite(g.baseStepLimit));
    assert.ok(Number.isFinite(g.effectiveStepLimit));
    assert.ok(g.growthEvidenceMultiplier >= 1);
    assert.ok(g.effectiveStepLimit >= g.baseStepLimit - 1e-9);
    assert.ok(typeof g.ambitionLimiter === "string");
  }
  // Sales Hiringの判断は倍率を変えても直接には変わらない（販売希望が同じなら同じ）。
  const legacyStep = fixtures.map((f) =>
    generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn, {
      ...STANDARD_AI_PARAMETERS_V1,
      growthPressure: { ...GROWTH_PRESSURE_PARAMETERS_V1, maxGrowthStepMultiplier: 1 },
    })
  );
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i].decision.salesPlans) === JSON.stringify(legacyStep[i].decision.salesPlans)) {
      assert.equal(a[i].decision.salesForceHireCount, legacyStep[i].decision.salesForceHireCount);
    }
  }
});
