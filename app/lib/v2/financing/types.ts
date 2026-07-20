// ShrimpX V2 — 資金繰り・借入・銀行信用モジュール 型定義（Phase 8B-1）
//
// Phase 8Aのfinance/（原価計算・PL/BS/CF）を実績の唯一の情報源としたまま、
// その上に「銀行は会社の実績を承認時点までしか知らない」資金調達・資金制約
// レイヤーを追加する。本モジュールはPhase 8Aの会計三表を再計算しない
// （finance/types.tsのUsd等をそのまま再利用し、closeFinancialQuarterへは
// FinancingAdjustmentという単一の追加入力を渡すだけで接続する）。
//
// 【銀行が知らない情報】当期の市場結果・当期の売上・当期の生産実績は、
// 銀行の与信判断（信用スコア・借入限度額・引受）には一切使わない。
// 与信判断は常に「前期末までの財務状態・融資履歴」だけを参照する
// （bankUnderwriting.ts・liquidityClose.tsのplanQuarterFinancing参照）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";

export class FinancingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancingValidationError";
  }
}

// ---------------------------------------------------------------------
// 1. 融資ポートフォリオ
// ---------------------------------------------------------------------

export type LoanType = "workingCapital" | "termLoan" | "emergency";
export type RepaymentMethod = "bulletAtMaturity" | "equalPrincipal";
export type LoanStatus = "current" | "delinquent" | "closed";

/**
 * 1件の融資。currentPrincipalは「返済されなかった元本がそのまま残る」ことで
 * 延滞を自然に表現する（延滞元本を別建ての残高として二重計上しない設計。
 * arrearsPrincipalUsdは「今期までに期日到来したのに未返済の元本」の診断用
 * 累計であり、currentPrincipalの一部を指すメモであってBS残高への加算対象ではない）。
 */
export interface LoanRecord {
  readonly loanId: string;
  readonly companyId: CompanyId;
  readonly loanType: LoanType;
  readonly originalPrincipalUsd: number;
  readonly currentPrincipalUsd: number;
  readonly originationPeriod: PeriodV2;
  readonly maturityPeriod: PeriodV2;
  /** 年率（基準金利+信用スプレッド+条件加算の合計）。 */
  readonly annualInterestRate: number;
  /** 年率のうち信用スプレッド部分（診断用メモ）。 */
  readonly creditSpreadAnnual: number;
  readonly repaymentMethod: RepaymentMethod;
  /** 元金均等返済の場合の1回あたり予定元本返済額（満期一括の場合は0。満期時にcurrentPrincipal全額が予定額になる）。 */
  readonly equalPrincipalInstallmentUsd: number;
  /** 期日到来したのに現金で返済できなかった元本の累計（診断用。currentPrincipalの一部）。 */
  readonly arrearsPrincipalUsd: number;
  /** 期日到来したのに現金で支払えなかった利息の累計（診断用。会社全体のaccruedInterestPayableUsdの一部）。 */
  readonly arrearsInterestUsd: number;
  readonly status: LoanStatus;
  readonly isEmergency: boolean;
  /** 借換えで旧融資を返済して実行された場合、旧融資IDを保持する。 */
  readonly refinancedFromLoanId?: string;
}

export interface LoanPortfolio {
  readonly companyId: CompanyId;
  readonly loans: readonly LoanRecord[];
}

// ---------------------------------------------------------------------
// 2. 財務状態の分類
// ---------------------------------------------------------------------

export type FinancialHealthTier = "healthy" | "watch" | "stressed" | "covenantBreach" | "paymentArrears" | "insolvent" | "paymentDefault";

/**
 * 財務状態は複数フラグが同時に成立しうる（例: 債務超過かつ延滞）。primaryは
 * 表示・要約向けの単一区分（優先順位: paymentDefault > insolvent >
 * paymentArrears > covenantBreach > stressed > watch > healthy）。
 */
export interface FinancialHealthStatus {
  readonly primary: FinancialHealthTier;
  /** 純資産がマイナス（債務超過）。直ちに支払不能を意味しない。 */
  readonly insolvent: boolean;
  readonly covenantBreach: boolean;
  /** 当期、期日到来した債務（利息・元本・買掛金）の一部が未払のまま残った。 */
  readonly paymentArrears: boolean;
  /** 延滞が重大（一定額以上）または既定の四半期数を超えて継続している。 */
  readonly paymentDefault: boolean;
  readonly usedEmergencyLoanThisPeriod: boolean;
  readonly consecutiveArrearsQuarters: number;
  readonly consecutiveCovenantBreachQuarters: number;
}

// ---------------------------------------------------------------------
// 3. 銀行信用スコア
// ---------------------------------------------------------------------

export type CreditTier = "A" | "B" | "C" | "D" | "E";

export interface CreditScoreBreakdownItem {
  readonly factor: string;
  readonly weight: number;
  /** この要素の正規化スコア（0〜100）。 */
  readonly normalizedScore0to100: number;
  /** weight × normalizedScore0to100。 */
  readonly weightedContribution: number;
  readonly note: string;
}

export interface CreditScoreResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly score0to100: number;
  readonly tier: CreditTier;
  readonly breakdown: readonly CreditScoreBreakdownItem[];
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------
// 4. 借入限度額
// ---------------------------------------------------------------------

export interface BorrowingCapacityConstraint {
  readonly name: string;
  readonly limitUsd: number;
}

export interface BorrowingCapacityResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 担保価値（適格売掛金＋適格原料在庫＋適格完成品在庫、掛目適用後）に基づく上限。 */
  readonly collateralBasedLimitUsd: number;
  /** 直近の収益力（EBITDA相当）に基づく上限。 */
  readonly earningsBasedLimitUsd: number;
  /** 信用区分による上限（自己資本に対する倍率キャップ）。 */
  readonly creditTierCapUsd: number;
  /** 上記の最小値（既存借入控除前の総枠）。 */
  readonly grossLimitUsd: number;
  readonly existingLoanBalanceUsd: number;
  /** max(0, grossLimit - existingLoanBalance)。underwritingFrozen時は0。 */
  readonly availableAdditionalCapacityUsd: number;
  /** 信用区分E・重大延滞・支払不能等により通常融資を停止している状態。 */
  readonly underwritingFrozen: boolean;
  readonly constraints: readonly BorrowingCapacityConstraint[];
  /** どの制約が最終的に効いたか（"existingLoanBalance"は既存借入控除が支配的だった場合）。 */
  readonly bindingConstraint: string;
}

// ---------------------------------------------------------------------
// 5. 融資意思決定・銀行審査
// ---------------------------------------------------------------------

export interface FinancingRequestInput {
  readonly desiredAmountUsd: number;
  readonly desiredLoanType: LoanType;
  readonly desiredTermQuarters: number;
  readonly desiredRepaymentMethod: RepaymentMethod;
  /** 任意の期限前返済希望額（高金利融資から優先的に返済）。 */
  readonly desiredPrepaymentUsd: number;
  readonly emergencyAcceptable: boolean;
}

export interface UnderwritingDecision {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly requestedAmountUsd: number;
  readonly approvedAmountUsd: number;
  readonly deniedAmountUsd: number;
  readonly appliedAnnualRate: number;
  readonly maturityPeriod?: PeriodV2;
  readonly repaymentMethod: RepaymentMethod;
  readonly approvedLoanId?: string;
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------
// 6. 財務制限条項
// ---------------------------------------------------------------------

export interface CovenantThresholdCheck {
  readonly name: string;
  readonly requiredValue: number;
  readonly actualValue: number;
  readonly breached: boolean;
}

export interface CovenantCheckResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly checks: readonly CovenantThresholdCheck[];
  readonly anyBreach: boolean;
}

// ---------------------------------------------------------------------
// 7. 調達・生産制約
// ---------------------------------------------------------------------

export interface ProcurementConstraintResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly originalDomesticPurchaseQuantityTons: number;
  readonly plannedCashNeedUsd: number;
  readonly availableLiquidityUsd: number;
  /** 0〜1。1なら制約なし。 */
  readonly scaleRatio: number;
  readonly constrainedDomesticPurchaseQuantityTons: number;
  readonly unmetDemandUsd: number;
  /** 重大延滞・支払不能により輸入発注も抑制した場合true。 */
  readonly importOrdersBlocked: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------
// 8. 緊急融資
// ---------------------------------------------------------------------

export interface EmergencyLoanResult {
  readonly requestedUsd: number;
  readonly approvedUsd: number;
  readonly annualRate: number;
  readonly capUsd: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------
// 9. 延滞・履歴・会社状態
// ---------------------------------------------------------------------

export interface ArrearsEvent {
  readonly loanId: string;
  readonly kind: "interest" | "principal";
  readonly amountUsd: number;
}

export interface CompanyFinancingHistory {
  readonly consecutiveArrearsQuarters: number;
  readonly consecutiveCovenantBreachQuarters: number;
  readonly totalOnTimeRepaymentEventsCount: number;
  readonly totalArrearsEventsCount: number;
  readonly totalEmergencyLoanDrawsCount: number;
  readonly lastFinancialHealth?: FinancialHealthTier;
}

export interface CompanyFinancingState {
  readonly companyId: CompanyId;
  readonly loanPortfolio: LoanPortfolio;
  /** 未払利息残高（finance側BSのaccruedInterestPayableの唯一の真実。四半期をまたいで繰り越す）。 */
  readonly accruedInterestPayableUsd: number;
  readonly history: CompanyFinancingHistory;
}

export interface FinancingState {
  readonly companies: readonly CompanyFinancingState[];
}

// ---------------------------------------------------------------------
// 10. 四半期資金繰り結果
// ---------------------------------------------------------------------

export interface FinancingQuarterResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly creditScore: CreditScoreResult;
  readonly borrowingCapacity: BorrowingCapacityResult;
  readonly underwriting: UnderwritingDecision;
  readonly covenant: CovenantCheckResult;
  readonly procurementConstraint?: ProcurementConstraintResult;
  readonly emergencyLoan?: EmergencyLoanResult;
  readonly interestAccrualUsd: number;
  readonly interestPaidCashUsd: number;
  readonly scheduledPrincipalDueUsd: number;
  readonly principalPaidCashUsd: number;
  readonly arrearsEvents: readonly ArrearsEvent[];
  readonly financialHealth: FinancialHealthStatus;
  readonly loanDrawUsd: number;
  readonly refinancedLoanIds: readonly string[];
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  readonly endingAccruedInterestPayableUsd: number;
}
