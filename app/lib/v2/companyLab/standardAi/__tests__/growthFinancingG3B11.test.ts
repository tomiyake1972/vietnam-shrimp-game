// ShrimpX V2 — Phase SAI-GROW-3B-1.1 受入: Growth Financing Completion
//
// 3B-1では当期の投資判定を「手元現金のみ（cashBasedHeadroom）」で行っていた。
// しかしengine実測では、承認された通常融資は同一Turn内で
//   closeQuarterWithFinancing（loanDrawUsd）→ balanceSheet.cash
//   → closeQuarterWithCapex の preCapexCashUsd（capexClose.ts）
// という順に流れ、**当期の設備投資支払原資になる**。
// このテストは「安全なDebt-funded growthは可能、危険なレバレッジは不可」を固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCommittedCashRequirement, evaluateInvestmentAffordability } from "../decision/liquidity";
import { buildStandardAiFinancingRequest } from "../decision/finance";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { FinancialRiskTolerance } from "../../vision/types";
import { StandardAiCrisisState } from "../crisisState";

const MILLION = 1_000_000;

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    cashUsd: 30 * MILLION,
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

const PRESSURES: PressureScores = {
  targetMinimumCashUsd: 10 * MILLION,
  borrowingPressure: 0,
  cashPressure: 0,
} as unknown as PressureScores;

function assess(
  obs: Partial<StandardAiObservation> = {},
  riskTolerance: FinancialRiskTolerance | null = "MEDIUM",
  crisisState: StandardAiCrisisState = "NORMAL"
) {
  return assessCommittedCashRequirement({
    observation: observation(obs),
    pressures: PRESSURES,
    params: STANDARD_AI_PARAMETERS_V1,
    procurementCashPlan: { domesticDesiredQuantityTons: 4000, importOrderedQuantityTons: 1000 },
    crisisState,
    financialRiskTolerance: riskTolerance,
  });
}

/** cash-only余力とcurrent-turn余力の「間」に入る当期支払額（＝借入が無ければ不可な額）。 */
function paymentBetweenCashAndFundable(a: ReturnType<typeof assess>): number {
  assert.ok(
    a.currentTurnFundableHeadroomUsd > a.cashBasedHeadroomUsd,
    "この前提（借入で余力が広がる）が崩れている"
  );
  return (a.cashBasedHeadroomUsd + a.currentTurnFundableHeadroomUsd) / 2;
}

// ---------------------------------------------------------------------

test("G3B11-A: Cash単独では当期のCAPEXを実行できない", () => {
  const a = assess();
  const payment = paymentBetweenCashAndFundable(a);
  // cash-onlyの余力を超えている＝現金だけでは払えない。
  assert.ok(payment > a.cashBasedHeadroomUsd, "テスト前提: 現金だけでは足りない額であること");
  const cashOnlyAffordable = a.cashBasedHeadroomUsd - payment >= 0;
  assert.equal(cashOnlyAffordable, false, "現金のみでは実行可能と判定されてはいけない");
});

test("G3B11-B: 同じケースでも健全な信用＋当期調達可能借入があればCAPEX可", () => {
  const a = assess();
  const payment = paymentBetweenCashAndFundable(a);
  const r = evaluateInvestmentAffordability(a, payment, 0, 0, payment, 0);
  assert.equal(r.affordable, true, "健全な借入余力があればDebt-funded growthを許すべき");
  assert.ok(r.currentTurnBorrowingUsedUsd > 0, "借入に依存した額が記録されるべき");
  assert.ok(
    r.currentTurnBorrowingUsedUsd <= a.currentTurnFundableBorrowingUsd + 1e-6,
    "借入依存額が当期調達可能借入を超えてはいけない"
  );
});

test("G3B11-C: 借入前提で承認した投資は、Financing Requestの申請額へ必ず含まれる", () => {
  const obs = observation();
  const a = assess();
  const payment = paymentBetweenCashAndFundable(a);
  const r = evaluateInvestmentAffordability(a, payment, 0, 0, payment, 0);
  assert.equal(r.affordable, true);

  const procurementCashPlan = { domesticDesiredQuantityTons: 4000, importOrderedQuantityTons: 1000 };
  const borrowingNeededUsd = Math.max(0, payment - Math.max(0, a.cashBasedHeadroomUsd));
  assert.ok(borrowingNeededUsd > 0, "テスト前提: 借入に依存していること");

  // 3B-1の経路（fundingBalance + 投資額）だけでは、当期AR回収が資金に数えられるため
  // 申請額が0になり得る。Growth Financing Completionはそれを塞ぐ。
  const withoutGrowth = buildStandardAiFinancingRequest(obs, PRESSURES, STANDARD_AI_PARAMETERS_V1, procurementCashPlan, {
    assessment: a,
    approvedInvestmentPaymentsThisQuarterUsd: payment,
  });
  const withGrowth = buildStandardAiFinancingRequest(obs, PRESSURES, STANDARD_AI_PARAMETERS_V1, procurementCashPlan, {
    assessment: a,
    approvedInvestmentPaymentsThisQuarterUsd: payment,
    approvedInvestmentBorrowingThisQuarterUsd: borrowingNeededUsd,
  });
  assert.equal(withoutGrowth.financingRequest.desiredAmountUsd, 0, "この局面では旧経路の申請額は0（＝完結していなかった）");
  assert.ok(
    withGrowth.financingRequest.desiredAmountUsd >= borrowingNeededUsd - 1e-6,
    "投資が依存した借入額が申請されていない"
  );
  assert.ok(
    withGrowth.financingRequest.desiredAmountUsd <= a.currentTurnFundableBorrowingUsd + 1e-6,
    "投資判断が使った当期調達可能借入を超えて申請してはいけない"
  );
});

test("G3B11-D: underwritingFrozen では B と同じ案件を実行できない", () => {
  const frozen = assess({ lastQuarterUnderwritingFrozen: true });
  const healthy = assess();
  const payment = paymentBetweenCashAndFundable(healthy);
  assert.equal(frozen.currentTurnFundableBorrowingUsd, 0, "審査凍結時は当期調達可能借入を0にすべき");
  const r = evaluateInvestmentAffordability(frozen, payment, 0, 0, payment, 0);
  assert.equal(r.affordable, false, "審査凍結時にDebt-funded growthを許してはいけない");
});

test("G3B11-D2: 重大な信用悪化（tier）でも当期調達可能借入は0", () => {
  for (const tier of ["paymentDefault", "insolvent", "paymentArrears", "covenantBreach"] as const) {
    const a = assess({ lastQuarterFinancialHealthTier: tier });
    assert.equal(a.currentTurnFundableBorrowingUsd, 0, `${tier} で借入を資金に数えてはいけない`);
  }
  const severe = assess({}, "MEDIUM", "SEVERE_DISTRESS");
  assert.equal(severe.currentTurnFundableBorrowingUsd, 0, "SEVERE_DISTRESSで借入を資金に数えてはいけない");
});

test("G3B11-E: LOW financialRiskTolerance ではDebt-funded growthが抑制される", () => {
  const low = assess({}, "LOW");
  assert.equal(low.currentTurnFundableBorrowingUsd, 0, "LOWは借入を成長原資に数えない");
  assert.equal(
    low.currentTurnFundableHeadroomUsd,
    low.cashBasedHeadroomUsd,
    "LOWの当期余力はcash-onlyと一致すべき"
  );
});

test("G3B11-F: HIGH / MEDIUM ではprofileに応じた健全なDebt利用が可能（会社IDのhardcodeなし）", () => {
  const high = assess({}, "HIGH");
  const medium = assess({}, "MEDIUM");
  const low = assess({}, "LOW");
  assert.ok(high.currentTurnFundableBorrowingUsd > medium.currentTurnFundableBorrowingUsd);
  assert.ok(medium.currentTurnFundableBorrowingUsd > low.currentTurnFundableBorrowingUsd);
  // 当期調達可能借入は、常にhorizonの現実的借入余力以下でなければならない。
  for (const a of [high, medium, low]) {
    assert.ok(
      a.currentTurnFundableBorrowingUsd <= a.realisticallyAvailableBorrowingUsd + 1e-6,
      "currentTurnFundableBorrowing <= realisticallyAvailableBorrowing が破れている"
    );
  }
});

test("G3B11-G: 借入込みでもPostInvestmentLiquidityがprotected requirementを割る案件は不可", () => {
  const a = assess();
  // horizon余力を超える大型案件（当期支払は小さいが、総額が流動性を食い潰す）。
  const oversized = a.liquidityHeadroomUsd + 5 * MILLION;
  const r = evaluateInvestmentAffordability(a, oversized, 0, 0, 1 * MILLION, 0);
  assert.equal(r.affordable, false, "horizonで破綻する案件を借入で通してはいけない");
  assert.ok(r.postInvestmentLiquidityUsd < 0);
});

test("G3B11-H: 借入を使っても同一Turnの複数CAPEXがCash/Debtを二重利用しない", () => {
  const a = assess();
  const payment = paymentBetweenCashAndFundable(a);

  // 1件目は通る。
  const first = evaluateInvestmentAffordability(a, payment, 0, 0, payment, 0);
  assert.equal(first.affordable, true);

  // 2件目は、1件目の支払を差し引いた後で評価される（＝同じCash/Debtを再利用できない）。
  const second = evaluateInvestmentAffordability(a, payment, payment, 0, payment, payment);
  assert.equal(second.affordable, false, "同じ当期資金を2件で二重に使えてはいけない");
  assert.ok(second.postInvestmentCashHeadroomUsd < 0);

  // 合計が当期余力の範囲に収まるなら2件とも通る（無条件に1件へ絞るわけではない）。
  const half = payment / 2;
  const s1 = evaluateInvestmentAffordability(a, half, 0, 0, half, 0);
  const s2 = evaluateInvestmentAffordability(a, half, half, 0, half, half);
  assert.equal(s1.affordable, true);
  assert.equal(s2.affordable, true);
});
