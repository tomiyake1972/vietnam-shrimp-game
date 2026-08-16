// ShrimpX V2 — Standard AI Capability Expansion（Phase CE-3）単体テスト
//
// 指示§46の CE3-1〜16 にそのまま対応させる。QI-I1で完成した品質管理設備
// （qualityControlEquipment）のゲーム効果そのもの（30%リスク低減・2Qランプ・
// 既存Quality Score/Trust/VAP capabilityへの波及）は一切変更していないため、
// それらは引き続き既存のqualityControlEquipmentEffect.test.ts・
// qualityControlEquipmentState.test.ts・qualityControlEquipmentIntegration.test.ts
// が検証する。ここではdecision/capex.tsに新設した品質管理設備「候補生成」
// （§3-28）だけを対象にする。

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
import { QUALITY_PARAMETERS_V1 } from "../../../quality/parameters";
import { resolveQualityEquipmentStatusByFactory } from "../../qualityControlEquipmentState";
import { period, nextPeriod } from "../../../core/period";
import { hosoEqTons, ratio } from "../../../core/units";
import { Factory } from "../../../production/types";
import { CapexState, CapitalProject } from "../../../capex/types";

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

const ZERO_QUALITY_METRICS: FactoryObservation["qualityMetrics"] = {
  operationalRisk: 0,
  downgradeTons: 0,
  reworkTons: 0,
  disposalTons: 0,
  majorIncidentOccurred: false,
  productionTons: 0,
  qualitySensitiveProductionTons: 0,
};

/** 高いQuality Need（operationalRisk高・損失量大・major incident発生・品質敏感商品シェア高）を持つ工場の品質実績。 */
const HIGH_NEED_METRICS: FactoryObservation["qualityMetrics"] = {
  operationalRisk: 0.65,
  downgradeTons: 60,
  reworkTons: 40,
  disposalTons: 30,
  majorIncidentOccurred: true,
  productionTons: 1000,
  qualitySensitiveProductionTons: 700,
};

/** Quality Needが低い（操業ストレス小・損失なし）工場の品質実績。 */
const LOW_NEED_METRICS: FactoryObservation["qualityMetrics"] = {
  operationalRisk: 0.1,
  downgradeTons: 0,
  reworkTons: 0,
  disposalTons: 0,
  majorIncidentOccurred: false,
  productionTons: 1000,
  qualitySensitiveProductionTons: 100,
};

function factoryObservation(overrides: Partial<FactoryObservation> & Pick<FactoryObservation, "factoryId">): FactoryObservation {
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
    qualityEquipment: { hasQualityEquipment: false, qualityEquipmentStatus: "NONE", equipmentRampProgress: 0, qualityEquipmentRiskMultiplier: 1 },
    qualityMetrics: ZERO_QUALITY_METRICS,
    ...overrides,
  };
}

/** HOSO/PD/VAPライン増設・PD機械化のいずれのゲートも発火しない中立observation。品質管理設備候補生成だけを単独で観測する。 */
function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [factoryObservation({ factoryId: "BAL-F1", qualityMetrics: HIGH_NEED_METRICS })],
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

test("CE3-1: PROFILE OFF（STANDARD_AI_PARAMETERS_V1）でも品質管理設備capabilityが利用できる（QUALITY_EQUIP_PROPOSEDが発火し得る）", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_PROPOSED"),
    "STANDARD_AI_PARAMETERS_V1（PROFILE OFF相当）でも品質管理設備が提案されるべき"
  );
  assert.ok(result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"));
});

test("CE3-2: Quality Needが低い工場は候補にならない（QUALITY_EQUIP_LOW_NEED、提案なし）", () => {
  const obs = observation({ factories: [factoryObservation({ factoryId: "BAL-F1", qualityMetrics: LOW_NEED_METRICS })] });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_LOW_NEED"));
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"));
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_DEFERRED"));
});

test("CE3-3: 高いoperationalRisk・損失露出を持つ工場は候補になる（QUALITY_EQUIP_PROPOSED）", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "QUALITY_EQUIP_PROPOSED");
  assert.ok(proposed);
  assert.equal(proposed!.targetFactoryId, "BAL-F1");
});

test("CE3-4: JPQ（品質・加工志向）はneutral（BAL相当）より品質管理設備へのsoft preferenceが強い（同一Quality Needでも提案されやすい）", () => {
  const jpqParams = resolveStandardAiProfileForMode("JPQ", "ON").params;
  const balParams = STANDARD_AI_PARAMETERS_V1;
  // BALでは提案されない程度の中程度Need
  const moderateNeedMetrics: FactoryObservation["qualityMetrics"] = {
    operationalRisk: 0.35,
    downgradeTons: 10,
    reworkTons: 10,
    disposalTons: 5,
    majorIncidentOccurred: false,
    productionTons: 1000,
    qualitySensitiveProductionTons: 400,
  };
  const obs = observation({ factories: [factoryObservation({ factoryId: "BAL-F1", qualityMetrics: moderateNeedMetrics })] });
  const balResult = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, balParams);
  const jpqResult = buildStandardAiCapexDecision({ ...fixture, companyId: "JPQ" } as CompanyFixture, obs, pressures(), NO_SHORTFALL, 6000, jpqParams);
  const balConsidered = balResult.diagnostics.find((d) => d.code === "QUALITY_EQUIP_CONSIDERED");
  const jpqConsidered = jpqResult.diagnostics.find((d) => d.code === "QUALITY_EQUIP_CONSIDERED");
  assert.ok(balConsidered && jpqConsidered);
  assert.ok(
    (jpqConsidered!.keyValues!.effectiveNeedThreshold as number) < (balConsidered!.keyValues!.effectiveNeedThreshold as number),
    "JPQのeffectiveNeedThresholdはBALより低い（動きやすい）べき"
  );
});

test("CE3-5: VAP（高付加価値志向）でも品質管理設備が自然に発生し得る（財務・Need条件を満たせば提案）", () => {
  const vapParams = resolveStandardAiProfileForMode("VAP", "ON").params;
  const result = buildStandardAiCapexDecision({ ...fixture, companyId: "VAP" } as CompanyFixture, observation({ companyId: "VAP" }), pressures(), NO_SHORTFALL, 6000, vapParams);
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_PROPOSED"));
});

test("CE3-6: MASS（コモディティ志向）はhard-blockされない（品質リスクが十分高ければ投資できる）", () => {
  const massParams = resolveStandardAiProfileForMode("MASS", "ON").params;
  const result = buildStandardAiCapexDecision({ ...fixture, companyId: "MASS" } as CompanyFixture, observation({ companyId: "MASS" }), pressures(), NO_SHORTFALL, 6000, massParams);
  assert.ok(
    result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_PROPOSED"),
    "MASSでも十分高いQuality Need（HIGH_NEED_METRICS）があれば投資できるべき（hard rule禁止・指示§38）"
  );
});

test("CE3-7: 財務ゲート未達（現金不足）では品質管理設備を提案しない（QUALITY_EQUIP_FINANCE_BLOCKED）", () => {
  const obs = observation({ cashUsd: 0 });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures({ targetMinimumCashUsd: 30_000_000 }), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_FINANCE_BLOCKED"));
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"));
});

test("CE3-8: 品質管理設備提案もCM-1のCrisis Gate（SEVERE_DISTRESS時のnewProjectProposals一律ゼロ化）の対象になる", () => {
  // 【アーキテクチャ上の保証】policy.ts の capexDecisionAfterCrisisGate は
  //   isSevereDistress ? { ...capexResult.capexDecision, newProjectProposals: [] } : capexResult.capexDecision
  // という、案件種別を一切区別しない一律ゲートである。品質管理設備はCE-3で
  // buildStandardAiCapexDecision内の同じproposals配列（=capexResult.capexDecision.
  // newProjectProposals）へ積むだけであり、この配列を経由する以上、他のCAPEX種別と
  // 完全に同じ扱いでCrisis Gateの対象になる（既存のCRISIS-6テスト・
  // crisisState.test.tsが、この一律ゲート自体を汎用的に検証・regression保護している）。
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"),
    "前提: この入力では品質管理設備が提案されるはず"
  );
  const isSevereDistress = true;
  const capexDecisionAfterCrisisGate = isSevereDistress ? { ...result.capexDecision, newProjectProposals: [] } : result.capexDecision;
  assert.equal(capexDecisionAfterCrisisGate.newProjectProposals.length, 0, "SEVERE_DISTRESSでは品質管理設備提案も含め新規CAPEX提案は0件になるべき");
});

test("CE3-9: 既に稼働中(FULL_EFFECT)の設備がある工場は重複提案しない（QUALITY_EQUIP_ALREADY_ACTIVE）", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        qualityMetrics: HIGH_NEED_METRICS,
        qualityEquipment: { hasQualityEquipment: true, qualityEquipmentStatus: "FULL_EFFECT", equipmentRampProgress: 1, qualityEquipmentRiskMultiplier: 0.7 },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_ALREADY_ACTIVE"));
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"));
});

test("CE3-10: ランプ中(RAMPING)の設備を「設備なし」と誤判定せず、重複提案しない（QUALITY_EQUIP_ALREADY_ACTIVE）", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        qualityMetrics: HIGH_NEED_METRICS,
        qualityEquipment: { hasQualityEquipment: true, qualityEquipmentStatus: "RAMPING", equipmentRampProgress: 0.5, qualityEquipmentRiskMultiplier: 0.85 },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const alreadyActive = result.diagnostics.find((d) => d.code === "QUALITY_EQUIP_ALREADY_ACTIVE");
  assert.ok(alreadyActive, "ランプ中の設備を持つFactoryは「設備なし」と誤判定されてはならない");
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "qualityControlEquipment"));
});

test("CE3-10b: 導入進行中(IN_PROGRESS)の設備も重複提案しない", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        qualityMetrics: HIGH_NEED_METRICS,
        qualityEquipment: { hasQualityEquipment: true, qualityEquipmentStatus: "IN_PROGRESS", equipmentRampProgress: 0, qualityEquipmentRiskMultiplier: 1 },
      }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_ALREADY_ACTIVE"));
});

test("CE3-11: primaryFactory固定ではなく、Need・経済性で選ばれたFactory 2が候補に選定される", () => {
  const obs = observation({
    factories: [
      factoryObservation({
        factoryId: "BAL-F1",
        qualityMetrics: LOW_NEED_METRICS,
        qualityEquipment: { hasQualityEquipment: true, qualityEquipmentStatus: "FULL_EFFECT", equipmentRampProgress: 1, qualityEquipmentRiskMultiplier: 0.7 },
      }),
      factoryObservation({ factoryId: "BAL-F2", qualityMetrics: HIGH_NEED_METRICS }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "QUALITY_EQUIP_PROPOSED");
  assert.ok(proposed);
  assert.equal(proposed!.targetFactoryId, "BAL-F2", "主工場（BAL-F1、既に設備あり）ではなく、Needの高いBAL-F2が選ばれるべき");
  assert.equal(
    result.capexDecision.newProjectProposals.find((p) => p.projectType === "qualityControlEquipment")?.targetFactoryId,
    "BAL-F2"
  );
});

test("CE3-12: QUALITY_EQUIP_PROPOSED診断はfirst-classなtargetFactoryIdフィールドを持つ（文字列parse不要）", () => {
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const proposed = result.diagnostics.find((d) => d.code === "QUALITY_EQUIP_PROPOSED");
  assert.ok(proposed);
  assert.equal(proposed!.targetFactoryId, "BAL-F1", "targetFactoryIdはdecisionSummaryではなくfirst-classフィールドとして持つべき");
});

test("CE3-13: Analysis Pack（captureStrategy）はdecisionSummary文字列をparseせず、targetFactoryIdフィールドから対象工場を取得する", () => {
  const entries: StandardAiDiagnosticEntry[] = [
    {
      code: "QUALITY_EQUIP_CONSIDERED",
      domain: "capex",
      companyId: "BAL",
      severity: "info",
      targetFactoryId: "BAL-F1",
      decisionSummary: "品質管理設備を評価中（工場情報はdecisionSummaryに含めない）",
      message: "test",
    },
    {
      code: "QUALITY_EQUIP_PROPOSED",
      domain: "capex",
      companyId: "BAL",
      severity: "info",
      targetFactoryId: "BAL-F2",
      keyValues: {
        investmentCostUsd: 1_200_000,
        qualityNeedScore: 0.42,
        effectiveNeedThreshold: 0.3,
        lossExposureCoverage: 0.13,
        qualitySensitiveExposureRatio: 0.6,
        qualityRiskProtectionRatio: 5.2,
        strategyFitMultiplier: 1.0,
        financialConservatismRatio: 1.0,
      },
      decisionSummary: "品質管理設備を提案（工場情報はdecisionSummaryに含めない）",
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
    strategy.qualityEquipment?.proposedTargetFactoryId,
    "BAL-F2",
    "decisionSummaryの紛らわしい文言に惑わされず、targetFactoryIdフィールドの値（BAL-F2）を正しく採用するべき"
  );
  assert.equal(strategy.qualityEquipment?.investmentCostUsd, 1_200_000);
  assert.equal(strategy.qualityEquipment?.qualityNeedScore, 0.42);
});

test("CE3-15: 品質管理設備を含むCAPEX判断は、PROFILE OFF・ONいずれのparamsでも決定論的である", () => {
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

test("CE3-14: Save/Resume（CapexStateのJSON往復）後も、品質管理設備の状態観測（hasQualityEquipment/status/rampProgress）が正しく復元される", () => {
  const P1 = period(2020, 1);
  const P2 = nextPeriod(P1);
  const P3 = nextPeriod(P2);
  const P4 = nextPeriod(P3);
  const factories: readonly Factory[] = [
    {
      factoryId: "BAL-F1",
      companyId: "BAL",
      status: "active",
      commonProcessingCapacity: hosoEqTons(1000),
      hosoCapacity: hosoEqTons(1000),
      pdCapacity: hosoEqTons(1000),
      vapCapacity: hosoEqTons(1000),
      freezingPackagingCapacity: hosoEqTons(1000),
      baseUtilizationRate: ratio(1),
      equipmentAvailabilityRate: ratio(1),
    },
  ];
  const project: CapitalProject = {
    projectId: "PROJ-Q1",
    companyId: "BAL",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: [{ stageIndex: 0, plannedRatio: 1 }],
    completedPaymentStagesCount: 1,
    cumulativePaidUsd: 1_200_000,
    elapsedConstructionQuartersWithPayment: 1,
    requiredConstructionQuarters: 1,
    status: "completed",
    proposedPeriod: P1,
    approvedPeriod: P1,
    completedPeriod: P1,
    targetFactoryId: "BAL-F1",
    futureCapacityEffect: { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 },
    lastDiagnosticReasons: [],
    priority: 1,
  } as CapitalProject;
  const capexState: CapexState = { companies: [{ companyId: "BAL", portfolio: { companyId: "BAL", projects: [project] }, nextProjectSequence: 2 }] };

  const roundTripped: CapexState = JSON.parse(JSON.stringify(capexState));
  const before = resolveQualityEquipmentStatusByFactory(capexState, factories, P4);
  const after = resolveQualityEquipmentStatusByFactory(roundTripped, factories, P4);
  assert.deepEqual(Array.from(after.entries()), Array.from(before.entries()));
  assert.equal(after.get("BAL-F1")?.hasQualityEquipment, true);
  assert.equal(after.get("BAL-F1")?.qualityEquipmentStatus, "FULL_EFFECT");
});

test("CE3-16: 品質管理設備そのもののゲーム効果（QI-I1）はCE-3で一切変更されていない（30%/2Qのまま）", () => {
  assert.equal(QUALITY_PARAMETERS_V1.qualityControlEquipment.fullEffectRiskReductionRatio, 0.3);
  assert.equal(QUALITY_PARAMETERS_V1.qualityControlEquipment.rampQuarters, 2);
});
