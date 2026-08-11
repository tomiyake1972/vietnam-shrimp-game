// ShrimpX V2 — Strategic Posture (AGGRESSIVE_EARLY_CAPACITY) の Forward Capacity Gap route。
//
// Phase F の実測ベンチマーク（scripts/strategicPostureBenchmark.ts）で、既存5シナリオ×32Qでは
// strategic routeが一度もreactive routeより先に発火しないことが確認された。原因は
// buildMarketGrowthEvidence の observedMarketGrowthRatio が、reactive Gate H
// （EXISTING_CAPACITY_IN_USE）と同じ「持続的に稼働率が高い」条件に紐づいていたため
// （newFactory.ts のコメント参照）。このテストは、その修正後の挙動を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyVision } from "../../vision/types";
import { computeStrategicGrowthState } from "../../vision/strategicGrowth";
import { CommercialAmbition } from "../../vision/commercialAmbition";
import { evaluateNewFactoryDecision, NEW_FACTORY_STRATEGY_PARAMETERS_V1, NewFactoryDecisionInput } from "../decision/newFactory";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { CompanyFixture } from "../../types";

const fixture = { companyId: "TEST" } as unknown as CompanyFixture;

function vision(overrides: Partial<CompanyVision> = {}): CompanyVision {
  return {
    visionId: "TEST-vision",
    effectiveFromTurn: 1,
    growthAmbition: "HIGH",
    targetScaleTonsPerQuarterAtQ32: 34000,
    preferredEndState: "LARGE_INTEGRATED",
    willingnessToBuildFactories: "HIGH",
    financialRiskTolerance: "HIGH",
    desiredProductEvolution: "INTEGRATED",
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 16000 },
      { turn: 32, scaleTonsPerQuarter: 34000 },
    ],
    longTermNarrative: "テスト用",
    emphasisProducts: ["hoso"],
    strategicPosture: "AGGRESSIVE_EARLY_CAPACITY",
    ...overrides,
  };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "TEST",
    period: "2015Q3",
    turn: 12,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 1000,
    rawMaterialInTransitImportQuantity: 0,
    rawMaterialGrowingAquacultureQuantity: 0,
    rawMaterialCertainInboundThisPeriod: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 20000,
    // 【意図的に低稼働率】current utilization ~68% — reactive Gate Hをまだ満たさない
    // （minimumUtilizationForNewFactory=0.75）。「今はまだ余裕がある」を再現する。
    totalEffectiveCapacityByProduct: { hoso: 6840, pd: 5985, vap: 4275 },
    totalEffectiveCommonProcessingCapacity: 17100,
    totalEffectiveFreezingPackagingCapacity: 17100,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 120,
    procurementHeadcountTotal: 12,
    lastQuarterActualProductionByProduct: { hoso: 4600, pd: 4000, vap: 2800 },
    markets: [],
    marketPremiumByProduct: {},
    vietnamDomesticPriorMarket: { supply: 40000, effectiveDemand: 30000, transactedVolume: 30000, unsoldSupply: 10000 },
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 6000,
    receivablesDueThisPeriodUsd: 0,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 0,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    factoryCount: 1,
    maxFactoriesPerCompany: 4,
    pendingNewFactoryProjectCount: 0,
    prospectiveFactoryCount: 1,
    factorySpaceTotalUnits: 125350,
    factorySpaceUsedUnits: 124350,
    factorySpaceRemainingUnits: 1000,
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    borrowingPressure: 0,
    equipmentUtilizationLastQuarter: 0.68,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.7,
    targetMinimumCashUsd: 20_000_000,
    ...overrides,
  } as PressureScores;
}

function commercialAmbition(overrides: Partial<CommercialAmbition> = {}): CommercialAmbition {
  return {
    ambitionTons: 20000,
    baselineTons: 15100,
    visionPullTons: 4900,
    // 志・観測できる採算機会に支えられた強い自社成長根拠（32%）。
    ambitionMultiplier: 1.32,
    realisticOpportunityTons: 25000,
    limiter: "NONE",
    expanded: true,
    ...overrides,
  };
}

/** 現在はまだ稼働率が低いが、Vision上は完成予定ターンに向けて大きく成長する入力。 */
function baseInput(overrides: Partial<NewFactoryDecisionInput> = {}): NewFactoryDecisionInput {
  const v = vision();
  // currentSustainableScaleTons(≈15,100)に対し、参考軌道はturn12時点で
  // 既に約19,900t/期 — onTrackにならない程度の遅れを作る（現在gapはGROWTH_PRESSURE的にreactiveが動く水準）。
  const strategicGrowth = computeStrategicGrowthState({ vision: v, turn: 12, currentSustainableScaleTons: 15_100 });
  return {
    turn: 12,
    fixture,
    observation: observation(),
    pressures: pressures(),
    vision: v,
    strategicGrowth,
    productionNeededByProductBeforeCap: { hoso: 4600, pd: 4000, vap: 2800 },
    existingExpansionProposedThisQuarter: false,
    commercialAmbition: commercialAmbition(),
    unservedOpportunity: undefined,
    persistentCapacityCausedUnserved: false,
    ...overrides,
  };
}

test("STRAT-G1: current growth pressureがLOW/MODERATEでも、forward gapとgrowth thesisが十分ならstrategic routeが評価・提案する", () => {
  const r = evaluateNewFactoryDecision(baseInput());
  assert.equal(r.assessment.decisionRoute, "STRATEGIC_FORWARD_CAPACITY", `status=${r.assessment.status} route=${r.assessment.decisionRoute}`);
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.ok(r.assessment.forwardCapacityGap, "forwardCapacityGapが記録されている");
  assert.ok((r.assessment.forwardCapacityGap?.forwardCapacityGapTons ?? 0) > 0);
});

test("STRAT-G2: strategic routeが提案した四半期は、reactive routeがまだREADY_TO_BUILDではなかったことがtraceへ残る", () => {
  const r = evaluateNewFactoryDecision(baseInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.notEqual(r.assessment.reactiveStatusAtStrategicDecision, "READY_TO_BUILD");
  assert.ok(r.assessment.reactiveStatusAtStrategicDecision !== null, "reactiveの状態が記録されている");
});

test("STRAT-G3: 観測できる成長根拠（自社成長・市場成長）が弱ければ、想定規模が現状から伸びず、forward gap自体が意味を持たない", () => {
  // observedGrowthRatioPerQuarter=0 だと、想定規模（trendAdjustedScaleAtCompletion）は
  // 現在規模のまま横ばいになる。Vision参考軌道とのminを取るForward Capacity Gapの式では、
  // これが「成長根拠が無ければ先行投資の根拠も無い」という結果に直結する（設計文書§5.2）。
  const r = evaluateNewFactoryDecision(
    baseInput({
      commercialAmbition: commercialAmbition({ ambitionMultiplier: 1.0 }),
      unservedOpportunity: undefined,
    })
  );
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.forwardCapacityGap?.observedGrowthRatioPerQuarter, 0);
  assert.equal(r.assessment.forwardCapacityGap?.forwardCapacityGapTons, 0);
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT"));
});

test("STRAT-G4: forward gapが小さければbuildしない", () => {
  // Visionの参考軌道をほぼ横ばいにし、かつ観測できる成長根拠も無くす。
  // どちらか一方だけでも残すと（G6のように）gapが小さくても意味を持ちうるため、
  // ここでは両方をゼロにして「完成時点でも今と変わらない」を再現する。
  const flatVision = vision({ referenceGrowthPath: [{ turn: 1, scaleTonsPerQuarter: 15_100 }] });
  const strategicGrowth = computeStrategicGrowthState({ vision: flatVision, turn: 12, currentSustainableScaleTons: 15_100 });
  const r = evaluateNewFactoryDecision(
    baseInput({
      vision: flatVision,
      strategicGrowth,
      commercialAmbition: commercialAmbition({ ambitionMultiplier: 1.0 }),
      unservedOpportunity: undefined,
    })
  );
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT"));
});

test("STRAT-G5: 財務条件を満たさなければbuildしない（積極戦略でも財務ゲートは緩めない）", () => {
  const r = evaluateNewFactoryDecision(baseInput({ observation: observation({ cashUsd: 1_000_000 }) }));
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE"));
  assert.equal(r.assessment.postConstructionActivationFeasible, false);
});

test("STRAT-G6: 既存増設の余地があり、forward gapもその範囲内で収まるなら、先行して新工場は建てない", () => {
  // forward gap比率がoverlapGapRatio(0.3)以下になるよう、成長根拠を緩やかにする
  // （G1のambitionMultiplier=1.32では大きすぎてgapJustifiesOverlapが成立してしまう）。
  const r = evaluateNewFactoryDecision(
    baseInput({
      observation: observation({ factorySpaceRemainingUnits: 50_000 }),
      commercialAmbition: commercialAmbition({ ambitionMultiplier: 1.05 }),
      unservedOpportunity: undefined,
    })
  );
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.status, "DEFERRED");
  assert.ok((r.assessment.forwardCapacityGap?.forwardCapacityGapRatio ?? 1) <= NEW_FACTORY_STRATEGY_PARAMETERS_V1.overlapGapRatio);
  assert.ok(r.assessment.existingExpansionAlternativeSufficientTons !== null);
});

test("STRAT-G7b: 既存増設だけでは追いつかないほどforward gapが大きければ、既存増設余地があっても先行着工を検討する", () => {
  const r = evaluateNewFactoryDecision(baseInput({ observation: observation({ factorySpaceRemainingUnits: 50_000 }) }));
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.existingExpansionAlternativeSufficientTons, null);
});

test("STRAT-G7: DEMAND_CONFIRMED（保守）は同じ入力でも先行着工しない（Profile差が消えない）", () => {
  const aggressiveResult = evaluateNewFactoryDecision(baseInput());
  const conservativeVision = vision({ strategicPosture: "DEMAND_CONFIRMED" });
  const conservativeGrowth = computeStrategicGrowthState({ vision: conservativeVision, turn: 12, currentSustainableScaleTons: 15_100 });
  const conservativeResult = evaluateNewFactoryDecision(
    baseInput({ vision: conservativeVision, strategicGrowth: conservativeGrowth })
  );
  assert.equal(aggressiveResult.assessment.status, "READY_TO_BUILD", "AGGRESSIVEは同一条件で先行着工する");
  assert.notEqual(conservativeResult.assessment.status, "READY_TO_BUILD", "DEMAND_CONFIRMEDは同一条件で先行着工しない");
  assert.equal(conservativeResult.assessment.decisionRoute, "NONE");
});

test("STRAT-G8: TRUE未来需要を引数として受け取れない（型に存在しない）ことを確認する", () => {
  const input = baseInput();
  const keys = Object.keys(input);
  for (const forbidden of ["trueFutureDemand", "trueDemand", "futurePrice", "futureDemand"]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} が入力に存在してはならない`);
  }
});

test("STRAT-G9: 建設リードタイムはcapex.tsのテンプレート値をそのまま使い、独自の定数を作っていない", () => {
  const r = evaluateNewFactoryDecision(baseInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  // newFactoryConstruction テンプレート = standardConstructionQuarters(3) + postCompletionReadinessQuarters(1) = 4。
  assert.equal(r.assessment.forwardCapacityGap?.constructionLeadTimeQuarters, 4);
  assert.equal(r.assessment.forwardCapacityGap?.forecastCompletionTurn, 16);
});
