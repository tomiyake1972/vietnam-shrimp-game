// ShrimpX V2 — 資金繰りモジュール 銀行審査（Phase 8B-1）
//
// 会社の希望（FinancingRequestInput）をそのまま承認せず、信用スコア・
// 借入限度額・財務制限条項違反状況から、申請額・承認額・否決額・適用金利・
// 満期・返済条件・理由を返す。緊急融資はここでは扱わない（通常融資が
// 不足した場合のみliquidityClose.tsが別途最後の手段として検討する）。

import { PeriodV2, nextPeriod } from "../core/period";
import { CompanyId } from "../sales/types";
import { composeLoanRate } from "./interestRate";
import { FinancingParameters } from "./parameters";
import { BorrowingCapacityResult, CovenantCheckResult, CreditScoreResult, FinancingRequestInput, UnderwritingDecision } from "./types";

function addQuarters(period: PeriodV2, quarters: number): PeriodV2 {
  let p = period;
  for (let i = 0; i < quarters; i++) p = nextPeriod(p);
  return p;
}

export function underwriteLoanApplication(
  companyId: CompanyId,
  period: PeriodV2,
  request: FinancingRequestInput,
  creditScore: CreditScoreResult,
  capacity: BorrowingCapacityResult,
  covenant: CovenantCheckResult,
  hasArrearsHistory: boolean,
  params: FinancingParameters,
  loanIdSeed: string
): UnderwritingDecision {
  const reasons: string[] = [];

  if (request.desiredAmountUsd <= 0) {
    return {
      companyId,
      period,
      requestedAmountUsd: 0,
      approvedAmountUsd: 0,
      deniedAmountUsd: 0,
      appliedAnnualRate: 0,
      repaymentMethod: request.desiredRepaymentMethod,
      reasons: ["申請なし。"],
    };
  }

  if (capacity.underwritingFrozen) {
    reasons.push(`信用区分${creditScore.tier}・借入余力枠停止（binding: ${capacity.bindingConstraint}）により通常融資を承認できません。`);
    return {
      companyId,
      period,
      requestedAmountUsd: request.desiredAmountUsd,
      approvedAmountUsd: 0,
      deniedAmountUsd: request.desiredAmountUsd,
      appliedAnnualRate: 0,
      repaymentMethod: request.desiredRepaymentMethod,
      reasons,
    };
  }

  const approvedAmountUsd = Math.max(0, Math.min(request.desiredAmountUsd, capacity.availableAdditionalCapacityUsd));
  const deniedAmountUsd = request.desiredAmountUsd - approvedAmountUsd;

  const rate = composeLoanRate(
    {
      creditTier: creditScore.tier,
      loanType: request.desiredLoanType,
      isRefinance: false,
      covenantBreach: covenant.anyBreach,
      hasArrearsHistory,
      termQuarters: request.desiredTermQuarters,
    },
    params
  );

  if (approvedAmountUsd < request.desiredAmountUsd) {
    reasons.push(
      `借入余力枠(残り${capacity.availableAdditionalCapacityUsd.toFixed(0)}USD、binding: ${capacity.bindingConstraint})を超える申請のため一部のみ承認。`
    );
  } else {
    reasons.push("借入余力の範囲内のため全額承認。");
  }
  if (covenant.anyBreach) reasons.push("財務制限条項違反により金利加算を適用。");
  if (hasArrearsHistory) reasons.push("延滞履歴により金利加算を適用。");

  return {
    companyId,
    period,
    requestedAmountUsd: request.desiredAmountUsd,
    approvedAmountUsd,
    deniedAmountUsd,
    appliedAnnualRate: rate.totalAnnualRate,
    maturityPeriod: approvedAmountUsd > 0 ? addQuarters(period, Math.max(1, request.desiredTermQuarters)) : undefined,
    repaymentMethod: request.desiredRepaymentMethod,
    approvedLoanId: approvedAmountUsd > 0 ? `${companyId}-LOAN-${period}-${loanIdSeed}` : undefined,
    reasons,
  };
}
