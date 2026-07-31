// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 資金繰りドメイン
//
// 【基本方針（実装指示 §資金繰り）】
//   - 会社規模連動の最低現金バッファ（pressures.targetMinimumCashUsd。
//     parameters.tsのestimateTargetMinimumCashUsd参照。全社一律の絶対額は使わない）を
//     下回る見込みなら、その差額を通常融資として申請する。
//   - 現金が十分（最低バッファのvoluntaryPrepaymentMultiple倍を超過）で既存借入が
//     あれば、超過分を任意期限前返済として申請する。
//   - 当期開始時点の情報（前期末までの財務状態）だけを参照する（関数シグネチャ上、
//     当期の市場・生産実績はそもそも受け取れない）。
//
// 【SAI-6 Phase 1A追加・資金見通しに基づく必要借入の是正（三宅さんご指示、要旨）】
//   旧式（params.fundingOutlookEnabled=false、既定）:
//     desiredAmountUsd = max(0, targetMinimumCashUsd - cashUsd)
//   この式は当期の確実な入金（既発生・決済期到来済みの売掛金回収等）も、当期の
//   計画支出（原料調達・労務費等）も一切見ないため、現金が「たまたま」バッファを
//   上回っていれば、当期に大きな支出が控えていても借入を申請しない。
//
//   新式（params.fundingOutlookEnabled=true、fundingOutlookが渡された場合のみ）:
//     reliableCashInflowsUsd = 当期に決済期が到来する売掛金（前期末までに発生済み、
//       金額・decision時点で確定）
//     plannedCashOutflowsUsd = 当期に決済期が到来する買掛金 + 既存借入の当期約定
//       利息・元本（前期末までの融資条件から確定） + 当期自身の調達・労務の意思
//       決定に基づく現金支出見積り（この四半期のdecisionそのもの、パイプライン上
//       finance判断より前に確定済み） + fixture由来の販管費固定費（会社規模から
//       決定論的に定まる）
//     projectedEndingCashBeforeNewBorrowingUsd = cashUsd + reliableCashInflowsUsd
//       - plannedCashOutflowsUsd
//     desiredAmountUsd = max(0, targetMinimumCashUsd - projectedEndingCashBeforeNewBorrowingUsd)
//   将来の市場結果・当期の乱数・他社の非公開情報はいずれも参照しない（すべて
//   前期末までに確定した契約・残高、または当期自身のAI意思決定から機械的に導出）。
//   借入余力（borrowingCapacity）による上限は、本関数の後段（financing/
//   liquidityClose.tsのplanQuarterFinancing→underwriteLoanApplication）が既存の
//   仕組みでそのまま適用するため、本関数側では上限クランプを重複実装しない。

import { FinancingRequestInput, CompanyFinancingState, LoanRecord } from "../../../financing/types";
import { CompanyFinanceState } from "../../../finance/types";
import { computeLoanQuarterlyInterest, computeScheduledPrincipalDue } from "../../../financing/loanSchedule";
import { PeriodV2 } from "../../../core/period";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

export interface FinancingPlanResult {
  readonly financingRequest: FinancingRequestInput;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

/**
 * 【SAI-6 Phase 1A】資金見通し計算の入力（fundingOutlookEnabled=trueのときのみ使用）。
 * いずれも「当期開始時点で確定している情報」または「当期自身のAI意思決定
 * （このfinance判断より前に確定済みのもの）」のみから構成する。当期の市場結果・
 * 乱数・他社の非公開情報は含まない。
 */
export interface FundingOutlookInputs {
  readonly period: PeriodV2;
  /** 前期末までの自社財務状態（売掛金・買掛金の残高と決済期を含む）。 */
  readonly financeState: CompanyFinanceState;
  /** 前期末までの自社資金繰り状態（既存融資ポートフォリオ、約定利息・元本の算出に使う）。 */
  readonly financingState: CompanyFinancingState;
  /** 当期自身の調達意思決定（procurement.ts）に基づく国内買付の現金支出見積り（USD）。 */
  readonly domesticPurchaseCashNeedUsd: number;
  /** 当期自身の労務意思決定（labor.ts）に基づく人件費（常用・臨時・残業）の現金支出見積り（USD）。 */
  readonly laborCashCostUsd: number;
  /** fixture由来の販管費固定費見積り（会社規模から決定論的に定まる、USD）。 */
  readonly sgaFixedCashCostUsd: number;
}

export function buildStandardAiFinancingRequest(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  fundingOutlook?: FundingOutlookInputs
): FinancingPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const cashUsd = observation.cashUsd;
  const targetMinimumCashUsd = pressures.targetMinimumCashUsd;
  const voluntaryPrepaymentThresholdCashUsd = targetMinimumCashUsd * params.voluntaryPrepaymentMultiple;

  let desiredAmountUsd: number;
  if (params.fundingOutlookEnabled && fundingOutlook) {
    const { period, financeState, financingState, domesticPurchaseCashNeedUsd, laborCashCostUsd, sgaFixedCashCostUsd } = fundingOutlook;

    const reliableCashInflowsUsd = financeState.receivables
      .filter((r) => r.dueSettlementPeriod === period)
      .reduce((s, r) => s + (r.amount as number), 0);
    const payablesDueThisPeriodUsd = financeState.payables
      .filter((p) => p.dueSettlementPeriod === period)
      .reduce((s, p) => s + (p.amount as number), 0);
    const scheduledDebtServiceUsd = financingState.loanPortfolio.loans.reduce(
      (s: number, loan: LoanRecord) => s + computeLoanQuarterlyInterest(loan, period) + computeScheduledPrincipalDue(loan, period),
      0
    );
    const plannedCashOutflowsUsd =
      payablesDueThisPeriodUsd + scheduledDebtServiceUsd + Math.max(0, domesticPurchaseCashNeedUsd) + Math.max(0, laborCashCostUsd) + Math.max(0, sgaFixedCashCostUsd);
    const projectedEndingCashBeforeNewBorrowingUsd = cashUsd + reliableCashInflowsUsd - plannedCashOutflowsUsd;
    desiredAmountUsd = Math.max(0, targetMinimumCashUsd - projectedEndingCashBeforeNewBorrowingUsd);

    diagnostics.push({
      code: "FUNDING_OUTLOOK_BORROWING_REQUESTED",
      domain: "finance",
      companyId: observation.companyId,
      severity: desiredAmountUsd > 0 ? "info" : "info",
      keyValues: {
        cashUsd,
        reliableCashInflowsUsd,
        payablesDueThisPeriodUsd,
        scheduledDebtServiceUsd,
        domesticPurchaseCashNeedUsd,
        laborCashCostUsd,
        sgaFixedCashCostUsd,
        plannedCashOutflowsUsd,
        projectedEndingCashBeforeNewBorrowingUsd,
        targetMinimumCashUsd,
        desiredAmountUsd,
      },
      message: `資金見通し: 期首現金(${Math.round(cashUsd).toLocaleString()})＋当期回収見込み(${Math.round(reliableCashInflowsUsd).toLocaleString()})－当期計画支出(${Math.round(plannedCashOutflowsUsd).toLocaleString()})＝借入前残高見込み(${Math.round(projectedEndingCashBeforeNewBorrowingUsd).toLocaleString()})。最低バッファ(${Math.round(targetMinimumCashUsd).toLocaleString()})に対する必要借入は${Math.round(desiredAmountUsd).toLocaleString()} USD。`,
    });
  } else {
    // 【既定・fundingOutlookEnabled=false】旧式のまま（ビット単位で従来と同一）。
    desiredAmountUsd = cashUsd < targetMinimumCashUsd ? targetMinimumCashUsd - cashUsd : 0;
  }

  const desiredPrepaymentUsd =
    cashUsd > voluntaryPrepaymentThresholdCashUsd && observation.existingLoanBalanceUsd > 0
      ? Math.min(cashUsd - voluntaryPrepaymentThresholdCashUsd, observation.existingLoanBalanceUsd)
      : 0;

  if (desiredAmountUsd > 0 && !params.fundingOutlookEnabled) {
    diagnostics.push({
      code: "CASH_BUFFER_SHORTAGE",
      domain: "finance",
      companyId: observation.companyId,
      severity: pressures.cashPressure >= params.severeCashPressureThreshold ? "critical" : "warning",
      keyValues: { cashUsd, targetMinimumCashUsd, desiredAmountUsd },
      message: `現金(${Math.round(cashUsd).toLocaleString()} USD)が会社規模連動の最低バッファ(${Math.round(targetMinimumCashUsd).toLocaleString()} USD)を下回る見込みのため、通常融資を申請する。`,
    });
  }
  if (desiredPrepaymentUsd > 0) {
    diagnostics.push({
      code: "DEBT_REPAYMENT_SURPLUS",
      domain: "finance",
      companyId: observation.companyId,
      severity: "info",
      keyValues: { cashUsd, voluntaryPrepaymentThresholdCashUsd, desiredPrepaymentUsd },
      message: "現金余剰のため、既存借入の任意期限前返済を申請する（高金利融資から優先的に充当される）。",
    });
  }

  return {
    financingRequest: {
      desiredAmountUsd,
      desiredLoanType: "workingCapital",
      desiredTermQuarters: params.desiredTermQuarters,
      desiredRepaymentMethod: "bulletAtMaturity",
      desiredPrepaymentUsd,
      emergencyAcceptable: true,
    },
    diagnostics,
  };
}
