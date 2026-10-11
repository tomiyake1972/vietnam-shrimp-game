/**
 * 【再現確認】FINANCE の「任意期限前返済希望額」が実行されない、という実機プレイ
 * （Fable の28Turnプレイ・Turn Xで $22.5M を入れたが約定分 −$1.5M しか減らなかった）
 * の報告を、engine 単体で再現する。推測で直す前に、まず実測する。
 *
 * 条件: 現金は潤沢、既存借入は約定返済のある termLoan（equalPrincipal）1本だけ。
 * 任意繰上返済を 0 / 一部 / 全額 と変えて、期末の借入残高と元本支払額を比べる。
 */
import { period } from "../../app/lib/v2/core/period";
import { FINANCE_PARAMETERS_V1 } from "../../app/lib/v2/finance/parameters";
import { usd, type CompanyFinanceState } from "../../app/lib/v2/finance/types";
import type { CompanyQuarterBusinessActuals } from "../../app/lib/v2/finance/quarterClose";
import {
  closeQuarterWithFinancing,
  planQuarterFinancing,
  type CloseQuarterWithFinancingInput,
  type QuarterFinancingPlanInput,
} from "../../app/lib/v2/financing/liquidityClose";
import { FINANCING_PARAMETERS_V1 } from "../../app/lib/v2/financing/parameters";
import type { CollateralInput } from "../../app/lib/v2/financing/borrowingCapacity";
import type { CompanyFinancingState, FinancingRequestInput, LoanRecord } from "../../app/lib/v2/financing/types";
import type { Product } from "../../app/lib/v2/market/types";

const P1 = period(2015, 1);
const PROCESSING_RATES: Readonly<Record<Product, number>> = { hoso: 350, pd: 520, vap: 780 };

const CASH = 60_000_000;
const LOAN_PRINCIPAL = 40_000_000;
/** equalPrincipal・残20四半期相当。約定返済は 2,000,000/四半期。 */
const SCHEDULED_INSTALLMENT = 2_000_000;

function financeState(): CompanyFinanceState {
  // テスト（financing/__tests__/liquidityClose.test.ts の makeFinanceState）と
  // 同じ形で組み立てる。retainedEarnings は残差として置き、開始BSを一致させる。
  const fixedAssetsGross = 100_000_000;
  const accumulatedDepreciation = 20_000_000;
  const otherCurrentAssets = 0;
  const otherLiabilities = 0;
  const capitalStock = 50_000_000;
  const totalAssets = CASH + otherCurrentAssets + (fixedAssetsGross - accumulatedDepreciation);
  const totalLiabilities = LOAN_PRINCIPAL + otherLiabilities;
  return {
    companyId: "TEST",
    cash: usd(CASH),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(otherCurrentAssets),
    fixedAssetsGross: usd(fixedAssetsGross),
    accumulatedDepreciation: usd(accumulatedDepreciation),
    shortTermLoans: usd(0),
    longTermLoans: usd(LOAN_PRINCIPAL),
    otherLiabilities: usd(otherLiabilities),
    capitalStock: usd(capitalStock),
    retainedEarnings: usd(totalAssets - totalLiabilities - capitalStock),
    distributableEarnings: usd(0),
    finishedGoodsCostLedger: [],
  } as unknown as CompanyFinanceState;
}

function loan(): LoanRecord {
  return {
    loanId: "L-TERM",
    companyId: "TEST",
    loanType: "termLoan",
    originalPrincipalUsd: LOAN_PRINCIPAL,
    currentPrincipalUsd: LOAN_PRINCIPAL,
    originationPeriod: period(2014, 1),
    maturityPeriod: period(2020, 1),
    annualInterestRate: 0.08,
    creditSpreadAnnual: 0.04,
    repaymentMethod: "equalPrincipal",
    equalPrincipalInstallmentUsd: SCHEDULED_INSTALLMENT,
    arrearsPrincipalUsd: 0,
    arrearsInterestUsd: 0,
    status: "current",
    isEmergency: false,
  };
}

function financingState(): CompanyFinancingState {
  return {
    companyId: "TEST",
    loanPortfolio: { companyId: "TEST", loans: [loan()] },
    accruedInterestPayableUsd: 0,
    history: {
      consecutiveArrearsQuarters: 0,
      consecutiveCovenantBreachQuarters: 0,
      totalOnTimeRepaymentEventsCount: 8,
      totalArrearsEventsCount: 0,
      totalEmergencyLoanDrawsCount: 0,
    },
  };
}

function zeroActuals(): CompanyQuarterBusinessActuals {
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
  } as unknown as CompanyQuarterBusinessActuals;
}

const collateral: CollateralInput = {
  receivablesUsd: 20_000_000,
  rawMaterialAvailableUsd: 10_000_000,
  rawMaterialInTransitUsd: 0,
  finishedGoodsUsd: 10_000_000,
};

function run(desiredPrepaymentUsd: number) {
  const request: FinancingRequestInput = {
    desiredAmountUsd: 0,
    desiredLoanType: "termLoan",
    desiredTermQuarters: 20,
    desiredRepaymentMethod: "equalPrincipal",
    desiredPrepaymentUsd,
    emergencyAcceptable: false,
  };
  const fin = financeState();
  const financing = financingState();
  const planInput: QuarterFinancingPlanInput = {
    companyId: "TEST",
    period: P1,
    prevFinanceState: fin,
    prevFinancingState: financing,
    collateral,
    financingRequest: request,
  };
  const quarterPlan = planQuarterFinancing(planInput, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1);
  const input: CloseQuarterWithFinancingInput = {
    companyId: "TEST",
    period: P1,
    prevFinanceState: fin,
    prevFinancingState: financing,
    actuals: zeroActuals(),
    plan: quarterPlan,
    financingRequest: request,
    collateralForEmergency: collateral,
  };
  const out = closeQuarterWithFinancing(input, FINANCE_PARAMETERS_V1, FINANCING_PARAMETERS_V1, PROCESSING_RATES);
  const r = out.financingQuarterResult;
  const endingPrincipal = out.nextFinancingState.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0);
  return {
    desiredPrepaymentUsd,
    scheduledPrincipalDueUsd: r.scheduledPrincipalDueUsd,
    principalPaidCashUsd: r.principalPaidCashUsd,
    endingPrincipal,
    arrears: r.arrearsEvents.length,
  };
}

const M = (n: number) => `$${(n / 1e6).toFixed(2)}M`;
console.log(`期首現金 ${M(CASH)} ／ 期首借入 ${M(LOAN_PRINCIPAL)} ／ 約定返済 ${M(SCHEDULED_INSTALLMENT)}/四半期`);
console.log(["繰上返済の希望額", "約定返済額", "実際の元本支払", "期末借入残高", "延滞件数"].map((h) => h.padStart(18)).join(""));
for (const requested of [0, 5_000_000, 22_500_000, 38_000_000]) {
  const row = run(requested);
  console.log(
    [M(row.desiredPrepaymentUsd), M(row.scheduledPrincipalDueUsd), M(row.principalPaidCashUsd), M(row.endingPrincipal), String(row.arrears)]
      .map((c) => c.padStart(18))
      .join("")
  );
}
