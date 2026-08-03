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

import { PeriodV2, nextPeriod } from "../core/period";
import { CompanyId } from "../sales/types";
import {
  CompanyFinanceState,
  CompanyFinancialQuarterResult,
  FinancingAdjustment,
} from "../finance/types";
import { closeFinancialQuarter, CompanyQuarterBusinessActuals } from "../finance/quarterClose";
import { FinanceParameters } from "../finance/parameters";
import { Product } from "../market/types";
import { computeBorrowingCapacity, CollateralInput, BorrowingCapacityInput } from "./borrowingCapacity";
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
// 【診断専用・observation-only】与信スナップショット／ローン残高ロールフォワード
// の観測フック（2026-08-03、財務診断ブランチ）。
//
// 目的: computeBorrowingCapacity へ実際に渡された入力オブジェクト（同一参照）と、
// closeQuarterWithFinancing 内でのローン残高の遷移（前期末→通常融資実行→
// 緊急融資実行→元金返済→当期末）を、実行中のその時点で・加工せずそのまま
// 捕捉するための登録式コールバック。
//
// 【本番挙動への影響なし】
//   - オブザーバーが未登録(undefined)の場合、既存コードと完全に同一の
//     処理・戻り値・副作用のみが発生する（if (observer) の内側でしか
//     呼ばれないコールバックを追加しただけ）。
//   - コールバックはRNGを消費せず、会社状態・意思決定・戻り値を書き換えない
//     （読み取り専用。渡すオブジェクトはconst代入したものをそのまま使うだけで、
//     computeBorrowingCapacity等への実引数の組み立て方自体は変更していない）。
//   - このファイルの他のエクスポート・計算式は一切変更していない。
// ---------------------------------------------------------------------

/** computeBorrowingCapacity へ実際に渡された入力・結果を、その呼び出し直後にそのまま捕捉したもの。 */
export interface UnderwritingSnapshot {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** computeBorrowingCapacityへ実際に渡された引数オブジェクトそのもの（同一参照）。 */
  readonly borrowingCapacityInput: BorrowingCapacityInput;
  /** computeBorrowingCapacityの戻り値そのもの（同一参照）。 */
  readonly borrowingCapacityResult: BorrowingCapacityResult;
  readonly creditScore: CreditScoreResult;
  readonly covenant: CovenantCheckResult;
  readonly underwriting: UnderwritingDecision;
  readonly requestedAmountUsd: number;
  readonly applicationType: FinancingRequestInput["desiredLoanType"];
}

/** closeQuarterWithFinancing内でのローン残高の遷移を、実際の計算過程からそのまま捕捉したもの。 */
export interface LoanRollForwardSnapshot {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** (1)(2)(3) 前期末＝引受時点＝返済前残高（設計上単一の値。ST/LT内訳つき）。 */
  readonly priorShortTermLoansUsd: number;
  readonly priorLongTermLoansUsd: number;
  readonly priorTotalLoanBalanceUsd: number;
  /** (4)相当: 通常融資の実行額（緊急融資を含まない）。 */
  readonly normalDrawUsd: number;
  /** (5)相当: 緊急融資の実行額。 */
  readonly emergencyDrawUsd: number;
  readonly totalLoanDrawUsd: number;
  readonly scheduledPrincipalDueUsd: number;
  readonly scheduledInterestDueUsd: number;
  /** (6)相当: 実際に支払われた元本額（scheduledPrincipalDueUsd以下のことがある＝現金不足時）。 */
  readonly principalPaidCashUsd: number;
  readonly interestPaidCashUsd: number;
  /** (7) 当期末残高（ST/LT内訳つき）。 */
  readonly endingShortTermLoansUsd: number;
  readonly endingLongTermLoansUsd: number;
  readonly endingTotalLoanBalanceUsd: number;
}

let underwritingSnapshotObserver: ((snapshot: UnderwritingSnapshot) => void) | undefined;
let loanRollForwardObserver: ((snapshot: LoanRollForwardSnapshot) => void) | undefined;

/**
 * 【診断専用】与信スナップショットの観測フックを登録する。
 * `undefined`を渡せば解除（デフォルトは未登録＝本番挙動と完全に同一）。
 */
export function setUnderwritingSnapshotObserver(observer: ((snapshot: UnderwritingSnapshot) => void) | undefined): void {
  underwritingSnapshotObserver = observer;
}

/**
 * 【診断専用】ローン残高ロールフォワードの観測フックを登録する。
 * `undefined`を渡せば解除（デフォルトは未登録＝本番挙動と完全に同一）。
 */
export function setLoanRollForwardObserver(observer: ((snapshot: LoanRollForwardSnapshot) => void) | undefined): void {
  loanRollForwardObserver = observer;
}

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
  // 【診断用】computeBorrowingCapacityへ渡す引数を一度constへ束縛してから呼ぶ
  // （呼び方自体は従来と同じインライン組み立てを変数化しただけで、値・評価順序は不変）。
  // これにより、下のオブザーバーへ「実際に渡されたのと同一の参照」をそのまま渡せる。
  const borrowingCapacityInput: BorrowingCapacityInput = {
    companyId: input.companyId,
    period: input.period,
    collateral: input.collateral,
    ebitdaLikeQuarterlyUsd: ebitdaLike,
    totalEquityUsd: totalEquity,
    existingLoanBalanceUsd: existingLoanBalance,
    creditTier: creditScore.tier,
    severeArrears,
    insolvent,
  };
  const borrowingCapacity = computeBorrowingCapacity(borrowingCapacityInput, params);

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

  if (underwritingSnapshotObserver) {
    underwritingSnapshotObserver({
      companyId: input.companyId,
      period: input.period,
      borrowingCapacityInput,
      borrowingCapacityResult: borrowingCapacity,
      creditScore,
      covenant,
      underwriting,
      requestedAmountUsd: input.financingRequest.desiredAmountUsd,
      applicationType: input.financingRequest.desiredLoanType,
    });
  }

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

/**
 * 【バグ修正（fix/v2-emergency-loan-maturity）】緊急融資の満期を、当期からの
 * termQuarters経過後として算出するための局所ヘルパー。initialPortfolio.ts・
 * bankUnderwriting.tsに存在する同名ヘルパーと同じ実装（重複だが、各モジュールが
 * 依存を増やさず独立して満期計算できるようにする既存の設計慣行に合わせた）。
 * 通常融資の審査（bankUnderwriting.ts）が持つmaturityPeriodは通常融資自身の
 * 希望期間（desiredTermQuarters）から算出されたものであり、緊急融資の期間
 * （params.emergencyLoan.termQuarters）とは無関係。緊急融資の満期は必ずこの
 * 関数で、緊急融資自身のtermQuartersから算出しなければならない
 * （通常融資が否認・未実行の場合でも、緊急融資の満期計算はここで完結する）。
 */
function addQuarters(period: PeriodV2, quarters: number): PeriodV2 {
  let p = period;
  for (let i = 0; i < quarters; i++) p = nextPeriod(p);
  return p;
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
          // 【修正】通常融資の審査結果（plan.underwriting.maturityPeriod）を流用しない。
          // 緊急融資自身のtermQuarters（params.emergencyLoan.termQuarters）から
          // 満期を算出する。通常融資が否認・未実行（plan.underwriting.maturityPeriod
          // がundefined）の場合でも、この計算は独立して成立する。
          maturityPeriod: addQuarters(period, params.emergencyLoan.termQuarters),
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

  if (loanRollForwardObserver) {
    const priorShortTermLoansUsd = priorLoans
      .filter((l) => l.loanType === "workingCapital" || l.loanType === "emergency")
      .reduce((s, l) => s + l.currentPrincipalUsd, 0);
    const priorLongTermLoansUsd = priorLoans.filter((l) => l.loanType === "termLoan").reduce((s, l) => s + l.currentPrincipalUsd, 0);
    loanRollForwardObserver({
      companyId,
      period,
      priorShortTermLoansUsd,
      priorLongTermLoansUsd,
      priorTotalLoanBalanceUsd: priorShortTermLoansUsd + priorLongTermLoansUsd,
      normalDrawUsd,
      emergencyDrawUsd,
      totalLoanDrawUsd,
      scheduledPrincipalDueUsd: scheduledPrincipalDue,
      scheduledInterestDueUsd: fullAccruedInterest,
      principalPaidCashUsd,
      interestPaidCashUsd,
      endingShortTermLoansUsd,
      endingLongTermLoansUsd,
      endingTotalLoanBalanceUsd: endingShortTermLoansUsd + endingLongTermLoansUsd,
    });
  }

  return {
    financeResult: passTwo.result,
    nextFinanceState: passTwo.nextState,
    financingQuarterResult,
    nextFinancingState,
  };
}
