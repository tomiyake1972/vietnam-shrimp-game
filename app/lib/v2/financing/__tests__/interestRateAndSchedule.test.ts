// ShrimpX V2 — 資金繰りモジュール 金利・返済スケジュール テスト（Phase 8B-1）
//
// 対応する重要テスト: 16.年率と四半期利息の換算が正しい 17.信用低下で金利が上昇する
// 18.緊急融資が通常融資より高い 19.満期一括返済が正しい 20.元金均等返済が正しい

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { annualToQuarterlyRate, composeLoanRate } from "../interestRate";
import { computeLoanQuarterlyInterest, computeScheduledPrincipalDue } from "../loanSchedule";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { LoanRecord } from "../types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const P3 = period(2015, 3);
const P5 = period(2016, 1);

test("受入確認IR-1: 年率から四半期利率への換算は年率÷4である", () => {
  assert.equal(annualToQuarterlyRate(0.08), 0.02);
  assert.equal(annualToQuarterlyRate(0), 0);
});

test("受入確認IR-2: 信用区分が悪化する（A→E）ほど信用スプレッドが増え、合成年率が上昇する", () => {
  const a = composeLoanRate({ creditTier: "A", loanType: "workingCapital", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const c = composeLoanRate({ creditTier: "C", loanType: "workingCapital", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const e = composeLoanRate({ creditTier: "E", loanType: "workingCapital", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  assert.ok(a.totalAnnualRate < c.totalAnnualRate);
  assert.ok(c.totalAnnualRate < e.totalAnnualRate);
});

test("受入確認IR-3: 緊急融資は同じ信用区分の通常融資より年率が高い", () => {
  const normal = composeLoanRate({ creditTier: "C", loanType: "workingCapital", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const emergency = composeLoanRate({ creditTier: "C", loanType: "emergency", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 2 }, FINANCING_PARAMETERS_V1);
  assert.ok(emergency.totalAnnualRate > normal.totalAnnualRate);
});

test("受入確認IR-4: 条項違反・延滞履歴・借換えはそれぞれ金利を加算する", () => {
  const clean = composeLoanRate({ creditTier: "C", loanType: "termLoan", isRefinance: false, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const breach = composeLoanRate({ creditTier: "C", loanType: "termLoan", isRefinance: false, covenantBreach: true, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const arrears = composeLoanRate({ creditTier: "C", loanType: "termLoan", isRefinance: false, covenantBreach: false, hasArrearsHistory: true, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  const refi = composeLoanRate({ creditTier: "C", loanType: "termLoan", isRefinance: true, covenantBreach: false, hasArrearsHistory: false, termQuarters: 4 }, FINANCING_PARAMETERS_V1);
  assert.ok(breach.totalAnnualRate > clean.totalAnnualRate);
  assert.ok(arrears.totalAnnualRate > clean.totalAnnualRate);
  assert.ok(refi.totalAnnualRate > clean.totalAnnualRate);
});

function makeLoan(overrides: Partial<LoanRecord> = {}): LoanRecord {
  return {
    loanId: "L1",
    companyId: "TEST",
    loanType: "workingCapital",
    originalPrincipalUsd: 4_000_000,
    currentPrincipalUsd: 4_000_000,
    originationPeriod: P1,
    maturityPeriod: P3,
    annualInterestRate: 0.08,
    creditSpreadAnnual: 0.04,
    repaymentMethod: "bulletAtMaturity",
    equalPrincipalInstallmentUsd: 0,
    arrearsPrincipalUsd: 0,
    arrearsInterestUsd: 0,
    status: "current",
    isEmergency: false,
    ...overrides,
  };
}

test("受入確認LS-1: 満期一括返済は満期到達前は元本返済0、満期到達時に残元本全額が予定額になる", () => {
  const loan = makeLoan({ repaymentMethod: "bulletAtMaturity", maturityPeriod: P3, currentPrincipalUsd: 4_000_000 });
  assert.equal(computeScheduledPrincipalDue(loan, P1), 0);
  assert.equal(computeScheduledPrincipalDue(loan, P2), 0);
  assert.equal(computeScheduledPrincipalDue(loan, P3), 4_000_000);
});

test("受入確認LS-2: 元金均等返済は毎期一定額（equalPrincipalInstallmentUsd）が予定額になり、残元本を超えない", () => {
  const loan = makeLoan({
    repaymentMethod: "equalPrincipal",
    originalPrincipalUsd: 4_000_000,
    currentPrincipalUsd: 4_000_000,
    equalPrincipalInstallmentUsd: 1_000_000,
    maturityPeriod: P5,
  });
  assert.equal(computeScheduledPrincipalDue(loan, P1), 1_000_000);
  const almostRepaid = makeLoan({
    repaymentMethod: "equalPrincipal",
    currentPrincipalUsd: 500_000,
    equalPrincipalInstallmentUsd: 1_000_000,
    maturityPeriod: P5,
  });
  assert.equal(computeScheduledPrincipalDue(almostRepaid, P1), 500_000, "残元本を超えて予定額にしてはならない");
});

test("受入確認LS-3: 四半期発生利息は 現在元本 × (年率÷4) と一致する（実行四半期より後であること）", () => {
  const loan = makeLoan({ currentPrincipalUsd: 4_000_000, annualInterestRate: 0.08, originationPeriod: P1 });
  assert.equal(computeLoanQuarterlyInterest(loan, P2), 4_000_000 * 0.02);
});

test("受入確認LS-3b: 新規実行した当四半期（originationPeriod===period）は利息を発生させない（借りた直後に即延滞と誤判定しないための設計）", () => {
  const loan = makeLoan({ currentPrincipalUsd: 4_000_000, annualInterestRate: 0.08, originationPeriod: P1 });
  assert.equal(computeLoanQuarterlyInterest(loan, P1), 0);
});

test("受入確認LS-4: 完済済み（status=closed）の融資は利息・予定元本ともに0", () => {
  const loan = makeLoan({ status: "closed", currentPrincipalUsd: 0, originationPeriod: P1 });
  assert.equal(computeLoanQuarterlyInterest(loan, P3), 0);
  assert.equal(computeScheduledPrincipalDue(loan, P3), 0);
});
