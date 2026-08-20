// ShrimpX V2 — Phase SAI-GROW-2: Adaptive Opportunity Share テスト（実装指示§26）
//
// GROW2-1〜19。実Anthropic APIは呼ばない。
// GROW-2でDecisionへ接続するのは「Commercial Ambition / Commitment の機会share」だけであり、
// production / procurement / CAPEX / sales hiring の判断式は変更していないことも固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGrowthPressureCore, GrowthPressureCoreInput, GROWTH_PRESSURE_PARAMETERS_V1 } from "../growth";
import { StandardAiObservation } from "../types";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1 } from "../../../sales/salesCapacityModel";
import { COMMERCIAL_AMBITION_PARAMETERS_V1 } from "../../vision/commercialAmbition";
import { COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { period } from "../../../core/period";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../../../core/units";
import { SalesContract } from "../../../sales/types";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { CompanyLabState } from "../../types";
import { DYNAMIC_SCENARIO_1 } from "../../../scenario/definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../../../scenario/definitions/dynamicScenario2";
import { computeOrientationWeightedOpportunity } from "../decision/sales";

const LEGACY_AMBITION_SHARE = COMMERCIAL_AMBITION_PARAMETERS_V1.realisticShareOfProfitableOpportunity;
const LEGACY_COMMITMENT_SHARE = COMMERCIAL_COMMITMENT_PARAMETERS_V1.realisticShareOfOpportunity;

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    lastQuarterActualProductionByProduct: { hoso: 10000, pd: 0, vap: 0 },
    lifecycleTrendByMarket: undefined,
    productSupplyPressureByProduct: undefined,
    markets: [],
    ...overrides,
  } as unknown as StandardAiObservation;
}

function contract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "c1",
    companyId: "BAL",
    market: "japan",
    product: "hoso",
    contractedPeriod: period(2015, 1),
    dueDate: period(2015, 3),
    originalQuantity: hosoEqTons(1000),
    outstandingQuantity: hosoEqTons(1000),
    unitPrice: usdPerHosoEqKg(6),
    status: "open",
    ...overrides,
  } as SalesContract;
}

/** 既定は「Vision gapが大きく、市場headroomも大きい」＝拡張が起きる状況。 */
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

// ---------------------------------------------------------------------
// GROW2-1〜4: headroomの非循環性とshare拡張
// ---------------------------------------------------------------------

test("GROW2-1: opportunity headroomは現行の提出上限に依存しない（非循環）", () => {
  // shareを変えても（＝提出上限が変わっても）headroomは変わらない。
  const legacy = core({ params: { ...GROWTH_PRESSURE_PARAMETERS_V1, adaptiveShareEnabled: false } });
  const adaptive = core();
  assert.equal(adaptive.observableOpportunityHeadroomTons, legacy.observableOpportunityHeadroomTons);
  assert.equal(adaptive.observableOpportunityHeadroomRatio, legacy.observableOpportunityHeadroomRatio);
  assert.equal(adaptive.opportunitySupport, legacy.opportunitySupport);
  // headroomは「観測機会 − 現在の自社規模」であり、提出上限を含まない。
  assert.equal(adaptive.observableOpportunityHeadroomTons, 100000 - 15000);
  assert.equal(Number(adaptive.observableOpportunityHeadroomRatio.toFixed(4)), Number(((100000 - 15000) / 15000).toFixed(4)));
  // shareだけが変わる。
  assert.equal(legacy.effectiveOpportunityShare.commitment, LEGACY_COMMITMENT_SHARE);
  assert.ok(adaptive.effectiveOpportunityShare.commitment > LEGACY_COMMITMENT_SHARE);
});

test("GROW2-2: 市場機会が無ければshareは拡張されない", () => {
  const none = core({ attainableProfitableTons: 0, orientationWeightedOpportunityTons: 0 });
  assert.equal(none.opportunitySupport, 0);
  assert.equal(none.shareExpansionRatio, 0);
  assert.equal(none.effectiveOpportunityShare.ambition, LEGACY_AMBITION_SHARE);
  assert.equal(none.effectiveOpportunityShare.commitment, LEGACY_COMMITMENT_SHARE);
  assert.ok(none.reasonCodes.includes("GROWTH_SHARE_HELD_LOW"));
  // 自社規模と同じ機会しかない場合もheadroom=0。
  const equal = core({ attainableProfitableTons: 15000, orientationWeightedOpportunityTons: 15000 });
  assert.equal(equal.observableOpportunityHeadroomTons, 0);
  assert.equal(equal.shareExpansionRatio, 0);
});

test("GROW2-3: Growth Pressure LOWでは機会shareが現行値と完全に一致する", () => {
  // Vision gapが無い（志に追いついている）＝LOW。
  const onTrack = core({ visionReferenceScaleTons: 15000 });
  assert.equal(onTrack.level, "LOW");
  assert.equal(onTrack.shareExpansionRatio, 0);
  assert.equal(onTrack.effectiveOpportunityShare.ambition, LEGACY_AMBITION_SHARE);
  assert.equal(onTrack.effectiveOpportunityShare.commitment, LEGACY_COMMITMENT_SHARE);
  assert.equal(onTrack.incrementalDesiredSalesFromGrowthTons, 0);
});

test("GROW2-4: Growth Pressureが高く市場機会もあればshareが開放される", () => {
  const a = core();
  assert.ok(a.level === "HIGH" || a.level === "URGENT", `level=${a.level}`);
  assert.ok(a.shareExpansionRatio > 0);
  assert.ok(a.effectiveOpportunityShare.commitment > LEGACY_COMMITMENT_SHARE);
  assert.ok(a.effectiveOpportunityShare.commitment <= GROWTH_PRESSURE_PARAMETERS_V1.maxCommitmentOpportunityShare + 1e-9);
  assert.ok(a.effectiveOpportunityShare.ambition <= GROWTH_PRESSURE_PARAMETERS_V1.maxAmbitionOpportunityShare + 1e-9);
  assert.ok(a.adaptiveSubmissionCeilingTons > a.currentSubmissionCeilingTons);
  assert.equal(
    Number(a.incrementalDesiredSalesFromGrowthTons.toFixed(6)),
    Number((a.adaptiveSubmissionCeilingTons - a.currentSubmissionCeilingTons).toFixed(6))
  );
});

// ---------------------------------------------------------------------
// GROW2-5〜9: feedback
// ---------------------------------------------------------------------

test("GROW2-5: 成約率の悪化は拡張幅を縮小する", () => {
  const good = core({ observedConversionRatio: 0.95 });
  const poor = core({ observedConversionRatio: 0.5 });
  const veryPoor = core({ observedConversionRatio: 0.3 });
  assert.ok(poor.shareExpansionRatio < good.shareExpansionRatio);
  assert.equal(veryPoor.conversionFeedback, 0);
  assert.equal(veryPoor.shareExpansionRatio, 0);
  assert.ok(poor.reasonCodes.includes("GROWTH_SHARE_REDUCED_BY_CONVERSION"));
});

test("GROW2-6: 採算の悪化は拡張幅を縮小する", () => {
  const good = core({ weightedContributionUsdPerKg: 1.0 });
  const thin = core({ weightedContributionUsdPerKg: 0.1 });
  const negative = core({ weightedContributionUsdPerKg: 0.04 });
  assert.ok(thin.shareExpansionRatio < good.shareExpansionRatio);
  assert.equal(negative.marginFeedback, 0);
  assert.equal(negative.shareExpansionRatio, 0);
  assert.equal(negative.effectiveOpportunityShare.commitment, LEGACY_COMMITMENT_SHARE);
  assert.ok(thin.reasonCodes.includes("GROWTH_SHARE_REDUCED_BY_MARGIN"));
});

test("GROW2-7: 完成品在庫の過剰は拡張を止める", () => {
  const excess = core({ finishedGoodsExcessRatioByProduct: { hoso: 1.6, pd: 0.2, vap: 0.2 } });
  assert.equal(excess.inventoryFeedback, 0);
  assert.equal(excess.shareExpansionRatio, 0);
  assert.equal(excess.effectiveOpportunityShare.commitment, LEGACY_COMMITMENT_SHARE);
  const partial = core({ finishedGoodsExcessRatioByProduct: { hoso: 1.4, pd: 0.2, vap: 0.2 } });
  assert.ok(partial.shareExpansionRatio > 0 && partial.shareExpansionRatio < core().shareExpansionRatio);
  assert.ok(partial.reasonCodes.includes("GROWTH_SHARE_REDUCED_BY_INVENTORY"));
});

test("GROW2-8: overdueは拡張を増やさない", () => {
  const base = core();
  const overdue = core({ contracts: [contract({ dueDate: period(2015, 1), outstandingQuantity: hosoEqTons(8000), status: "overdue" })] });
  assert.equal(overdue.forwardDemandSignal, 0);
  assert.equal(overdue.shareExpansionRatio, base.shareExpansionRatio);
});

test("GROW2-9: healthy forward backlogは拡張を支援しうる（ただし単独では無制限にしない）", () => {
  const base = core();
  const healthy = core({ contracts: [contract({ dueDate: period(2015, 3), outstandingQuantity: hosoEqTons(8000) })] });
  assert.ok(healthy.forwardDemandSignal > 0);
  assert.ok(healthy.shareExpansionRatio >= base.shareExpansionRatio);
  // backlogだけでは上限を超えない。
  assert.ok(healthy.effectiveOpportunityShare.commitment <= GROWTH_PRESSURE_PARAMETERS_V1.maxCommitmentOpportunityShare + 1e-9);
  // Vision gapが無ければbacklogがあっても拡張しない。
  const onTrackWithBacklog = core({
    visionReferenceScaleTons: 15000,
    contracts: [contract({ dueDate: period(2015, 3), outstandingQuantity: hosoEqTons(8000) })],
  });
  assert.equal(onTrackWithBacklog.shareExpansionRatio, 0);
});

// ---------------------------------------------------------------------
// GROW2-10〜12: profile差
// ---------------------------------------------------------------------

test("GROW2-10: 成長意欲の高い会社（MASS相当）ほど早く大きくshareを開放する", () => {
  const shared = { visionReferenceScaleTons: 40000, currentRelevantScaleTons: 20000 } as const;
  const high = core({ ...shared, growthAmbition: "HIGH", financialRiskTolerance: "HIGH" });
  const medium = core({ ...shared, growthAmbition: "MEDIUM", financialRiskTolerance: "MEDIUM" });
  const low = core({ ...shared, growthAmbition: "LOW", financialRiskTolerance: "MEDIUM" });
  assert.ok(high.shareExpansionRatio > medium.shareExpansionRatio);
  assert.ok(medium.shareExpansionRatio > low.shareExpansionRatio);
  assert.ok(high.effectiveOpportunityShare.commitment > medium.effectiveOpportunityShare.commitment);
});

test("GROW2-11: value志向（VALUE_FIRST）は採算が伴わなければ大きく開放しない", () => {
  const shared = { visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 0.1 } as const;
  const neutral = core({ ...shared, strategicPosture: "DEMAND_CONFIRMED" });
  const valueFirst = core({ ...shared, strategicPosture: "VALUE_FIRST" });
  assert.ok(valueFirst.valueOrientationGate < 1);
  assert.ok(valueFirst.shareExpansionRatio < neutral.shareExpansionRatio);
  // 採算が十分に良ければVALUE_FIRSTでも拡張できる（量のgapだけでは開かないが、
  // value economicsが伴えば取りに行く）。
  const valueFirstGoodMargin = core({ visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 1.0, strategicPosture: "VALUE_FIRST" });
  assert.equal(valueFirstGoodMargin.valueOrientationGate, 1);
  assert.ok(valueFirstGoodMargin.shareExpansionRatio > valueFirst.shareExpansionRatio);
});

test("GROW2-12: 財務規律の強い会社（CONSV相当）は採算・財務が揃わないと開放が小さい", () => {
  const shared = { visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 0.12, lastQuarterFinancialHealthTier: "watch" } as const;
  const riskTolerant = core({ ...shared, financialRiskTolerance: "HIGH" });
  const disciplined = core({ ...shared, financialRiskTolerance: "LOW" });
  assert.ok(disciplined.financialDisciplineGate < riskTolerant.financialDisciplineGate);
  assert.ok(disciplined.shareExpansionRatio < riskTolerant.shareExpansionRatio);
  // 財務が健全で採算も十分ならLOW toleranceでも開放される。
  const healthyDisciplined = core({ visionReferenceScaleTons: 60000, weightedContributionUsdPerKg: 1.0, financialRiskTolerance: "LOW" });
  assert.equal(healthyDisciplined.financialDisciplineGate, 1);
  assert.ok(healthyDisciplined.shareExpansionRatio > disciplined.shareExpansionRatio);
});

// ---------------------------------------------------------------------
// GROW2-13〜17: 変更していないことの固定
// ---------------------------------------------------------------------

test("GROW2-13: Sales Capacity Engineは変更されていない", () => {
  const model = SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1;
  assert.equal(model.companyBaselineCapacityTons, 1000);
  assert.equal(model.companyCapacityMaxIncrementTons, 95000);
  assert.equal(model.companyCapacitySaturationHeadcount, 190);
  assert.equal(SALES_PARAMETERS_V1.maximumSupplierShare, 0.35);
  // legacy shareの定数自体も削除・変更していない（可変化は呼び出し時のparams上書きで行う）。
  assert.equal(LEGACY_AMBITION_SHARE, 0.35);
  assert.equal(LEGACY_COMMITMENT_SHARE, 0.5);
});

/** 同一Turnで adaptive share の有無を比較する（他の入力はすべて同一）。 */
function compareFirstTurn() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "grow2-cmp", turns: 32 });
  const publicInfo = buildPublicMarketInfo(state);
  const legacyParams = {
    ...STANDARD_AI_PARAMETERS_V1,
    growthPressure: { ...GROWTH_PRESSURE_PARAMETERS_V1, adaptiveShareEnabled: false },
  };
  return fixtures.map((f) => {
    const own = buildCompanyOwnState(state, f);
    const adaptive = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    const legacy = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo, state.currentPeriod, state.scenarioState.currentTurn, legacyParams);
    return { adaptive, legacy };
  });
}

test("GROW2-14: 生産計画の判断式は直接変更していない（販売希望が同じなら生産も同じ）", () => {
  for (const { adaptive, legacy } of compareFirstTurn()) {
    const sameSales =
      adaptive.decision.salesPlans.reduce((a, p) => a + unwrapUnit(p.desiredQuantity), 0) ===
      legacy.decision.salesPlans.reduce((a, p) => a + unwrapUnit(p.desiredQuantity), 0);
    if (sameSales) {
      assert.deepEqual(adaptive.decision.productionPlans, legacy.decision.productionPlans);
    }
  }
});

test("GROW2-15: 調達の判断式は直接変更していない（生産計画が同じなら調達も同じ）", () => {
  for (const { adaptive, legacy } of compareFirstTurn()) {
    if (JSON.stringify(adaptive.decision.productionPlans) === JSON.stringify(legacy.decision.productionPlans)) {
      assert.deepEqual(adaptive.decision.domesticPurchasePlan, legacy.decision.domesticPurchasePlan);
      assert.deepEqual(adaptive.decision.importOrders, legacy.decision.importOrders);
    }
  }
});

test("GROW2-16: CAPEXの判断式は直接変更していない（生産必要量が同じならCAPEXも同じ）", () => {
  for (const { adaptive, legacy } of compareFirstTurn()) {
    if (JSON.stringify(adaptive.decision.productionPlans) === JSON.stringify(legacy.decision.productionPlans)) {
      assert.deepEqual(adaptive.decision.capexDecision, legacy.decision.capexDecision);
      assert.equal(adaptive.decision.salesForceHireCount, legacy.decision.salesForceHireCount);
    }
  }
});

test("GROW2-17: 未公開のシナリオ将来イベントは入力として受け取れない", () => {
  const input: GrowthPressureCoreInput = {
    companyId: "BAL",
    period: period(2015, 2),
    observation: observation(),
    contracts: [],
    visionReferenceScaleTons: 60000,
    growthAmbition: "MEDIUM",
    strategicPosture: null,
    financialRiskTolerance: null,
    currentRelevantScaleTons: 15000,
    attainableProfitableTons: 100000,
    orientationWeightedOpportunityTons: 100000,
    weightedContributionUsdPerKg: 1.0,
    priceObservationMissing: false,
    observedConversionRatio: 0.95,
    finishedGoodsExcessRatioByProduct: { hoso: 0.5, pd: 0.5, vap: 0.5 },
    crisisState: "NORMAL",
    lastQuarterFinancialHealthTier: "healthy",
  };
  assert.deepEqual(Object.keys(input).sort(), [
    "attainableProfitableTons",
    "companyId",
    "contracts",
    "crisisState",
    "currentRelevantScaleTons",
    "financialRiskTolerance",
    "finishedGoodsExcessRatioByProduct",
    "growthAmbition",
    "lastQuarterFinancialHealthTier",
    "observation",
    "observedConversionRatio",
    "orientationWeightedOpportunityTons",
    "period",
    "priceObservationMissing",
    "strategicPosture",
    "visionReferenceScaleTons",
    "weightedContributionUsdPerKg",
  ]);
  // orientation weighting も観測需要のみから作られる。
  const weighted = computeOrientationWeightedOpportunity(observation(), SALES_PARAMETERS_V1, {}, {});
  assert.equal(weighted.weightedAttainableProfitableTons, 0);
  assert.equal(weighted.orientationActive, false);
});

// ---------------------------------------------------------------------
// GROW2-18〜19: DS1 / DS2 regression（安全性）
// ---------------------------------------------------------------------

function runScenario(scenarioId: string, seed: string, turns: number, legacy: boolean) {
  const { state: s0, fixtures } = initializeCompanyLab({ scenarioId, mode: "canonical", seed, turns: 32 });
  let state: CompanyLabState = s0;
  const params = legacy
    ? { ...STANDARD_AI_PARAMETERS_V1, growthPressure: { ...GROWTH_PRESSURE_PARAMETERS_V1, adaptiveShareEnabled: false } }
    : STANDARD_AI_PARAMETERS_V1;
  let distressTurns = 0;
  let zeroProductionTurns = 0;
  let desiredSalesTotal = 0;
  let minCash = Number.POSITIVE_INFINITY;
  for (let i = 0; i < turns && !state.isComplete; i++) {
    const publicInfo = buildPublicMarketInfo(state);
    const results = fixtures.map((f) =>
      generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn, params)
    );
    desiredSalesTotal += results.reduce((a, r) => a + r.decision.salesPlans.reduce((b, p) => b + unwrapUnit(p.desiredQuantity), 0), 0);
    state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(results.map((r) => [r.decision.companyId, r.decision])));
    const record = state.history[state.history.length - 1];
    for (const s of record.companySummaries) {
      const produced = unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced);
      if (produced <= 0) zeroProductionTurns += 1;
    }
    for (const f of record.financialResults) {
      minCash = Math.min(minCash, Number(f.balanceSheet.cash));
    }
    for (const f of record.financingResults) {
      if (f.financialHealth.primary !== "healthy") distressTurns += 1;
    }
  }
  return { distressTurns, zeroProductionTurns, desiredSalesTotal, minCash };
}

test("GROW2-18: DS1でdistress/zero productionが明確に悪化しない", () => {
  const legacy = runScenario(DYNAMIC_SCENARIO_1.scenarioId, "grow2-ds1", 16, true);
  const adaptive = runScenario(DYNAMIC_SCENARIO_1.scenarioId, "grow2-ds1", 16, false);
  assert.ok(
    adaptive.zeroProductionTurns <= legacy.zeroProductionTurns + 5,
    `zeroProduction legacy=${legacy.zeroProductionTurns} adaptive=${adaptive.zeroProductionTurns}`
  );
  assert.ok(adaptive.distressTurns <= legacy.distressTurns * 1.5 + 5, `distress legacy=${legacy.distressTurns} adaptive=${adaptive.distressTurns}`);
});

test("GROW2-19: DS2で販売希望が増え、distress/zero productionが明確に悪化しない", () => {
  const legacy = runScenario(DYNAMIC_SCENARIO_2.scenarioId, "grow2-ds2", 16, true);
  const adaptive = runScenario(DYNAMIC_SCENARIO_2.scenarioId, "grow2-ds2", 16, false);
  assert.ok(adaptive.desiredSalesTotal > legacy.desiredSalesTotal, `desired legacy=${legacy.desiredSalesTotal} adaptive=${adaptive.desiredSalesTotal}`);
  assert.ok(
    adaptive.zeroProductionTurns <= legacy.zeroProductionTurns + 5,
    `zeroProduction legacy=${legacy.zeroProductionTurns} adaptive=${adaptive.zeroProductionTurns}`
  );
  assert.ok(adaptive.distressTurns <= legacy.distressTurns * 1.5 + 5, `distress legacy=${legacy.distressTurns} adaptive=${adaptive.distressTurns}`);
});
