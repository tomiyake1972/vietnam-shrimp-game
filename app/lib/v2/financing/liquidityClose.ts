// ShrimpX V2 — 資金繰りモジュール 四半期資金繰りクローズ（Phase 8B-1）
//
// 【全体の処理順序（実装指示§5.8。既存companyLab runnerの構造に合わせ、
// 銀行の与信判断だけを「当期のturnResult計算より前」に前倒しする）】
//   1. planQuarterFinancing: 期首（前期末の財務状態・融資履歴だけ）で信用スコア・
//      借入限度額・財務制限条項・銀行審査を確定する（当期の市場結果・生産実績は
//      一切参照しない＝銀行は未来を知らない）。
//   2. computeProcurementConstraint: 1の結果（承認済み通常融資枠）と前期末現金から
//      「当期使える現金」を算出し、国内買付（即金）の希望数量を必要なら縮小する。
//      companyLab/runner.tsがこの結果でdecisions[].domesticPurchasePlan等を
//      書き換えてからturnResult以降の既存パイプラインへ渡す。
//   3.（既存パイプライン: 市場・原料・生産・品質・契約履行。本モジュールは
//      一切関与しない。）
//   4. closeQuarterWithFinancing: 当期の事業実績（既存のCompanyQuarterBusinessActuals）
//      から、二段呼び出しでfinance/quarterClose.tsのclosefinancialQuarterを
//      呼び、実際に支払える利息・元本を算出し、緊急融資・延滞・支払不能判定を
//      行い、最終的なPL/BS/CFと次期の財務・資金繰り状態を返す。
//
// 【二段呼び出しで循環を避ける設計】「利息・元本をいくら現金で払えるか」は
// 「当期の営業キャッシュフロー（既存finance/quarterClose.tsのロジック）」に
// 依存するが、そのロジック自体は変更しない（会計計算の二重実装を避ける）。
// そこで closeFinancialQuarter を2回呼ぶ：
//   Pass1（予備）: 新規融資実行は反映するが、利息・元本の現金支払はまだ0とした
//     financingを渡し、返ってきたclosingCashを「デットサービス前に使える現金」
//     として取り出す（PL・税は正しい発生利息で計算されるため、taxの計算だけは
//     正確である。cashはあくまで「利息・元本を払う前」の額）。
//   Pass2（確定）: Pass1の結果から算出した実際の利息・元本の現金支払額を渡し、
//     最終的なPL/BS/CFを確定する。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import {
  CompanyFinanceState,
  CompanyFinancialQuarterResult,
  FinancingAdjustment,
} from "../finance/types";
import { closeFinancialQuarter, CompanyQuarterBusinessActuals } from "../finance/quarterClose";
import { FinanceParameters } from "../finance/parameters";
import { Product } from "../market/types";
import { computeBorrowingCapacity, CollateralInput } from "./borrowingCapacity";
import { computeCreditScore, CreditScoreInput } from "./creditScore";
import { checkCovenants } from "./covenant";
import { underwriteLoanApplication } from "./bankUnderwriting";
import { composeLoanRate } from "./interestRate";
import { computeLoanQuarterlyInterest, computeScheduledPrincipalDue } from "./loanSchedule";
import { FinancingParameters } from "./parameters";
import {
  ArrearsEvent,
  BorrowingCapacityResult,
  CompanyFinancingHistory,
  CompanyFinancingState,
  CovenantCheckResult,
  CreditScoreResult,
  EmergencyLoanResult,
  FinancialHealthStatus,
  FinancialHealthTier,
  FinancingRequestInput,
  LoanRecord,
  ProcurementConstraintResult,
  UnderwritingDecision,
} from "./types";

// ---------------------------------------------------------------------
// 1. 期首の与信判断（planQuarterFinancing）
// ---------------------------------------------------------------------

export interface QuarterFinancingPlanInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly prevFinanceState: CompanyFinanceState;
  readonly prevFinancingState: CompanyFinancingState;
  readonly priorQuarterResult?: CompanyFinancialQuarterResult;
  readonly customerTrustAvg?: number;
  readonly deliveryReliabilityAvg?: number;
  readonly collateral: CollateralInput;
  readonly financingRequest: FinancingRequestInput;
}

export interface QuarterFinancingPlan {
  readonly creditScore: CreditScoreResult;
  readonly borrowingCapacity: BorrowingCapacityResult;
  readonly covenant: CovenantCheckResult;
  readonly underwriting: UnderwritingDecision;
}

function ebitdaLikeFromPriorResult(prior?: CompanyFinancialQuarterResult): number {
  if (!prior) return 0;
  return (prior.profitAndLoss.operatingProfit as number) + (prior.manufacturingCost.depreciationCost as number);
}

/**
 * 期首時点（前期末までの情報だけ）で信用スコア・借入限度額・財務制限条項・
 * 銀行審査を確定する。当期のturnResult（市場・生産実績）は一切受け取らない
 * （関数シグネチャ上、そもそも渡せない＝銀行は未来を知らない）。
 */
export function planQuarterFinancing(input: QuarterFinancingPlanInput, financeParams: FinanceParameters, params: FinancingParameters): QuarterFinancingPlan {
  const fs = input.prevFinanceState;
  const fin = input.prevFinancingState;

  const creditScoreInput: CreditScoreInput = {
    companyId: input.companyId,
    period: input.period,
    financeState: fs,
    priorQuarterResult: input.priorQuarterResult,
    financingHistory: fin.history,
    customerTrustAvg: input.customerTrustAvg,
    deliveryReliabilityAvg: input.deliveryReliabilityAvg,
  };
  const creditScore = computeCreditScore(creditScoreInput, params);

  const totalAssets =
    (fs.cash as number) +
    fs.receivables.reduce((s, r) => s + (r.amount as number), 0) +
    (fs.otherCurrentAssets as number) +
    ((fs.fixedAssetsGross as number) - (fs.accumulatedDepreciation as number)) +
    input.collateral.rawMaterialAvailableUsd +
    input.collateral.rawMaterialInTransitUsd +
    input.collateral.finishedGoodsUsd;
  const totalLiabilities =
    fs.payables.reduce((s, p) => s + (p.amount as number), 0) +
    (fs.shortTermLoans as number) +
    (fs.longTermLoans as number) +
    (fs.otherLiabilities as number) +
    fin.accruedInterestPayableUsd;
  const totalEquity = (fs.capitalStock as number) + (fs.retainedEarnings as number);
  const insolvent = totalEquity < 0;
  const existingLoanBalance = fin.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0);
  const ebitdaLike = ebitdaLikeFromPriorResult(input.priorQuarterResult);
  const priorInterestExpense = input.priorQuarterResult ? (input.priorQuarterResult.profitAndLoss.interestExpense as number) : 0;

  const covenant = checkCovenants(
    {
      companyId: input.companyId,
      period: input.period,
      totalAssetsUsd: totalAssets,
      totalLiabilitiesUsd: totalLiabilities,
      totalEquityUsd: totalEquity,
      ebitdaLikeQuarterlyUsd: ebitdaLike,
      interestExpenseQuarterlyUsd: priorInterestExpense,
      hasArrearsThisPeriod: fin.history.consecutiveArrearsQuarters > 0,
    },
    params
  );

  const severeArrears = fin.history.consecutiveArrearsQuarters >= params.liquidity.paymentDefaultConsecutiveQuartersThreshold;
  const borrowingCapacity = computeBorrowingCapacity(
    {
      companyId: input.companyId,
      period: input.period,
      collateral: input.collateral,
      ebitdaLikeQuarterlyUsd: ebitdaLike,
      totalEquityUsd: totalEquity,
      existingLoanBalanceUsd: existingLoanBalance,
      creditTier: creditScore.tier,
      severeArrears,
      insolvent,
    },
    params
  );

  const underwriting = underwriteLoanApplication(
    input.companyId,
    input.period,
    input.financingRequest,
    creditScore,
    borrowingCapacity,
    covenant,
    fin.history.totalArrearsEventsCount > 0,
    params,
    `${fin.loanPortfolio.loans.length}`
  );

  return { creditScore, borrowingCapacity, covenant, underwriting };
}

// ---------------------------------------------------------------------
// 2. 調達制約（procurement constraint）
// ---------------------------------------------------------------------

export interface ProcurementConstraintInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly originalDomesticPurchaseQuantityTons: number;
  readonly expectedDomesticPriceUsdPerKg: number;
  readonly prevCashUsd: number;
  readonly approvedNormalLoanDrawUsd: number;
  /** 重大な延滞または支払不能状態（輸入発注も抑制する判定に使う）。 */
  readonly severeArrearsOrInsolvent: boolean;
}

/**
 * 国内買付（即金支払）の希望数量を、期首時点で利用可能な流動性
 * （前期末現金＋承認済み通常融資、負の現金は0扱い）に応じて縮小する。
 * 縮小した数量は、既存のproduction/allocation.ts側の原料不足ロジックが
 * そのまま処理するため、生産・在庫・契約履行・品質・会計への一貫した反映は
 * 既存構造にまかせる（本関数は「発注前の希望数量」だけを変える）。
 */
export function computeProcurementConstraint(input: ProcurementConstraintInput, params: FinancingParameters): ProcurementConstraintResult {
  const plannedCashNeedUsd = input.originalDomesticPurchaseQuantityTons * 1000 * input.expectedDomesticPriceUsdPerKg;
  const availableLiquidityUsd =
    Math.max(0, input.prevCashUsd) * params.liquidity.domesticPurchaseCashAllocationRatio + input.approvedNormalLoanDrawUsd;

  const scaleRatio = plannedCashNeedUsd > params.epsilonUsd ? Math.max(0, Math.min(1, availableLiquidityUsd / plannedCashNeedUsd)) : 1;
  const constrainedDomesticPurchaseQuantityTons = input.originalDomesticPurchaseQuantityTons * scaleRatio;
  const unmetDemandUsd = plannedCashNeedUsd * (1 - scaleRatio);

  const importOrdersBlocked = input.severeArrearsOrInsolvent;

  const reason =
    scaleRatio >= 1
      ? "流動性は十分で調達制約は発生していない。"
      : `現金不足のため国内買付を${(scaleRatio * 100).toFixed(0)}%へ縮小（必要${plannedCashNeedUsd.toFixed(0)}USD、利用可能${availableLiquidityUsd.toFixed(0)}USD）。`;

  return {
    companyId: input.companyId,
    period: input.period,
    originalDomesticPurchaseQuantityTons: input.originalDomesticPurchaseQuantityTons,
    plannedCashNeedUsd,
    availableLiquidityUsd,
    scaleRatio,
    constrainedDomesticPurchaseQuantityTons,
    unmetDemandUsd,
    importOrdersBlocked,
    reason,
  };
}

// ---------------------------------------------------------------------
// 3. 四半期資金繰りクローズ（closeQuarterWithFinancing）
// ---------------------------------------------------------------------

export interface CloseQuarterWithFinancingInput {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly prevFinanceState: CompanyFinanceState;
  readonly prevFinancingState: CompanyFinancingState;
  readonly actuals: CompanyQuarterBusinessActuals;
  readonly plan: QuarterFinancingPlan;
  readonly financingRequest: FinancingRequestInput;
  readonly collateralForEmergency: CollateralInput;
}

export interface CloseQuarterWithFinancingOutput {
  readonly financeResult: CompanyFinancialQuarterResult;
  readonly nextFinanceState: CompanyFinanceState;
  readonly financingQuarterResult: import("./types").FinancingQuarterResult;
  readonly nextFinancingState: CompanyFinancingState;
}

function sortByRateDescending(loans: readonly LoanRecord[]): LoanRecord[] {
  return [...loans].sort((a, b) => b.annualInterestRate - a.annualInterestRate);
}

/** ポートフォリオ全体へ、利用可能現金を高金利融資から優先して利息・元本へ配分する。 */
function applyWaterfallAcrossPortfolio(
  loans: readonly LoanRecord[],
  period: PeriodV2,
  availableForInterestUsd: number,
  availableForMandatoryPrincipalUsd: number,
  voluntaryPrepaymentRequestUsd: number
): {
  readonly updatedLoans: LoanRecord[];
  readonly totalInterestPaidUsd: number;
  readonly totalPrincipalPaidUsd: number;
  readonly arrearsEvents: ArrearsEvent[];
} {
  const ordered = sortByRateDescending(loans);
  let remainingInterest = Math.max(0, availableForInterestUsd);
  let remainingPrincipal = Math.max(0, availableForMandatoryPrincipalUsd);
  let totalInterestPaid = 0;
  let totalPrincipalPaid = 0;
  const arrearsEvents: ArrearsEvent[] = [];

  const updated = ordered.map((loan) => {
    const accrued = computeLoanQuarterlyInterest(loan, period);
    const interestPaid = Math.min(accrued, remainingInterest);
    remainingInterest -= interestPaid;
    totalInterestPaid += interestPaid;
    if (accrued - interestPaid > 1e-6) arrearsEvents.push({ loanId: loan.loanId, kind: "interest", amountUsd: accrued - interestPaid });

    const scheduledDue = computeScheduledPrincipalDue(loan, period);
    const principalPaid = Math.min(scheduledDue, remainingPrincipal);
    remainingPrincipal -= principalPaid;
    totalPrincipalPaid += principalPaid;
    if (scheduledDue - principalPaid > 1e-6) arrearsEvents.push({ loanId: loan.loanId, kind: "principal", amountUsd: scheduledDue - principalPaid });

    return {
      loan,
      accrued,
      interestPaid,
      scheduledDue,
      principalPaid,
    };
  });

  // 任意期限前返済: 必須の利息・元本を全額払えた場合のみ、残り現金から高金利融資を追加返済する。
  const allMandatoryMet = arrearsEvents.length === 0;
  let voluntaryRemaining = allMandatoryMet ? Math.max(0, Math.min(voluntaryPrepaymentRequestUsd, remainingPrincipal)) : 0;

  const finalLoans: LoanRecord[] = updated.map((u) => {
    let extraPrincipal = 0;
    if (voluntaryRemaining > 1e-6 && u.loan.currentPrincipalUsd - u.principalPaid > 1e-6) {
      extraPrincipal = Math.min(voluntaryRemaining, u.loan.currentPrincipalUsd - u.principalPaid);
      voluntaryRemaining -= extraPrincipal;
      totalPrincipalPaid += extraPrincipal;
    }
    const totalPrincipalPaidThisLoan = u.principalPaid + extraPrincipal;
    const nextPrincipal = Math.max(0, u.loan.currentPrincipalUsd - totalPrincipalPaidThisLoan);
    const interestShortfall = Math.max(0, u.accrued - u.interestPaid);
    const principalShortfall = Math.max(0, u.scheduledDue - u.principalPaid);
    const status: LoanRecord["status"] =
      nextPrincipal <= 1e-6 && interestShortfall <= 1e-6 ? "closed" : principalShortfall > 1e-6 ? "delinquent" : "current";
    return {
      ...u.loan,
      currentPrincipalUsd: nextPrincipal,
      arrearsPrincipalUsd: u.loan.arrearsPrincipalUsd + principalShortfall,
      arrearsInterestUsd: u.loan.arrearsInterestUsd + interestShortfall,
      status,
    };
  });

  return { updatedLoans: finalLoans, totalInterestPaidUsd: totalInterestPaid, totalPrincipalPaidUsd: totalPrincipalPaid, arrearsEvents };
}

function classifyFinancialHealth(
  insolvent: boolean,
  covenantBreach: boolean,
  hasArrearsThisPeriod: boolean,
  arrearsRatioOfDue: number,
  consecutiveArrearsQuarters: number,
  consecutiveCovenantBreachQuarters: number,
  usedEmergencyLoanThisPeriod: boolean,
  creditTier: "A" | "B" | "C" | "D" | "E",
  params: FinancingParameters
): FinancialHealthStatus {
  const paymentDefault =
    consecutiveArrearsQuarters >= params.liquidity.paymentDefaultConsecutiveQuartersThreshold ||
    (hasArrearsThisPeriod && arrearsRatioOfDue >= params.liquidity.severeArrearsRatioThreshold);
  let primary: FinancialHealthTier;
  if (paymentDefault) primary = "paymentDefault";
  else if (insolvent) primary = "insolvent";
  else if (hasArrearsThisPeriod) primary = "paymentArrears";
  else if (covenantBreach) primary = "covenantBreach";
  else if (usedEmergencyLoanThisPeriod || creditTier === "E") primary = "stressed";
  else if (creditTier === "D") primary = "watch";
  else primary = "healthy";

  return {
    primary,
    insolvent,
    covenantBreach,
    paymentArrears: hasArrearsThisPeriod,
    paymentDefault,
    usedEmergencyLoanThisPeriod,
    consecutiveArrearsQuarters,
    consecutiveCovenantBreachQuarters,
  };
}

/**
 * 当期の事業実績確定後に、実際に支払える利息・元本を算出し、緊急融資・延滞・
 * 支払不能判定を行い、最終的な財務結果・次期の財務・資金繰り状態を返す。
 */
export function closeQuarterWithFinancing(
  input: CloseQuarterWithFinancingInput,
  financeParams: FinanceParameters,
  params: FinancingParameters,
  processingRateByProduct: Readonly<Record<Product, number>>
): CloseQuarterWithFinancingOutput {
  const { companyId, period, prevFinanceState, prevFinancingState, actuals, plan } = input;
  const priorLoans = prevFinancingState.loanPortfolio.loans;

  const fullAccruedInterest = priorLoans.reduce((s, l) => s + computeLoanQuarterlyInterest(l, period), 0);
  const scheduledPrincipalDue = priorLoans.reduce((s, l) => s + computeScheduledPrincipalDue(l, period), 0);

  const normalDrawUsd = plan.underwriting.approvedAmountUsd;
  const newNormalLoan: LoanRecord | undefined =
    normalDrawUsd > 0 && plan.underwriting.approvedLoanId
      ? {
          loanId: plan.underwriting.approvedLoanId,
          companyId,
          loanType: input.financingRequest.desiredLoanType,
          originalPrincipalUsd: normalDrawUsd,
          currentPrincipalUsd: normalDrawUsd,
          originationPeriod: period,
          maturityPeriod: plan.underwriting.maturityPeriod ?? period,
          annualInterestRate: plan.underwriting.appliedAnnualRate,
          creditSpreadAnnual: params.interestRate.creditSpreadAnnualByTier[plan.creditScore.tier],
          repaymentMethod: plan.underwriting.repaymentMethod,
          equalPrincipalInstallmentUsd:
            plan.underwriting.repaymentMethod === "equalPrincipal" && input.financingRequest.desiredTermQuarters > 0
              ? normalDrawUsd / input.financingRequest.desiredTermQuarters
              : 0,
          arrearsPrincipalUsd: 0,
          arrearsInterestUsd: 0,
          status: "current",
          isEmergency: false,
        }
      : undefined;

  // --- Pass1（予備）: 新規融資実行は反映するが利息・元本の現金支払はまだ0 ---
  const beginningAccrued = prevFinancingState.accruedInterestPayableUsd;
  const passOneFinancing: FinancingAdjustment = {
    interestExpenseUsd: fullAccruedInterest,
    interestPaidCashUsd: 0,
    loanDrawUsd: normalDrawUsd,
    principalRepaymentCashUsd: 0,
    endingShortTermLoansUsd: prevFinanceState.shortTermLoans as number,
    endingLongTermLoansUsd: prevFinanceState.longTermLoans as number,
    beginningAccruedInterestPayableUsd: beginningAccrued,
  };
  const passOne = closeFinancialQuarter(prevFinanceState, actuals, financeParams, processingRateByProduct, passOneFinancing);
  const availableForDebtServiceBeforeEmergency = passOne.result.balanceSheet.cash as number;

  // --- 緊急融資の判定（通常融資だけでは利息・必須元本を払いきれない場合の最後の手段） ---
  const shortfallBeforeEmergency = Math.max(0, fullAccruedInterest + scheduledPrincipalDue - Math.max(0, availableForDebtServiceBeforeEmergency));
  let emergencyLoan: EmergencyLoanResult | undefined;
  let emergencyDrawUsd = 0;
  if (shortfallBeforeEmergency > params.epsilonUsd && input.financingRequest.emergencyAcceptable) {
    const eligibleCollateral =
      input.collateralForEmergency.receivablesUsd * params.borrowingCapacity.receivablesHaircut +
      input.collateralForEmergency.rawMaterialAvailableUsd * params.borrowingCapacity.rawMaterialInventoryHaircut +
      input.collateralForEmergency.finishedGoodsUsd * params.borrowingCapacity.finishedGoodsInventoryHaircut;
    const capUsd = Math.min(params.emergencyLoan.absoluteCapUsd, eligibleCollateral * params.emergencyLoan.capRatioOfCollateral);
    const approvedUsd = Math.max(0, Math.min(shortfallBeforeEmergency, capUsd));
    const rate = composeLoanRate(
      { creditTier: plan.creditScore.tier, loanType: "emergency", isRefinance: false, covenantBreach: plan.covenant.anyBreach, hasArrearsHistory: prevFinancingState.history.totalArrearsEventsCount > 0, termQuarters: params.emergencyLoan.termQuarters },
      params
    );
    emergencyLoan = {
      requestedUsd: shortfallBeforeEmergency,
      approvedUsd,
      annualRate: rate.totalAnnualRate,
      capUsd,
      reason: approvedUsd >= shortfallBeforeEmergency - params.epsilonUsd ? "不足額を全額緊急融資で補填。" : "担保・上限により緊急融資は不足額の一部のみ。",
    };
    emergencyDrawUsd = approvedUsd;
  }

  const totalLoanDrawUsd = normalDrawUsd + emergencyDrawUsd;
  const availableForDebtService = availableForDebtServiceBeforeEmergency + emergencyDrawUsd;

  const portfolioForWaterfall = newNormalLoan ? [...priorLoans, newNormalLoan] : [...priorLoans];
  const emergencyLoanRecord: LoanRecord | undefined =
    emergencyDrawUsd > 0
      ? {
          loanId: `${companyId}-LOAN-${period}-emergency`,
          companyId,
          loanType: "emergency",
          originalPrincipalUsd: emergencyDrawUsd,
          currentPrincipalUsd: emergencyDrawUsd,
          originationPeriod: period,
          maturityPeriod: plan.underwriting.maturityPeriod ?? period,
          annualInterestRate: emergencyLoan!.annualRate,
          creditSpreadAnnual: params.interestRate.creditSpreadAnnualByTier[plan.creditScore.tier],
          repaymentMethod: "bulletAtMaturity",
          equalPrincipalInstallmentUsd: 0,
          arrearsPrincipalUsd: 0,
          arrearsInterestUsd: 0,
          status: "current",
          isEmergency: true,
        }
      : undefined;
  const portfolioAfterDraws = emergencyLoanRecord ? [...portfolioForWaterfall, emergencyLoanRecord] : portfolioForWaterfall;

  const availableForInterest = Math.max(0, Math.min(availableForDebtService, fullAccruedInterest));
  const availableForPrincipal = Math.max(0, availableForDebtService - availableForInterest);

  const waterfall = applyWaterfallAcrossPortfolio(
    portfolioAfterDraws,
    period,
    availableForInterest,
    Math.min(availableForPrincipal, scheduledPrincipalDue),
    input.financingRequest.desiredPrepaymentUsd
  );

  const interestPaidCashUsd = waterfall.totalInterestPaidUsd;
  const principalPaidCashUsd = waterfall.totalPrincipalPaidUsd;

  const endingShortTermLoansUsd = waterfall.updatedLoans
    .filter((l) => l.loanType === "workingCapital" || l.loanType === "emergency")
    .reduce((s, l) => s + l.currentPrincipalUsd, 0);
  const endingLongTermLoansUsd = waterfall.updatedLoans.filter((l) => l.loanType === "termLoan").reduce((s, l) => s + l.currentPrincipalUsd, 0);

  // --- Pass2（確定） ---
  const passTwoFinancing: FinancingAdjustment = {
    interestExpenseUsd: fullAccruedInterest,
    interestPaidCashUsd,
    loanDrawUsd: totalLoanDrawUsd,
    principalRepaymentCashUsd: principalPaidCashUsd,
    endingShortTermLoansUsd,
    endingLongTermLoansUsd,
    beginningAccruedInterestPayableUsd: beginningAccrued,
  };
  const passTwo = closeFinancialQuarter(prevFinanceState, actuals, financeParams, processingRateByProduct, passTwoFinancing);

  const endingAccruedInterestPayableUsd = passTwo.result.balanceSheet.accruedInterestPayable as number;

  const hasArrearsThisPeriod = waterfall.arrearsEvents.length > 0;
  const totalDue = fullAccruedInterest + scheduledPrincipalDue;
  const totalUnpaid = waterfall.arrearsEvents.reduce((s, e) => s + e.amountUsd, 0);
  const arrearsRatioOfDue = totalDue > params.epsilonUsd ? totalUnpaid / totalDue : 0;

  const nextConsecutiveArrears = hasArrearsThisPeriod ? prevFinancingState.history.consecutiveArrearsQuarters + 1 : 0;
  const nextConsecutiveCovenantBreach = plan.covenant.anyBreach ? prevFinancingState.history.consecutiveCovenantBreachQuarters + 1 : 0;

  const financialHealth = classifyFinancialHealth(
    passTwo.result.negativeEquity,
    plan.covenant.anyBreach,
    hasArrearsThisPeriod,
    arrearsRatioOfDue,
    nextConsecutiveArrears,
    nextConsecutiveCovenantBreach,
    emergencyDrawUsd > 0,
    plan.creditScore.tier,
    params
  );

  const nextHistory: CompanyFinancingHistory = {
    consecutiveArrearsQuarters: nextConsecutiveArrears,
    consecutiveCovenantBreachQuarters: nextConsecutiveCovenantBreach,
    totalOnTimeRepaymentEventsCount: prevFinancingState.history.totalOnTimeRepaymentEventsCount + (hasArrearsThisPeriod ? 0 : 1),
    totalArrearsEventsCount: prevFinancingState.history.totalArrearsEventsCount + waterfall.arrearsEvents.length,
    totalEmergencyLoanDrawsCount: prevFinancingState.history.totalEmergencyLoanDrawsCount + (emergencyDrawUsd > 0 ? 1 : 0),
    lastFinancialHealth: financialHealth.primary,
  };

  const nextFinancingState: CompanyFinancingState = {
    companyId,
    loanPortfolio: { companyId, loans: waterfall.updatedLoans.filter((l) => l.status !== "closed" || l.currentPrincipalUsd > 0) },
    accruedInterestPayableUsd: endingAccruedInterestPayableUsd,
    history: nextHistory,
  };

  const financingQuarterResult: import("./types").FinancingQuarterResult = {
    companyId,
    period,
    creditScore: plan.creditScore,
    borrowingCapacity: plan.borrowingCapacity,
    underwriting: plan.underwriting,
    covenant: plan.covenant,
    emergencyLoan,
    interestAccrualUsd: fullAccruedInterest,
    interestPaidCashUsd,
    scheduledPrincipalDueUsd: scheduledPrincipalDue,
    principalPaidCashUsd,
    arrearsEvents: waterfall.arrearsEvents,
    financialHealth,
    loanDrawUsd: totalLoanDrawUsd,
    refinancedLoanIds: [],
    endingShortTermLoansUsd,
    endingLongTermLoansUsd,
    endingAccruedInterestPayableUsd,
  };

  return {
    financeResult: passTwo.result,
    nextFinanceState: passTwo.nextState,
    financingQuarterResult,
    nextFinancingState,
  };
}
