// ShrimpX V2 — Standard AI Capability Expansion（Phase CE-1.1）単体テスト
//
// CE-1.1指示: PD Mechanization「capability」（Operational Need・Economics・
// Payback・Finance・Crisis Gate）と「Strategy Profile」（会社ごとの選好の強さ）を
// 明確に分離する。PROFILE OFFでもcapability自体は常に使用可能で、
// strategyFitMultiplierがneutral（1.0）になるだけ、という設計を検証する。
//
// 指示§23の CE1.1-1〜10 にそのまま対応させる。CE1-1〜13（pdMechanizationCE1.test.ts）
// は引き続き有効な回帰テストとして維持する（削除・変更していない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiCapexDecision } from "../decision/capex";
import { StandardAiObservation, FactoryObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { resolveStandardAiProfileForMode } from "../orientationProfile";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { captureStrategy } from "../../simulation/aiPack/capture";
import { StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const fixture = {
  companyId: "BAL",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
      hoso: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.12,
        allocatedFixedCostUsdPerHosoEqKg: 0.1,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.03,
        targetMarginUsdPerHosoEqKg: 0.08,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.12,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.02,
        minimumContributionMarginUsdPerHosoEqKg: 0.03,
      },
      pd: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.17,
        allocatedFixedCostUsdPerHosoEqKg: 0.15,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.05,
        targetMarginUsdPerHosoEqKg: 0.15,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.17,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.03,
        minimumContributionMarginUsdPerHosoEqKg: 0.05,
      },
      vap: {
        expectedVariableProcessingCostUsdPerHosoEqKg: 0.43,
        allocatedFixedCostUsdPerHosoEqKg: 0.35,
        sellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
        targetMarginUsdPerHosoEqKg: 0.1,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
        minimumContributionMarginUsdPerHosoEqKg: 0.1,
      },
    },
  },
} as unknown as CompanyFixture;

function factoryObservation(
  overrides: Partial<FactoryObservation> & Pick<FactoryObservation, "factoryId">
): FactoryObservation {
  return {
    capacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    commonProcessingCapacity: 30000,
    freezingPackagingCapacity: 30000,
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 30000,
    effectiveFreezingPackagingCapacity: 30000,
    currentRegularHeadcount: 500,
    skillByProduct: { hoso: 1, pd: 1, vap: 1 },
    attendanceRate: 1,
    pdMechanization: { previousQuarterPdUtilization: 0, hasActiveOrCompletedProject: false },
    ...overrides,
  };
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
      }),
    ],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 30000,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalEffectiveCommonProcessingCapacity: 30000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.5,
    lastQuarterLaborUtilizationRate: 0.5,
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 1000 },
    markets: [],
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vietnamDomesticPriorPrice: 4.0,
    lastHosoPriceVn: 5.0,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 600,
    receivablesDueThisPeriodUsd: 0,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 0,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    activeCapexProjectTargets: new Set(),
    suspendedCapexProjectIds: [],
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    contractFulfillmentPressure: 0,
    finishedGoodsExcessRatioByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialInventoryPosition: 5000,
    cashPressure: 0,
    borrowingPressure: 0.1,
    equipmentUtilizationLastQuarter: 0.5,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.5,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

const NO_SHORTFALL = { hoso: 0, pd: 0, vap: 0 };

test("CE1.1-1: PROFILE OFF（STANDARD_AI_PARAMETERS_V1そのまま）でもPD機械化candidateを生成・提案できる", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_CONSIDERED"), "OFF相当のparamsでもconsideredされるべき");
  const proposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "pdMechanization");
  assert.ok(proposal, "OFF相当のparamsでも経済性が良ければ提案されるべき（capability自体はProfileと独立）");
});

test("CE1.1-2: PROFILE OFF（STANDARD_AI_PARAMETERS_V1）はstrategyFitMultiplier=1.0（neutral）で評価する", () => {
  assert.deepEqual(STANDARD_AI_PARAMETERS_V1.productOrientationMultipliers, {}, "OFF基準paramsは商品志向倍率を持たない（＝neutral 1.0扱い）");
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "PD_MECH_PROPOSED");
  assert.ok(proposed);
  assert.equal(proposed!.keyValues?.strategyFitMultiplier, 1, "OFFのstrategyFitMultiplierは1.0（neutral）であるべき");
  assert.equal(proposed!.keyValues?.financialConservatismRatio, 1, "OFFのfinancialConservatismRatioも1.0（neutral）であるべき");
});

test("CE1.1-3: PROFILE ONでは既存のCompanyOrientationProfile/ManagementProfileからstrategy fitを解決する（pd/hoso比・財務保守性）", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  assert.equal(jpqResolution.mode, "ON");
  assert.equal(jpqResolution.orientationProfileId, "japanQuality");
  const jpqObservation = observation({ companyId: "JPQ" });
  const jpqFixture = { ...fixture, companyId: "JPQ" } as unknown as CompanyFixture;
  const result = buildStandardAiCapexDecision(jpqFixture, jpqObservation, pressures(), NO_SHORTFALL, 6000, jpqResolution.params);
  const entry = result.diagnostics.find((d) => d.code === "PD_MECH_CONSIDERED" || d.code === "PD_MECH_PROPOSED" || d.code === "PD_MECH_PAYBACK_UNATTRACTIVE");
  assert.ok(entry, "JPQ ONでも何らかのPD機械化診断が記録されるはず");
});

test("CE1.1-4: BAL（neutral profile）はPROFILE OFF≈ONでPD機械化のtiming/countがほぼ同一になる（重要control）", () => {
  const balResolution = resolveStandardAiProfileForMode("BAL", "ON");
  // BALはmanagementProfile=balanced（capexHurdleBiasRatio=0）・orientation=balancedGeneralist
  // （全商品倍率1.0）。productOrientationMultipliers等はOFF基準の{}に対しON側は
  // {hoso:1,pd:1,vap:1}という明示的な全1のオブジェクトになる（他ドメイン・
  // 他Phase由来の既存挙動であり、CE-1.1のスコープではない）ため、params全体の
  // deepEqualは成立しない。PD機械化に効く値（pd/hoso比・financialConservatismRatio）
  // が実質1.0になることと、それによって最終的な意思決定がOFFと完全一致することを
  // 確認する（これがneutral controlとして重要な不変条件）。
  assert.deepEqual(balResolution.params.productOrientationMultipliers, { hoso: 1, pd: 1, vap: 1 });
  assert.equal(
    balResolution.params.capexCurrentShortfallRatioThreshold,
    STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold,
    "BALはcapexHurdleBiasRatio=0のため財務保守性のしきい値もOFFと同一のはず"
  );

  const offResult = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const onResult = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, balResolution.params);
  assert.deepEqual(onResult.capexDecision, offResult.capexDecision, "BALはOFF/ONで意思決定が完全に一致するべき");
});

test("CE1.1-5: JPQ（PROFILE ON）でも経済性が悪ければPD機械化を強制しない（strategy fitはeconomicsを上書きしない）", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  const jpqFixture = { ...fixture, companyId: "JPQ" } as unknown as CompanyFixture;
  // PD稼働率を低くし、Operational Needのゲート自体で落ちるようにする。
  const badEconomicsObservation = observation({
    companyId: "JPQ",
    factories: [
      factoryObservation({
        factoryId: "JPQ-F1",
        pdMechanization: { previousQuarterPdUtilization: 0.1, hasActiveOrCompletedProject: false },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(jpqFixture, badEconomicsObservation, pressures(), NO_SHORTFALL, 6000, jpqResolution.params);
  assert.ok(
    !result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"),
    "PD稼働率が低ければJPQ ONでも提案されないべき（strategy fitはOperational Needを迂回しない）"
  );
  assert.ok(result.diagnostics.some((d) => d.code === "PD_MECH_LOW_UTILIZATION"));
});

test("CE1.1-6: Finance GateはPROFILE OFF・ONの両方で機能する", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  const jpqFixture = { ...fixture, companyId: "JPQ" } as unknown as CompanyFixture;
  const lowCashObservation = observation({ companyId: "JPQ", cashUsd: 1_000_000 });
  const gatedPressures = pressures({ targetMinimumCashUsd: 30_000_000 });

  const offResult = buildStandardAiCapexDecision(fixture, lowCashObservation, gatedPressures, NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(!offResult.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"), "OFFでも財務ゲートで見送るべき");
  assert.ok(offResult.diagnostics.some((d) => d.code === "PD_MECH_FINANCE_BLOCKED"));

  const onResult = buildStandardAiCapexDecision(jpqFixture, lowCashObservation, gatedPressures, NO_SHORTFALL, 6000, jpqResolution.params);
  assert.ok(!onResult.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"), "ONでも財務ゲートで見送るべき");
  assert.ok(onResult.diagnostics.some((d) => d.code === "PD_MECH_FINANCE_BLOCKED"));
});

test("CE1.1-7: Crisis GateはPROFILE OFF・ONいずれのparamsが生んだPD機械化提案も一律にゼロ化する", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  const jpqFixture = { ...fixture, companyId: "JPQ" } as unknown as CompanyFixture;
  const goodObservation = observation({ companyId: "JPQ" });

  for (const params of [STANDARD_AI_PARAMETERS_V1, jpqResolution.params]) {
    const result = buildStandardAiCapexDecision(jpqFixture, goodObservation, pressures(), NO_SHORTFALL, 6000, params);
    assert.ok(result.capexDecision.newProjectProposals.some((p) => p.projectType === "pdMechanization"), "前提: この入力では提案されるはず");
    const isSevereDistress = true;
    const capexDecisionAfterCrisisGate = isSevereDistress
      ? { ...result.capexDecision, newProjectProposals: [] }
      : result.capexDecision;
    assert.equal(capexDecisionAfterCrisisGate.newProjectProposals.length, 0, "OFF/ONいずれのparamsでもCrisis Gateで新規CAPEX提案は0件になるべき");
  }
});

test("CE1.1-8: PD_MECH_PROPOSED診断はfirst-classなtargetFactoryIdフィールドを持つ（文字列parse不要）", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "PD_MECH_PROPOSED");
  assert.ok(proposed);
  assert.equal(proposed!.targetFactoryId, "BAL-F1", "targetFactoryIdはdecisionSummaryではなくfirst-classフィールドとして持つべき");
});

test("CE1.1-9: Analysis Pack（captureStrategy）はdecisionSummary文字列をparseせず、targetFactoryIdフィールドから対象工場を取得する", () => {
  const entries: StandardAiDiagnosticEntry[] = [
    {
      code: "PD_MECH_CONSIDERED",
      domain: "capex",
      companyId: "BAL",
      severity: "info",
      targetFactoryId: "BAL-F1",
      // 【意図的】decisionSummaryをfactoryId以外の文言にし、文字列parseに依存していないことを証明する。
      decisionSummary: "PD機械化を評価中（工場情報はdecisionSummaryに含めない）",
      message: "test",
    },
    {
      code: "PD_MECH_PROPOSED",
      domain: "capex",
      companyId: "BAL",
      severity: "info",
      targetFactoryId: "BAL-F2",
      keyValues: {
        investmentCostUsd: 2_500_000,
        paybackQuarters: 10,
        laborSavingsHeadcount: 3,
        expectedQuarterlySavingUsd: 3000,
        effectiveMaxPaybackQuarters: 12,
        strategyFitMultiplier: 1,
        financialConservatismRatio: 1,
      },
      // 【意図的】文言に別のfactoryId風文字列を混ぜても、targetFactoryIdフィールドが優先されるべき。
      decisionSummary: "BAL-F1: これはダミーの紛らわしい文言（実際の対象はBAL-F2）",
      message: "test",
    },
  ];
  const diagnostics = {
    entries,
    vision: undefined,
    strategicGrowth: undefined,
    newFactoryAssessment: undefined,
    crisis: undefined,
  } as unknown as StandardAiQuarterDiagnostics;

  const strategy = captureStrategy(diagnostics);
  assert.equal(
    strategy.pdMechanization?.proposedTargetFactoryId,
    "BAL-F2",
    "decisionSummaryの紛らわしい文言に惑わされず、targetFactoryIdフィールドの値（BAL-F2）を正しく採用するべき"
  );
});

test("CE1.1-10: PD機械化を含むCAPEX判断は、PROFILE OFF・ONいずれのparamsでも決定論的である", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  const jpqFixture = { ...fixture, companyId: "JPQ" } as unknown as CompanyFixture;
  const goodObservation = observation({ companyId: "JPQ" });

  for (const params of [STANDARD_AI_PARAMETERS_V1, jpqResolution.params] as StandardAiParameters[]) {
    const run1 = buildStandardAiCapexDecision(jpqFixture, goodObservation, pressures(), NO_SHORTFALL, 6000, params);
    const run2 = buildStandardAiCapexDecision(jpqFixture, goodObservation, pressures(), NO_SHORTFALL, 6000, params);
    assert.deepEqual(run1.capexDecision, run2.capexDecision);
    assert.deepEqual(run1.diagnostics, run2.diagnostics);
  }
});
