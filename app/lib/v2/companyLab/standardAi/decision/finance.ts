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

import { FinancingRequestInput } from "../../../financing/types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

export interface FinancingPlanResult {
  readonly financingRequest: FinancingRequestInput;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiFinancingRequest(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): FinancingPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const cashUsd = observation.cashUsd;
  const targetMinimumCashUsd = pressures.targetMinimumCashUsd;
  const voluntaryPrepaymentThresholdCashUsd = targetMinimumCashUsd * params.voluntaryPrepaymentMultiple;

  const desiredAmountUsd = cashUsd < targetMinimumCashUsd ? targetMinimumCashUsd - cashUsd : 0;
  const desiredPrepaymentUsd =
    cashUsd > voluntaryPrepaymentThresholdCashUsd && observation.existingLoanBalanceUsd > 0
      ? Math.min(cashUsd - voluntaryPrepaymentThresholdCashUsd, observation.existingLoanBalanceUsd)
      : 0;

  if (desiredAmountUsd > 0) {
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
