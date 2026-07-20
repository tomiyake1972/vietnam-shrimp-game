// ShrimpX V2 — 資金繰りモジュール 返済スケジュール（Phase 8B-1）
//
// 満期一括返済（bulletAtMaturity）と元金均等返済（equalPrincipal）の2方式を
// 扱う。元本の返済はPLへ計上しない（発生する利息だけがPL費用）。延滞は
// 「currentPrincipalが予定どおり減らない・利息が未払のまま残る」という
// null-opとして表現し、別建ての残高を持たない（二重計上防止）。

import { PeriodV2 } from "../core/period";
import { annualToQuarterlyRate } from "./interestRate";
import { LoanRecord } from "./types";

/**
 * 1融資・当四半期ぶんの発生利息（未払含む全額）。
 *
 * 【新規実行した四半期は利息を発生させない】closeQuarterWithFinancingは、
 * 当期に新規実行した融資（originationPeriod===period）も同じ四半期の
 * ウォーターフォール（利息・元本の支払配分）へ含める。もし新規融資が
 * 実行直後に即座に1四半期分の利息を発生させると、その利息はどの
 * availableForDebtService算出（当期の資金調達計画時点ではまだ存在しない
 * 融資の利息）にも織り込まれておらず、必ず延滞として誤判定される
 * （借りたその場で「借りた分の利息を返済できなかった」と判定される、
 * という会計・ゲーム上不合理な状態）。したがって、融資の初回四半期
 * （実行した当期）は利息0とし、次の四半期から通常どおり発生させる。
 */
export function computeLoanQuarterlyInterest(loan: LoanRecord, period: PeriodV2): number {
  if (loan.status === "closed") return 0;
  if (loan.originationPeriod === period) return 0;
  return loan.currentPrincipalUsd * annualToQuarterlyRate(loan.annualInterestRate);
}

/**
 * 1融資・当四半期ぶんの予定元本返済額（現金制約を考慮する前の「本来支払うべき額」）。
 *   - bulletAtMaturity: 満期四半期のみcurrentPrincipal全額。それ以外は0。
 *   - equalPrincipal: 満期到達分を含め、毎期equalPrincipalInstallmentUsdを
 *     予定額とする（ただし残元本を超えない）。
 */
export function computeScheduledPrincipalDue(loan: LoanRecord, period: PeriodV2): number {
  if (loan.status === "closed" || loan.currentPrincipalUsd <= 0) return 0;
  if (loan.repaymentMethod === "bulletAtMaturity") {
    return loan.maturityPeriod <= period ? loan.currentPrincipalUsd : 0;
  }
  // equalPrincipal: 満期到達済みなら残元本全額を予定額とする（最終回の端数調整）。
  if (loan.maturityPeriod <= period) return loan.currentPrincipalUsd;
  return Math.min(loan.equalPrincipalInstallmentUsd, loan.currentPrincipalUsd);
}

export interface LoanPaymentApplication {
  readonly loan: LoanRecord;
  readonly interestPaidUsd: number;
  readonly principalPaidUsd: number;
}

/**
 * 1融資へ、実際に支払われた利息・元本を適用し、更新後のLoanRecordを返す
 * （純粋関数）。未払分はcurrentPrincipalが減らない・
 * arrearsPrincipalUsd/arrearsInterestUsdが増える形で表現する。
 * 全額返済（元本0かつ延滞なし）になった場合はstatus="closed"にする。
 */
export function applyLoanPayment(
  loan: LoanRecord,
  scheduledPrincipalDueUsd: number,
  accruedInterestUsd: number,
  application: { readonly interestPaidUsd: number; readonly principalPaidUsd: number }
): LoanRecord {
  const interestShortfall = Math.max(0, accruedInterestUsd - application.interestPaidUsd);
  const principalShortfall = Math.max(0, scheduledPrincipalDueUsd - application.principalPaidUsd);
  const nextPrincipal = Math.max(0, loan.currentPrincipalUsd - application.principalPaidUsd);

  const status: LoanRecord["status"] = nextPrincipal <= 1e-6 && interestShortfall <= 1e-6 ? "closed" : principalShortfall > 1e-6 ? "delinquent" : "current";

  return {
    ...loan,
    currentPrincipalUsd: nextPrincipal,
    arrearsPrincipalUsd: loan.arrearsPrincipalUsd + principalShortfall,
    arrearsInterestUsd: loan.arrearsInterestUsd + interestShortfall,
    status,
  };
}
