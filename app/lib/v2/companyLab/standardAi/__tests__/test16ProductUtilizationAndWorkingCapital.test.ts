// ShrimpX V2 — Test16: 商品別稼働率によるcapex判断 ＋ 短期運転資金の借入判断
//
// 【このテストが守る因果】
//  (a) 「何の設備へ投資するか」に対応する設備の稼働率で持続性を判定する。
//      共通前処理能力(common)が低稼働でも、HOSO専用ラインが逼迫していれば
//      HOSO増設は投資候補になる。逆にHOSOラインが低稼働なら見送る。
//  (b) 「原料を買うのに資金が要る」ことが借入判断の入力になっている。
//      現金が十分なら借りない。不足するなら借りる。売掛回収見込みは必要額を減らす。
//
// いずれもゲームのパラメータは変更していない。合成observationで分岐だけを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiCapexDecision, relevantUtilizationFor } from "../decision/capex";
import { buildStandardAiFinancingRequest } from "../decision/finance";
import { assessWorkingCapitalNeed } from "../decision/workingCapital";
import { MAX_HOSO_CAPACITY_TONS } from "../../../capex/capacityEffect";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { FINANCING_PARAMETERS_V1 } from "../../../financing/parameters";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";

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
        targetMarginUsdPerHosoEqKg: 0.3,
        avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
        incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
        minimumContributionMarginUsdPerHosoEqKg: 0.1,
      },
    },
  },
} as unknown as CompanyFixture;

/**
 * Test16の工場設計を写した合成observation。
 * common 30,000 に対し商品別は HOSO 8,000 / PD 7,000 / VAP 5,000（合計20,000）。
 * これは「工場全体の箱は大きいが、商品別専用能力が商品構成を制約する」という設計。
 */
function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 3,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 5000,
    rawMaterialPipeline: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalCommonProcessingCapacity: 30000,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    totalEffectiveCommonProcessingCapacity: 30000,
    totalEffectiveFreezingPackagingCapacity: 30000,
    aquacultureCapacity: 4000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 12,
    // 会社全体（分母=common 30,000）で見ると 20,000/30,000 ≒ 0.67 にしかならない。
    lastQuarterEquipmentUtilizationRate: 0.26,
    lastQuarterLaborUtilizationRate: 0.85,
    // HOSOラインだけは 7,800/8,000 = 97.5% で逼迫している。
    lastQuarterActualProductionByProduct: { hoso: 7800, pd: 1000, vap: 500 },
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
    equipmentUtilizationLastQuarter: 0.26,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.85,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    targetMinimumCashUsd: 30_000_000,
    expectedRawPriceUsdPerKg: 2.5,
    ...overrides,
  } as unknown as PressureScores;
}

/** HOSOだけが能力不足、PD/VAPは余裕。 */
const HOSO_SHORTFALL = { hoso: 12000, pd: 1000, vap: 500 };

function capex(obs: StandardAiObservation, pr: PressureScores) {
  return buildStandardAiCapexDecision(fixture, obs, pr, HOSO_SHORTFALL, 10000, STANDARD_AI_PARAMETERS_V1);
}

function hosoDiagnostic(result: ReturnType<typeof capex>) {
  return result.diagnostics.find((d) => d.decisionSummary?.startsWith("HOSO"));
}

// ---------------------------------------------------------------------
// Capex 1〜7
// ---------------------------------------------------------------------

test("Test16-CAPEX-1: HOSOの稼働率はHOSO能力を分母に計算される", () => {
  const u = relevantUtilizationFor(observation(), "hoso");
  assert.equal(u.capacity, 8000);
  assert.equal(u.actualProduction, 7800);
  assert.ok(Math.abs(u.utilization - 7800 / 8000) < 1e-9);
});

test("Test16-CAPEX-2: PDの稼働率はPD能力を分母に計算される", () => {
  const u = relevantUtilizationFor(observation(), "pd");
  assert.equal(u.capacity, 7000);
  assert.equal(u.actualProduction, 1000);
  assert.ok(Math.abs(u.utilization - 1000 / 7000) < 1e-9);
});

test("Test16-CAPEX-3: VAPの稼働率はVAP能力を分母に計算される", () => {
  const u = relevantUtilizationFor(observation(), "vap");
  assert.equal(u.capacity, 5000);
  assert.equal(u.actualProduction, 500);
  assert.ok(Math.abs(u.utilization - 500 / 5000) < 1e-9);
});

test("Test16-CAPEX-4: 共通前処理能力の稼働率はHOSOの持続性判定に使われない", () => {
  const obs = observation();
  const common = relevantUtilizationFor(obs, "commonProcessing");
  const hoso = relevantUtilizationFor(obs, "hoso");
  // 共通前処理の稼働率は 9,300/30,000 = 0.31 で、HOSOの 0.975 とは全く違う。
  assert.ok(common.utilization < 0.4, `common utilization=${common.utilization}`);
  assert.ok(hoso.utilization > 0.9, `hoso utilization=${hoso.utilization}`);

  // HOSOの判定に使われた稼働率がHOSO側であることをdiagnosticsで確認する。
  const d = hosoDiagnostic(capex(obs, pressures()));
  assert.ok(d, "HOSOのcapex diagnosticsが無い");
  assert.equal(d!.keyValues!.relevantCapacity, 8000);
  assert.ok(Math.abs((d!.keyValues!.relevantUtilization as number) - 0.975) < 1e-9);
  // 旧方式の値も保存されており、両者が異なることが説明可能になっている。
  assert.ok(Math.abs((d!.keyValues!.legacyOverallEquipmentUtilization as number) - 0.26) < 1e-9);
});

test("Test16-CAPEX-5: commonが低稼働でもHOSOが92%超なら持続性条件を満たし投資候補になる", () => {
  const result = capex(observation(), pressures());
  const d = hosoDiagnostic(result);
  assert.ok(d, "HOSOのcapex diagnosticsが無い");
  assert.equal(d!.keyValues!.sustainedGate, 1, "HOSOラインが逼迫しているのに持続性条件が成立していない");
  assert.ok(
    result.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"),
    "HOSOライン増設が提案されていない"
  );
});

test("Test16-CAPEX-6: HOSOラインが低稼働なら、能力不足でもHOSO投資は見送られる", () => {
  const obs = observation({ lastQuarterActualProductionByProduct: { hoso: 3000, pd: 1000, vap: 500 } });
  const result = capex(obs, pressures());
  const d = hosoDiagnostic(result);
  assert.ok(d, "HOSOのcapex diagnosticsが無い");
  assert.equal(d!.keyValues!.sustainedGate, 0, "低稼働なのに持続性条件が成立している");
  assert.equal(d!.keyValues!.finalDecision, 0);
  assert.ok(!result.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"));
});

test("Test16-CAPEX-7: HOSO能力の明示上限は24,000tであり、1件あたり増分は4,000t・工期1Q", () => {
  assert.equal(MAX_HOSO_CAPACITY_TONS, 24_000);
  const t = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion;
  const increment = t.futureCapacityEffect!.capacityIncreaseTonsPerQuarter!;
  assert.equal(increment, 4_000);
  assert.equal(t.standardBudgetUsd, 8_000_000);
  assert.deepEqual([...t.paymentRatios], [1.0]);
  assert.equal(t.standardConstructionQuarters, 1);
  // 初期8,000tから4回の増設で上限に達する。
  assert.equal(8_000 + 4 * increment, MAX_HOSO_CAPACITY_TONS);
});

// ---------------------------------------------------------------------
// Finance 8〜14
// ---------------------------------------------------------------------

const PROCUREMENT = { domesticDesiredQuantityTons: 10_000, importOrderedQuantityTons: 2_000 };

test("Test16-FIN-8: 原料調達必要額が借入判断の入力に入っている", () => {
  const obs = observation({ cashUsd: 1_000_000 });
  const withoutPlan = buildStandardAiFinancingRequest(obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  const withPlan = buildStandardAiFinancingRequest(obs, pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);

  // 原料調達コスト = 10,000t × 1000kg × 4.0 USD/kg = 40M（国内）＋ 8M（輸入）
  assert.equal(withPlan.workingCapital?.plannedDomesticRawProcurementCostUsd, 40_000_000);
  assert.equal(withPlan.workingCapital?.plannedImportRawProcurementCostUsd, 8_000_000);
  // 調達計画を渡さない従来経路より、必ず多く借りようとする。
  assert.ok(
    withPlan.financingRequest.desiredAmountUsd > withoutPlan.financingRequest.desiredAmountUsd,
    "原料調達必要額が借入希望額へ反映されていない"
  );
});

test("Test16-FIN-9: 現金が十分なら不要な借入をしない", () => {
  // 調達コスト48M・人件費等に対し、現金2億USD。全体でも国内買付枠でも足りる。
  const r = buildStandardAiFinancingRequest(observation({ cashUsd: 200_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  assert.equal(r.financingRequest.desiredAmountUsd, 0, "十分な現金があるのに借入している");
  assert.ok((r.workingCapital?.projectedWorkingCapitalGapUsd ?? 0) <= 0);
});

test("Test16-FIN-10: 現金不足なら短期運転資金として借入を申請する", () => {
  const r = buildStandardAiFinancingRequest(observation({ cashUsd: 5_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  assert.ok(r.financingRequest.desiredAmountUsd > 0, "資金不足なのに借入を申請していない");
  assert.equal(r.financingRequest.desiredLoanType, "workingCapital");
});

test("Test16-FIN-11: 売掛回収見込みは借入必要額を減らす", () => {
  const base = buildStandardAiFinancingRequest(observation({ cashUsd: 5_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  const withAr = buildStandardAiFinancingRequest(
    observation({ cashUsd: 5_000_000, receivablesDueThisPeriodUsd: 20_000_000 }),
    pressures(),
    STANDARD_AI_PARAMETERS_V1,
    PROCUREMENT
  );
  assert.ok(
    (withAr.workingCapital?.overallCashGapUsd ?? 0) < (base.workingCapital?.overallCashGapUsd ?? 0),
    "売掛回収見込みが資金不足額を減らしていない"
  );
  assert.equal(withAr.workingCapital?.expectedArCollectionUsd, 20_000_000);
});

test("Test16-FIN-12: 借入希望額は運転資金不足額であり、実際の借入額は審査が決める", () => {
  const r = buildStandardAiFinancingRequest(observation({ cashUsd: 5_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  const w = r.workingCapital!;
  // AIが申請するのは「経済的に必要な額」と「最低現金バッファ不足額」の大きい方。
  assert.equal(r.financingRequest.desiredAmountUsd, Math.max(w.economicallyDesiredBorrowingUsd, 30_000_000 - 5_000_000));
  // 借入可能枠はobservationに配線されていない（捏造しない）。実際の承認額は
  // financingエンジンのunderwritingが決めるため、ここでは確定しない。
  assert.equal(observation().availableBorrowingHeadroomUsd, undefined);
});

test("Test16-FIN-13: 必要額を超えて借りない（運転資金が充足していれば申請ゼロ）", () => {
  const r = buildStandardAiFinancingRequest(observation({ cashUsd: 200_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, {
    domesticDesiredQuantityTons: 100,
    importOrderedQuantityTons: 0,
  });
  assert.equal(r.financingRequest.desiredAmountUsd, 0);
});

test("Test16-FIN-14: 資金ゲート（国内買付へ充当できる現金割合）はPlayer・AI共通の制約として織り込まれる", () => {
  const ratio = FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio;
  const w = assessWorkingCapitalNeed(observation({ cashUsd: 50_000_000 }), PROCUREMENT, 30_000_000);
  // 現金5,000万のうち、国内買付へ回せるのは ratio 倍だけ。
  assert.equal(w.cashUsableForDomesticProcurementUsd, 50_000_000 * ratio);
  // 40M の買付に対して 50M × ratio では足りず、その差が資金不足として現れる。
  assert.equal(w.domesticProcurementFundingGapUsd, 40_000_000 - 50_000_000 * ratio);
  // このゲートはエンジン側（companyLab/runner.ts）が全社の意思決定へ一律に適用するため、
  // Standard AI だけの裏技にはならない。
  assert.ok(w.projectedWorkingCapitalGapUsd >= w.domesticProcurementFundingGapUsd);
});

// ---------------------------------------------------------------------
// Diagnostics 15〜16
// ---------------------------------------------------------------------

test("Test16-DIAG-15: capex diagnosticsに投資対象設備の稼働率一式が保存される", () => {
  const d = hosoDiagnostic(capex(observation(), pressures()));
  assert.ok(d, "HOSOのcapex diagnosticsが無い");
  for (const key of [
    "relevantCapacity",
    "relevantActualProduction",
    "relevantUtilization",
    "sustainedThreshold",
    "shortfallRatio",
    "financialGate",
    "inventoryGate",
    "ongoingProjectGate",
    "shortfallGate",
    "sustainedGate",
    "finalDecision",
    "legacyOverallEquipmentUtilization",
  ]) {
    assert.ok(key in d!.keyValues!, `capex diagnosticsに ${key} が無い`);
  }
  // 「共通前処理能力の稼働率ではない」ことがメッセージから読み取れる。
  assert.match(d!.message, /共通前処理能力の稼働率ではない/);
});

test("Test16-DIAG-16: 運転資金diagnosticsに指示Hの項目一式が保存される", () => {
  const r = buildStandardAiFinancingRequest(observation({ cashUsd: 5_000_000 }), pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  const entry = r.diagnostics.find((d) => d.code === "WORKING_CAPITAL_ASSESSED");
  assert.ok(entry, "WORKING_CAPITAL_ASSESSED が出ていない");
  for (const key of [
    "cashOnHand",
    "minimumCashBuffer",
    "expectedARCollection",
    "plannedRawProcurementCost",
    "otherNearTermOperatingNeeds",
    "projectedWorkingCapitalGap",
    "economicallyDesiredBorrowing",
    "requestedBorrowing",
    "unfundedWorkingCapitalGapIfNotApproved",
  ]) {
    assert.ok(key in entry!.keyValues!, `運転資金diagnosticsに ${key} が無い`);
  }
});

test("Test16-FIN-追加: 運転資金が不足しているときは任意期限前返済をしない", () => {
  const obs = observation({ cashUsd: 60_000_000, existingLoanBalanceUsd: 20_000_000 });
  // 現金6,000万は voluntaryPrepaymentMultiple 倍の閾値を超えるが、
  // 国内買付40Mに対し使える現金は 6,000万 × ratio しかなく運転資金は不足する。
  const r = buildStandardAiFinancingRequest(obs, pressures(), STANDARD_AI_PARAMETERS_V1, PROCUREMENT);
  assert.ok((r.workingCapital?.projectedWorkingCapitalGapUsd ?? 0) > 0, "この設定では運転資金が不足しているはず");
  assert.equal(r.financingRequest.desiredPrepaymentUsd, 0, "運転資金不足なのに期限前返済しようとしている");
});

// ---------------------------------------------------------------------
// capex現金ゲート（投資額連動方式）
// ---------------------------------------------------------------------

/** 必要現金 = 最低現金バッファ + 投資額 × (1 + capexCostSafetyRatio) */
function requiredCashFor(costUsd: number, ratio: number, targetMinimumCashUsd = 30_000_000): number {
  return targetMinimumCashUsd + costUsd * (1 + ratio);
}

test("Test16-GATE-1: 現金ゲートは投資額に連動し、旧方式より緩いが投資後もバッファを割らない", () => {
  const cost = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.standardBudgetUsd;
  const ratio = STANDARD_AI_PARAMETERS_V1.capexCostSafetyRatio;
  const required = requiredCashFor(cost, ratio);

  // 旧方式（30M × 1.75 = 52.5M）より緩い。
  assert.ok(required < 30_000_000 * STANDARD_AI_PARAMETERS_V1.capexCashSafetyMultiple, `required=${required}`);
  // それでも「投資後に最低現金バッファを割らない」を必ず満たす。
  assert.ok(required - cost >= 30_000_000, "投資後に最低現金バッファを割る水準になっている");
});

test("Test16-GATE-2: 必要現金ちょうど超なら投資し、下回れば見送る", () => {
  const cost = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.standardBudgetUsd;
  const required = requiredCashFor(cost, STANDARD_AI_PARAMETERS_V1.capexCostSafetyRatio);

  const above = capex(observation({ cashUsd: required + 1_000_000 }), pressures());
  assert.ok(
    above.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"),
    "必要現金を上回っているのに投資しない"
  );

  const below = capex(observation({ cashUsd: required - 1_000_000 }), pressures());
  assert.ok(
    !below.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"),
    "必要現金を下回っているのに投資している"
  );
  const d = hosoDiagnostic(below);
  assert.equal(d!.keyValues!.financialGateCashSafe, 0);
  // 借入余力・財務健全性のゲートは維持されており、落ちたのは現金条件だと分かる。
  assert.equal(d!.keyValues!.financialGateBorrowingSafe, 1);
});

test("Test16-GATE-3: 旧方式は投資額と無関係に会社規模だけで必要現金を決める", () => {
  const legacy = { ...STANDARD_AI_PARAMETERS_V1, capexCashGateMode: "legacyMultiple" as const };
  const cash = requiredCashFor(8_000_000, 0.5) + 1_000_000; // 新方式なら投資できる水準
  const r = buildStandardAiCapexDecision(fixture, observation({ cashUsd: cash }), pressures(), HOSO_SHORTFALL, 10000, legacy);
  assert.ok(
    !r.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"),
    "旧方式でも投資できてしまっており、方式の差が出ていない"
  );
  const d = r.diagnostics.find((x) => x.decisionSummary?.startsWith("HOSO"));
  assert.equal(d!.keyValues!.financialGateRequiredCashUsd, 30_000_000 * STANDARD_AI_PARAMETERS_V1.capexCashSafetyMultiple);
});

test("Test16-GATE-4: 借入圧力が高い場合は現金が足りていても投資しない（既存ゲート維持）", () => {
  const cost = CAPEX_PARAMETERS_V1.templatesByType.hosoLineExpansion.standardBudgetUsd;
  const cash = requiredCashFor(cost, STANDARD_AI_PARAMETERS_V1.capexCostSafetyRatio) + 10_000_000;
  const r = capex(observation({ cashUsd: cash }), pressures({ borrowingPressure: 1.2 }));
  assert.ok(!r.capexDecision.newProjectProposals.some((p) => p.projectType === "hosoLineExpansion"));
  const d = hosoDiagnostic(r);
  assert.equal(d!.keyValues!.financialGateCashSafe, 1);
  assert.equal(d!.keyValues!.financialGateBorrowingSafe, 0);
});
