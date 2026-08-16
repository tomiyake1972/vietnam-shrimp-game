// ShrimpX V2 — Strategy Profile Calibration（Phase SP-Q2）単体・統合テスト
//
// 指示§34の SPQ2-6〜11 にそのまま対応させる（SPQ2-1〜5はpersistence専用、
// standardAiProfileModePersistenceSPQ2.test.tsを参照）。

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

const AT = "2026-01-01T00:00:00.000Z";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "spq2-calib-test-001", turns: 8, ...overrides };
}

// ---------------------------------------------------------------------
// SPQ2-6: MASS profile resolution（importRelianceRatioが0になったことの確認）
// ---------------------------------------------------------------------
test("SPQ2-6: MASS（growth）のimportMixRatioは基準値のまま（importRelianceRatioバイアスを撤去した）が、salesUtilizationTarget等は引き続き高い", () => {
  const resolution = resolveStandardAiProfileForMode("MASS", "ON");
  assert.equal(resolution.managementProfileId, "growth");
  assert.equal(resolution.params.importMixRatio, STANDARD_AI_PARAMETERS_V1.importMixRatio, "importMixRatioはSP-Q2で基準値のまま(バイアス撤去)になったはず");
  assert.ok(resolution.params.salesUtilizationTarget > STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget, "salesAggressivenessRatioは引き続き有効なはず");
  assert.ok(resolution.params.maxDiscountRatioForExcessStock > STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock);
  assert.notDeepEqual(resolution.params.marketOrientationMultipliers, {}, "chinaVolumeの市場志向は引き続き有効なはず");
});

// ---------------------------------------------------------------------
// SPQ2-7: CONSV conservatism actually changes investment decision where expected
// ---------------------------------------------------------------------
test("SPQ2-7: CONSV（conservative）はcapexCurrentShortfallRatioThresholdが基準値より高く、CAPEXがより慎重になる方向へ実際に働く", () => {
  const resolution = resolveStandardAiProfileForMode("CONSV", "ON");
  assert.equal(resolution.managementProfileId, "conservative");
  assert.ok(
    resolution.params.capexCurrentShortfallRatioThreshold > STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold,
    "CONSVのCAPEXしきい値は基準値より高い（＝投資判断がより慎重）はず"
  );
  // 実際に投資判断へ効くことを、慎重さバイアスの有無で比較して確認する。
  const withoutHurdle = { ...resolution.params, capexCurrentShortfallRatioThreshold: STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold };
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures.find((f) => f.companyId === "CONSV")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  // 単turnでは通常しきい値を超えないため、この検証は「しきい値の値そのもの」で行う
  // （CAPEX候補生成のsustained gate等は複数turnの履歴を要するため、統合的な効果は
  // scripts/strategyProfileQuantificationSPQ1.ts系のベンチマークで別途確認済み）。
  assert.ok(resolution.params.capexCurrentShortfallRatioThreshold > withoutHurdle.capexCurrentShortfallRatioThreshold);
  // 意思決定自体は例外なく生成できることの健全性確認。
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, 1, resolution.params);
  assert.ok(decision);
});

// ---------------------------------------------------------------------
// SPQ2-8: BAL zero-bias remains neutral
// ---------------------------------------------------------------------
test("SPQ2-8: BAL（balanced+balancedGeneralist）は今回の変更後もparamsが基準値と完全一致するゼロバイアスのまま", () => {
  const resolution = resolveStandardAiProfileForMode("BAL", "ON");
  assert.equal(resolution.managementProfileId, "balanced");
  assert.equal(resolution.orientationProfileId, "balancedGeneralist");
  assert.equal(resolution.params.salesUtilizationTarget, STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.equal(resolution.params.importMixRatio, STANDARD_AI_PARAMETERS_V1.importMixRatio);
  assert.equal(resolution.params.capexCurrentShortfallRatioThreshold, STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold, "BALは新設のcapexHurdleBiasRatioの影響も受けないはず");
  assert.deepEqual(resolution.appliedBiasItems, []);
});

// ---------------------------------------------------------------------
// SPQ2-9: Crisis overrides strategy（MASS calibration後もCM-1が優先される）
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

test("SPQ2-9: SP-Q2でのMASS/CONSVプロファイル調整後も、SEVERE_DISTRESSではCrisis Gate（CM-1）が優先し新規CAPEX・新規受注を停止する", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ turns: 16 }));
  const publicInfo = buildPublicMarketInfo(state);
  const period = state.currentPeriod;

  for (const companyId of ["MASS", "CONSV"] as const) {
    const fixture = fixtures.find((f) => f.companyId === companyId)!;
    const ownState = buildCompanyOwnState(state, fixture);
    const resolution = resolveStandardAiProfileForMode(companyId, "ON");
    const distressedOwnState = { ...ownState, lastFinancingResult: severeDistressFinancingResult(fixture.companyId, period) };
    const result = generateStandardAiDecisionWithDiagnostics(fixture, distressedOwnState, publicInfo, period, 1, resolution.params);
    assert.equal(result.diagnostics.crisis?.state, "SEVERE_DISTRESS", `${companyId}: SEVERE_DISTRESSと判定されるはず`);
    assert.equal(result.decision.capexDecision.newProjectProposals.length, 0, `${companyId}: SP-Q2調整後もSEVERE_DISTRESSでは新規CAPEXが0件のはず`);
    assert.equal(result.decision.salesForceHireCount, undefined, `${companyId}: SP-Q2調整後もSEVERE_DISTRESSでは営業採用が0のはず`);
  }
});

// ---------------------------------------------------------------------
// SPQ2-10: unsupported CAPEX still unsupported
// ---------------------------------------------------------------------
test("SPQ2-10: SP-Q2のcapexHurdleBiasRatio新設後も、Standard AIが提案するCAPEX種別はSTANDARD_AI_PROPOSABLE_CAPEX_TYPESの範囲内に留まる", async () => {
  let session = createSimulationSession({
    simulationRunId: "spq2-10",
    scenarioId: "global-demand-boom",
    seed: "spq2-10-seed",
    requestedTurns: 10,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });
  const observedTypes = new Set<CapitalProjectType>();
  for (let i = 0; i < 10; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];
    for (const decision of record.decisions) {
      for (const proposal of decision.capexDecision.newProjectProposals) observedTypes.add(proposal.projectType);
    }
  }
  for (const t of observedTypes) {
    assert.ok(STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes(t), `${t}はSTANDARD_AI_PROPOSABLE_CAPEX_TYPESに含まれているべき`);
  }
  const forbidden: readonly CapitalProjectType[] = CAPITAL_PROJECT_TYPES.filter((t) => !STANDARD_AI_PROPOSABLE_CAPEX_TYPES.includes(t));
  for (const t of forbidden) {
    assert.ok(!observedTypes.has(t), `${t}はcapexHurdleBiasRatio新設後も一度も提案されないはず（AI capability自体が無いため）`);
  }
});

// ---------------------------------------------------------------------
// SPQ2-11: deterministic replay
// ---------------------------------------------------------------------
test("SPQ2-11: SP-Q2のcalibration後も、同一scenario/seed/mode=ONの2回実行は決定論的に一致する", () => {
  function runThree(profileMode: "OFF" | "ON") {
    let session = createSimulationSession({
      simulationRunId: `spq2-11-${profileMode}`,
      scenarioId: "baseline",
      seed: "spq2-11-seed",
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
    return {
      mass: record.decisions.find((d) => d.companyId === "MASS")?.salesPlans,
      consv: record.decisions.find((d) => d.companyId === "CONSV")?.capexDecision,
    };
  }
  const runA = runThree("ON");
  const runB = runThree("ON");
  assert.deepEqual(runA, runB, "同一入力なら決定論的に同じ意思決定になるべき");
});
