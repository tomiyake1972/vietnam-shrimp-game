// ShrimpX V2 — 資金繰りモジュール 金利計算（Phase 8B-1）
//
// 年率と四半期率を明確に区別する（実装指示§1）。年率→四半期利息への換算は
// 単純な年率÷4（複利ではなく単利の四半期換算）を採用する。四半期単位の
// ゲームで複利効果の精緻化はPhase 8B-2以降の校正対象とする。

import { CreditTier, LoanType } from "./types";
import { FinancingParameters } from "./parameters";

/** 年率 → 四半期利率（単純に4分の1。複利は考慮しない、暫定・要校正）。 */
export function annualToQuarterlyRate(annualRate: number): number {
  return annualRate / 4;
}

export interface RateCompositionInput {
  readonly creditTier: CreditTier;
  readonly loanType: LoanType;
  readonly isRefinance: boolean;
  readonly covenantBreach: boolean;
  readonly hasArrearsHistory: boolean;
  readonly termQuarters: number;
}

export interface RateComposition {
  readonly baseRateAnnual: number;
  readonly creditSpreadAnnual: number;
  readonly emergencySurchargeAnnual: number;
  readonly covenantSurchargeAnnual: number;
  readonly arrearsSurchargeAnnual: number;
  readonly refinanceSurchargeAnnual: number;
  readonly termSurchargeAnnual: number;
  /** 全条件加算の合計年率。 */
  readonly totalAnnualRate: number;
}

/**
 * 年率 = 基準金利 + 信用スプレッド + 条件加算（緊急融資・条項違反・延滞履歴・
 * 借換え・融資期間）の合成。緊急融資でない通常融資では
 * emergencySurchargeAnnual=0。
 */
export function composeLoanRate(input: RateCompositionInput, params: FinancingParameters): RateComposition {
  const baseRateAnnual = params.interestRate.baseRateAnnual;
  const creditSpreadAnnual = params.interestRate.creditSpreadAnnualByTier[input.creditTier];
  const emergencySurchargeAnnual = input.loanType === "emergency" ? params.interestRate.emergencyLoanSurchargeAnnual : 0;
  const covenantSurchargeAnnual = input.covenantBreach ? params.interestRate.covenantBreachSurchargeAnnual : 0;
  const arrearsSurchargeAnnual = input.hasArrearsHistory ? params.interestRate.arrearsHistorySurchargeAnnual : 0;
  const refinanceSurchargeAnnual = input.isRefinance ? params.interestRate.refinanceSurchargeAnnual : 0;
  const termSurchargeAnnual =
    input.loanType === "termLoan" && input.termQuarters > 8 ? params.interestRate.termLoanDurationSurchargeAnnual : 0;

  const totalAnnualRate =
    baseRateAnnual +
    creditSpreadAnnual +
    emergencySurchargeAnnual +
    covenantSurchargeAnnual +
    arrearsSurchargeAnnual +
    refinanceSurchargeAnnual +
    termSurchargeAnnual;

  return {
    baseRateAnnual,
    creditSpreadAnnual,
    emergencySurchargeAnnual,
    covenantSurchargeAnnual,
    arrearsSurchargeAnnual,
    refinanceSurchargeAnnual,
    termSurchargeAnnual,
    totalAnnualRate,
  };
}
