// ShrimpX V2 — 複数工場CAPEX Factory Targeting修正の単体テスト（CAPEX-FAC-8/9/12/13/16）
//
// capacityEffect.test.ts の CAPEX-FAC-1〜7/11/15 は「能力がどのFactoryへ反映されるか」を
// 検証する。このファイルは (a) 工場スペースがFactoryごとに正しく判定されること、
// (b) Standard AIが投資先Factoryを合理的に選ぶこと、(c) 存在しないFactoryIdへの
// 提案が拒否されること、を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, ratio } from "../../core/units";
import { Factory } from "../../production/types";
import {
  buildCompanyFactorySpaceState,
  buildFactorySpaceApprovalBudgetByFactory,
} from "../factorySpace";
import { CapexState, CapitalProject } from "../types";
import { evaluateProposal, ProposalApprovalGate, ProposalFactoryMechanizationGate } from "../projectLifecycle";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import { buildStandardAiCapexDecision } from "../../companyLab/standardAi/decision/capex";
import { StandardAiObservation, FactoryObservation } from "../../companyLab/standardAi/types";
import { PressureScores } from "../../companyLab/standardAi/pressures";
import { STANDARD_AI_PARAMETERS_V1 } from "../../companyLab/standardAi/parameters";
import { CompanyFixture } from "../../companyLab/types";
import { DEMAND_MARKET_IDS } from "../../market/types";

function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  const zero = hosoEqTons(0);
  return {
    status: "active",
    commonProcessingCapacity: zero,
    hosoCapacity: zero,
    pdCapacity: zero,
    vapCapacity: zero,
    freezingPackagingCapacity: zero,
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

function capexStateWith(companyId: string, projects: readonly CapitalProject[]): CapexState {
  return { companies: [{ companyId, portfolio: { companyId, projects }, nextProjectSequence: projects.length + 1 }] };
}

// ---------------------------------------------------------------------
// CAPEX-FAC-8/9: 工場スペースはFactoryごとに判定される（会社全体合算ではない）
// ---------------------------------------------------------------------

test("CAPEX-FAC-8: targetFactoryIdを持つ提案は、その対象Factory自身のスペース枠だけを消費する", () => {
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", commonProcessingCapacity: hosoEqTons(30_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", commonProcessingCapacity: hosoEqTons(10_000) });
  const capexState = capexStateWith("BAL", []);
  const state = buildCompanyFactorySpaceState({ companyId: "BAL", baseFactories: [f1, f2], currentFactories: [f1, f2], capexState, period: period(2015, 3) });
  const budgetByFactory = buildFactorySpaceApprovalBudgetByFactory(state);
  assert.ok(budgetByFactory.has("BAL-F1"));
  assert.ok(budgetByFactory.has("BAL-F2"));
  // F1・F2はそれぞれ独立した枠を持つ（同じ枠を共有しない）。
  assert.notEqual(budgetByFactory.get("BAL-F1")!.totalSpaceUnits, undefined);
  assert.notEqual(budgetByFactory.get("BAL-F2")!.totalSpaceUnits, undefined);
});

test("CAPEX-FAC-9: F1のスペースが不足していても、F2に余裕があればF2向け投資は承認できる（会社全体合算では判定しない）", () => {
  // F1をほぼ満杯（総量に近い占有）、F2はほぼ空にする。
  const f1 = factory({ factoryId: "BAL-F1", companyId: "BAL", commonProcessingCapacity: hosoEqTons(30_000), hosoCapacity: hosoEqTons(24_000) });
  const f2 = factory({ factoryId: "BAL-F2", companyId: "BAL", commonProcessingCapacity: hosoEqTons(10_000) });
  const capexState = capexStateWith("BAL", []);
  const state = buildCompanyFactorySpaceState({ companyId: "BAL", baseFactories: [f1, f2], currentFactories: [f1, f2], capexState, period: period(2015, 3) });
  const budgetByFactory = buildFactorySpaceApprovalBudgetByFactory(state);
  const f1Budget = budgetByFactory.get("BAL-F1")!;
  const f2Budget = budgetByFactory.get("BAL-F2")!;
  // F1はF2よりも占有率が高い（HOSO専用ラインぶんのスペースを追加で使っているため）。
  assert.ok(f1Budget.remainingSpaceUnits < f1Budget.totalSpaceUnits, "F1は既に一部占有されている");
  assert.ok(
    f2Budget.remainingSpaceUnits / f2Budget.totalSpaceUnits > f1Budget.remainingSpaceUnits / f1Budget.totalSpaceUnits,
    "F2の空き比率はF1より大きいはず（HOSOラインを持たないぶん）"
  );

  // 提案評価: F2をtargetFactoryIdとする提案は、F2自身の（十分な）枠で承認される。
  const approvalGate: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };
  const outcome = evaluateProposal(
    "BAL",
    { projectType: "commonProcessingExpansion", targetFactoryId: "BAL-F2" },
    0,
    approvalGate,
    CAPEX_PARAMETERS_V1,
    period(2015, 3),
    "BAL-CAPEX-1",
    1,
    { requiredSpaceUnits: 100, remainingSpaceUnits: f2Budget.remainingSpaceUnits, totalSpaceUnits: f2Budget.totalSpaceUnits, epsilonSpaceUnits: 1e-6 }
  );
  assert.ok("approved" in outcome, "F2向け提案はF2自身の空き枠で承認されるべき");
});

// ---------------------------------------------------------------------
// CAPEX-FAC-16: 存在しないtargetFactoryIdへの提案は拒否される
// ---------------------------------------------------------------------

test("CAPEX-FAC-16: 存在しないFactoryIdを対象とする提案は、案件種別を問わず拒否される", () => {
  const approvalGate: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };
  const mechanizationGate: ProposalFactoryMechanizationGate = { hasActiveProjectForSameFactory: false, targetFactoryExists: false };
  const outcome = evaluateProposal(
    "BAL",
    { projectType: "commonProcessingExpansion", targetFactoryId: "BAL-NONEXISTENT" },
    0,
    approvalGate,
    CAPEX_PARAMETERS_V1,
    period(2015, 3),
    "BAL-CAPEX-1",
    1,
    undefined,
    undefined,
    mechanizationGate
  );
  assert.ok("rejected" in outcome);
  if ("rejected" in outcome) {
    assert.ok(outcome.rejected.reasons.some((r) => r.includes("存在しない")));
  }
});

// ---------------------------------------------------------------------
// CAPEX-FAC-12/13: Standard AIの投資先Factory選択
// ---------------------------------------------------------------------

const fixture = {
  companyId: "BAL",
  productEconomics: {
    expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
    premiumEconomics: {
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
    ...overrides,
  };
}

/** 2工場・HOSOが逼迫している合成observation。F2の方がHOSO実効能力が小さい。 */
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
      factoryObservation({ factoryId: "BAL-F1", effectiveCapacityByProduct: { hoso: 12000, pd: 7000, vap: 5000 } }),
      factoryObservation({ factoryId: "BAL-F2", effectiveCapacityByProduct: { hoso: 4000, pd: 3000, vap: 2000 } }),
    ],
    totalCapacityByProduct: { hoso: 16000, pd: 10000, vap: 7000 },
    totalCommonProcessingCapacity: 60000,
    totalEffectiveCapacityByProduct: { hoso: 16000, pd: 10000, vap: 7000 },
    totalEffectiveCommonProcessingCapacity: 60000,
    totalEffectiveFreezingPackagingCapacity: 60000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 12,
    lastQuarterEquipmentUtilizationRate: 0.9,
    lastQuarterLaborUtilizationRate: 0.85,
    lastQuarterActualProductionByProduct: { hoso: 15500, pd: 1000, vap: 500 },
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
    equipmentUtilizationLastQuarter: 0.9,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.85,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

test("CAPEX-FAC-12: Standard AIがHOSOライン増設を提案する際、実効HOSO能力が最も小さいFactory（最もbindingしているFactory）をtargetFactoryIdに選ぶ", () => {
  const HOSO_SHORTFALL = { hoso: 18000, pd: 1000, vap: 500 };
  const result = buildStandardAiCapexDecision(fixture, observation(), pressures(), HOSO_SHORTFALL, 10000, STANDARD_AI_PARAMETERS_V1);
  const hosoProposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "hosoLineExpansion");
  assert.ok(hosoProposal, "HOSOライン増設が提案されるべき前提が崩れている");
  assert.equal(hosoProposal!.targetFactoryId, "BAL-F2", "実効HOSO能力が小さいF2が選ばれるべき");
});

test("CAPEX-FAC-13: 新設Factory（AGGRESSIVE_EARLY_CAPACITY完成後）がobservation.factoriesに含まれていれば、Standard AIはそのFactoryへも投資できる", () => {
  const HOSO_SHORTFALL = { hoso: 18000, pd: 1000, vap: 500 };
  const obsWithNewFactory = observation({
    factories: [
      factoryObservation({ factoryId: "BAL-F1", effectiveCapacityByProduct: { hoso: 12000, pd: 7000, vap: 5000 } }),
      // 新設Factory（BAL-NEWF-...）はまだ稼働開始直後でHOSO能力が最小 → 選ばれる。
      factoryObservation({ factoryId: "BAL-NEWF-BAL-CAPEX-30", effectiveCapacityByProduct: { hoso: 2000, pd: 1500, vap: 1000 } }),
    ],
  });
  const result = buildStandardAiCapexDecision(fixture, obsWithNewFactory, pressures(), HOSO_SHORTFALL, 10000, STANDARD_AI_PARAMETERS_V1);
  const hosoProposal = result.capexDecision.newProjectProposals.find((p) => p.projectType === "hosoLineExpansion");
  assert.ok(hosoProposal);
  assert.equal(hosoProposal!.targetFactoryId, "BAL-NEWF-BAL-CAPEX-30", "新設Factoryが最もbindingしているFactoryとして正しく選ばれるべき");
});
