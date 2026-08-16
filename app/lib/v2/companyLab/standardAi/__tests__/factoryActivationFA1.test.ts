// ShrimpX V2 — Standard AI Factory Activation Strategy（Phase FA-1）単体テスト
//
// 指示§41のFA1-1〜16に対応させる。監査の結果、既存のCAPEX候補生成
// （selectTargetFactoryId等、CE-1由来）は既にFactory単位で「実効能力最小の
// Factoryを選ぶ」設計であり、新設Factoryを含めて機能することを確認した
// （新しい判断ロジックを重複実装していない）。FA-1で実際に変更したのは
// (a) companyLab/standardAi/decision/labor.tsのバグ修正（新設Factoryへの
// WorkerAssignmentが構造的に一切生成されなかった欠落を修正）、
// (b) companyLab/standardAi/factoryActivation.tsの新規診断（既存
// FactoryObservationだけから導出、新SSoTなし）の2点である。

import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFactoryActivation } from "../factoryActivation";
import { buildStandardAiWorkerAssignments } from "../decision/labor";
import { buildStandardAiCapexDecision } from "../decision/capex";
import { FactoryObservation, StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { resolveStandardAiProfileForMode } from "../orientationProfile";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";
import { CompanyProductionPlanEntry } from "../../../production/types";
import { ratio } from "../../../core/units";

const ZERO_QUALITY_METRICS: FactoryObservation["qualityMetrics"] = {
  operationalRisk: 0,
  downgradeTons: 0,
  reworkTons: 0,
  disposalTons: 0,
  majorIncidentOccurred: false,
  productionTons: 0,
  qualitySensitiveProductionTons: 0,
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

// ---------------------------------------------------------------------
// FA1-1〜6: diagnoseFactoryActivation（純粋関数）
// ---------------------------------------------------------------------

test("FA1-1: 稼働開始直後・未活用（生産実績ゼロ）の新設Factoryは、実効能力が正しく認識される", () => {
  const factory = factoryObservation({
    factoryId: "BAL-NEWF-1",
    currentRegularHeadcount: 0,
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 0 },
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.equal(diag.factoryId, "BAL-NEWF-1");
  assert.ok(diag.effectiveCapacityTons > 0, "新設Factoryのライン容量（capex効果でランプ済み）が認識されるべき");
  assert.equal(diag.utilization, 0, "生産実績ゼロなので稼働率も0");
});

test("FA1-2: 稼働率が低く常用人数も不足している未活用Factoryは、ボトルネックがNONEにならない", () => {
  const factory = factoryObservation({
    factoryId: "BAL-NEWF-1",
    currentRegularHeadcount: 0,
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 3000, qualitySensitiveProductionTons: 0 },
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.notEqual(diag.bottleneck, "NONE", "labor不足のFactoryはNONE（追加のActivation不要）と誤診断されないべき");
});

test("FA1-3: common processing能力がライン合計より明確に小さい場合、COMMONボトルネックと診断される", () => {
  const factory = factoryObservation({
    factoryId: "BAL-F1",
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 10000, // 合計20000の半分程度しかない
    currentRegularHeadcount: 2000,
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 8000 },
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.equal(diag.bottleneck, "COMMON");
});

test("FA1-4: common処理は十分だが稼働率が高いFactoryは、PRODUCT_LINEボトルネックと診断される", () => {
  const factory = factoryObservation({
    factoryId: "BAL-F1",
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 30000, // 十分大きい
    currentRegularHeadcount: 3000, // labor十分
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 19000 }, // 稼働率95%
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.equal(diag.bottleneck, "PRODUCT_LINE");
});

test("FA1-5: 設備・common処理は十分だが常用人数が必要数を大きく下回るFactoryは、LABORボトルネックと診断される", () => {
  const factory = factoryObservation({
    factoryId: "BAL-F1",
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 30000,
    currentRegularHeadcount: 10, // 極端に少ない
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 5000 },
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.equal(diag.bottleneck, "LABOR");
});

test("FA1-6相当: 稼働率・人員とも十分なFactoryはNONE（追加のActivation不要）と診断される", () => {
  const factory = factoryObservation({
    factoryId: "BAL-F1",
    effectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    effectiveCommonProcessingCapacity: 30000,
    currentRegularHeadcount: 5000,
    qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 4000 }, // 稼働率20%程度、余裕あり
  });
  const diag = diagnoseFactoryActivation(factory);
  assert.equal(diag.bottleneck, "NONE");
});

// ---------------------------------------------------------------------
// FA1-7〜8: labor.tsの新設Factoryぶんworker baseline合成（バグ修正の検証）
// ---------------------------------------------------------------------

const fixture = {
  companyId: "BAL",
  factories: [],
  workerBaseline: [
    { factoryId: "BAL-F1", companyId: "BAL", regularHeadcount: 500, skills: [{ product: "hoso", skillLevel: ratio(1) }, { product: "pd", skillLevel: ratio(1) }, { product: "vap", skillLevel: ratio(1) }], attendanceRate: ratio(0.95) },
  ],
  productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
} as unknown as CompanyFixture;

function laborObservation(factories: readonly FactoryObservation[]): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    factories,
    totalCapacityByProduct: { hoso: 16000, pd: 14000, vap: 10000 },
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 1000 },
  } as unknown as StandardAiObservation;
}

test("FA1-7: 稼働開始済みの新設Factory（workerBaselineに存在しない）にも、WorkerAssignmentが生成される（バグ修正の確認）", () => {
  const factories = [
    factoryObservation({ factoryId: "BAL-F1" }),
    factoryObservation({ factoryId: "BAL-NEWF-1", currentRegularHeadcount: 0 }),
  ];
  const productionPlans: CompanyProductionPlanEntry[] = [
    { factoryId: "BAL-NEWF-1", companyId: "BAL", product: "hoso", desiredQuantity: 3000 } as unknown as CompanyProductionPlanEntry,
  ];
  const result = buildStandardAiWorkerAssignments(fixture, laborObservation(factories), {} as PressureScores, productionPlans, STANDARD_AI_PARAMETERS_V1);
  const newFactoryAssignment = result.workerAssignments.find((w) => w.factoryId === "BAL-NEWF-1");
  assert.ok(newFactoryAssignment, "修正前は新設Factoryぶんの割り当てが一切生成されなかった（構造的バグ）");
  assert.ok(result.diagnostics.some((d) => d.code === "FACTORY_ACTIVATION_LABOR_BASELINE_SYNTHESIZED"));
});

test("FA1-8: 既存Factory（workerBaselineに存在）は重複して割り当てが生成されない（合成baselineとの重複禁止）", () => {
  const factories = [factoryObservation({ factoryId: "BAL-F1" })];
  const result = buildStandardAiWorkerAssignments(fixture, laborObservation(factories), {} as PressureScores, [], STANDARD_AI_PARAMETERS_V1);
  const matches = result.workerAssignments.filter((w) => w.factoryId === "BAL-F1");
  assert.equal(matches.length, 1, "既存Factoryは1件だけ割り当てられるべき（合成baselineと重複しない）");
});

// ---------------------------------------------------------------------
// FA1-9〜16: 統合・既存ロジックとの整合
// ---------------------------------------------------------------------

const capexFixture = {
  companyId: "BAL",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
      hoso: { expectedVariableProcessingCostUsdPerHosoEqKg: 0.12, allocatedFixedCostUsdPerHosoEqKg: 0.1, sellingAndLogisticsCostUsdPerHosoEqKg: 0.03, targetMarginUsdPerHosoEqKg: 0.08, avoidableVariableProcessingCostUsdPerHosoEqKg: 0.12, incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.02, minimumContributionMarginUsdPerHosoEqKg: 0.03 },
      pd: { expectedVariableProcessingCostUsdPerHosoEqKg: 0.17, allocatedFixedCostUsdPerHosoEqKg: 0.15, sellingAndLogisticsCostUsdPerHosoEqKg: 0.05, targetMarginUsdPerHosoEqKg: 0.15, avoidableVariableProcessingCostUsdPerHosoEqKg: 0.17, incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.03, minimumContributionMarginUsdPerHosoEqKg: 0.05 },
      vap: { expectedVariableProcessingCostUsdPerHosoEqKg: 0.43, allocatedFixedCostUsdPerHosoEqKg: 0.35, sellingAndLogisticsCostUsdPerHosoEqKg: 0.1, targetMarginUsdPerHosoEqKg: 0.1, avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43, incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06, minimumContributionMarginUsdPerHosoEqKg: 0.1 },
    },
  },
} as unknown as CompanyFixture;

function capexObservation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [
      factoryObservation({ factoryId: "BAL-F1" }),
      factoryObservation({
        factoryId: "BAL-NEWF-1",
        effectiveCapacityByProduct: { hoso: 1000, pd: 1000, vap: 1000 },
        pdMechanization: { previousQuarterPdUtilization: 0.9, hasActiveOrCompletedProject: false },
        qualityMetrics: { ...ZERO_QUALITY_METRICS, operationalRisk: 0.65, downgradeTons: 60, reworkTons: 40, disposalTons: 30, majorIncidentOccurred: true, productionTons: 1000, qualitySensitiveProductionTons: 700 },
      }),
    ],
    totalCapacityByProduct: { hoso: 9000, pd: 8000, vap: 6000 },
    totalCommonProcessingCapacity: 60000,
    totalEffectiveCapacityByProduct: { hoso: 9000, pd: 8000, vap: 6000 },
    totalEffectiveCommonProcessingCapacity: 60000,
    totalEffectiveFreezingPackagingCapacity: 60000,
    lastQuarterEquipmentUtilizationRate: 0.5,
    lastQuarterLaborUtilizationRate: 0.5,
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 1000 },
    markets: [],
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
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

test("FA1-9: Factory Activation診断はFinance Gateを迂回しない（現金不足では実際のCAPEX提案は発生しない）", () => {
  const obs = capexObservation({ cashUsd: 0 });
  const result = buildStandardAiCapexDecision(capexFixture, obs, pressures({ targetMinimumCashUsd: 30_000_000 }), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.capexDecision.newProjectProposals.length, 0, "現金不足時はFactory Activation関連の診断があっても実際のCAPEX提案はゼロのはず");
});

test("FA1-10: SEVERE_DISTRESS時はFactory Activation由来の提案も含め、新規CAPEX提案が一律ゼロ化される", () => {
  const obs = capexObservation();
  const result = buildStandardAiCapexDecision(capexFixture, obs, pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  const isSevereDistress = true;
  const capexDecisionAfterCrisisGate = isSevereDistress ? { ...result.capexDecision, newProjectProposals: [] } : result.capexDecision;
  assert.equal(capexDecisionAfterCrisisGate.newProjectProposals.length, 0);
});

test("FA1-11: Factory Activationの診断（diagnoseFactoryActivation）自体はStrategy Profileパラメータに依存しない（純粋関数、softバイアスは下流の既存CAPEX/Quality/PD Mechanization候補生成側だけに残る）", () => {
  const factory = factoryObservation({ factoryId: "BAL-NEWF-1", currentRegularHeadcount: 0, qualityMetrics: { ...ZERO_QUALITY_METRICS, productionTons: 3000 } });
  const diagA = diagnoseFactoryActivation(factory);
  const diagB = diagnoseFactoryActivation(factory);
  assert.deepEqual(diagA, diagB, "同一入力に対して常に同一の診断結果を返すべき（決定論的・パラメータ非依存）");
});

test("FA1-14: 新設Factoryを含む観測でも、PD Mechanization候補生成（CE-1）は引き続き正常に動作する", () => {
  const result = buildStandardAiCapexDecision(capexFixture, capexObservation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.diagnostics.some((d) => d.code === "PD_MECH_CONSIDERED" && d.targetFactoryId === "BAL-NEWF-1"),
    "新設Factory（BAL-NEWF-1）もPD Mechanization候補として評価されるべき"
  );
});

test("FA1-15: 新設Factoryを含む観測でも、Quality Equipment候補生成（CE-3）は引き続き正常に動作する", () => {
  const result = buildStandardAiCapexDecision(capexFixture, capexObservation(), pressures(), NO_SHORTFALL, 6000, STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    result.diagnostics.some((d) => d.code === "QUALITY_EQUIP_PROPOSED" && d.targetFactoryId === "BAL-NEWF-1"),
    "新設Factory（BAL-NEWF-1）が高いQuality Needを持つ場合、品質管理設備の提案対象になるべき"
  );
});

test("FA1-16: Factory Activationを含むCAPEX判断は決定論的である（同一入力→同一出力）", () => {
  const jpqResolution = resolveStandardAiProfileForMode("JPQ", "ON");
  const jpqFixture = { ...capexFixture, companyId: "JPQ" } as unknown as CompanyFixture;
  const obs = capexObservation({ companyId: "JPQ" });
  for (const params of [STANDARD_AI_PARAMETERS_V1, jpqResolution.params] as StandardAiParameters[]) {
    const run1 = buildStandardAiCapexDecision(jpqFixture, obs, pressures(), NO_SHORTFALL, 6000, params);
    const run2 = buildStandardAiCapexDecision(jpqFixture, obs, pressures(), NO_SHORTFALL, 6000, params);
    assert.deepEqual(run1.capexDecision, run2.capexDecision);
    assert.deepEqual(run1.diagnostics, run2.diagnostics);
  }
});
