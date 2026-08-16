// ShrimpX V2 — Procurement Planning: procurementCashViewModel のテスト（PROC-CASH-1〜13）
//
// 合成observationを直接組み立てて buildProcurementCashFromObservation を呼ぶ
// （standardAi/__tests__/test16ProductUtilizationAndWorkingCapital.test.ts と
// 同じテストパターン。CompanyFixture/CompanyOwnState全体を組み立てる重い経路は通らない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardAiObservation } from "../../../lib/v2/companyLab/standardAi/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG } from "../../../lib/v2/companyLab/standardAi/decision/workingCapital";
import { FinancialHealthTier } from "../../../lib/v2/financing/types";
import {
  buildProcurementCashFromObservation,
  BuildProcurementCashFromObservationInput,
  PRE_FINANCING_APPROVED_LOAN_DRAW_USD,
} from "../procurementCashViewModel";

const PERIOD = "2026Q2" as never;

const fixture = {
  companyId: "BAL",
  factories: [],
  workerBaseline: [],
} as unknown as CompanyFixture;

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: PERIOD,
    turn: 3,
    outstandingContractByProduct: { hoso: 0, pd: 0, vap: 0 },
    finishedGoodsByProduct: { hoso: 0, pd: 0, vap: 0 },
    rawMaterialAvailable: 0,
    rawMaterialPipeline: 0,
    factories: [],
    totalCapacityByProduct: { hoso: 0, pd: 0, vap: 0 },
    totalCommonProcessingCapacity: 0,
    aquacultureCapacity: 0,
    salesForceHeadcountTotal: 0,
    procurementHeadcountTotal: 0,
    markets: [],
    marketPremiumByProduct: {},
    vietnamDomesticPriorPrice: 2.5,
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 } },
    cashUsd: 200_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 0,
    receivablesDueThisPeriodUsd: 0,
    payablesDueThisPeriodUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    ...overrides,
  } as unknown as StandardAiObservation;
}

function buildInput(overrides: Partial<BuildProcurementCashFromObservationInput> = {}): BuildProcurementCashFromObservationInput {
  return {
    observation: observation(),
    fixture,
    period: PERIOD,
    lastFinancialHealth: undefined,
    domesticDesiredQuantityTons: 1000,
    importOrderedQuantityTons: 500,
    ...overrides,
  };
}

// PROC-CASH-1: 国内調達コストの一致（数量×1000×期待国内価格）
test("PROC-CASH-1: estimatedDomesticProcurementCostUsdは数量×1000×期待国内価格と一致する", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ domesticDesiredQuantityTons: 2000 }));
  const expected = 2000 * 1000 * 2.5;
  assert.ok(Math.abs(vm.estimatedDomesticProcurementCostUsd - expected) < 1e-6);
});

// PROC-CASH-2: 輸入調達コストの一致
test("PROC-CASH-2: estimatedImportProcurementCostUsdは輸入発注量×1000×期待国内価格（代理指標）と一致する", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ importOrderedQuantityTons: 300 }));
  const expected = 300 * 1000 * 2.5;
  assert.ok(Math.abs(vm.estimatedImportProcurementCostUsd - expected) < 1e-6);
});

// PROC-CASH-3: 合計コストの一致
test("PROC-CASH-3: totalPlannedRawProcurementCostUsdは国内+輸入の合計と一致する", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ domesticDesiredQuantityTons: 1000, importOrderedQuantityTons: 500 }));
  assert.ok(Math.abs(vm.totalPlannedRawProcurementCostUsd - (vm.estimatedDomesticProcurementCostUsd + vm.estimatedImportProcurementCostUsd)) < 1e-6);
});

// PROC-CASH-4: 現金潤沢ならfunding gapは0以下（余剰）— assessWorkingCapitalNeedは
// gapを0でクランプしないため、コスト − 利用可能流動性が負（余剰）になり得る。
test("PROC-CASH-4: 現金が十分ならdomesticProcurementFundingGapUsdは0以下（余剰）", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ observation: observation({ cashUsd: 500_000_000 }), domesticDesiredQuantityTons: 100 }));
  assert.ok(vm.domesticProcurementFundingGapUsd <= 0);
  // 制約が発生していないことも同時に確認する（余剰＝制約なし）。
  assert.equal(vm.preFinancingScaleRatio, 1);
});

// PROC-CASH-5: 現金が乏しいとfunding gap > 0
test("PROC-CASH-5: 現金が乏しく国内買付コストが大きいとdomesticProcurementFundingGapUsd > 0", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ observation: observation({ cashUsd: 100 }), domesticDesiredQuantityTons: 1_000_000 }));
  assert.ok(vm.domesticProcurementFundingGapUsd > 0);
});

// PROC-CASH-6: 制約なしのときscaleRatio = 1.0
test("PROC-CASH-6: 流動性が十分なときpreFinancingScaleRatioは1.0で、数量は縮小されない", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ observation: observation({ cashUsd: 500_000_000 }), domesticDesiredQuantityTons: 1000 }));
  assert.equal(vm.preFinancingScaleRatio, 1);
  assert.equal(vm.preFinancingConstrainedDomesticQuantityTons, 1000);
});

// PROC-CASH-7: 流動性不足のときscaleRatio < 1、数量が縮小される
test("PROC-CASH-7: 流動性不足のときpreFinancingScaleRatio < 1で、数量が希望量未満へ縮小される", () => {
  const vm = buildProcurementCashFromObservation(buildInput({ observation: observation({ cashUsd: 1000 }), domesticDesiredQuantityTons: 1_000_000 }));
  assert.ok(vm.preFinancingScaleRatio < 1);
  assert.ok(vm.preFinancingConstrainedDomesticQuantityTons < vm.domesticDesiredQuantityTons);
});

// PROC-CASH-8: lastFinancialHealthが重大延滞・支払不能ならimportOrdersBlocked=true
test("PROC-CASH-8: lastFinancialHealthがpaymentDefault/insolventならimportOrdersBlocked=true", () => {
  const defaultVm = buildProcurementCashFromObservation(buildInput({ lastFinancialHealth: "paymentDefault" as FinancialHealthTier }));
  assert.equal(defaultVm.importOrdersBlocked, true);
  const insolventVm = buildProcurementCashFromObservation(buildInput({ lastFinancialHealth: "insolvent" as FinancialHealthTier }));
  assert.equal(insolventVm.importOrdersBlocked, true);
});

// PROC-CASH-9: 健全・未定義ならimportOrdersBlocked=false
test("PROC-CASH-9: lastFinancialHealthが健全またはundefinedならimportOrdersBlocked=false", () => {
  const healthyVm = buildProcurementCashFromObservation(buildInput({ lastFinancialHealth: "healthy" as FinancialHealthTier }));
  assert.equal(healthyVm.importOrdersBlocked, false);
  const undefinedVm = buildProcurementCashFromObservation(buildInput({ lastFinancialHealth: undefined }));
  assert.equal(undefinedVm.importOrdersBlocked, false);
});

// PROC-CASH-10: approvedNormalLoanDrawUsdは常に0固定
test("PROC-CASH-10: assumptions.approvedNormalLoanDrawUsdは常に0（追加借入承認前）", () => {
  assert.equal(PRE_FINANCING_APPROVED_LOAN_DRAW_USD, 0);
  const vm = buildProcurementCashFromObservation(buildInput());
  assert.equal(vm.assumptions.approvedNormalLoanDrawUsd, 0);
  assert.equal(vm.assumptions.label, "Pre-Financing Procurement Capacity");
});

// PROC-CASH-11: Cash End Forecast相当のfieldが存在しない
test("PROC-CASH-11: Projected/Forecast/Ending Cash相当のフィールドが一切存在しない", () => {
  const vm = buildProcurementCashFromObservation(buildInput());
  const allKeys = [...Object.keys(vm), ...Object.keys(vm.assumptions)];
  const forbiddenPattern = /projected|forecast|endingcash|cashend/i;
  const offending = allKeys.filter((k) => forbiddenPattern.test(k));
  assert.deepEqual(offending, [], `Cash Projection相当のフィールドが含まれている: ${offending.join(", ")}`);
});

// PROC-CASH-12: 期待国内価格が観測できない(turn1等)場合はFALLBACK定数を使う
test("PROC-CASH-12: vietnamDomesticPriorPriceが未定義のとき、FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KGを使う", () => {
  const vm = buildProcurementCashFromObservation(
    buildInput({ observation: observation({ vietnamDomesticPriorPrice: undefined }), domesticDesiredQuantityTons: 1000 })
  );
  const expected = 1000 * 1000 * FALLBACK_EXPECTED_DOMESTIC_PRICE_USD_PER_KG;
  assert.ok(Math.abs(vm.estimatedDomesticProcurementCostUsd - expected) < 1e-6);
});

// PROC-CASH-13: 負値・NaNの入力は0として扱われる
test("PROC-CASH-13: 負値・NaNの数量入力は0として扱われる", () => {
  const vm = buildProcurementCashFromObservation(
    buildInput({ domesticDesiredQuantityTons: -500, importOrderedQuantityTons: Number.NaN })
  );
  assert.equal(vm.domesticDesiredQuantityTons, 0);
  assert.equal(vm.importOrderedQuantityTons, 0);
  assert.equal(vm.estimatedDomesticProcurementCostUsd, 0);
  assert.equal(vm.estimatedImportProcurementCostUsd, 0);
});
