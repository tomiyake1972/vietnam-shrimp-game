// ShrimpX V2 — 資金繰りモジュール 初期融資ポートフォリオ（Phase 8B-1）
//
// Phase 8Aの初期財務状態（finance/initialState.tsのINITIAL_FINANCE_FIXTURES_V1、
// CompanyFinanceState.shortTermLoans/longTermLoans）を、二重計上せずに
// 融資ポートフォリオへ接続する。各社の既存短期借入金・長期借入金を、
// それぞれ1件の合成融資（満期一括返済の短期融資／元金均等返済の長期融資）
// として表現する。既存の金額そのものはfinance/initialState.tsの値を1件も
// 変更せず、そのまま1対1でLoanRecordへ写すだけなので、初期BSの貸借一致
// （Phase 8A I-1で検証済み）は一切崩れない。

import { PeriodV2, nextPeriod } from "../core/period";
import { CompanyFinanceState } from "../finance/types";
import { FINANCING_PARAMETERS_V1 } from "./parameters";
import { CompanyFinancingState, LoanRecord } from "./types";

/** 長期借入金の暫定満期（校正前の目安。元金均等返済で20四半期＝5年）。 */
const INITIAL_LONG_TERM_LOAN_QUARTERS = 20;
/** 短期借入金の暫定満期（満期一括返済で4四半期＝1年、ロールオーバー想定の暫定値）。 */
const INITIAL_SHORT_TERM_LOAN_QUARTERS = 4;

function addQuarters(period: PeriodV2, quarters: number): PeriodV2 {
  let p = period;
  for (let i = 0; i < quarters; i++) p = nextPeriod(p);
  return p;
}

/**
 * 1社の初期CompanyFinanceState（Phase 8A由来）から、二重計上なしの初期融資
 * ポートフォリオ・初期CompanyFinancingStateを構築する。
 */
export function buildInitialCompanyFinancingState(financeState: CompanyFinanceState, startPeriod: PeriodV2): CompanyFinancingState {
  const loans: LoanRecord[] = [];
  const shortTermPrincipal = financeState.shortTermLoans as number;
  const longTermPrincipal = financeState.longTermLoans as number;

  if (shortTermPrincipal > 0) {
    loans.push({
      loanId: `${financeState.companyId}-LOAN-INITIAL-ST`,
      companyId: financeState.companyId,
      loanType: "workingCapital",
      originalPrincipalUsd: shortTermPrincipal,
      currentPrincipalUsd: shortTermPrincipal,
      originationPeriod: startPeriod,
      maturityPeriod: addQuarters(startPeriod, INITIAL_SHORT_TERM_LOAN_QUARTERS),
      annualInterestRate: FINANCING_PARAMETERS_V1.interestRate.baseRateAnnual + FINANCING_PARAMETERS_V1.interestRate.creditSpreadAnnualByTier.C,
      creditSpreadAnnual: FINANCING_PARAMETERS_V1.interestRate.creditSpreadAnnualByTier.C,
      repaymentMethod: "bulletAtMaturity",
      equalPrincipalInstallmentUsd: 0,
      arrearsPrincipalUsd: 0,
      arrearsInterestUsd: 0,
      status: "current",
      isEmergency: false,
    });
  }
  if (longTermPrincipal > 0) {
    const termQuarters = INITIAL_LONG_TERM_LOAN_QUARTERS;
    loans.push({
      loanId: `${financeState.companyId}-LOAN-INITIAL-LT`,
      companyId: financeState.companyId,
      loanType: "termLoan",
      originalPrincipalUsd: longTermPrincipal,
      currentPrincipalUsd: longTermPrincipal,
      originationPeriod: startPeriod,
      maturityPeriod: addQuarters(startPeriod, termQuarters),
      annualInterestRate: FINANCING_PARAMETERS_V1.interestRate.baseRateAnnual + FINANCING_PARAMETERS_V1.interestRate.creditSpreadAnnualByTier.C,
      creditSpreadAnnual: FINANCING_PARAMETERS_V1.interestRate.creditSpreadAnnualByTier.C,
      repaymentMethod: "equalPrincipal",
      equalPrincipalInstallmentUsd: longTermPrincipal / termQuarters,
      arrearsPrincipalUsd: 0,
      arrearsInterestUsd: 0,
      status: "current",
      isEmergency: false,
    });
  }

  return {
    companyId: financeState.companyId,
    loanPortfolio: { companyId: financeState.companyId, loans },
    accruedInterestPayableUsd: 0,
    history: {
      consecutiveArrearsQuarters: 0,
      consecutiveCovenantBreachQuarters: 0,
      totalOnTimeRepaymentEventsCount: 0,
      totalArrearsEventsCount: 0,
      totalEmergencyLoanDrawsCount: 0,
    },
  };
}
