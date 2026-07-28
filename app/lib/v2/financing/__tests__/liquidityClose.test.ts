// ShrimpX V2 — 資金繰りモジュール 統合テスト（Phase 8B-1）
//
// planQuarterFinancing・computeProcurementConstraint・closeQuarterWithFinancingを
// 通した、資金調達→会計三表接続の受入確認。事業活動は「ゼロ活動四半期」に固定し、
// 融資・利息・元本・延滞・支払不能・債務超過の効果だけを切り分けて検証する。
//
// 対応する重要テスト: 会計三表(21〜29のうち融資関連分)、現金不足(30〜38のうち
// 会計処理・延滞/支払不能区分部分)、資金不足時の処理順序・支払優先順位の
// 実効性検証。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period, nextPeriod } from "../../core/period";
import { Product } from "../../market/types";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { CompanyQuarterBusinessActuals } from "../../finance/quarterClose";
import { CompanyFinanceState, usd } from "../../finance/types";
import {
  closeQuarterWithFinancing,
  CloseQuarterWithFinancingInput,
  computeProcurementConstraint,
  ProcurementConstraintInput,
  planQuarterFinancing,
  QuarterFinancingPlanInput,
} from "../liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { CollateralInput } from "../borrowingCapacity";
import { CompanyFinancingHistory, CompanyFinancingState, FinancingRequestInput, LoanRecord } from "../types";

const P1 = period(2015, 1);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };
const EPS = 1;

/** テスト側で期待値を独立に組み立てるためのヘルパー（liquidityClose.ts内部実装とは無関係）。 */
function addQuartersForExpectation(p: ReturnType<typeof period>, quarters: number): ReturnType<typeof period> {
  let result = p;
  for (let i = 0; i < quarters; i++) result = nextPeriod(result);
  return result;
}

/**
 * テスト用の期首財務状態を生成する。retainedEarnings は明示的に渡さず、
 * 常に「資産合計 - 負債合計 - 資本金」の残差として自動算出する（貸借を
 * 恒常的に一致させ、cash/shortTermLoans等を個別に上書きしても
 * 開始BSが不整合にならないようにする）。
 */
interface FinanceStateFields {
  readonly cash: number;
  readonly otherCurrentAssets: number;
  readonly fixedAssetsGross: number;
  readonly accumulatedDepreciation: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly otherLiabilities: number;
  readonly capitalStock: number;
}

function makeFinanceState(overrides: Partial<FinanceStateFields> = {}): CompanyFinanceState {
  const f: FinanceStateFields = {
    cash: 10_000_000,
    otherCurrentAssets: 0,
    fixedAssetsGross: 40_000_000,
    accumulatedDepreciation: 0,
    shortTermLoans: 0,
    longTermLoans: 0,
    otherLiabilities: 0,
    capitalStock: 30_000_000,
    ...overrides,
  };
  const totalAssets = f.cash + f.otherCurrentAssets + (f.fixedAssetsGross - f.accumulatedDepreciation);
  const totalLiabilities = f.shortTermLoans + f.longTermLoans + f.otherLiabilities;
  const retainedEarnings = totalAssets - totalLiabilities - f.capitalStock;
  return {
    companyId: "TEST",
    cash: usd(f.cash),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(f.otherCurrentAssets),
    fixedAssetsGross: usd(f.fixedAssetsGross),
    accumulatedDepreciation: usd(f.accumulatedDepreciation),
    shortTermLoans: usd(f.shortTermLoans),
    longTermLoans: usd(f.longTermLoans),
    otherLiabilities: usd(f.otherLiabilities),
    capitalStock: usd(f.capitalStock),
    retainedEarnings: usd(retainedEarnings),
    finishedGoodsCostLedger: [],
  };
}

function zeroActuals(overrides: Partial<CompanyQuarterBusinessActuals> = {}): CompanyQuarterBusinessActuals {
  return {
    companyId: "TEST",
    period: P1,
    fulfillmentUsage: [],
    contractTerms: [],
    batches: [],
    regularHeadcount: 0,
    temporaryHeadcount: 0,
    appliedOvertimeRate: 0,
    activeFactoryCount: 0,
    salesForceHeadcount: 0,
    procurementHeadcount: 0,
    domesticPurchasesUsd: 0,
    importOrdersUsd: 0,
    aquacultureHarvestUsd: 0,
    rawMaterialInventoryBeginUsd: 0,
    rawMaterialInventoryEndUsd: 0,
    lotConsumption: [],
    finishedGoodsRemainingByLot: [],
    ...overrides,
  };
}

function makeHistory(overrides: Partial<CompanyFinancingHistory> = {}): CompanyFinancingHistory {
  return {
    consecutiveArrearsQuarters: 0,
    consecutiveCovenantBreachQuarters: 0,
    totalOnTimeRepaymentEventsCount: 4,
    totalArrearsEventsCount: 0,
    totalEmergencyLoanDrawsCount: 0,
    ...overrides,
  };
}

function makeFinancingState(loans: readonly LoanRecord[] = [], historyOverrides: Partial<CompanyFinancingHistory> = {}): CompanyFinancingState {
  return {
    companyId: "TEST",
    loanPortfolio: { companyId: "TEST", loans },
    accruedInterestPayableUsd: 0,
    history: makeHistory(historyOverrides),
  };
}

function makeCollateral(overrides: Partial<CollateralInput> = {}): CollateralInput {
  return { receivablesUsd: 5_000_000, rawMaterialAvailableUsd: 2_000_000, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 2_000_000, ...overrides };
}

function makeRequest(overrides: Partial<FinancingRequestInput> = {}): FinancingRequestInput {
  return {
    desiredAmountUsd: 0,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: 4,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd: 0,
    emergencyAcceptable: false,
    ...overrides,
  };
}

function makeLoan(overrides: Partial<LoanRecord> = {}): LoanRecord {
  return {
    loanId: "L1",
    companyId: "TEST",
    loanType: "workingCapital",
    originalPrincipalUsd: 2_000_000,
    currentPrincipalUsd: 2_000_000,
    originationPeriod: period(2014, 1),
    maturityPeriod: P1,
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

function plan(financeState: CompanyFinanceState, financingState: CompanyFinancingState, request: FinancingRequestInput, collateral = makeCollateral()) {
  const input: QuarterFinancingPlanInput = {
    companyId: "TEST",
    period: P1,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    collateral,
    financingRequest: request,
  };
  return planQuarterFinancing(input, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1);
}

function closeWithFinancing(
  financeState: CompanyFinanceState,
  financingState: CompanyFinancingState,
  request: FinancingRequestInput,
  collateral = makeCollateral(),
  actuals = zeroActuals()
) {
  const p = plan(financeState, financingState, request, collateral);
  const input: CloseQuarterWithFinancingInput = {
    companyId: "TEST",
    period: P1,
    prevFinanceState: financeState,
    prevFinancingState: financingState,
    actuals,
    plan: p,
    financingRequest: request,
    collateralForEmergency: collateral,
  };
  return closeQuarterWithFinancing(input, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1, PROCESSING_RATES);
}

function assertThreeStatementIdentities(output: ReturnType<typeof closeWithFinancing>) {
  const { financeResult, nextFinanceState, financingQuarterResult, nextFinancingState } = output;
  assert.ok(Math.abs(financeResult.balanceSheet.balanceDifference as number) < EPS, `貸借差額: ${financeResult.balanceSheet.balanceDifference}`);
  assert.ok(Math.abs(financeResult.cashFlow.directIndirectDifference as number) < EPS, `直接法/間接法CFOの差: ${financeResult.cashFlow.directIndirectDifference}`);
  assert.ok(
    Math.abs((financeResult.cashFlow.closingCash as number) - ((financeResult.cashFlow.openingCash as number) + (financeResult.cashFlow.netCashChange as number))) < EPS
  );
  assert.ok(Math.abs((nextFinanceState.cash as number) - (financeResult.cashFlow.closingCash as number)) < EPS);
  // 融資ポートフォリオ残高とBS借入残高が一致する。
  const portfolioShortTerm = nextFinancingState.loanPortfolio.loans
    .filter((l) => l.loanType === "workingCapital" || l.loanType === "emergency")
    .reduce((s, l) => s + l.currentPrincipalUsd, 0);
  const portfolioLongTerm = nextFinancingState.loanPortfolio.loans.filter((l) => l.loanType === "termLoan").reduce((s, l) => s + l.currentPrincipalUsd, 0);
  assert.ok(Math.abs(portfolioShortTerm - (nextFinanceState.shortTermLoans as number)) < EPS);
  assert.ok(Math.abs(portfolioLongTerm - (nextFinanceState.longTermLoans as number)) < EPS);
  assert.ok(Math.abs(financingQuarterResult.endingShortTermLoansUsd - (nextFinanceState.shortTermLoans as number)) < EPS);
  assert.ok(Math.abs(financingQuarterResult.endingLongTermLoansUsd - (nextFinanceState.longTermLoans as number)) < EPS);
  assert.ok(Math.abs(financingQuarterResult.endingAccruedInterestPayableUsd - (financeResult.balanceSheet.accruedInterestPayable as number)) < EPS);
  assert.ok(Math.abs(financingQuarterResult.endingAccruedInterestPayableUsd - nextFinancingState.accruedInterestPayableUsd) < EPS);
}

// ---------------------------------------------------------------------
// 1. 調達制約（computeProcurementConstraint）
// ---------------------------------------------------------------------

test("受入確認PC-1: 利用可能な流動性が計画必要現金を上回る場合は調達制約が発生しない（scaleRatio=1）", () => {
  const input: ProcurementConstraintInput = {
    companyId: "TEST",
    period: P1,
    originalDomesticPurchaseQuantityTons: 100,
    expectedDomesticPriceUsdPerKg: 3.0,
    prevCashUsd: 10_000_000,
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };
  const result = computeProcurementConstraint(input, FINANCING_PARAMETERS_V1);
  assert.equal(result.scaleRatio, 1);
  assert.equal(result.constrainedDomesticPurchaseQuantityTons, 100);
  assert.equal(result.unmetDemandUsd, 0);
});

test("受入確認PC-2: 現金が乏しい場合は国内買付希望数量が利用可能流動性の比率で縮小される", () => {
  const input: ProcurementConstraintInput = {
    companyId: "TEST",
    period: P1,
    originalDomesticPurchaseQuantityTons: 1000,
    expectedDomesticPriceUsdPerKg: 3.0, // 計画必要現金 = 1000*1000*3.0 = 3,000,000
    prevCashUsd: 500_000, // 利用可能 = 500,000*0.6 = 300,000
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };
  const result = computeProcurementConstraint(input, FINANCING_PARAMETERS_V1);
  assert.ok(result.scaleRatio < 1 && result.scaleRatio > 0);
  assert.ok(Math.abs(result.constrainedDomesticPurchaseQuantityTons - 1000 * result.scaleRatio) < 0.001);
  assert.ok(result.unmetDemandUsd > 0);
});

test("受入確認PC-3: 承認済み通常融資枠が加わると利用可能流動性が増え、縮小幅が緩和される", () => {
  const base: ProcurementConstraintInput = {
    companyId: "TEST",
    period: P1,
    originalDomesticPurchaseQuantityTons: 1000,
    expectedDomesticPriceUsdPerKg: 3.0,
    prevCashUsd: 500_000,
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: false,
  };
  const withoutLoan = computeProcurementConstraint(base, FINANCING_PARAMETERS_V1);
  const withLoan = computeProcurementConstraint({ ...base, approvedNormalLoanDrawUsd: 1_000_000 }, FINANCING_PARAMETERS_V1);
  assert.ok(withLoan.scaleRatio > withoutLoan.scaleRatio);
});

test("受入確認PC-4: 重大延滞・支払不能の場合は輸入発注も抑制される（importOrdersBlocked=true）", () => {
  const input: ProcurementConstraintInput = {
    companyId: "TEST",
    period: P1,
    originalDomesticPurchaseQuantityTons: 100,
    expectedDomesticPriceUsdPerKg: 3.0,
    prevCashUsd: 10_000_000,
    approvedNormalLoanDrawUsd: 0,
    severeArrearsOrInsolvent: true,
  };
  const result = computeProcurementConstraint(input, FINANCING_PARAMETERS_V1);
  assert.equal(result.importOrdersBlocked, true);
});

// ---------------------------------------------------------------------
// 2. 会計三表への接続（closeQuarterWithFinancing）
// ---------------------------------------------------------------------

test("受入確認FI-1: 新規融資実行は現金と借入金を同額増加させ、貸借・CF恒等式が保たれる", () => {
  const financeState = makeFinanceState({ cash: 2_000_000 });
  const financingState = makeFinancingState([]);
  const request = makeRequest({ desiredAmountUsd: 3_000_000 });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.ok(output.financingQuarterResult.loanDrawUsd > 0, "承認額が0ではないこと（借入余力が十分にある前提）");
  assert.ok(Math.abs((output.financeResult.cashFlow.financingCashFlow as number) - output.financingQuarterResult.loanDrawUsd) < EPS);
  assert.ok(Math.abs((output.nextFinanceState.shortTermLoans as number) - output.financingQuarterResult.loanDrawUsd) < EPS);
  assertThreeStatementIdentities(output);
});

test("受入確認FI-2: 元本返済は現金と借入金を同額減少させ、PLには一切影響しない（利息のみPLに影響する）", () => {
  const loan = makeLoan({ currentPrincipalUsd: 2_000_000, originalPrincipalUsd: 2_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 10_000_000, shortTermLoans: 2_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0 });
  const output = closeWithFinancing(financeState, financingState, request);

  const expectedInterest = 2_000_000 * (0.08 / 4);
  assert.ok(Math.abs(output.financingQuarterResult.interestAccrualUsd - expectedInterest) < EPS);
  assert.ok(Math.abs(output.financingQuarterResult.scheduledPrincipalDueUsd - 2_000_000) < EPS);
  assert.ok(Math.abs(output.financingQuarterResult.principalPaidCashUsd - 2_000_000) < EPS, "潤沢な現金があるため満期到来元本は全額返済される");
  // 元本返済はPL項目に一切現れない: 純利益への影響は支払利息だけである。
  assert.ok(Math.abs((output.financeResult.profitAndLoss.interestExpense as number) - expectedInterest) < EPS);
  assert.ok(Math.abs((output.nextFinanceState.shortTermLoans as number) - 0) < EPS, "全額返済のため期末短期借入金は0");
  assert.ok(
    Math.abs((output.financeResult.cashFlow.financingCashFlow as number) - -2_000_000) < EPS,
    "CFFは元本返済のみを反映（利息はCFOに含まれる）"
  );
  assertThreeStatementIdentities(output);
});

test("受入確認FI-3: 未払利息はBS負債として残り、資金不足で利払いできない分もCF直接法/間接法の一致を保つ", () => {
  // 現金が極めて乏しく、利息も元本も一部しか払えない状況。
  const loan = makeLoan({ currentPrincipalUsd: 2_000_000, originalPrincipalUsd: 2_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 10_000, shortTermLoans: 2_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: false });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.ok(output.financingQuarterResult.arrearsEvents.length > 0, "利息・元本の一部が延滞になっているはず");
  assert.ok(output.financingQuarterResult.interestPaidCashUsd < output.financingQuarterResult.interestAccrualUsd);
  assert.ok((output.financeResult.balanceSheet.accruedInterestPayable as number) > 0, "未払利息はBS負債として残る（消滅しない）");
  assertThreeStatementIdentities(output);
});

// ---------------------------------------------------------------------
// 3. 延滞・支払不能・債務超過・条項違反の区別
// ---------------------------------------------------------------------

test("受入確認FH-1: 純資産マイナス（債務超過）だが借入がなく延滞も条項違反もない場合、primaryは insolvent であり paymentArrears/paymentDefault ではない", () => {
  // otherLiabilitiesを資産合計より十分大きくして、貸借を保ったまま純資産をマイナスにする。
  const financeState = makeFinanceState({ cash: 1_000_000, shortTermLoans: 0, longTermLoans: 0, otherLiabilities: 60_000_000 });
  const financingState = makeFinancingState([]);
  const request = makeRequest({ desiredAmountUsd: 0 });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.financialHealth.insolvent, true);
  assert.equal(output.financingQuarterResult.financialHealth.paymentArrears, false);
  assert.equal(output.financingQuarterResult.financialHealth.paymentDefault, false);
  assert.equal(output.financingQuarterResult.financialHealth.primary, "insolvent");
  assertThreeStatementIdentities(output);
});

test("受入確認FH-2: 支払期日到来分の一部が未払（延滞）だが、単発では paymentDefault にはならず paymentArrears に分類される", () => {
  const loan = makeLoan({ currentPrincipalUsd: 5_000_000, originalPrincipalUsd: 5_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 50_000, shortTermLoans: 5_000_000 });
  const financingState = makeFinancingState([loan], { consecutiveArrearsQuarters: 0 });
  const request = makeRequest({ desiredAmountUsd: 0 });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.financialHealth.paymentArrears, true);
  // 初回の延滞なので、まだpaymentDefault（重大延滞閾値または連続閾値）には達していない可能性が高いことを、
  // 少なくとも連続延滞四半期数が1であることで確認する。
  assert.equal(output.financingQuarterResult.financialHealth.consecutiveArrearsQuarters, 1);
  assertThreeStatementIdentities(output);
});

test("受入確認FH-3: 延滞が既定の連続四半期数に達すると paymentDefault に分類される", () => {
  const loan = makeLoan({ currentPrincipalUsd: 5_000_000, originalPrincipalUsd: 5_000_000, annualInterestRate: 0.08, repaymentMethod: "bulletAtMaturity", maturityPeriod: period(2014, 4) });
  // すでに満期を過ぎている（毎期満額が予定額になる）想定として、maturityPeriodをP1より前にする代わりに、
  // bulletAtMaturityはmaturity以降も満額が予定額になる仕様（computeScheduledPrincipalDue）を利用する。
  const financeState = makeFinanceState({ cash: 0, shortTermLoans: 5_000_000 });
  const threshold = FINANCING_PARAMETERS_V1.liquidity.paymentDefaultConsecutiveQuartersThreshold;
  const financingState = makeFinancingState([loan], { consecutiveArrearsQuarters: threshold - 1 });
  const request = makeRequest({ desiredAmountUsd: 0 });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.financialHealth.paymentArrears, true);
  assert.equal(output.financingQuarterResult.financialHealth.consecutiveArrearsQuarters, threshold);
  assert.equal(output.financingQuarterResult.financialHealth.paymentDefault, true);
  assert.equal(output.financingQuarterResult.financialHealth.primary, "paymentDefault");
  assertThreeStatementIdentities(output);
});

test("受入確認FH-4: 財務制限条項違反のみ（延滞なし・債務超過なし）の場合、primaryは covenantBreach に分類される", () => {
  // 負債比率を最大ラインより悪化させるが、純資産はプラス、借入はなし（延滞なし）にする。
  const financeState = makeFinanceState({
    cash: 1_000_000,
    fixedAssetsGross: 200_000_000,
    capitalStock: 30_000_000,
    otherLiabilities: 180_000_000, // 総資産に対して負債比率を極端に高くする（純資産は自動算出でプラスのまま残る）。
  });
  const financingState = makeFinancingState([]);
  const request = makeRequest({ desiredAmountUsd: 0 });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.financialHealth.insolvent, false, "純資産はプラスのまま（債務超過ではない）");
  assert.equal(output.financingQuarterResult.financialHealth.paymentArrears, false, "延滞となる借入がないため延滞は発生しない");
  assert.equal(output.financingQuarterResult.covenant.anyBreach, true, "負債比率が過大なため財務制限条項違反となるはず");
  assert.equal(output.financingQuarterResult.financialHealth.primary, "covenantBreach");
  assertThreeStatementIdentities(output);
});

// ---------------------------------------------------------------------
// 4. 緊急融資の上限・不要な緊急融資の回避
// ---------------------------------------------------------------------

test("受入確認EM-1: 健全企業（現金潤沢）は不足が発生しないため緊急融資を利用しない", () => {
  const loan = makeLoan({ currentPrincipalUsd: 1_000_000, originalPrincipalUsd: 1_000_000, annualInterestRate: 0.06, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 20_000_000, shortTermLoans: 1_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: true });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.emergencyLoan, undefined);
  assert.equal(output.financingQuarterResult.financialHealth.usedEmergencyLoanThisPeriod, false);
  assertThreeStatementIdentities(output);
});

test("受入確認EM-2: 緊急融資は担保価値・中央パラメータの上限（capUsd）を超えて承認されない", () => {
  const loan = makeLoan({ currentPrincipalUsd: 50_000_000, originalPrincipalUsd: 50_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 0, shortTermLoans: 50_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: true });
  const smallCollateral: CollateralInput = { receivablesUsd: 100_000, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
  const output = closeWithFinancing(financeState, financingState, request, smallCollateral);

  assert.ok(output.financingQuarterResult.emergencyLoan, "巨額の不足が発生するため緊急融資が検討されるはず");
  const em = output.financingQuarterResult.emergencyLoan!;
  assert.ok(em.approvedUsd <= em.capUsd + EPS);
  assert.ok(em.approvedUsd < em.requestedUsd - EPS, "担保不足のため不足額を全額は補えないはず");
  assert.ok(output.financingQuarterResult.arrearsEvents.length > 0, "緊急融資でも補えない分は延滞として残る（自動救済ではない）");
  assertThreeStatementIdentities(output);
});

test("受入確認EM-3: 緊急融資の年率は同一信用区分の通常融資より高い（EM-2のシナリオで確認）", () => {
  const loan = makeLoan({ currentPrincipalUsd: 50_000_000, originalPrincipalUsd: 50_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 0, shortTermLoans: 50_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: true });
  const smallCollateral: CollateralInput = { receivablesUsd: 5_000_000, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
  const output = closeWithFinancing(financeState, financingState, request, smallCollateral);
  const em = output.financingQuarterResult.emergencyLoan!;
  const normalRateForSameTier =
    FINANCING_PARAMETERS_V1.interestRate.baseRateAnnual + FINANCING_PARAMETERS_V1.interestRate.creditSpreadAnnualByTier[output.financingQuarterResult.creditScore.tier];
  assert.ok(em.annualRate > normalRateForSameTier);
});

// ---------------------------------------------------------------------
// 5. 緊急融資の満期（バグ修正回帰: fix/v2-emergency-loan-maturity）
//
// 修正前は、緊急融資の maturityPeriod に「通常融資の審査結果
// (plan.underwriting.maturityPeriod ?? period)」を誤って流用していた。
// 通常融資が否認された四半期は plan.underwriting.maturityPeriod が
// undefined となるため `?? period` で当期そのものが満期となり、緊急融資が
// 実行直後にbulletAtMaturityの満期到来元本として扱われ、同一四半期のうちに
// 延滞（もしくは取り崩し不能な現金不足）を引き起こしていた。
// 修正後は、緊急融資自身の params.emergencyLoan.termQuarters から独立に
// 満期を算出する（通常融資の承認有無・満期とは無関係）。
// ---------------------------------------------------------------------

test("受入確認EM-4（バグ修正回帰）: 通常融資が否認された四半期でも、緊急融資の満期は当期そのものにならず、実行四半期の元本延滞対象にならない", () => {
  const loan = makeLoan({ currentPrincipalUsd: 8_000_000, originalPrincipalUsd: 8_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 1_000_000, shortTermLoans: 8_000_000 });
  const financingState = makeFinancingState([loan]);
  // 通常融資は申請なし（0円）→ plan.underwriting.maturityPeriod は undefined になるはずの場面。
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: true });
  const output = closeWithFinancing(financeState, financingState, request);

  assert.equal(output.financingQuarterResult.underwriting.maturityPeriod, undefined, "前提: 通常融資は否認され、maturityPeriodはundefined");
  assert.ok(output.financingQuarterResult.emergencyLoan, "既存融資の満期到来により緊急融資が発生するはず");

  const emergencyRecord = output.nextFinancingState.loanPortfolio.loans.find((l) => l.loanType === "emergency");
  assert.ok(emergencyRecord, "緊急融資のLoanRecordが融資ポートフォリオに残っているはず");
  const expectedMaturity = addQuartersForExpectation(P1, FINANCING_PARAMETERS_V1.emergencyLoan.termQuarters);
  assert.equal(emergencyRecord!.maturityPeriod, expectedMaturity, "緊急融資の満期は当期(P1)ではなく、当期+termQuarters後であるべき");
  assert.notEqual(emergencyRecord!.maturityPeriod, P1, "満期が実行四半期と同一（＝即時満期扱いのバグ）になっていないこと");
  assert.equal(emergencyRecord!.status, "current", "実行四半期に満期到来元本として扱われ延滞になっていないこと");
  assert.equal(emergencyRecord!.arrearsPrincipalUsd, 0, "緊急融資自身の元本延滞が発生していないこと");
  assert.ok((output.nextFinanceState.cash as number) >= -EPS, "緊急融資後の期末現金が0未満にならないこと（このシナリオでは担保が十分で不足額を全額補える）");
  assertThreeStatementIdentities(output);
});

test("受入確認EM-5（バグ修正回帰）: 通常融資が同一四半期に承認された場合でも、緊急融資の満期は通常融資の満期を流用せず、緊急融資自身のtermQuartersから独立に算出される", () => {
  const loan = makeLoan({ currentPrincipalUsd: 8_000_000, originalPrincipalUsd: 8_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 1_000_000, shortTermLoans: 8_000_000 });
  const financingState = makeFinancingState([loan]);
  // 通常融資も同一四半期に申請・承認される場面（担保を厚くして承認されるようにする）。
  const request = makeRequest({ desiredAmountUsd: 2_000_000, desiredTermQuarters: 4, emergencyAcceptable: true });
  const collateral = makeCollateral({ receivablesUsd: 30_000_000, rawMaterialAvailableUsd: 20_000_000, finishedGoodsUsd: 20_000_000 });
  const output = closeWithFinancing(financeState, financingState, request, collateral);

  assert.ok(output.financingQuarterResult.underwriting.approvedAmountUsd > 0, "前提: 通常融資が同一四半期に承認されている");
  const normalMaturity = output.financingQuarterResult.underwriting.maturityPeriod;
  assert.ok(normalMaturity, "前提: 通常融資のmaturityPeriodが確定している");
  assert.ok(output.financingQuarterResult.emergencyLoan, "既存融資の満期到来により緊急融資も発生するはず");

  const emergencyRecord = output.nextFinancingState.loanPortfolio.loans.find((l) => l.loanType === "emergency");
  assert.ok(emergencyRecord);
  const expectedMaturity = addQuartersForExpectation(P1, FINANCING_PARAMETERS_V1.emergencyLoan.termQuarters);
  assert.equal(emergencyRecord!.maturityPeriod, expectedMaturity, "緊急融資の満期は緊急融資自身のtermQuartersから算出されるべき");
  assert.notEqual(
    emergencyRecord!.maturityPeriod,
    normalMaturity,
    "緊急融資の満期が、同一四半期に承認された通常融資の満期と一致してしまっていないこと（流用の再発防止）"
  );
  assert.equal(emergencyRecord!.status, "current");
  assert.equal(emergencyRecord!.arrearsPrincipalUsd, 0);
  assert.ok((output.nextFinanceState.cash as number) >= -EPS, "緊急融資後の期末現金が0未満にならないこと（通常融資と緊急融資の両方が同一四半期に発生しても成立する）");
  assertThreeStatementIdentities(output);
});

test("受入確認EM-6（バグ修正の影響範囲確認・回帰）: 緊急融資の満期修正は、EM-2（担保不足で緊急融資が不足額の一部しか補えない）シナリオの既存の延滞処理・現金額を変えない", () => {
  // 【重要な注記（本ブランチのスコープ外）】このシナリオ（cash=0・担保がほぼ0・
  // 既存融資50Mが当期満期）では、緊急融資の満期修正の有無にかかわらず、期末現金は
  // マイナス（本テスト実行時点で-765,000USD）になる。これは緊急融資の満期計算とは
  // 無関係な、別の既存メカニズムによるもの: finance/quarterClose.tsのoperatingCashFlow
  // （行896付近）は、企業の期首現金・緊急融資枠に関わらず、SG&A固定費
  // （sellingGeneralAdmin.adminFixedUsdPerQuarter=800,000USD/四半期）を無条件に現金支出
  // として差し引く。一方、元利金の支払（debt service）はapplyWaterfallAcrossPortfolio
  // により「払えない分は延滞（arrears）へ振り替え、現金は0未満にしない」設計になっている
  // が、SG&A固定費にはそのような「現金不足時は繰り延べる」仕組みが存在しない。
  // そのため、担保不足で緊急融資が小額しか承認されない極端なケースでは、
  // 延滞処理そのものは正しく機能していても、期末現金がマイナスになり得る。
  // これは緊急融資の満期バグ（本ブランチで修正した項目②）とは別の、項目①
  // （緊急融資後のマイナス現金）に関連しうる独立した論点であり、このブランチの
  // 修正対象ではない。本テストは「今回の修正がこの挙動を悪化・改善させていない
  // （baseline時点の値と一致する）」ことだけを回帰確認する。
  const loan = makeLoan({ currentPrincipalUsd: 50_000_000, originalPrincipalUsd: 50_000_000, annualInterestRate: 0.08, maturityPeriod: P1 });
  const financeState = makeFinanceState({ cash: 0, shortTermLoans: 50_000_000 });
  const financingState = makeFinancingState([loan]);
  const request = makeRequest({ desiredAmountUsd: 0, emergencyAcceptable: true });
  const smallCollateral: CollateralInput = { receivablesUsd: 100_000, rawMaterialAvailableUsd: 0, rawMaterialInTransitUsd: 0, finishedGoodsUsd: 0 };
  const output = closeWithFinancing(financeState, financingState, request, smallCollateral);

  // 通常融資（今回は申請なし）や既存融資の延滞処理そのものは、緊急融資の満期修正によって変わらない。
  assert.equal(output.financingQuarterResult.underwriting.approvedAmountUsd, 0);
  assert.ok(output.financingQuarterResult.arrearsEvents.length > 0, "担保不足で緊急融資でも補いきれない分は、従来どおり延滞として残る");
  // baseline（修正前コード）でも同じ値になることを別途スクリプトで確認済み（-765,000USD）。
  // ここでは値そのものより「今回の修正で変化していないこと」を固定して回帰検知する。
  assert.ok(Math.abs((output.nextFinanceState.cash as number) - -765_000) < EPS, "この既知シナリオでの期末現金は修正前後で変化しない（-765,000USD）");
  assertThreeStatementIdentities(output);
});
