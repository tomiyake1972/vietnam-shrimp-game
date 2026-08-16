// ShrimpX V2 — Strategy Profile Quantification（Phase SP-Q1）単体・統合テスト
//
// 指示§28の SPQ1-1〜9 にそのまま対応させる。既存ManagementProfile（SAI-4）・
// CompanyOrientationProfile（SAI-5A）の値そのものは今回変更しない（監査のみ）。
// 検証するのは「本番経路（simulation/engine.ts）へ正しく接続されたか」であり、
// Profile値自体の妥当性ではない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStandardAiProfileForMode } from "../orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { CompanyLabConfig } from "../../types";
import { FinancingQuarterResult } from "../../../financing/types";
import { PeriodV2 } from "../../../core/period";
import { CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../../../capex/types";
import { STANDARD_AI_PROPOSABLE_CAPEX_TYPES } from "../decision/capex";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { CompanyId } from "../../../sales/types";

const AT = "2026-01-01T00:00:00.000Z";
const COMPANIES: readonly CompanyId[] = ["MASS", "BAL", "JPQ", "CONSV", "VAP"];

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "spq1-test-001", turns: 8, ...overrides };
}

// ---------------------------------------------------------------------
// SPQ1-1: company profile resolves correctly
// ---------------------------------------------------------------------
test("SPQ1-1: 会社IDから既存ManagementProfile/OrientationProfileが正しく解決される（値は変更しない、既存値をそのまま確認）", () => {
  const expected: Record<string, { management: string; orientation: string }> = {
    BAL: { management: "balanced", orientation: "balancedGeneralist" },
    MASS: { management: "growth", orientation: "chinaVolume" },
    JPQ: { management: "opportunistic", orientation: "japanQuality" },
    VAP: { management: "valueAdded", orientation: "usProcessedGrowth" },
    CONSV: { management: "conservative", orientation: "europePdConservative" },
  };
  for (const companyId of COMPANIES) {
    const resolution = resolveStandardAiProfileForMode(companyId, "ON");
    assert.equal(resolution.managementProfileId, expected[companyId].management, `${companyId}のManagementProfile`);
    assert.equal(resolution.orientationProfileId, expected[companyId].orientation, `${companyId}のOrientationProfile`);
  }
  // BAL（balanced）はゼロバイアスプロファイルなので、appliedBiasItemsは空のはず。
  const bal = resolveStandardAiProfileForMode("BAL", "ON");
  assert.deepEqual(bal.appliedBiasItems, [], "BALはbalanced+balancedGeneralistでバイアスゼロ");
  // MASS（growth）は非ゼロバイアスを持つはず。
  const mass = resolveStandardAiProfileForMode("MASS", "ON");
  assert.ok(mass.appliedBiasItems.length > 0, "MASSはgrowthプロファイルで非ゼロバイアスを持つはず");
});

// ---------------------------------------------------------------------
// SPQ1-2: engine passes profile into Standard AI
// ---------------------------------------------------------------------
test("SPQ1-2: simulation/engine.tsがstandardAiProfileMode=ONの時、会社別paramsをStandard AIへ渡す", () => {
  let session = createSimulationSession({
    simulationRunId: "spq1-2",
    scenarioId: "baseline",
    seed: "spq1-2-seed",
    requestedTurns: 3,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });
  const outcome = advanceSimulationTurn(session, AT);
  assert.ok(outcome.advanced, "Turn1が正常に進行すること");
  session = outcome.session;
  const massStrategy = session.packCompanyTurns.find((c) => c.companyId === "MASS" && c.turn === 1)?.strategy;
  assert.ok(massStrategy?.profile, "MASSのPackStrategy.profileが記録されていること");
  assert.equal(massStrategy?.profile?.mode, "ON");
  assert.equal(massStrategy?.profile?.managementProfileId, "growth");
  assert.equal(massStrategy?.profile?.orientationProfileId, "chinaVolume");
  assert.ok((massStrategy?.profile?.appliedBiasItems.length ?? 0) > 0, "MASSはgrowthプロファイルでバイアスが適用されているはず");
});

// ---------------------------------------------------------------------
// SPQ1-3: OFF produces zero bias
// ---------------------------------------------------------------------
test("SPQ1-3: standardAiProfileMode未指定（=OFF）は、paramsがSTANDARD_AI_PARAMETERS_V1と参照レベルで同一になる（ビット単位で従来挙動と一致）", () => {
  const offResolution = resolveStandardAiProfileForMode("MASS", undefined);
  assert.equal(offResolution.mode, "OFF");
  assert.equal(offResolution.params, STANDARD_AI_PARAMETERS_V1, "OFF時のparamsはSTANDARD_AI_PARAMETERS_V1そのもの（同一オブジェクト参照）であるべき");
  assert.deepEqual(offResolution.appliedBiasItems, []);

  const explicitOff = resolveStandardAiProfileForMode("MASS", "OFF");
  assert.equal(explicitOff.params, STANDARD_AI_PARAMETERS_V1, "明示的な'OFF'も未指定と同じ結果になるべき");
});

test("SPQ1-3b: engine.tsでstandardAiProfileMode未指定の場合、PackStrategy.profileはOFF・バイアスゼロのまま記録される", async () => {
  let session = createSimulationSession({
    simulationRunId: "spq1-3b",
    scenarioId: "baseline",
    seed: "spq1-3b-seed",
    requestedTurns: 2,
    startedAt: AT,
    // standardAiProfileMode未指定
  });
  const outcome = advanceSimulationTurn(session, AT);
  assert.ok(outcome.advanced);
  session = outcome.session;
  for (const companyId of COMPANIES) {
    const strategy = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === 1)?.strategy;
    assert.equal(strategy?.profile?.mode, "OFF", `${companyId}はmode未指定なのでOFFのはず`);
    assert.deepEqual(strategy?.profile?.appliedBiasItems, [], `${companyId}はOFFなのでappliedBiasItemsは空のはず`);
  }
});

// ---------------------------------------------------------------------
// SPQ1-4: ON uses company-specific profile
// ---------------------------------------------------------------------
test("SPQ1-4: mode=ONでは会社ごとに異なるparamsが解決される（会社差が実際に生まれる）", () => {
  const mass = resolveStandardAiProfileForMode("MASS", "ON");
  const consv = resolveStandardAiProfileForMode("CONSV", "ON");
  const bal = resolveStandardAiProfileForMode("BAL", "ON");
  assert.notEqual(mass.params.salesUtilizationTarget, consv.params.salesUtilizationTarget, "MASS(growth)とCONSV(conservative)のsalesUtilizationTargetは異なるはず");
  assert.notDeepEqual(mass.params.productOrientationMultipliers, consv.params.productOrientationMultipliers, "商品志向倍率も会社ごとに異なるはず");
  // BALはゼロバイアスなので基準値と一致するはず。
  assert.equal(bal.params.salesUtilizationTarget, STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget, "BAL(balanced)は基準値と一致するはず");
});

// ---------------------------------------------------------------------
// SPQ1-5 / SPQ1-6: Vision / Strategic Posture unaffected
// ---------------------------------------------------------------------
test("SPQ1-5・SPQ1-6: Profile ON/OFFはVision（規模目標）とStrategic Postureへ一切影響しない", () => {
  let offSession = createSimulationSession({
    simulationRunId: "spq1-56-off",
    scenarioId: "baseline",
    seed: "spq1-56-seed",
    requestedTurns: 2,
    startedAt: AT,
    standardAiProfileMode: "OFF",
  });
  let onSession = createSimulationSession({
    simulationRunId: "spq1-56-on",
    scenarioId: "baseline",
    seed: "spq1-56-seed",
    requestedTurns: 2,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });
  const offOutcome = advanceSimulationTurn(offSession, AT);
  const onOutcome = advanceSimulationTurn(onSession, AT);
  assert.ok(offOutcome.advanced && onOutcome.advanced);
  offSession = offOutcome.session;
  onSession = onOutcome.session;
  for (const companyId of COMPANIES) {
    const offVision = offSession.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === 1)?.strategy.vision;
    const onVision = onSession.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === 1)?.strategy.vision;
    assert.equal(onVision?.targetScaleTonsPerQuarterAtQ32, offVision?.targetScaleTonsPerQuarterAtQ32, `${companyId}のVision規模目標はProfile ON/OFFで不変であるべき`);
    assert.equal(onVision?.strategicPosture, offVision?.strategicPosture, `${companyId}のStrategic PostureはProfile ON/OFFで不変であるべき`);
    assert.equal(onVision?.growthAmbition, offVision?.growthAmbition, `${companyId}のgrowthAmbitionはProfile ON/OFFで不変であるべき（Visionのフィールドであり、Profileが上書きしてはいけない）`);
  }
});

// ---------------------------------------------------------------------
// SPQ1-7: Crisis Gate dominates severe distress
// ---------------------------------------------------------------------
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

test("SPQ1-7: SEVERE_DISTRESS下では、Profile=ON（growthプロファイルで積極的なMASS）でも新規CAPEX・新規受注は強制的に停止する（CM-1のCrisis Gateが優先）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ turns: 16 }));
  const fixture = fixtures.find((f) => f.companyId === "MASS")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const period = state.currentPeriod;
  const turn = 1;

  const massProfile = resolveStandardAiProfileForMode("MASS", "ON");
  assert.ok(massProfile.appliedBiasItems.length > 0, "前提: MASSのgrowthプロファイルは非ゼロバイアスを持つ");

  const distressedOwnState = { ...ownState, lastFinancingResult: severeDistressFinancingResult(fixture.companyId, period) };
  const distressedResult = generateStandardAiDecisionWithDiagnostics(fixture, distressedOwnState, publicInfo, period, turn, massProfile.params);
  assert.equal(distressedResult.diagnostics.crisis?.state, "SEVERE_DISTRESS");
  assert.equal(distressedResult.decision.capexDecision.newProjectProposals.length, 0, "Profile=ONでもSEVERE_DISTRESSでは新規CAPEXが0件であるべき（Crisis GateはProfileより下位ではなく優先度が高い）");
  assert.equal(distressedResult.decision.salesForceHireCount, undefined, "Profile=ONでもSEVERE_DISTRESSでは営業採用が0であるべき");
});

// ---------------------------------------------------------------------
// SPQ1-8: profile cannot create unsupported CAPEX type
// ---------------------------------------------------------------------
test("SPQ1-8: Profile=ONでも、Standard AIが提案するCAPEX種別はSTANDARD_AI_PROPOSABLE_CAPEX_TYPESの範囲内に留まる（PD Mechanization等の新capabilityは生まれない）", async () => {
  let session = createSimulationSession({
    simulationRunId: "spq1-8",
    scenarioId: "global-demand-boom",
    seed: "spq1-8-seed",
    requestedTurns: 10,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });
  const observedTypes = new Set<CapitalProjectType>();
  for (let i = 0; i < 10; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced, `Turn${i + 1}が正常に進行すること`);
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];
    for (const decision of record.decisions) {
      for (const proposal of decision.capexDecision.newProjectProposals) {
        observedTypes.add(proposal.projectType);
      }
    }
  }
  for (const t of observedTypes) {
    assert.ok(STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes(t), `Standard AIが提案した${t}はSTANDARD_AI_PROPOSABLE_CAPEX_TYPESに含まれているべき`);
  }
  // 明示的にPD Mechanization等が一度も提案されないことも確認する（SP-A1監査で確認済みの構造的不在を、Profile接続後も再確認）。
  const forbidden: readonly CapitalProjectType[] = CAPITAL_PROJECT_TYPES.filter((t) => !STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes(t));
  for (const t of forbidden) {
    assert.ok(!observedTypes.has(t), `${t}はStandard AIに候補生成関数が無いため、Profile接続後も一度も提案されないはず`);
  }
});

// ---------------------------------------------------------------------
// SPQ1-9: normal deterministic reproducibility
// ---------------------------------------------------------------------
test("SPQ1-9: 同一scenario/seed/mode=ONを2回実行すると、決定論的に同じ結果になる", () => {
  function runThree(profileMode: "OFF" | "ON") {
    let session = createSimulationSession({
      simulationRunId: `spq1-9-${profileMode}`,
      scenarioId: "baseline",
      seed: "spq1-9-seed",
      requestedTurns: 3,
      startedAt: AT,
      standardAiProfileMode: profileMode,
    });
    for (let i = 0; i < 3; i++) {
      const outcome = advanceSimulationTurn(session, AT);
      assert.ok(outcome.advanced);
      session = outcome.session;
    }
    const record = session.state.history[session.state.history.length - 1];
    return record.decisions.find((d) => d.companyId === "MASS")?.salesPlans;
  }
  const runA = runThree("ON");
  const runB = runThree("ON");
  assert.deepEqual(runA, runB, "同一入力なら決定論的に同じ意思決定になるべき（Date.now/Math.randomをゲーム判断へ渡していない）");
});
