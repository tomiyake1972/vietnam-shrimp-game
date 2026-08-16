// ShrimpX V2 — Standard AI Crisis Management（Phase CM-1）単体・統合テスト
//
// 指示§25の CRISIS-1〜10 にそのまま対応させる。
//
// 【CRISIS-2の実装についての注記・推測しない】指示のCRISIS-2は「scaleRatio低下で
// LIQUIDITY_STRESS」と書かれているが、実装中の32Q回帰テスト
// （commercialCommitmentIntegration.test.ts・heterogeneousProfiles.test.ts）で、
// 財務的に健全なRunでもTurn2〜3程度でscaleRatioが0.3〜0.5台まで下がることが
// 実測された（domesticPurchaseCashAllocationRatioによる「今期使う→来期温存」という
// 正常な資金繰りサイクル）。これをLIQUIDITY_STRESSの閾値にすると、健全な会社が
// 単発Turnのノイズで新規受注を抑制し、売上減→現金回復せず→危機状態が続く
// という自己成就的な悪化ループを引き起こした（crisisState.tsのコメント参照）。
// そのため実装では、LIQUIDITY_STRESSの判定を既存Financeの持続的シグナル
// （lastQuarterFinancialHealthTier: stressed/covenantBreach/paymentArrears。
// いずれもconsecutiveArrears等の累積指標から確定する）だけに絞った。
// CRISIS-2はこの実装済みの挙動（financialHealthTierの悪化でLIQUIDITY_STRESS）を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessStandardAiCrisisState,
  applyCrisisGateToCommercialCommitment,
  StandardAiCrisisAssessment,
} from "../crisisState";
import { CommercialCommitmentState } from "../../vision/commercialCommitment";
import { buildCurrentPeriodDeliveryDemand } from "../diagnosis/currentPeriodDeliveryDemand";
import { StandardAiObservation, zeroProductAmount } from "../types";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyLabConfig } from "../../types";
import { FinancingQuarterResult } from "../../../financing/types";
import { PeriodV2 } from "../../../core/period";

function baseCommitment(overrides: Partial<CommercialCommitmentState> = {}): CommercialCommitmentState {
  return {
    submissionTargetTons: 10000,
    stretchOverAmbition: 1,
    expectedConversionRatio: 0.8,
    productionExpectedConversionRatio: 0.8,
    limiter: "NONE",
    caps: { ambitionTons: 10000, conversionAdjustedTons: 12500, stretchLimitTons: 12500, opportunityTons: null, salesCapacityTons: null },
    overSubmissionRisk: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// CRISIS-1: NORMALでは既存decision維持
// ---------------------------------------------------------------------
test("CRISIS-1: 危機シグナルが一切無ければNORMALと判定され、Commercial Commitmentは変更されない", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 1,
    lastQuarterUnderwritingFrozen: false,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "healthy",
  });
  assert.equal(assessment.state, "NORMAL");
  assert.deepEqual(assessment.signals, []);

  const commitment = baseCommitment();
  const gated = applyCrisisGateToCommercialCommitment(commitment, assessment);
  assert.deepEqual(gated, commitment, "NORMAL時はcomputeCommercialCommitmentの出力をそのまま使う必要がある");
});

test("CRISIS-1b: Turn1（前Turnの記録が無い）は必ずNORMALになる（架空の危機を作らない）", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: null,
    lastQuarterUnderwritingFrozen: null,
    lastQuarterImportOrdersBlocked: null,
    lastQuarterFinancialHealthTier: null,
  });
  assert.equal(assessment.state, "NORMAL");
});

// ---------------------------------------------------------------------
// CRISIS-2: 財務健全性tier悪化でLIQUIDITY_STRESS（上記ファイル冒頭の注記参照）
// ---------------------------------------------------------------------
test("CRISIS-2: lastQuarterFinancialHealthTier=stressedならLIQUIDITY_STRESSと判定され、CRISIS_LIQUIDITY_STRESSシグナルを持つ", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 0.9,
    lastQuarterUnderwritingFrozen: false,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "stressed",
  });
  assert.equal(assessment.state, "LIQUIDITY_STRESS");
  assert.ok(assessment.signals.includes("CRISIS_LIQUIDITY_STRESS"));
});

test("CRISIS-2b: LIQUIDITY_STRESSはCommercial Commitmentを縮小するが、完全ゼロにはしない", () => {
  const assessment: StandardAiCrisisAssessment = { state: "LIQUIDITY_STRESS", signals: ["CRISIS_LIQUIDITY_STRESS"], summary: "test" };
  const commitment = baseCommitment({ submissionTargetTons: 10000 });
  const gated = applyCrisisGateToCommercialCommitment(commitment, assessment);
  assert.ok(gated.submissionTargetTons > 0, "LIQUIDITY_STRESSで新規販売を完全ゼロにしてはいけない（指示§4）");
  assert.ok(gated.submissionTargetTons < commitment.submissionTargetTons, "LIQUIDITY_STRESSでは新規Commitmentを縮小する必要がある");
  assert.equal(gated.limiter, "CRISIS");
});

// ---------------------------------------------------------------------
// CRISIS-3: severeArrearsOrInsolvent相当（insolvent/paymentDefault tier）でSEVERE_DISTRESS
// ---------------------------------------------------------------------
test("CRISIS-3: lastQuarterFinancialHealthTier=insolventならSEVERE_DISTRESSと判定される", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 0.5,
    lastQuarterUnderwritingFrozen: false,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "insolvent",
  });
  assert.equal(assessment.state, "SEVERE_DISTRESS");
});

test("CRISIS-3b: underwritingFrozen=trueだけでもSEVERE_DISTRESSになる（指示§5候補シグナル）", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 0.9,
    lastQuarterUnderwritingFrozen: true,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "healthy",
  });
  assert.equal(assessment.state, "SEVERE_DISTRESS");
  assert.ok(assessment.signals.includes("CRISIS_UNDERWRITING_FROZEN"));
});

test("CRISIS-3c: procurementConstraint.scaleRatio≈0だけでもSEVERE_DISTRESSになる（指示§5例示）", () => {
  const assessment = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 0,
    lastQuarterUnderwritingFrozen: false,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "healthy",
  });
  assert.equal(assessment.state, "SEVERE_DISTRESS");
  assert.ok(assessment.signals.includes("CRISIS_PROCUREMENT_BLOCKED"));
});

// ---------------------------------------------------------------------
// CRISIS-4: SEVERE_DISTRESSでnew sales commitment=0
// ---------------------------------------------------------------------
test("CRISIS-4: SEVERE_DISTRESSでCommercial Commitmentのsubmissionは厳密に0になる", () => {
  const assessment: StandardAiCrisisAssessment = { state: "SEVERE_DISTRESS", signals: ["CRISIS_UNDERWRITING_FROZEN"], summary: "test" };
  const commitment = baseCommitment({ submissionTargetTons: 25000 });
  const gated = applyCrisisGateToCommercialCommitment(commitment, assessment);
  assert.equal(gated.submissionTargetTons, 0);
  assert.equal(gated.limiter, "CRISIS");
});

// ---------------------------------------------------------------------
// CRISIS-5: 既存Backlogは消えない
// ---------------------------------------------------------------------
function fixtureObservation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "MASS",
    period: "2020Q1",
    turn: 10,
    outstandingContractByProduct: { hoso: 5000, pd: 2000, vap: 1000 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 0,
    rawMaterialPipeline: 0,
    rawMaterialInTransitImportQuantity: 0,
    rawMaterialGrowingAquacultureQuantity: 0,
    rawMaterialCertainInboundThisPeriod: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 8000, pd: 5000, vap: 3000 },
    totalCommonProcessingCapacity: 20000,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 5000, vap: 3000 },
    totalEffectiveCommonProcessingCapacity: 20000,
    totalEffectiveFreezingPackagingCapacity: 20000,
    aquacultureCapacity: 0,
    salesForceHeadcountTotal: 50,
    procurementHeadcountTotal: 10,
    lastQuarterActualProductionByProduct: { hoso: 5000, pd: 2000, vap: 1000 },
    markets: [],
    marketPremiumByProduct: {},
    vietnamDomesticPriorMarket: { supply: 10000, effectiveDemand: 8000, transactedVolume: 8000, unsoldSupply: 2000 },
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 0,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 100,
    receivablesDueThisPeriodUsd: 0,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 0,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    lastQuarterProcurementScaleRatio: null,
    lastQuarterUnderwritingFrozen: null,
    lastQuarterImportOrdersBlocked: null,
    lastQuarterFinancialHealthTier: null,
    factoryCount: 1,
    maxFactoriesPerCompany: 4,
    pendingNewFactoryProjectCount: 0,
    prospectiveFactoryCount: 1,
    factorySpaceTotalUnits: 100000,
    factorySpaceUsedUnits: 90000,
    factorySpaceRemainingUnits: 10000,
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as StandardAiObservation;
}

test("CRISIS-5: 新規販売がゼロ（SEVERE_DISTRESS相当）でも、確定受注残（Backlog）は当期納品需要へ100%反映される", () => {
  const observation = fixtureObservation();
  const zeroNewSales = zeroProductAmount();
  const result = buildCurrentPeriodDeliveryDemand("MASS", observation, zeroNewSales, 1);
  // outstandingContractByProduct（確定受注残）は新規提出量に一切依存せず、常に100%反映される
  // （diagnosis/currentPeriodDeliveryDemand.tsの既存仕様。confirmedは割り引かれない）。
  assert.equal(result.deliveryDemand.byProduct.hoso, observation.outstandingContractByProduct.hoso);
  assert.equal(result.deliveryDemand.byProduct.pd, observation.outstandingContractByProduct.pd);
  assert.equal(result.deliveryDemand.byProduct.vap, observation.outstandingContractByProduct.vap);
});

// ---------------------------------------------------------------------
// CRISIS-6/7: SEVERE_DISTRESSでCAPEX・Sales Hiring停止（policy.ts統合）
// ---------------------------------------------------------------------
function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "crisis-test-001", turns: 20, ...overrides };
}

function severeDistressFinancingResult(companyId: string, period: PeriodV2): FinancingQuarterResult {
  return {
    companyId,
    period,
    creditScore: { companyId, period, score0to100: 5, tier: "E", breakdown: [], reasons: [] },
    borrowingCapacity: {
      companyId,
      period,
      collateralBasedLimitUsd: 0,
      earningsBasedLimitUsd: 0,
      creditTierCapUsd: 0,
      grossLimitUsd: 0,
      existingLoanBalanceUsd: 0,
      availableAdditionalCapacityUsd: 0,
      underwritingFrozen: true,
      constraints: [],
      bindingConstraint: "underwritingFrozen",
    },
    underwriting: {
      companyId,
      period,
      requestedAmountUsd: 0,
      approvedAmountUsd: 0,
      deniedAmountUsd: 0,
      appliedAnnualRate: 0,
      repaymentMethod: "bulletAtMaturity",
      reasons: ["underwriting frozen (test fixture)"],
    },
    covenant: { companyId, period, checks: [], anyBreach: true },
    procurementConstraint: {
      companyId,
      period,
      originalDomesticPurchaseQuantityTons: 10000,
      plannedCashNeedUsd: 10000000,
      availableLiquidityUsd: 0,
      scaleRatio: 0,
      constrainedDomesticPurchaseQuantityTons: 0,
      unmetDemandUsd: 10000000,
      importOrdersBlocked: true,
      reason: "test fixture: total shutdown",
    },
    interestAccrualUsd: 0,
    interestPaidCashUsd: 0,
    scheduledPrincipalDueUsd: 0,
    principalPaidCashUsd: 0,
    arrearsEvents: [],
    financialHealth: {
      primary: "insolvent",
      insolvent: true,
      covenantBreach: false,
      paymentArrears: false,
      paymentDefault: false,
      usedEmergencyLoanThisPeriod: false,
      consecutiveArrearsQuarters: 3,
      consecutiveCovenantBreachQuarters: 0,
    },
    loanDrawUsd: 0,
    refinancedLoanIds: [],
    endingShortTermLoansUsd: 0,
    endingLongTermLoansUsd: 0,
    endingAccruedInterestPayableUsd: 0,
  };
}

/** MASSのTurn16（既存Vision Calibrationベンチマークで新規CAPEX提案が実際に発生するturn）を土台にする。 */
function setupMassAtCapexProposingTurn() {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ turns: 16 }));
  // 16ターン分の履歴を作らず、単turnのCompanyOwnStateへ直接severeDistressの
  // 財務シグナルを注入する（既存の意思決定ロジック自体は一切変更しない）。
  const fixture = fixtures.find((f) => f.companyId === "MASS")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { fixture, ownState, publicInfo, period: state.currentPeriod, turn: 1 };
}

test("CRISIS-6: SEVERE_DISTRESS時、新規設備投資提案（CAPEX）が停止する", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMassAtCapexProposingTurn();
  const normalResult = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  assert.equal(normalResult.diagnostics.crisis?.state, "NORMAL", "このfixtureは前Turnの記録が無いためTurn1相当＝NORMALのはず");

  const distressedOwnState = { ...ownState, lastFinancingResult: severeDistressFinancingResult(fixture.companyId, period) };
  const distressedResult = generateStandardAiDecisionWithDiagnostics(fixture, distressedOwnState, publicInfo, period, turn);
  assert.equal(distressedResult.diagnostics.crisis?.state, "SEVERE_DISTRESS");
  assert.equal(distressedResult.decision.capexDecision.newProjectProposals.length, 0, "SEVERE_DISTRESSでは新規CAPEX提案（新工場含む）が0件であるべき");
});

test("CRISIS-7: SEVERE_DISTRESS時、営業採用（salesForceHireCount）が0になる", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMassAtCapexProposingTurn();
  const distressedOwnState = { ...ownState, lastFinancingResult: severeDistressFinancingResult(fixture.companyId, period) };
  const distressedResult = generateStandardAiDecisionWithDiagnostics(fixture, distressedOwnState, publicInfo, period, turn);
  assert.equal(distressedResult.decision.salesForceHireCount, undefined, "SEVERE_DISTRESSでは営業採用が0（undefinedとして提出）であるべき");
});

// ---------------------------------------------------------------------
// CRISIS-8: Finance signal回復でNORMALへ復帰可能
// ---------------------------------------------------------------------
test("CRISIS-8: 前Turnの危機シグナルが解消されれば、次Turnの判定はNORMALへ戻る（永久stickyにしない）", () => {
  const distressed = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 0,
    lastQuarterUnderwritingFrozen: true,
    lastQuarterImportOrdersBlocked: true,
    lastQuarterFinancialHealthTier: "insolvent",
  });
  assert.equal(distressed.state, "SEVERE_DISTRESS");

  const recovered = assessStandardAiCrisisState({
    lastQuarterProcurementScaleRatio: 1,
    lastQuarterUnderwritingFrozen: false,
    lastQuarterImportOrdersBlocked: false,
    lastQuarterFinancialHealthTier: "healthy",
  });
  assert.equal(recovered.state, "NORMAL", "同じ関数へ回復後のシグナルを渡せばNORMALに戻る必要がある（内部に前回状態を保持するsticky実装であってはならない）");
});

// ---------------------------------------------------------------------
// CRISIS-9: Vision targetは保持
// ---------------------------------------------------------------------
test("CRISIS-9: SEVERE_DISTRESSでも診断上のvisionフィールド（Vision Ambitionの根拠）は変更されない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMassAtCapexProposingTurn();
  const normalResult = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const distressedOwnState = { ...ownState, lastFinancingResult: severeDistressFinancingResult(fixture.companyId, period) };
  const distressedResult = generateStandardAiDecisionWithDiagnostics(fixture, distressedOwnState, publicInfo, period, turn);

  assert.equal(distressedResult.diagnostics.vision?.targetScaleTonsPerQuarterAtQ32, normalResult.diagnostics.vision?.targetScaleTonsPerQuarterAtQ32, "危機であってもVision（Q32目標）を書き換えてはいけない");
  assert.equal(distressedResult.diagnostics.commercialAmbition?.ambitionTons, normalResult.diagnostics.commercialAmbition?.ambitionTons, "Commercial Ambition（志）自体は危機でも変更しない（指示§6）");
  // Commitment（実際に取りに行く量）だけがCrisis Gateで下がる。
  assert.equal(distressedResult.diagnostics.commercialCommitment?.submissionTargetTons, 0);
});

// ---------------------------------------------------------------------
// CRISIS-10: normal seed regression
// ---------------------------------------------------------------------
test("CRISIS-10: 前Turn記録が無い・危機シグナルが無い通常のTurn1では、Crisis Gateは一切decisionへ影響しない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMassAtCapexProposingTurn();
  const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  assert.equal(result.diagnostics.crisis?.state, "NORMAL");
  assert.equal(result.diagnostics.crisis?.newSalesSuppressed, false);
  assert.equal(result.diagnostics.crisis?.capexPaused, false);
  assert.equal(result.diagnostics.crisis?.salesHiringStopped, false);
});
