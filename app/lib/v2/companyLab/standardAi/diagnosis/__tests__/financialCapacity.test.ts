// ShrimpX V2 — 2026-08-03 Phase E: Financial Capacity 診断モジュールのテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../policy";
import { buildStandardAiObservation } from "../../observation";
import { computePressureScores } from "../../pressures";
import { CompanyLabConfig } from "../../../types";
import { buildStandardAiFinancialCapacity, scaledProductionPlan, zeroFinancialCapacityPlan } from "../financialCapacity";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "financial-capacity-001", turns: 8, ...overrides };
}

function setupTurn2(companyId = "BAL", seed = "financial-capacity-001") {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const fixture = fixtures.find((f) => f.companyId === companyId)!;
  const publicInfo1 = buildPublicMarketInfo(state);
  const decisionsTurn1: Record<string, ReturnType<typeof generateStandardAiDecisionWithDiagnostics>["decision"]> = {};
  for (const f of fixtures) {
    const own = buildCompanyOwnState(state, f);
    decisionsTurn1[f.companyId] = generateStandardAiDecisionWithDiagnostics(f, own, publicInfo1, state.currentPeriod, 1).decision;
  }
  const nextState = advanceCompanyLabQuarter(state, fixtures, decisionsTurn1);
  const ownState2 = buildCompanyOwnState(nextState, fixture);
  const publicInfo2 = buildPublicMarketInfo(nextState);
  const observation2 = buildStandardAiObservation(fixture, ownState2, publicInfo2, nextState.currentPeriod, 2);
  const pressures2 = computePressureScores(observation2, fixture);
  return { fixture, observation2, pressures2 };
}

test("financial capacity respects AR collection timing（帳簿上の売掛金全額を当期現金として扱わない）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  // receivablesNotYetDueUsdがopeningCashへ加算されていないことを、
  // projectedCashBeforeFinancingがopeningCash+dueThisPeriodのみを起点にしていることで確認する。
  assert.equal(result.receivablesDueThisPeriodUsd, observation2.receivablesDueThisPeriodUsd);
  assert.equal(result.receivablesNotYetDueUsd, observation2.receivablesNotYetDueUsd);
  if (observation2.receivablesNotYetDueUsd > 0) {
    const withoutNotYetDue = observation2.cashUsd + observation2.receivablesDueThisPeriodUsd;
    // projectedCashBeforeFinancingは常にopeningCash+dueThisPeriod以下（各種現金支出を引くため）。
    assert.ok(result.projectedCashBeforeFinancingUsd <= withoutNotYetDue + 1e-6);
  }
});

test("projected cash does not double-count receivables（当期新規の輸入発注はcash outに計上せず、決済期日到来分のみ計上する）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const plan = { ...zeroFinancialCapacityPlan(), importProcurementTons: 1000, importRawPriceUsdPerKgOverride: 3.0 };
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, plan);
  // 当期の輸入キャッシュアウトは既存買掛金の決済分のみ（新規発注1000tの代金3,000,000ドルは含まれない）。
  assert.equal(result.expectedImportCashOutUsd, observation2.payablesDueThisPeriodUsd);
  assert.equal(result.newImportOrdersCreatingFuturePayableUsd, 1000 * 1000 * 3.0);
  assert.notEqual(result.expectedImportCashOutUsd, result.newImportOrdersCreatingFuturePayableUsd);
});

test("unknown inputs remain unknown/null（養殖コスト・追加借入可能額は常にnull、憶測しない）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  assert.equal(result.aquacultureRelatedCashOutUsd, null);
  assert.equal(result.availableBorrowingHeadroomUsd, null);
  assert.ok(result.dataQuality.aquacultureCostUnavailableNote.length > 0);
  assert.ok(result.dataQuality.borrowingHeadroomUnavailableNote.length > 0);
});

test("existing finance parameters are reused verbatim（regularLaborCashOutUsd = headcount × 既存の四半期給与パラメータ）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  assert.equal(result.regularLaborCashOutUsd, observation2.regularHeadcountTotal * 1000); // FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter = 1000
});

test("liquidity warningはprojectedCashAfterPlannedFinancingとtargetMinimumCashUsdの関係で決まる（3区分）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const healthyResult = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  assert.ok(["SUFFICIENT", "BELOW_TARGET_BUFFER", "NEGATIVE_CASH_PROJECTED"].includes(healthyResult.liquidityWarning));

  // 極端に大きい設備投資キャッシュアウトを与えると、必ずNEGATIVE_CASH_PROJECTEDへ落ちることを確認する。
  const hugeCapexPlan = { ...zeroFinancialCapacityPlan(), plannedCapexCashOutUsd: 1e12 };
  const negativeResult = buildStandardAiFinancialCapacity(observation2, pressures2, hugeCapexPlan);
  assert.equal(negativeResult.liquidityWarning, "NEGATIVE_CASH_PROJECTED");
  assert.ok(negativeResult.projectedCashAfterPlannedFinancingUsd < 0);
});

test("quarterLevelLiquidityHeadroomUsdの明示ノートは四半期内の最低残高ではないことを明記している", () => {
  const { observation2, pressures2 } = setupTurn2();
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  assert.match(result.dataQuality.liquidityHeadroomIsQuarterLevelNote, /四半期末/);
  assert.equal(result.quarterLevelLiquidityHeadroomUsd, result.projectedCashAfterPlannedFinancingUsd - pressures2.targetMinimumCashUsd);
});

test("新規借入・任意期限前返済を計画に含めると、projectedCashAfterPlannedFinancingへ反映される", () => {
  const { observation2, pressures2 } = setupTurn2();
  const base = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  const withBorrowing = buildStandardAiFinancialCapacity(observation2, pressures2, {
    ...zeroFinancialCapacityPlan(),
    plannedNewBorrowingUsd: 5_000_000,
  });
  assert.ok(Math.abs(withBorrowing.projectedCashAfterPlannedFinancingUsd - base.projectedCashAfterPlannedFinancingUsd - 5_000_000) < 1e-6);
  assert.equal(withBorrowing.projectedCashBeforeFinancingUsd, base.projectedCashBeforeFinancingUsd); // beforeFinancingは不変
});

test("スケールシナリオ分析: 10,000/15,000/17,000/20,000tでprojectedCashAfterPlannedFinancingが単調に変化する（規模が大きいほど現金消費が増える）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const scales = [10_000, 15_000, 17_000, 20_000];
  const baseMix = { hoso: 0.5, pd: 0.3, vap: 0.2 };
  const results = scales.map((scale) =>
    buildStandardAiFinancialCapacity(observation2, pressures2, scaledProductionPlan(baseMix, scale, { domesticRawPriceUsdPerKgOverride: 2.836 }))
  );
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i].projectedCashBeforeFinancingUsd < results[i - 1].projectedCashBeforeFinancingUsd,
      `scale ${scales[i]} should consume more cash than ${scales[i - 1]}`
    );
  }
});

test("会社IDが一致し、他社データが混入しない", () => {
  const { observation2, pressures2 } = setupTurn2("MASS");
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  assert.equal(result.companyId, "MASS");
});

test("既存融資が無い会社ではinterestCashOutUsd/principalRepaymentCashOutUsdが0（捏造しない、既存データがそのまま反映される）", () => {
  const { observation2, pressures2 } = setupTurn2();
  const result = buildStandardAiFinancialCapacity(observation2, pressures2, zeroFinancialCapacityPlan());
  if (observation2.existingLoanBalanceUsd <= 0) {
    assert.equal(result.interestCashOutUsd, 0);
    assert.equal(result.principalRepaymentCashOutUsd, 0);
  } else {
    assert.ok(result.interestCashOutUsd >= 0);
  }
});
