// ShrimpX V2 — Phase SAI-GROW-1: Shadow Growth Pressure テスト（実装指示§36）
//
// SAI-GROW-1〜20。実Anthropic APIは呼ばない。
// 最重要は SAI-GROW-16〜20（**Shadowを入れてもStandard AIの判断が一切変わらない**）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGrowthPressure, computeGrowthPressureCore, GrowthPressureCoreInput } from "../growth";
import { StandardAiObservation } from "../types";
import { CommercialAmbition, COMMERCIAL_AMBITION_PARAMETERS_V1 } from "../../vision/commercialAmbition";
import { CommercialCommitmentState, COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { UnservedOpportunity } from "../../vision/unservedOpportunity";
import { SalesContract } from "../../../sales/types";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1 } from "../../../sales/salesCapacityModel";
import { hosoEqTons, usdPerHosoEqKg } from "../../../core/units";
import { period } from "../../../core/period";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyLabState } from "../../types";
import { DYNAMIC_SCENARIO_2 } from "../../../scenario/definitions/dynamicScenario2";

// ---------------------------------------------------------------------
// 合成入力のヘルパー（engineは動かさず、Growth Pressureの式だけを検証する）
// ---------------------------------------------------------------------

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    lastQuarterActualProductionByProduct: { hoso: 10000, pd: 0, vap: 0 },
    lifecycleTrendByMarket: undefined,
    productSupplyPressureByProduct: undefined,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function ambition(baselineTons: number): CommercialAmbition {
  return {
    ambitionTons: baselineTons,
    baselineTons,
    visionPullTons: 0,
    ambitionMultiplier: 1,
    realisticOpportunityTons: 0,
    limiter: "NONE",
    expanded: false,
  };
}

function commitment(submissionTargetTons: number): CommercialCommitmentState {
  return {
    submissionTargetTons,
    stretchOverAmbition: 1,
    expectedConversionRatio: 0.85,
    productionExpectedConversionRatio: 0.85,
    limiter: "NONE",
    caps: {
      ambitionTons: submissionTargetTons,
      conversionAdjustedTons: submissionTargetTons,
      stretchLimitTons: submissionTargetTons,
      opportunityTons: null,
      salesCapacityTons: null,
    },
    overSubmissionRisk: false,
  };
}

function unserved(overrides: Partial<UnservedOpportunity> = {}): UnservedOpportunity {
  return {
    unservedProfitableTons: 0,
    blockedBySalesCapacityTons: 0,
    blockedByProductionCapacityTons: 0,
    blockedByLaborTons: 0,
    blockedByRawMaterialTons: 0,
    blockedByInventoryPolicyTons: 0,
    blockedByOtherTons: 0,
    primaryConstraint: "NONE",
    ...overrides,
  } as UnservedOpportunity;
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

/**
 * 【GROW-2でのAPI変更】assessGrowthPressureは「決定前に評価するcore」と
 * 「決定後のConstraint Routing」に分かれた。テストの意味は変えず、helperだけ合わせる。
 * routing側の入力（unservedOpportunity等）はoverridesから分離して渡す。
 */
interface TestOverrides extends Partial<GrowthPressureCoreInput> {
  readonly unservedOpportunity?: UnservedOpportunity;
  readonly salesHiringZeroReason?: string | null;
  readonly salesForceHireCount?: number;
  readonly newCapexProposalCount?: number;
  readonly commercialAmbition?: CommercialAmbition;
  readonly commercialCommitment?: CommercialCommitmentState;
}

function input(overrides: TestOverrides = {}): GrowthPressureCoreInput {
  const baselineTons = overrides.commercialAmbition?.baselineTons;
  const attainable = overrides.attainableProfitableTons ?? 40000;
  return {
    companyId: "BAL",
    period: period(2015, 2),
    observation: observation(),
    contracts: [],
    visionReferenceScaleTons: 20000,
    growthAmbition: "MEDIUM",
    strategicPosture: null,
    financialRiskTolerance: null,
    currentRelevantScaleTons: baselineTons ?? 10000,
    attainableProfitableTons: attainable,
    orientationWeightedOpportunityTons: overrides.orientationWeightedOpportunityTons ?? attainable,
    weightedContributionUsdPerKg: 1.0,
    priceObservationMissing: false,
    observedConversionRatio: 0.95,
    finishedGoodsExcessRatioByProduct: { hoso: 0.5, pd: 0.5, vap: 0.5 },
    crisisState: "NORMAL",
    lastQuarterFinancialHealthTier: "healthy",
    ...overrides,
  };
}

function assess(overrides: TestOverrides = {}) {
  const coreInput = input(overrides);
  return assessGrowthPressure({
    core: computeGrowthPressureCore(coreInput),
    observation: coreInput.observation,
    unservedOpportunity: overrides.unservedOpportunity ?? unserved(),
    salesHiringZeroReason: overrides.salesHiringZeroReason ?? null,
    salesForceHireCount: overrides.salesForceHireCount ?? 0,
    newCapexProposalCount: overrides.newCapexProposalCount ?? 0,
  });
}

// ---------------------------------------------------------------------
// SAI-GROW-1〜8: 入力ごとの効き方
// ---------------------------------------------------------------------

test("SAI-GROW-1: Vision gapがVision参照規模と現在規模から正しく計算される", () => {
  const a = assess({ visionReferenceScaleTons: 20000, commercialAmbition: ambition(15000) });
  assert.equal(Number(a.strategicScaleGapRatio.toFixed(4)), 0.25);
  assert.equal(a.currentRelevantScaleTons, 15000);
  assert.equal(a.visionReferenceScaleTons, 20000);
  // 志より先行している場合は0（負の焦りを作らない）。
  const ahead = assess({ visionReferenceScaleTons: 20000, commercialAmbition: ambition(26000) });
  assert.equal(ahead.strategicScaleGapRatio, 0);
  // Visionが無い会社ではgap=0（架空のVisionを作らない）。
  const noVision = assess({ visionReferenceScaleTons: null, growthAmbition: null });
  assert.equal(noVision.strategicScaleGapRatio, 0);
  assert.equal(noVision.profileSensitivity, 1);
});

test("SAI-GROW-2: 市場機会が無ければpressureはLOWになり、制約はNO_MARKET_OPPORTUNITY", () => {
  const a = assess({ attainableProfitableTons: 0 });
  assert.equal(a.level, "LOW");
  assert.equal(a.score, 0);
  assert.equal(a.primaryGrowthConstraint, "NO_MARKET_OPPORTUNITY");
  assert.equal(a.recommendedPressureDestination, "HOLD_GROWTH");
  assert.ok(a.reasonCodes.includes("GROWTH_NO_MARKET_OPPORTUNITY"));

  // 機会はあるが、現在の提出量と同じ規模しか無い場合も支持度0。
  const equal = assess({ attainableProfitableTons: 10000, commercialCommitment: commitment(10000) });
  assert.equal(equal.opportunitySupport, 0);
  assert.equal(equal.level, "LOW");
});

test("SAI-GROW-3: 大きな市場機会＋Vision gapがあればpressureが高くなる", () => {
  const a = assess({ visionReferenceScaleTons: 60000, commercialAmbition: ambition(10000), attainableProfitableTons: 60000 });
  assert.equal(a.opportunitySupport, 1);
  assert.ok(a.strategicScaleGapRatio > 0.8);
  assert.ok(a.score >= 0.5, `score=${a.score}`);
  assert.equal(a.level, "URGENT");
  assert.ok(a.reasonCodes.includes("GROWTH_OPPORTUNITY_AVAILABLE"));
  assert.ok(a.ceilingSuppressedOpportunityTons > 0);
  assert.ok(a.reasonCodes.includes("GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP"));
});

test("SAI-GROW-4: margin brake — 期待貢献が最低水準以下ならpressureは0になる", () => {
  const base = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000 });
  const weak = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, weightedContributionUsdPerKg: 0.04 });
  assert.ok(base.score > 0);
  assert.equal(weak.marginSignal, 0);
  assert.equal(weak.score, 0);
  assert.equal(weak.primaryGrowthConstraint, "MARGIN");
  assert.equal(weak.recommendedPressureDestination, "IMPROVE_MIX_OR_PRICE");
  // 参照売価が観測できない場合は採算を断定せず抑制もしない。
  const unknownPrice = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, weightedContributionUsdPerKg: 0, priceObservationMissing: true });
  assert.equal(unknownPrice.marginSignal, 1);
});

test("SAI-GROW-5: inventory brake — 完成品在庫が過剰ならpressureが下がる", () => {
  const normal = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000 });
  const full = assess({
      visionReferenceScaleTons: 60000,
      attainableProfitableTons: 60000,
      finishedGoodsExcessRatioByProduct: { hoso: 1.6, pd: 0.2, vap: 0.2 },
    });
  assert.equal(full.inventoryBrake, 1);
  assert.equal(full.score, 0);
  assert.equal(full.primaryGrowthConstraint, "INVENTORY");
  assert.equal(full.recommendedPressureDestination, "HOLD_GROWTH");
  const partial = assess({
      visionReferenceScaleTons: 60000,
      attainableProfitableTons: 60000,
      finishedGoodsExcessRatioByProduct: { hoso: 1.4, pd: 0.2, vap: 0.2 },
    });
  assert.ok(partial.inventoryBrake > 0 && partial.inventoryBrake < 1);
  assert.ok(partial.score < normal.score && partial.score > 0);
});

test("SAI-GROW-6: crisis brake — SEVERE_DISTRESSでpressureは0、LIQUIDITY_STRESSで減衰", () => {
  const normal = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000 });
  const severe = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, crisisState: "SEVERE_DISTRESS" });
  const stress = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, crisisState: "LIQUIDITY_STRESS" });
  assert.equal(severe.score, 0);
  assert.equal(severe.crisisBrake, 1);
  assert.equal(severe.primaryGrowthConstraint, "FINANCE");
  assert.ok(stress.score > 0 && stress.score < normal.score);
});

test("SAI-GROW-7: healthy forward backlogは成長のpositive signalになる", () => {
  const none = assess();
  const healthy = assess({
      // 期日が将来（2015-Q3）の受注残。現在は2015-Q2。
      contracts: [contract({ dueDate: period(2015, 3), outstandingQuantity: hosoEqTons(5000) })],
    });
  assert.equal(none.forwardDemandSignal, 0);
  assert.equal(Number(healthy.forwardDemandSignal.toFixed(4)), 0.5);
  assert.ok(healthy.score > none.score);
});

test("SAI-GROW-8: overdueはpositive growth signalとして扱わない", () => {
  const overdue = assess({
      // 期日が過去（2015-Q1）＝納期超過。現在は2015-Q2。
      contracts: [contract({ dueDate: period(2015, 1), outstandingQuantity: hosoEqTons(5000), status: "overdue" })],
    });
  const none = assess();
  assert.equal(overdue.forwardDemandSignal, 0);
  assert.equal(overdue.score, none.score);
});

// ---------------------------------------------------------------------
// SAI-GROW-9〜13: Constraint Routing
// ---------------------------------------------------------------------

test("SAI-GROW-9: 営業能力不足はCOMMERCIAL → SALES_HIRINGへルーティングされる", () => {
  const a = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, unservedOpportunity: unserved({ blockedBySalesCapacityTons: 2000 }) });
  assert.equal(a.primaryGrowthConstraint, "COMMERCIAL");
  assert.equal(a.recommendedPressureDestination, "SALES_HIRING");
  assert.ok(a.reasonCodes.includes("GROWTH_BLOCKED_BY_COMMERCIAL"));
});

test("SAI-GROW-10: 生産能力不足はPRODUCTION_CAPACITY → CAPEXへルーティングされる", () => {
  const a = assess({
      visionReferenceScaleTons: 60000,
      attainableProfitableTons: 60000,
      unservedOpportunity: unserved({ blockedByProductionCapacityTons: 3000 }),
    });
  assert.equal(a.primaryGrowthConstraint, "PRODUCTION_CAPACITY");
  assert.equal(a.recommendedPressureDestination, "CAPEX");
});

test("SAI-GROW-11: 原料制約はRAW_MATERIAL → PROCUREMENT_EXPANSION", () => {
  const a = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, unservedOpportunity: unserved({ blockedByRawMaterialTons: 1500 }) });
  assert.equal(a.primaryGrowthConstraint, "RAW_MATERIAL");
  assert.equal(a.recommendedPressureDestination, "PROCUREMENT_EXPANSION");
});

test("SAI-GROW-12: 労働制約はLABOR → WORKFORCE_EXPANSION", () => {
  const a = assess({ visionReferenceScaleTons: 60000, attainableProfitableTons: 60000, unservedOpportunity: unserved({ blockedByLaborTons: 900 }) });
  assert.equal(a.primaryGrowthConstraint, "LABOR");
  assert.equal(a.recommendedPressureDestination, "WORKFORCE_EXPANSION");
});

test("SAI-GROW-13: 財務悪化はFINANCE → HOLD_GROWTH（他の制約より優先される）", () => {
  const a = assess({
      visionReferenceScaleTons: 60000,
      attainableProfitableTons: 60000,
      lastQuarterFinancialHealthTier: "stressed",
      unservedOpportunity: unserved({ blockedBySalesCapacityTons: 2000 }),
    });
  assert.equal(a.primaryGrowthConstraint, "FINANCE");
  assert.equal(a.recommendedPressureDestination, "HOLD_GROWTH");
  assert.ok(a.financeBrake > 0);
  assert.ok(a.secondaryGrowthConstraints.includes("COMMERCIAL"));
});

// ---------------------------------------------------------------------
// SAI-GROW-14〜17: profile差・情報境界・engine不変
// ---------------------------------------------------------------------

test("SAI-GROW-14: 同一状況でもgrowthAmbitionによりpressureの強さが変わる（会社差）", () => {
  const shared = { visionReferenceScaleTons: 40000, commercialAmbition: ambition(20000), attainableProfitableTons: 60000 };
  const high = assess({ ...shared, growthAmbition: "HIGH" });
  const medium = assess({ ...shared, growthAmbition: "MEDIUM" });
  const low = assess({ ...shared, growthAmbition: "LOW" });
  assert.ok(high.score > medium.score && medium.score > low.score);
  assert.equal(high.profileSensitivity, 1.2);
  assert.equal(medium.profileSensitivity, 1);
  assert.equal(low.profileSensitivity, 0.7);
  // baseScore（感度適用前）は同一＝差はprofileだけから生じている。
  assert.equal(high.baseScore, low.baseScore);
});

test("SAI-GROW-15: 未公開のシナリオ将来イベントは入力として受け取れない", () => {
  // GrowthPressureInputのキー集合を固定する。scenario/未来のTRUE WORLDへ触れる
  // フィールドが将来足された場合、このテストが落ちる。
  const keys = Object.keys(input()).sort();
  assert.deepEqual(keys, [
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
});

test("SAI-GROW-16: 既存の0.35 / 0.5 capは変更されていない", () => {
  assert.equal(SALES_PARAMETERS_V1.maximumSupplierShare, 0.35);
  // commercialCommitmentの提出係数・commercialAmbitionの機会係数も現行のまま。
  assert.equal(COMMERCIAL_COMMITMENT_PARAMETERS_V1.realisticShareOfOpportunity, 0.5);
  assert.equal(COMMERCIAL_AMBITION_PARAMETERS_V1.realisticShareOfProfitableOpportunity, 0.35);
  // 【GROW-2】機会評価には0.35/0.5を使わない。currentSubmissionCeilingは
  // 「legacy shareならこうなる」という参照値であり、観測機会そのものは別に保持する。
  const a = assess({ attainableProfitableTons: 60000, currentRelevantScaleTons: 20000 });
  assert.equal(a.observedOpportunityTons, 60000);
  assert.equal(a.currentSubmissionCeilingTons, 60000 * 0.5);
  assert.equal(a.currentOpportunityShare.ambition, 0.35);
  assert.equal(a.currentOpportunityShare.commitment, 0.5);
});

test("SAI-GROW-17: Sales Capacity Engineの式は変更されておらず、漸近上限は診断のみに使う", () => {
  const model = SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1;
  assert.equal(model.companyBaselineCapacityTons, 1000);
  assert.equal(model.companyCapacityMaxIncrementTons, 95000);
  assert.equal(model.companyCapacitySaturationHeadcount, 190);
  // 漸近上限（96,000工数トン）を超えるVision規模ではengine cap診断が出る。
  const beyond = assess({ visionReferenceScaleTons: 120000, observation: observation({ lastQuarterActualProductionByProduct: { hoso: 10000 } }) });
  assert.ok(beyond.reasonCodes.includes("GROWTH_BLOCKED_BY_ENGINE_CAP"));
  assert.ok(beyond.reasonCodes.includes("EXTERNAL_ENGINE_CAPACITY_LIMIT"));
  // VAP主体（工数係数3.0）なら、より小さい規模でengine上限に当たる。
  const vapHeavy = assess({ visionReferenceScaleTons: 45000, observation: observation({ lastQuarterActualProductionByProduct: { vap: 10000 } }) });
  assert.ok(vapHeavy.reasonCodes.includes("GROWTH_BLOCKED_BY_ENGINE_CAP"));
  const within = assess({ visionReferenceScaleTons: 30000, observation: observation({ lastQuarterActualProductionByProduct: { hoso: 10000 } }) });
  assert.ok(!within.reasonCodes.includes("GROWTH_BLOCKED_BY_ENGINE_CAP"));
});

// ---------------------------------------------------------------------
// SAI-GROW-18〜20: Decision非干渉（最重要・実装指示§26）
// ---------------------------------------------------------------------

/** decisionのみを取り出す（診断は比較対象から外す＝Shadowの有無で変わるのは診断だけ）。 */
function decisionsOnly(state: CompanyLabState, fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]) {
  const publicInfo = buildPublicMarketInfo(state);
  return fixtures.map((f) =>
    generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
  );
}

test("SAI-GROW-18: Standard AIのproposalはShadow Growth Pressureの有無で変化しない（同一入力で決定論的）", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "grow1-a", turns: 32 });
  const first = decisionsOnly(state, fixtures);
  const second = decisionsOnly(state, fixtures);
  assert.deepEqual(
    second.map((r) => r.decision),
    first.map((r) => r.decision)
  );
  // Growth Pressureは診断として必ず生成される（Decisionには現れない）。
  for (const r of first) {
    assert.ok(r.diagnostics.growthPressure, `${r.decision.companyId}のgrowthPressureが無い`);
    assert.ok(!Object.keys(r.decision).some((k) => k.toLowerCase().includes("growth")));
  }
});

test("SAI-GROW-19: 12Turn通しのsimulation結果がGrowth Pressure評価の前後で一致する", () => {
  function run(): { decisions: unknown[]; summaries: unknown[] } {
    const { state: s0, fixtures } = initializeCompanyLab({
      scenarioId: DYNAMIC_SCENARIO_2.scenarioId,
      mode: "canonical",
      seed: "grow1-b",
      turns: 32,
    });
    let state: CompanyLabState = s0;
    const decisions: unknown[] = [];
    const summaries: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      const results = decisionsOnly(state, fixtures);
      decisions.push(results.map((r) => r.decision));
      state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(results.map((r) => [r.decision.companyId, r.decision])));
      summaries.push(state.history[state.history.length - 1].companySummaries);
    }
    return { decisions, summaries };
  }
  const a = run();
  const b = run();
  assert.deepEqual(b.decisions, a.decisions);
  assert.deepEqual(b.summaries, a.summaries);
});

test("SAI-GROW-20: Vision shadow sweep（候補Vision）はDecisionを一切変えない", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "grow1-c", turns: 32 });
  const results = decisionsOnly(state, fixtures);
  for (const r of results) {
    const current = r.diagnostics.growthPressure;
    assert.ok(current);
    // 候補Vision（DS3想定reference）でShadowを取り直しても、decisionは同じオブジェクトのまま。
    const candidateCore = computeGrowthPressureCore({
      companyId: r.diagnostics.companyId,
      period: r.diagnostics.period,
      observation: observation(),
      contracts: [],
      visionReferenceScaleTons: 100000,
      growthAmbition: "HIGH",
      strategicPosture: null,
      financialRiskTolerance: null,
      currentRelevantScaleTons: current.currentRelevantScaleTons,
      attainableProfitableTons: r.diagnostics.observableOpportunity!.attainableProfitableTons,
      orientationWeightedOpportunityTons: current.orientationWeightedOpportunityTons,
      weightedContributionUsdPerKg: r.diagnostics.observableOpportunity!.weightedContributionUsdPerKg,
      priceObservationMissing: r.diagnostics.observableOpportunity!.priceObservationMissing,
      observedConversionRatio: r.diagnostics.conversionObservation!.conversionRatio,
      finishedGoodsExcessRatioByProduct: r.diagnostics.pressures.finishedGoodsExcessRatioByProduct,
      crisisState: r.diagnostics.crisis!.state,
      lastQuarterFinancialHealthTier: null,
    });
    const candidate = assessGrowthPressure({
      core: candidateCore,
      observation: observation(),
      unservedOpportunity: r.diagnostics.unservedOpportunity!,
      salesHiringZeroReason: r.diagnostics.salesHiring!.zeroHireReason,
      salesForceHireCount: 0,
      newCapexProposalCount: 0,
    });
    // 候補Visionの方がgapが大きい＝shadowの値は変わるが、decisionは不変。
    assert.ok(candidate.strategicScaleGapRatio >= current.strategicScaleGapRatio);
  }
  const again = decisionsOnly(state, fixtures);
  assert.deepEqual(
    again.map((r) => r.decision),
    results.map((r) => r.decision)
  );
});
