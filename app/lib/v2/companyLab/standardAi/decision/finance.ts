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
import { assessWorkingCapitalNeed, ProcurementCashPlanInput, WorkingCapitalAssessment } from "./workingCapital";
import { LiquidityAssessment } from "./liquidity";

export interface FinancingPlanResult {
  readonly financingRequest: FinancingRequestInput;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
  /** 【Test16】短期運転資金の評価結果（診断・UI・監査で参照する）。調達計画未接続ならundefined。 */
  readonly workingCapital?: WorkingCapitalAssessment;
}

export function buildStandardAiFinancingRequest(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  /**
   * 【Test16】当期の原料調達計画。**これを渡すことで初めて「原料を買うのに
   * 資金が要る」ことが借入判断へ入る。** 未指定なら従来どおり最低現金バッファ
   * だけで判断する（既存呼び出し元・テストとの後方互換）。
   */
  procurementCashPlan?: ProcurementCashPlanInput,
  /**
   * 【Phase SAI-GROW-3B-1】Liquidity SSoT の評価結果と、当期に承認した新規投資の支払額。
   * 渡された場合、借入必要額はSSoTの financingNeedUsd（確定投資支払・危機bufferを含む）と
   * 当期承認した新規投資の支払を加えた額を下限にする。未指定なら従来どおり。
   */
  liquidity?: {
    readonly assessment: LiquidityAssessment;
    /** 当期にCAPEX/新工場ゲートを通した新規提案の、当期に出る支払額。 */
    readonly approvedInvestmentPaymentsThisQuarterUsd: number;
    /**
     * 【Phase SAI-GROW-3B-1.1】そのうち手元現金だけでは賄えず、
     * **当期の借入を前提に承認した額**。投資判断が当期調達可能借入
     * （currentTurnFundableBorrowingUsd）を根拠に承認した以上、
     * その借入をFinance決定が実際に申請しなければ判断が完結しない。
     * fundingBalance経路は当期AR回収を資金に数えるため、投資が借入に依存していても
     * 0へclampされ得る。この値を申請額の下限として別に持つ。
     */
    readonly approvedInvestmentBorrowingThisQuarterUsd?: number;
  }
): FinancingPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const cashUsd = observation.cashUsd;
  const targetMinimumCashUsd = pressures.targetMinimumCashUsd;
  const voluntaryPrepaymentThresholdCashUsd = targetMinimumCashUsd * params.voluntaryPrepaymentMultiple;

  // 【従来の判断】最低現金バッファの不足額。
  const bufferShortfallUsd = cashUsd < targetMinimumCashUsd ? targetMinimumCashUsd - cashUsd : 0;

  // 【Test16の追加判断】短期運転資金の不足額。
  // 原料購入・人件費・買掛決済・元利返済という当面の資金使途に対し、
  // 手元現金と売掛回収見込みで足りるかを評価する。
  const workingCapital = procurementCashPlan
    ? assessWorkingCapitalNeed(observation, procurementCashPlan, targetMinimumCashUsd)
    : undefined;

  // 借入希望額は両者の大きい方。バッファ不足のほうが大きい局面もあるため
  // 「置き換え」ではなく「いずれか大きい方」とし、既存の安全側の判断を失わない。
  // 【Phase SAI-GROW-3B-1】Liquidity SSoTがあれば、確定投資の支払・危機buffer・
  // 当期承認した新規投資まで含めた必要額も候補に入れる（同じ「必要現金」の定義を使う）。
  // 【重要】clamp前の過不足に投資額を足してから0でclampする。
  // clamp後の値に足すと、現金が潤沢でも投資額ぶんだけ借りてしまう。
  const liquidityDrivenNeedUsd = liquidity
    ? Math.max(
        0,
        liquidity.assessment.fundingBalanceBeforeBorrowingUsd + Math.max(0, liquidity.approvedInvestmentPaymentsThisQuarterUsd)
      )
    : 0;
  // 【Phase SAI-GROW-3B-1.1】投資判断が当期借入を前提に承認した分は、必ず申請する。
  // 上限は投資判断が使ったのと同じ currentTurnFundableBorrowingUsd であり、
  // 借入可能額そのものを新たに広げてはいない。
  const growthBorrowingNeedUsd = liquidity
    ? Math.max(0, Math.min(liquidity.approvedInvestmentBorrowingThisQuarterUsd ?? 0, liquidity.assessment.currentTurnFundableBorrowingUsd))
    : 0;
  const desiredAmountUsd = Math.max(
    bufferShortfallUsd,
    workingCapital?.economicallyDesiredBorrowingUsd ?? 0,
    liquidityDrivenNeedUsd,
    growthBorrowingNeedUsd
  );

  // 【重要】運転資金が不足しているときは期限前返済を行わない。
  // 返済して現金を減らした直後に原料が買えなくなる、という自己矛盾を防ぐ。
  const hasWorkingCapitalGap = (workingCapital?.projectedWorkingCapitalGapUsd ?? 0) > 0;
  const desiredPrepaymentUsd =
    !hasWorkingCapitalGap && cashUsd > voluntaryPrepaymentThresholdCashUsd && observation.existingLoanBalanceUsd > 0
      ? Math.min(cashUsd - voluntaryPrepaymentThresholdCashUsd, observation.existingLoanBalanceUsd)
      : 0;

  if (workingCapital) {
    const w = workingCapital;
    diagnostics.push({
      code: "WORKING_CAPITAL_ASSESSED",
      domain: "finance",
      companyId: observation.companyId,
      severity: w.economicallyDesiredBorrowingUsd > 0 ? "warning" : "info",
      keyValues: {
        cashOnHand: w.cashOnHandUsd,
        minimumCashBuffer: w.minimumCashBufferUsd,
        expectedARCollection: w.expectedArCollectionUsd,
        plannedRawProcurementCost: w.plannedRawProcurementCostUsd,
        plannedDomesticRawProcurementCost: w.plannedDomesticRawProcurementCostUsd,
        plannedImportRawProcurementCost: w.plannedImportRawProcurementCostUsd,
        payroll: w.payrollUsd,
        payablesDue: w.payablesDueUsd,
        debtService: w.debtServiceUsd,
        otherNearTermOperatingNeeds: w.payrollUsd + w.payablesDueUsd + w.debtServiceUsd,
        nearTermOperatingCashNeeds: w.nearTermOperatingCashNeedsUsd,
        cashUsableForDomesticProcurement: w.cashUsableForDomesticProcurementUsd,
        domesticProcurementFundingGap: w.domesticProcurementFundingGapUsd,
        overallCashGap: w.overallCashGapUsd,
        projectedWorkingCapitalGap: w.projectedWorkingCapitalGapUsd,
        economicallyDesiredBorrowing: w.economicallyDesiredBorrowingUsd,
        cashBufferShortfall: bufferShortfallUsd,
        // 実際に申請する額。承認額（＝actualBorrowing）は financing エンジンの
        // 審査結果であり、この時点では確定しないため保存しない（捏造しない）。
        requestedBorrowing: desiredAmountUsd,
        unfundedWorkingCapitalGapIfNotApproved: Math.max(0, w.economicallyDesiredBorrowingUsd - desiredAmountUsd),
      },
      decisionSummary:
        w.economicallyDesiredBorrowingUsd > 0
          ? `短期運転資金が ${Math.round(w.economicallyDesiredBorrowingUsd).toLocaleString()} USD 不足するため借入を申請`
          : "短期運転資金は手元現金と売掛回収見込みで充足",
      message:
        `当面の資金需要 ${Math.round(w.nearTermOperatingCashNeedsUsd).toLocaleString()} USD` +
        `（うち原料調達 ${Math.round(w.plannedRawProcurementCostUsd).toLocaleString()}、人件費 ${Math.round(w.payrollUsd).toLocaleString()}、` +
        `買掛決済 ${Math.round(w.payablesDueUsd).toLocaleString()}、元利返済 ${Math.round(w.debtServiceUsd).toLocaleString()}）に` +
        `最低現金バッファ ${Math.round(w.minimumCashBufferUsd).toLocaleString()} を加えた額に対し、` +
        `手元現金 ${Math.round(w.cashOnHandUsd).toLocaleString()} と売掛回収見込み ${Math.round(w.expectedArCollectionUsd).toLocaleString()} で` +
        `${w.projectedWorkingCapitalGapUsd > 0 ? `${Math.round(w.projectedWorkingCapitalGapUsd).toLocaleString()} USD 不足する` : "充足する"}。`,
    });
  }

  if (bufferShortfallUsd > 0) {
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
    workingCapital,
  };
}
