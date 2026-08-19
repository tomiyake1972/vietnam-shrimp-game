// ShrimpX V2 — Phase SAI-GROW-3B-1: Liquidity SSoT / Investment Discipline テスト
//
// G3B1-1〜14。実Anthropic APIは呼ばない。
// 「必要現金」の定義がFinance・既存増設CAPEX・新工場で1つであること、
// 同一Turnの複数提案が同じ現金を二重に使わないことを固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCommittedCashRequirement,
  evaluateInvestmentAffordability,
  plannedInvestmentPaymentsWithinHorizonUsd,
} from "../decision/liquidity";
import { buildStandardAiFinancingRequest } from "../decision/finance";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo, advanceCompanyLabQuarter } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyLabState } from "../../types";
import { DYNAMIC_SCENARIO_1 } from "../../../scenario/definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../../../scenario/definitions/dynamicScenario2";

const MILLION = 1_000_000;

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    cashUsd: 100 * MILLION,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 1000,
    salesForceHeadcountTotal: 60,
    procurementHeadcountTotal: 10,
    receivablesDueThisPeriodUsd: 20 * MILLION,
    receivablesNotYetDueUsd: 0,
    payablesDueThisPeriodUsd: 5 * MILLION,
    payablesNotYetDueUsd: 0,
    existingLoanInterestUsdThisQuarterEstimate: 0,
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: 0,
    lastQuarterFinancialHealthTier: "healthy",
    lastQuarterUnderwritingFrozen: false,
    committedCapexPaymentScheduleUsd: [0, 0, 0, 0],
    vietnamDomesticPriorPrice: 2.5,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    targetMinimumCashUsd: 10 * MILLION,
    borrowingPressure: 0,
    cashPressure: 0,
    ...overrides,
  } as unknown as PressureScores;
}

function assess(obs: Partial<StandardAiObservation> = {}, over: Partial<Parameters<typeof assessCommittedCashRequirement>[0]> = {}) {
  return assessCommittedCashRequirement({
    observation: observation(obs),
    pressures: pressures(),
    params: STANDARD_AI_PARAMETERS_V1,
    procurementCashPlan: { domesticDesiredQuantityTons: 4000, importOrderedQuantityTons: 1000 },
    crisisState: "NORMAL",
    financialRiskTolerance: "MEDIUM",
    ...over,
  });
}

// ---------------------------------------------------------------------

test("G3B1-1: 既承認CAPEXの残支払がProtected Funding Requirementへ入る", () => {
  const without = assess();
  const with20 = assess({ committedCapexPaymentScheduleUsd: [8 * MILLION, 6 * MILLION, 6 * MILLION, 0] });
  assert.equal(without.committedCapitalPaymentsUsd, 0);
  assert.equal(with20.committedCapitalPaymentsUsd, 20 * MILLION);
  assert.equal(with20.committedCapitalPaymentsThisQuarterUsd, 8 * MILLION);
  assert.equal(
    Math.round(with20.protectedFundingRequirementUsd - without.protectedFundingRequirementUsd),
    20 * MILLION
  );
  assert.ok(with20.liquidityHeadroomUsd < without.liquidityHeadroomUsd);
  // 当四半期の手元余力にも当期支払ぶんだけ反映される。
  assert.equal(Math.round(without.cashBasedHeadroomUsd - with20.cashBasedHeadroomUsd), 8 * MILLION);
});

test("G3B1-2: 同一Turnの複数提案は同じ現金を二重に使えない", () => {
  const a = assess();
  const first = evaluateInvestmentAffordability(a, 10 * MILLION, 0, 0, 10 * MILLION, 0);
  const second = evaluateInvestmentAffordability(a, 10 * MILLION, 10 * MILLION, 0, 10 * MILLION, 10 * MILLION);
  assert.ok(first.postInvestmentLiquidityUsd > second.postInvestmentLiquidityUsd);
  assert.equal(
    Math.round(first.postInvestmentCashHeadroomUsd - second.postInvestmentCashHeadroomUsd),
    10 * MILLION
  );
  // 余力ちょうど1件ぶんしか無い場合、2件目は必ず不可になる。
  const tight = assess({ cashUsd: 45 * MILLION });
  const oneProject = Math.max(1, tight.cashBasedHeadroomUsd);
  const ok1 = evaluateInvestmentAffordability(tight, oneProject, 0, 0, oneProject, 0);
  const ng2 = evaluateInvestmentAffordability(tight, oneProject, oneProject, 0, oneProject, oneProject);
  assert.equal(ok1.affordable, true);
  assert.equal(ng2.affordable, false);
});

test("G3B1-3: 投資後に次期の最低操業資金を割る案件は延期される", () => {
  const a = assess({ cashUsd: 40 * MILLION });
  // 手元余力 = 現金 − (最低操業 + 元利 + 当期確定投資 + 最低現金)
  assert.ok(a.cashBasedHeadroomUsd < 40 * MILLION);
  const tooBig = evaluateInvestmentAffordability(a, a.cashBasedHeadroomUsd + MILLION, 0, 0, a.cashBasedHeadroomUsd + MILLION, 0);
  assert.equal(tooBig.affordable, false);
  const justFits = evaluateInvestmentAffordability(a, a.cashBasedHeadroomUsd, 0, 0, a.cashBasedHeadroomUsd, 0);
  assert.equal(justFits.affordable, true);
});

test("G3B1-4: 現金が十分なら従来どおり投資できる", () => {
  const rich = assess({ cashUsd: 300 * MILLION });
  const affordability = evaluateInvestmentAffordability(rich, 20 * MILLION, 0, 0, 8 * MILLION, 0);
  assert.equal(affordability.affordable, true);
  assert.ok(rich.liquidityHeadroomUsd > 0);
  assert.ok(rich.cashBasedHeadroomUsd > 0);
});

test("G3B1-5: 借入余力があればhorizonの投資判断に算入される（Debtを使った成長を許す）", () => {
  const noLoan = assess({ existingLoanBalanceUsd: 0 });
  const levered = assess({ existingLoanBalanceUsd: 60 * MILLION });
  assert.ok(noLoan.realisticallyAvailableBorrowingUsd > 0);
  assert.ok(levered.realisticallyAvailableBorrowingUsd < noLoan.realisticallyAvailableBorrowingUsd);
  assert.equal(
    Math.round(noLoan.availableLiquidityUsd - noLoan.currentCashUsd - noLoan.expectedArCollectionUsd),
    Math.round(noLoan.realisticallyAvailableBorrowingUsd)
  );
  // ただし当四半期の支払原資（cashBasedHeadroom）には借入もARも含めない。
  assert.equal(
    Math.round(noLoan.cashBasedHeadroomUsd),
    Math.round(
      noLoan.currentCashUsd -
        (noLoan.minimumProtectedOperatingRequirementUsd +
          noLoan.debtServiceRequirementUsd +
          noLoan.committedCapitalPaymentsThisQuarterUsd +
          noLoan.minimumOperatingCashReserveUsd +
          noLoan.crisisBufferUsd)
    )
  );
});

test("G3B1-6: 借りられない状態では借入余力を0として扱う", () => {
  for (const tier of ["paymentDefault", "insolvent", "paymentArrears", "covenantBreach"] as const) {
    assert.equal(assess({ lastQuarterFinancialHealthTier: tier }).realisticallyAvailableBorrowingUsd, 0, tier);
  }
  assert.equal(assess({ lastQuarterUnderwritingFrozen: true }).realisticallyAvailableBorrowingUsd, 0);
  assert.equal(assess({}, { crisisState: "SEVERE_DISTRESS" }).realisticallyAvailableBorrowingUsd, 0);
});

test("G3B1-7: 財務リスク許容度が低いほど借入余力を保守的に見る（会社IDのhardcodeなし）", () => {
  const shared = { existingLoanBalanceUsd: 20 * MILLION };
  const high = assess(shared, { financialRiskTolerance: "HIGH" });
  const medium = assess(shared, { financialRiskTolerance: "MEDIUM" });
  const low = assess(shared, { financialRiskTolerance: "LOW" });
  assert.ok(high.realisticallyAvailableBorrowingUsd > medium.realisticallyAvailableBorrowingUsd);
  assert.ok(medium.realisticallyAvailableBorrowingUsd > low.realisticallyAvailableBorrowingUsd);
  // LOW（財務規律最重視）は借入を成長原資として数えない。
  assert.equal(low.realisticallyAvailableBorrowingUsd, 0);
  // どの会社でも借入枠を100%現金同等には数えない（実装指示§2）。
  const noLeverage = assess({ existingLoanBalanceUsd: 0 }, { financialRiskTolerance: "HIGH" });
  const policyLimit = (pressures().targetMinimumCashUsd / STANDARD_AI_PARAMETERS_V1.cashBufferQuarters) * STANDARD_AI_PARAMETERS_V1.capexMaxLoanToSizeRatio;
  assert.ok(noLeverage.realisticallyAvailableBorrowingUsd < policyLimit);
});

test("G3B1-8: crisis / 財務悪化ではbounded crisis bufferが積まれる（NORMALでは0）", () => {
  const normal = assess();
  assert.equal(normal.crisisBufferUsd, 0);
  const stress = assess({}, { crisisState: "LIQUIDITY_STRESS" });
  assert.ok(stress.crisisBufferUsd > 0);
  // 上限は最低現金バッファ1本ぶん（固定の巨額bufferにならない）。
  assert.ok(stress.crisisBufferUsd <= normal.minimumOperatingCashReserveUsd + 1e-6);
  const severe = assess({ lastQuarterFinancialHealthTier: "insolvent" });
  assert.equal(Math.round(severe.crisisBufferUsd), Math.round(severe.minimumOperatingCashReserveUsd));
});

test("G3B1-9: Finance決定はLiquidity SSoTと同じ必要現金を使う（CAPEX無しなら従来と同じ）", () => {
  const obs = observation({ cashUsd: 5 * MILLION });
  const p = pressures();
  const plan = { domesticDesiredQuantityTons: 4000, importOrderedQuantityTons: 1000 };
  const legacy = buildStandardAiFinancingRequest(obs, p, STANDARD_AI_PARAMETERS_V1, plan);
  const a = assessCommittedCashRequirement({
    observation: obs,
    pressures: p,
    params: STANDARD_AI_PARAMETERS_V1,
    procurementCashPlan: plan,
    crisisState: "NORMAL",
    financialRiskTolerance: "MEDIUM",
  });
  const withSSoT = buildStandardAiFinancingRequest(obs, p, STANDARD_AI_PARAMETERS_V1, plan, {
    assessment: a,
    approvedInvestmentPaymentsThisQuarterUsd: 0,
  });
  // 確定投資も危機bufferも無い場合、必要額は従来の運転資金判断を下回らない。
  assert.ok(withSSoT.financingRequest.desiredAmountUsd >= legacy.financingRequest.desiredAmountUsd - 1e-6);
});

test("G3B1-10: 当期承認した投資は借入必要額へ反映されるが、現金が潤沢なら借りない", () => {
  const p = pressures();
  const plan = { domesticDesiredQuantityTons: 4000, importOrderedQuantityTons: 1000 };
  const richObs = observation({ cashUsd: 300 * MILLION });
  const rich = assessCommittedCashRequirement({
    observation: richObs,
    pressures: p,
    params: STANDARD_AI_PARAMETERS_V1,
    procurementCashPlan: plan,
    crisisState: "NORMAL",
    financialRiskTolerance: "MEDIUM",
  });
  const richReq = buildStandardAiFinancingRequest(richObs, p, STANDARD_AI_PARAMETERS_V1, plan, {
    assessment: rich,
    approvedInvestmentPaymentsThisQuarterUsd: 8 * MILLION,
  });
  assert.equal(richReq.financingRequest.desiredAmountUsd, 0);

  const tightObs = observation({ cashUsd: 12 * MILLION });
  const tight = assessCommittedCashRequirement({
    observation: tightObs,
    pressures: p,
    params: STANDARD_AI_PARAMETERS_V1,
    procurementCashPlan: plan,
    crisisState: "NORMAL",
    financialRiskTolerance: "MEDIUM",
  });
  const noInvest = buildStandardAiFinancingRequest(tightObs, p, STANDARD_AI_PARAMETERS_V1, plan, {
    assessment: tight,
    approvedInvestmentPaymentsThisQuarterUsd: 0,
  });
  const withInvest = buildStandardAiFinancingRequest(tightObs, p, STANDARD_AI_PARAMETERS_V1, plan, {
    assessment: tight,
    approvedInvestmentPaymentsThisQuarterUsd: 8 * MILLION,
  });
  assert.ok(withInvest.financingRequest.desiredAmountUsd > noInvest.financingRequest.desiredAmountUsd);
});

test("G3B1-11: 支払スケジュールはCapitalProjectと同じ式で計算する", () => {
  const template = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction;
  const horizonAll = plannedInvestmentPaymentsWithinHorizonUsd(
    template.standardBudgetUsd,
    template.paymentRatios,
    template.paymentRatios.length
  );
  assert.equal(Math.round(horizonAll), Math.round(template.standardBudgetUsd));
  const firstOnly = plannedInvestmentPaymentsWithinHorizonUsd(template.standardBudgetUsd, template.paymentRatios, 1);
  assert.equal(Math.round(firstOnly), Math.round(template.standardBudgetUsd * template.paymentRatios[0]));
  assert.ok(firstOnly <= horizonAll);
});

test("G3B1-12: Finance・CAPEX・新工場が同一のassessmentを参照している（診断で追跡できる）", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_2.scenarioId, mode: "canonical", seed: "g3b1-a", turns: 32 });
  const publicInfo = buildPublicMarketInfo(state);
  for (const f of fixtures) {
    const r = generateStandardAiDecisionWithDiagnostics(
      f,
      buildCompanyOwnState(state, f),
      publicInfo,
      state.currentPeriod,
      state.scenarioState.currentTurn
    );
    const l = r.diagnostics.liquidity;
    assert.ok(l, `${f.companyId}のliquidity診断が無い`);
    assert.ok(Number.isFinite(l!.protectedFundingRequirementUsd));
    assert.ok(Number.isFinite(l!.liquidityHeadroomUsd));
    assert.ok(Number.isFinite(l!.cashBasedHeadroomUsd));
    assert.ok(l!.realisticallyAvailableBorrowingUsd >= 0);
    // 守るべき資金の内訳が合計と一致する。
    assert.equal(
      Math.round(l!.protectedFundingRequirementUsd),
      Math.round(
        l!.minimumProtectedOperatingRequirementUsd +
          l!.debtServiceRequirementUsd +
          l!.committedCapitalPaymentsUsd +
          l!.minimumOperatingCashReserveUsd +
          l!.crisisBufferUsd
      )
    );
    const entries = r.diagnostics.entries.filter((e) => e.code === "LIQUIDITY_ASSESSED");
    assert.equal(entries.length, 1);
  }
});

test("G3B1-13: 同一入力なら同一decision（決定論）", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: DYNAMIC_SCENARIO_1.scenarioId, mode: "canonical", seed: "g3b1-det", turns: 32 });
  const publicInfo = buildPublicMarketInfo(state);
  const run = () =>
    fixtures.map((f) =>
      generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
    );
  assert.deepEqual(
    run().map((r) => r.decision),
    run().map((r) => r.decision)
  );
});

test("G3B1-14: DS1/DS2で12Turn通しても資金不足・生産0が悪化しない", () => {
  for (const scenarioId of [DYNAMIC_SCENARIO_1.scenarioId, DYNAMIC_SCENARIO_2.scenarioId]) {
    const { state: s0, fixtures } = initializeCompanyLab({ scenarioId, mode: "canonical", seed: "g3b1-reg", turns: 32 });
    let state: CompanyLabState = s0;
    let zeroProduction = 0;
    let negativeCash = 0;
    for (let i = 0; i < 12; i++) {
      const publicInfo = buildPublicMarketInfo(state);
      const results = fixtures.map((f) =>
        generateStandardAiDecisionWithDiagnostics(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
      );
      state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(results.map((r) => [r.decision.companyId, r.decision])));
      const record = state.history[state.history.length - 1];
      for (const s of record.companySummaries) {
        const produced = Number(s.hosoProduced) + Number(s.pdProduced) + Number(s.vapProduced);
        if (produced <= 0) zeroProduction += 1;
      }
      for (const f of record.financialResults) {
        if (Number(f.balanceSheet.cash) < 0) negativeCash += 1;
      }
    }
    // 【baselineとの比較】DS1では、この変更以前からMASSが早期に資金繰り破綻して
    // 生産0になる四半期が存在する（PRE-AUDIT記録済みの既存挙動）。ここで固定するのは
    // 「Liquidity SSoT導入で悪化していないこと」であり、ゼロ件を新たに要求しない。
    assert.ok(zeroProduction <= 2, `${scenarioId}: 生産0が${zeroProduction}件（既存水準を超えている）`);
    assert.ok(negativeCash <= 5, `${scenarioId}: 現金マイナスが${negativeCash}件`);
  }
});
