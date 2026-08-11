// ShrimpX V2 — Standard AI Strategic Posture（先行能力投資型・積極成長戦略）単体テスト
//
// 設計文書: docs/standard_ai/STRATEGIC_POSTURE_AGGRESSIVE_EARLY_CAPACITY.md
//
// 検証の軸:
//   1. DEMAND_CONFIRMED/VALUE_FIRST は今日の reactive route だけで決まる（回帰しない）。
//   2. AGGRESSIVE_EARLY_CAPACITY は「完成予定ターン時点」の想定規模を見て、
//      今の稼働率が低くても先行着工しうる。
//   3. Vision 単独の楽観・TRUE未来情報では動かない（観測できる成長根拠が要る）。
//   4. 財務ゲートは reactive route と同一基準のまま緩めない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateNewFactoryDecision, NewFactoryDecisionInput } from "../newFactory";
import { computeForwardCapacityGap } from "../../forwardCapacityGap";
import { computeStrategicGrowthState } from "../../../vision/strategicGrowth";
import { CompanyVision, StrategicPosture } from "../../../vision/types";
import { StandardAiObservation } from "../../types";
import { PressureScores } from "../../pressures";
import { CompanyFixture } from "../../../types";
import { CAPEX_PARAMETERS_V1, CapexParameters } from "../../../../capex/parameters";
import { CommercialAmbition } from "../../../vision/commercialAmbition";
import { UnservedOpportunity } from "../../../vision/unservedOpportunity";

const fixture = { companyId: "TESTCO" } as unknown as CompanyFixture;
const CURRENT_SUSTAINABLE_SCALE_TONS = 10_000;

function vision(posture: StrategicPosture, overrides: Partial<CompanyVision> = {}): CompanyVision {
  return {
    visionId: "TEST-strategic-vision",
    effectiveFromTurn: 1,
    growthAmbition: "HIGH",
    targetScaleTonsPerQuarterAtQ32: 34000,
    preferredEndState: "LARGE_INTEGRATED",
    willingnessToBuildFactories: "HIGH",
    financialRiskTolerance: "HIGH",
    desiredProductEvolution: "INTEGRATED",
    referenceGrowthPath: [
      { turn: 1, scaleTonsPerQuarter: 10000 },
      { turn: 32, scaleTonsPerQuarter: 34000 },
    ],
    longTermNarrative: "テスト用",
    emphasisProducts: ["hoso"],
    strategicPosture: posture,
    ...overrides,
  };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "TESTCO",
    period: "2015Q3",
    turn: 5,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 1000,
    rawMaterialInTransitImportQuantity: 0,
    rawMaterialGrowingAquacultureQuantity: 0,
    rawMaterialCertainInboundThisPeriod: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 4500, pd: 3500, vap: 3500 },
    totalCommonProcessingCapacity: 11000,
    // 【意図的に低い稼働率】現在の実効能力に対し直近実績を小さくし、
    // reactive route の Gate H（EXISTING_CAPACITY_IN_USE）を落とす。
    totalEffectiveCapacityByProduct: { hoso: 4000, pd: 3000, vap: 3000 },
    totalEffectiveCommonProcessingCapacity: 10000,
    totalEffectiveFreezingPackagingCapacity: 10000,
    aquacultureCapacity: 2000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 8,
    lastQuarterActualProductionByProduct: { hoso: 1000, pd: 1000, vap: 1000 },
    markets: [],
    marketPremiumByProduct: {},
    vietnamDomesticPriorMarket: { supply: 40000, effectiveDemand: 30000, transactedVolume: 30000, unsoldSupply: 10000 },
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 1000,
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
    factorySpaceTotalUnits: 50000,
    factorySpaceUsedUnits: 49000,
    // 【意図的に小さい残余】既存増設だけで forward gap を吸収できない状況にする。
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
    equipmentUtilizationLastQuarter: 0.3,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.6,
    targetMinimumCashUsd: 20_000_000,
    ...overrides,
  } as PressureScores;
}

function commercialAmbition(ambitionMultiplier: number): CommercialAmbition {
  return {
    ambitionTons: 10500,
    baselineTons: 10000,
    visionPullTons: 500,
    ambitionMultiplier,
    realisticOpportunityTons: 10500,
    limiter: "NONE",
    expanded: ambitionMultiplier > 1,
  } as unknown as CommercialAmbition;
}

function unservedOpportunity(blockedByProductionCapacityTons: number): UnservedOpportunity {
  return {
    unservedProfitableTons: blockedByProductionCapacityTons,
    blockedBySalesCapacityTons: 0,
    blockedByProductionCapacityTons,
    blockedByLaborTons: 0,
  } as unknown as UnservedOpportunity;
}

/**
 * 全ゲートを通す「先行着工が正当化される」既定入力。
 *   - Vision参考軌道・観測成長根拠（自社成約成長5%、能力起因の未充足5%）の両方が
 *     完成予定ターン時点で現在能力を上回る見込みを示す。
 *   - 現在の稼働率はわざと低い（reactive routeは通らない）。
 *   - 既存増設余地は小さい（既存増設だけでは解消できない）。
 *   - 財務は健全（cash 200M、reactive Gate Lと同一基準）。
 */
function aggressiveInput(overrides: Partial<NewFactoryDecisionInput> = {}): NewFactoryDecisionInput {
  const v = vision("AGGRESSIVE_EARLY_CAPACITY");
  const strategicGrowth = computeStrategicGrowthState({ vision: v, turn: 5, currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS });
  return {
    turn: 5,
    fixture,
    observation: observation(),
    pressures: pressures(),
    vision: v,
    strategicGrowth,
    productionNeededByProductBeforeCap: { hoso: 1500, pd: 1500, vap: 1000 },
    existingExpansionProposedThisQuarter: false,
    commercialAmbition: commercialAmbition(1.05),
    unservedOpportunity: unservedOpportunity(500),
    persistentCapacityCausedUnserved: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// STRAT-1: DEMAND_CONFIRMED は今日の reactive route のままである
// ---------------------------------------------------------------------
test("STRAT-1: DEMAND_CONFIRMED の会社は、strategic routeを一切評価せず reactive route のみで決まる", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput({ vision: vision("DEMAND_CONFIRMED") }));
  assert.equal(r.assessment.decisionRoute, "NONE");
  assert.equal(r.assessment.strategicPosture, "DEMAND_CONFIRMED");
  assert.equal(r.assessment.forwardCapacityGap, null, "DEMAND_CONFIRMEDではForward Capacity Gapを計算しない");
  assert.equal(r.assessment.marketGrowthEvidence, null);
  // 現在の稼働率が低いため reactive の Gate H で見送りになる（今日と同じ挙動）。
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_DEFERRED_MARKET"));
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
});

// ---------------------------------------------------------------------
// STRAT-2/3: AGGRESSIVE_EARLY_CAPACITYは、今の稼働率が低くてもforward gapで先行着工しうる
// ---------------------------------------------------------------------
test("STRAT-2: AGGRESSIVE_EARLY_CAPACITYは、Forward Capacity Gapが十分な根拠を伴えば先行着工を提案する", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.decisionRoute, "STRATEGIC_FORWARD_CAPACITY");
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].projectType, "newFactoryConstruction");
  assert.ok(r.assessment.forwardCapacityGap);
  assert.ok(r.assessment.forwardCapacityGap!.forwardCapacityGapTons > 0);
});

test("STRAT-3: 今の稼働率が低い（reactive routeなら見送り）ままでも、strategic routeは弾かない。両ルートの根拠は診断に残る", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  // reactiveがGate Hで止めていた事実（今の稼働率が低い）は、diagnosticsに残る（説明可能性）。
  assert.ok(r.diagnostics.some((d) => d.code === "NEW_FACTORY_DEFERRED_MARKET"), "reactive routeが見送った根拠を捨てていない");
  assert.ok(r.diagnostics.some((d) => d.code === "NEW_FACTORY_STRATEGIC_PROPOSED"), "strategic routeの提案根拠が記録されている");
});

// ---------------------------------------------------------------------
// STRAT-4/7: gapが無い・Vision成長が弱ければ、先行着工しない
// ---------------------------------------------------------------------
test("STRAT-4/7: 完成予定ターン時点でも現在能力を上回る見込みが無ければ、先行着工しない", () => {
  const flatVision = vision("AGGRESSIVE_EARLY_CAPACITY", {
    referenceGrowthPath: [{ turn: 1, scaleTonsPerQuarter: CURRENT_SUSTAINABLE_SCALE_TONS }],
  });
  const strategicGrowth = computeStrategicGrowthState({ vision: flatVision, turn: 5, currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS });
  const r = evaluateNewFactoryDecision(
    aggressiveInput({
      vision: flatVision,
      strategicGrowth,
      commercialAmbition: commercialAmbition(1.0),
      unservedOpportunity: unservedOpportunity(0),
      persistentCapacityCausedUnserved: false,
    })
  );
  assert.equal(r.assessment.decisionRoute, "NONE");
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT"));
});

// ---------------------------------------------------------------------
// STRAT-5: 財務が満たなければ、gapが大きくても先行着工しない
// ---------------------------------------------------------------------
test("STRAT-5: Forward gapが大きくても、財務条件（reactive routeと同一基準）を満たさなければ先行着工しない", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput({ observation: observation({ cashUsd: 10_000_000 }) }));
  assert.equal(r.assessment.status, "DEFERRED");
  assert.equal(r.assessment.decisionRoute, "NONE");
  assert.ok(r.assessment.forwardCapacityGap, "gap自体は計算されている（見送り理由が財務であることを区別できる）");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE"));
});

// ---------------------------------------------------------------------
// STRAT-6: 建設リードタイムが長いほど、先行着工の価値（gap）は大きくなりうる
// ---------------------------------------------------------------------
test("STRAT-6: 建設リードタイムが長いほど、同じ成長根拠でもforward gapが大きくなる（早めに動く理由が強まる）", () => {
  const v = vision("AGGRESSIVE_EARLY_CAPACITY");
  const shortLeadParams: CapexParameters = {
    ...CAPEX_PARAMETERS_V1,
    templatesByType: {
      ...CAPEX_PARAMETERS_V1.templatesByType,
      newFactoryConstruction: {
        ...CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction,
        standardConstructionQuarters: 1,
        paymentRatios: [1],
        postCompletionReadinessQuarters: 1,
      },
    },
  };
  const longLeadParams: CapexParameters = {
    ...CAPEX_PARAMETERS_V1,
    templatesByType: {
      ...CAPEX_PARAMETERS_V1.templatesByType,
      newFactoryConstruction: {
        ...CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction,
        standardConstructionQuarters: 6,
        paymentRatios: [0.2, 0.2, 0.2, 0.2, 0.1, 0.1],
        postCompletionReadinessQuarters: 2,
      },
    },
  };
  const short = computeForwardCapacityGap({
    turn: 5,
    vision: v,
    currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS,
    marketGrowthEvidence: { recentOwnContractGrowthRatio: 0.05, observedMarketGrowthRatio: 0.05 },
    capexParams: shortLeadParams,
  });
  const long = computeForwardCapacityGap({
    turn: 5,
    vision: v,
    currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS,
    marketGrowthEvidence: { recentOwnContractGrowthRatio: 0.05, observedMarketGrowthRatio: 0.05 },
    capexParams: longLeadParams,
  });
  assert.ok(long.forecastCompletionTurn > short.forecastCompletionTurn);
  assert.ok(long.forwardCapacityGapTons > short.forwardCapacityGapTons, "リードタイムが長いほど完成時点の想定規模が伸び、gapも大きくなる");
});

// ---------------------------------------------------------------------
// STRAT-8: Vision単独の楽観だけでは動かない（観測できる成長根拠が無ければ抑制される）
// ---------------------------------------------------------------------
test("STRAT-8: Vision参考軌道は伸びていても、観測できる自社・市場成長根拠がどちらも無ければ、Vision単独の楽観だけではgapが生じず先行着工しない", () => {
  // 【gap算定式そのものが評価根拠の要求を内包する】trendAdjustedScaleAtCompletionは
  // observedGrowthRatioPerQuarter（自社成長・観測市場成長のmin）が0なら現在規模のまま
  // 伸びない。min(visionReference, trendAdjusted)を取るため、観測できる成長根拠が
  // 無ければVisionがどれだけ楽観的でもforwardCapacityGapTonsは0を超えない
  // （設計文書§5.2「支持されなければならない」）。
  const v = vision("AGGRESSIVE_EARLY_CAPACITY");
  const gapWithoutEvidence = computeForwardCapacityGap({
    turn: 5,
    vision: v,
    currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS,
    marketGrowthEvidence: { recentOwnContractGrowthRatio: null, observedMarketGrowthRatio: null },
    capexParams: CAPEX_PARAMETERS_V1,
  });
  assert.equal(gapWithoutEvidence.observedGrowthRatioPerQuarter, 0);
  assert.equal(gapWithoutEvidence.forwardCapacityGapTons, 0, "観測できる成長根拠が無ければ、Vision参考軌道がどれだけ伸びていてもgapは生じない");

  const r = evaluateNewFactoryDecision(
    aggressiveInput({
      commercialAmbition: commercialAmbition(1.0),
      unservedOpportunity: unservedOpportunity(0),
      persistentCapacityCausedUnserved: false,
    })
  );
  assert.notEqual(r.assessment.status, "READY_TO_BUILD");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT"));
});

// ---------------------------------------------------------------------
// STRAT-9: TRUE未来情報は一切引数に存在しない（限定合理性の型レベル保証）
// ---------------------------------------------------------------------
test("STRAT-9: Forward Capacity Gapの入力は観測可能な値だけで構成され、同一入力なら常に同一結果になる（未来を読んでいない）", () => {
  const v = vision("AGGRESSIVE_EARLY_CAPACITY");
  const input = {
    turn: 5,
    vision: v,
    currentSustainableScaleTons: CURRENT_SUSTAINABLE_SCALE_TONS,
    marketGrowthEvidence: { recentOwnContractGrowthRatio: 0.05, observedMarketGrowthRatio: 0.05 },
    capexParams: CAPEX_PARAMETERS_V1,
  };
  // ForwardCapacityGapInputには turn/vision/currentSustainableScaleTons/marketGrowthEvidence/capexParams/horizonTurn
  // 以外のフィールドが存在しない（シナリオの将来イベント・TRUE需要・TRUE価格を渡す余地が無い）。
  assert.deepEqual(Object.keys(input).sort(), ["capexParams", "currentSustainableScaleTons", "marketGrowthEvidence", "turn", "vision"].sort());
  const a = computeForwardCapacityGap(input);
  const b = computeForwardCapacityGap(input);
  assert.deepEqual(a, b, "同じ観測値からは常に同じ結果になる純粋関数である");
});

// ---------------------------------------------------------------------
// STRAT-10/11: 既存増設で足りるかどうかで、先行着工の要否が変わる
// ---------------------------------------------------------------------
test("STRAT-10: 既存工場の増設余地が十分で、志との差もまだ小さければ、先行して新工場は建てない", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput({ observation: observation({ factorySpaceRemainingUnits: 10_000 }) }));
  assert.equal(r.assessment.status, "DEFERRED");
  assert.equal(r.assessment.decisionRoute, "NONE");
  assert.ok(r.assessment.reasonCodes.includes("NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT"));
  assert.ok(r.assessment.existingExpansionAlternativeSufficientTons !== null);
});

test("STRAT-11: 既存増設だけでは解消できない規模のgapなら、新工場の先行着工に進む", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput({ observation: observation({ factorySpaceRemainingUnits: 500 }) }));
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.existingExpansionAlternativeSufficientTons, null);
});

// ---------------------------------------------------------------------
// STRAT-12: 完成後の稼働化可能性（空箱化リスク）も見ている
// ---------------------------------------------------------------------
test("STRAT-12: 先行着工の提案には、完成後の稼働化可能性（postConstructionActivationFeasible）の判定が伴う", () => {
  const r = evaluateNewFactoryDecision(aggressiveInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  assert.equal(r.assessment.postConstructionActivationFeasible, true);
  assert.ok(r.assessment.gates.some((g) => g.gate === "STRATEGIC_ACTIVATION_FEASIBILITY" && g.passed));
});

// ---------------------------------------------------------------------
// STRAT-13: このAIは未来を知らない以上、成長を見誤って過剰投資になりうる
// ---------------------------------------------------------------------
test("STRAT-13: strategic routeは観測できる成長根拠だけで判断する。将来その根拠が外れて過剰能力になっても、判断の入力にはシナリオの真の需要が存在しない（意図された限定合理性）", () => {
  // 観測できる根拠（自社成約成長・能力起因の未充足）が実際にはそろっているケースを、
  // 「その後シナリオがどう転んだか」を一切参照せず提案することを確認する。
  const r = evaluateNewFactoryDecision(aggressiveInput());
  assert.equal(r.assessment.status, "READY_TO_BUILD");
  // NewFactoryDecisionInputにシナリオ将来イベント・TRUE需要を渡すフィールドは存在しない
  // （型定義そのものが保証。STRAT-9と同じ設計）。
  assert.equal(r.assessment.decisionRoute, "STRATEGIC_FORWARD_CAPACITY");
});

// ---------------------------------------------------------------------
// STRAT-14: 同じ観測状態でも、Strategic Postureが違えば投資タイミングが変わる
// ---------------------------------------------------------------------
test("STRAT-14: 同一の観測状態でも、AGGRESSIVE_EARLY_CAPACITYは先行着工し、DEMAND_CONFIRMEDは着工しない（異なる賭けをする）", () => {
  const aggressive = evaluateNewFactoryDecision(aggressiveInput());
  const conservative = evaluateNewFactoryDecision(aggressiveInput({ vision: vision("DEMAND_CONFIRMED") }));
  assert.equal(aggressive.assessment.status, "READY_TO_BUILD");
  assert.notEqual(conservative.assessment.status, "READY_TO_BUILD");
  assert.equal(aggressive.assessment.decisionRoute, "STRATEGIC_FORWARD_CAPACITY");
  assert.equal(conservative.assessment.decisionRoute, "NONE");
});

// ---------------------------------------------------------------------
// STRAT-15: trace（診断エントリ）にroute・forward gapが残る
// ---------------------------------------------------------------------
test("STRAT-15: assessmentのtraceに decisionRoute と forwardCapacityGap が残り、reactiveだけの会社ではnullになる", () => {
  const strategic = evaluateNewFactoryDecision(aggressiveInput());
  assert.equal(strategic.assessment.decisionRoute, "STRATEGIC_FORWARD_CAPACITY");
  assert.ok(strategic.assessment.forwardCapacityGap);
  assert.ok(strategic.assessment.marketGrowthEvidence);
  assert.equal(strategic.assessment.strategicPosture, "AGGRESSIVE_EARLY_CAPACITY");

  const reactiveOnly = evaluateNewFactoryDecision(aggressiveInput({ vision: vision("DEMAND_CONFIRMED") }));
  assert.equal(reactiveOnly.assessment.decisionRoute, "NONE");
  assert.equal(reactiveOnly.assessment.forwardCapacityGap, null);
  assert.equal(reactiveOnly.assessment.marketGrowthEvidence, null);
});
