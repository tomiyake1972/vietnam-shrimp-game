// ShrimpX V2 — Phase SAI-GROW-3B-1: Liquidity SSoT / Investment Discipline
//
// 【この層が生まれた理由（PRE-AUDIT docs/v2/SAI_GROW3_PRE_AUDIT.md）】
// 「必要現金」の定義が4通りに分裂していた:
//   L-1 targetMinimumCashUsd（会社規模連動の最低バッファ）
//   L-2 assessWorkingCapitalNeed（原料+人件費+買掛+元利 vs 現金+AR）… finance決定のみ
//   L-3 CAPEX cash gate（targetMinimumCash + 案件費用×1.5）… 案件単位・当期のみ
//   L-4 新工場 Gate L（targetMinimumCash + 案件費用×riskTolerance別係数）
// この分裂の結果、DS3のBALは開始現金49.2Mのうち26.3Mを3四半期でCAPEXへ投じ、
// T5に現金が尽き、以後 調達縮小→生産0→回復不能 という崩壊を起こした。
//
// 【このモジュールの責務】
// 「今、いくらまでなら投資に回してよいか」を**1つのpure resolver**で決める。
// Finance決定・既存増設CAPEX・新工場のすべてがこの同じ評価を参照する。
//
// 【新しい経済モデルを作らない】
// 構成要素はすべて既存の唯一の情報源の再利用である:
//   ・運転資金        … decision/workingCapital.ts::assessWorkingCapitalNeed（無変更で再利用）
//   ・最低現金        … parameters.ts::estimateTargetMinimumCashUsd（pressures.targetMinimumCashUsd）
//   ・確定投資支払    … CapitalProject.paymentSchedule（observation.committedCapexPaymentScheduleUsd）
//   ・借入余力の考え方 … pressures.borrowingPressure（= 借入残 / (会社規模 × capexMaxLoanToSizeRatio)）
//   ・危機bufferの強さ … growth/growthPressure.ts の crisisGateByState
//   ・財務規律の強さ   … growth/growthPressure.ts の financialDisciplineExponentByRiskTolerance
//   ・調達の最低確保比 … parameters.ts::minDomesticPurchaseRatioOfBase
// 新しいmagic numberはこのファイルに1つも置いていない。

import { StandardAiParameters } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiCrisisState } from "../crisisState";
import { FinancialRiskTolerance } from "../../vision/types";
import { GROWTH_PRESSURE_PARAMETERS_V1, GrowthPressureParameters } from "../growth/growthPressure";
import { assessWorkingCapitalNeed, ProcurementCashPlanInput, WorkingCapitalAssessment } from "./workingCapital";
import { NEW_FACTORY_STRATEGY_PARAMETERS_V1 } from "./newFactoryStrategyParameters";

const EPSILON = 1e-6;

/** 【実装指示§13】1つの投資判断で追跡できるようにする、評価の内訳一式。 */
export interface LiquidityAssessment {
  // --- 利用可能な資金 ---
  readonly currentCashUsd: number;
  /** 当期に回収予定の売掛金（既存observationの確定値）。 */
  readonly expectedArCollectionUsd: number;
  /**
   * 現実的に使える追加借入。**facility残高の全額ではない**。
   *   ・危機時・財務健全性が悪い場合は0（借りられない枠を資金に数えない）
   *   ・AI自身の借入方針上限（pressures.borrowingPressure の分母）を超えない
   *   ・財務リスク許容度が低いほど強くhaircutする（既存の規律指数を再利用）
   */
  readonly realisticallyAvailableBorrowingUsd: number;
  readonly availableLiquidityUsd: number;

  // --- 守らなければならない資金 ---
  /** 当期の計画どおり操業するのに要する運転資金（原料+人件費+買掛）。 */
  readonly operatingWorkingCapitalRequirementUsd: number;
  /** そのうち「これを割ると次期の操業が成立しない」最低限（人件費・買掛は全額、原料は最低確保比）。 */
  readonly minimumProtectedOperatingRequirementUsd: number;
  readonly debtServiceRequirementUsd: number;
  /** 承認済み設備投資の今後の支払（当期＋次期以降、horizon内）。 */
  readonly committedCapitalPaymentsUsd: number;
  /** うち当期に出る分。 */
  readonly committedCapitalPaymentsThisQuarterUsd: number;
  readonly minimumOperatingCashReserveUsd: number;
  /** 危機・財務悪化時にのみ積む上限付きbuffer（NORMAL時は0）。 */
  readonly crisisBufferUsd: number;
  /** 上記の合計＝投資に回してはいけない資金。 */
  readonly protectedFundingRequirementUsd: number;

  // --- 差引 ---
  /** availableLiquidity − protectedFundingRequirement。負なら既に資金不足。 */
  readonly liquidityHeadroomUsd: number;
  /**
   * 【実装指示§2・§4】借入もAR回収も当てにしない、当四半期の手元現金だけで見た余力。
   *   現金 − (最低操業 + 元利 + 当期の確定投資支払 + 最低現金 + 危機buffer)
   *
   * 当四半期に出ていく投資支払は、**必ずこの余力の範囲**でなければならない。
   * ARを含めない理由: engine側の調達資金ゲート（financing/liquidityClose.ts
   * computeProcurementConstraint）は「前期末現金 × 配分比 ＋ 承認融資」だけを
   * 原資とし、**当期のAR回収は原料購入の原資にならない**。ARを投資可能額へ
   * 数えると、投資に回した現金のぶんだけ翌期の原料が買えなくなる
   * （DS3のBAL崩壊がまさにこの経路だった）。
   */
  readonly cashBasedHeadroomUsd: number;
  /** 運転資金を賄うために必要な借入額（Finance決定が申請する額の根拠）。 */
  readonly financingNeedUsd: number;
  /**
   * clampする前の資金過不足（負なら余っている）。
   * 当期に承認した新規投資の支払を足してから0でclampするために公開する
   * （現金が潤沢なのに投資額ぶんだけ借りる、という不整合を防ぐ）。
   */
  readonly fundingBalanceBeforeBorrowingUsd: number;
  /** 再利用した既存の運転資金評価（診断で内訳をそのまま追える）。 */
  readonly workingCapital: WorkingCapitalAssessment;
}

export interface CommittedCashRequirementInput {
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly params: StandardAiParameters;
  /** 当期の調達計画（既存のworkingCapital評価へそのまま渡す）。 */
  readonly procurementCashPlan: ProcurementCashPlanInput;
  readonly crisisState: StandardAiCrisisState;
  /** Visionの財務リスク許容度。Vision不在の会社はMEDIUM相当として扱う。 */
  readonly financialRiskTolerance: FinancialRiskTolerance | null;
  readonly growthParams?: GrowthPressureParameters;
}

/**
 * 【実装指示§2】現実的に使える追加借入。
 *
 * observation.availableBorrowingHeadroomUsd は「捏造しない」方針で恒常的に undefined
 * （types.ts に理由が明記されている）ため、engineの与信審査結果を先読みはしない。
 * 代わりに、**AI自身が既に持っている借入方針の上限**（pressures.borrowingPressure の
 * 定義そのもの）を使い、そこへ既存の規律パラメータでhaircutする。
 */
function realisticallyAvailableBorrowingUsd(input: CommittedCashRequirementInput, growthParams: GrowthPressureParameters): number {
  const { observation, pressures, params, crisisState } = input;

  // 借りられない状態では1ドルも数えない（実装指示§2）。
  // engine側の underwritingFrozen 条件（creditTier E / 重大延滞 / 債務超過）に対応する
  // 観測値は lastQuarterFinancialHealthTier であり、ここで新しい判定は作らない。
  const tier = observation.lastQuarterFinancialHealthTier;
  const frozenTier = tier === "paymentDefault" || tier === "insolvent" || tier === "paymentArrears" || tier === "covenantBreach";
  if (frozenTier || crisisState === "SEVERE_DISTRESS") return 0;
  if (observation.lastQuarterUnderwritingFrozen === true) return 0;

  // AI自身の借入方針上限 = 会社規模 × capexMaxLoanToSizeRatio
  // （pressures.borrowingPressure の分母と同一。新しい上限概念を作らない）
  const scaleForBorrowing = pressures.targetMinimumCashUsd / Math.max(EPSILON, params.cashBufferQuarters);
  const policyLimitUsd = scaleForBorrowing * params.capexMaxLoanToSizeRatio;
  const policyHeadroomUsd = Math.max(0, policyLimitUsd - observation.existingLoanBalanceUsd);

  // 【haircut① 財務リスク許容度】既存の新工場パラメータ
  // upfrontCoverageRatioByRiskTolerance（HIGH 0.6 / MEDIUM 0.85 / LOW 1.1 ＝
  // 「投資額のうち手元現金で賄いたい割合」）をそのまま裏返して使う。
  //   debtで賄ってよい割合 = clamp(1 − coverageRatio, 0, 1)
  //     HIGH 0.40 / MEDIUM 0.15 / LOW 0.00
  // これにより **どの会社でも借入枠を100%現金同等には数えない**（実装指示§2）。
  // LOW（CONSV相当）は借入を成長原資として数えない＝レバレッジ成長をしない。
  const coverageRatio = NEW_FACTORY_STRATEGY_PARAMETERS_V1.upfrontCoverageRatioByRiskTolerance[input.financialRiskTolerance ?? "MEDIUM"];
  const debtFundableShare = Math.max(0, Math.min(1, 1 - coverageRatio));

  // 【haircut② レバレッジ】既存の規律指数（HIGH 0 / MEDIUM 1 / LOW 2）を
  // 「(1 − 借入圧力) の何乗で割り引くか」として再利用する。借入が増えるほど保守化する。
  const exponent = growthParams.financialDisciplineExponentByRiskTolerance[input.financialRiskTolerance ?? "MEDIUM"];
  const leverageHaircut = Math.pow(Math.max(0, 1 - pressures.borrowingPressure), exponent);

  return Math.max(0, policyHeadroomUsd * debtFundableShare * leverageHaircut);
}

/**
 * 【実装指示§1】Liquidity SSoT。Finance・既存増設CAPEX・新工場のすべてがこれを参照する。
 * 純粋関数（同一入力なら常に同一出力）。
 */
export function assessCommittedCashRequirement(input: CommittedCashRequirementInput): LiquidityAssessment {
  const { observation, pressures, params, crisisState } = input;
  const growthParams = input.growthParams ?? GROWTH_PRESSURE_PARAMETERS_V1;

  // --- 既存の運転資金評価をそのまま再利用（二重計上を避ける唯一の方法） ---
  const workingCapital = assessWorkingCapitalNeed(observation, input.procurementCashPlan, pressures.targetMinimumCashUsd);

  // 運転資金（debtServiceは別項目として持つため、ここでは除く）。
  const operatingWorkingCapitalRequirementUsd =
    workingCapital.plannedRawProcurementCostUsd + workingCapital.payrollUsd + workingCapital.payablesDueUsd;

  // 【実装指示§4】計画全量を常に守ると成長を過剰に止めるため、「最低限操業できる額」を分ける。
  // 人件費・買掛は削れない固定的支出なので全額。原料は既存の最低確保比
  // （minDomesticPurchaseRatioOfBase＝AIが調達計画で既に使っている下限比率）を適用する。
  const minimumProtectedOperatingRequirementUsd =
    workingCapital.payrollUsd +
    workingCapital.payablesDueUsd +
    workingCapital.plannedRawProcurementCostUsd * params.minDomesticPurchaseRatioOfBase;

  const debtServiceRequirementUsd = workingCapital.debtServiceUsd;

  // 【実装指示§3】承認済み案件の今後の支払（当期＋次期以降）。observationが
  // CapitalProject.paymentSchedule から機械的に作った値をそのまま使う。
  const schedule = observation.committedCapexPaymentScheduleUsd ?? [];
  const committedCapitalPaymentsThisQuarterUsd = schedule[0] ?? 0;
  const committedCapitalPaymentsUsd = schedule.reduce((sum, v) => sum + Math.max(0, v), 0);

  const minimumOperatingCashReserveUsd = pressures.targetMinimumCashUsd;

  // 【実装指示§1】上限付きcrisis buffer。危機・財務悪化時のみ積み、NORMAL時は0。
  // 上限は最低現金バッファ1本ぶん（＝固定の巨額bufferにはならない）。
  const crisisGate = growthParams.crisisGateByState[crisisState] ?? 1;
  const healthGate =
    observation.lastQuarterFinancialHealthTier === null
      ? 1
      : (growthParams.financeGateByTier[observation.lastQuarterFinancialHealthTier] ?? 0);
  const crisisBufferUsd = pressures.targetMinimumCashUsd * (1 - Math.min(crisisGate, healthGate));

  const protectedFundingRequirementUsd =
    minimumProtectedOperatingRequirementUsd +
    debtServiceRequirementUsd +
    committedCapitalPaymentsUsd +
    minimumOperatingCashReserveUsd +
    crisisBufferUsd;

  const currentCashUsd = Math.max(0, observation.cashUsd);
  const expectedArCollectionUsd = workingCapital.expectedArCollectionUsd;
  const borrowingUsd = realisticallyAvailableBorrowingUsd(input, growthParams);
  const availableLiquidityUsd = currentCashUsd + expectedArCollectionUsd + borrowingUsd;

  const liquidityHeadroomUsd = availableLiquidityUsd - protectedFundingRequirementUsd;
  const cashBasedHeadroomUsd =
    currentCashUsd -
    (minimumProtectedOperatingRequirementUsd +
      debtServiceRequirementUsd +
      committedCapitalPaymentsThisQuarterUsd +
      minimumOperatingCashReserveUsd +
      crisisBufferUsd);

  // 【実装指示§8】借入必要額。計画どおり操業し、確定投資を払い、最低現金を残すのに
  // 手元現金＋AR回収で足りない額。借入余力そのものは含めない（借りる理由の計算であり、
  // 借りられる額の計算ではない）。
  const fundingNeedBeforeBorrowingUsd =
    operatingWorkingCapitalRequirementUsd +
    debtServiceRequirementUsd +
    committedCapitalPaymentsThisQuarterUsd +
    minimumOperatingCashReserveUsd +
    crisisBufferUsd -
    currentCashUsd -
    expectedArCollectionUsd;
  const financingNeedUsd = Math.max(0, fundingNeedBeforeBorrowingUsd);

  return {
    currentCashUsd,
    expectedArCollectionUsd,
    realisticallyAvailableBorrowingUsd: borrowingUsd,
    availableLiquidityUsd,
    operatingWorkingCapitalRequirementUsd,
    minimumProtectedOperatingRequirementUsd,
    debtServiceRequirementUsd,
    committedCapitalPaymentsUsd,
    committedCapitalPaymentsThisQuarterUsd,
    minimumOperatingCashReserveUsd,
    crisisBufferUsd,
    protectedFundingRequirementUsd,
    liquidityHeadroomUsd,
    cashBasedHeadroomUsd,
    financingNeedUsd,
    fundingBalanceBeforeBorrowingUsd: fundingNeedBeforeBorrowingUsd,
    workingCapital,
  };
}

/** 1件の投資提案に対する可否判定（実装指示§6）。 */
export interface InvestmentAffordability {
  readonly affordable: boolean;
  /** 当四半期に出る支払（＝借入を当てにせず手元で払えなければならない額）。 */
  readonly proposedPaymentsThisQuarterUsd: number;
  /** 当四半期の手元資金だけで見た投資後余力。 */
  readonly postInvestmentCashHeadroomUsd: number;
  /** この案件がhorizon内に要求する支払（＝新規に増える確定支払）。 */
  readonly proposedInvestmentPaymentsUsd: number;
  /** 同一Turnに既に承認した提案の支払合計（実装指示§3）。 */
  readonly alreadyApprovedThisTurnUsd: number;
  /** 投資後に残る流動性 = liquidityHeadroom − (既承認 + 本案件)。 */
  readonly postInvestmentLiquidityUsd: number;
  /** 財務リスク許容度による上乗せ安全余裕（新工場のprofile差を保つ）。 */
  readonly safetyMarginUsd: number;
}

/**
 * 【実装指示§3・§6】同一Turn内の複数提案が同じ現金を二重に使わないよう、
 * 「既に承認した提案の支払」を差し引いた上で判定する。
 *
 * @param proposedInvestmentPaymentsUsd この案件がhorizon内に要求する支払額
 * @param alreadyApprovedThisTurnUsd    同一Turnに先に承認した提案の支払合計
 * @param safetyMarginRatio             追加の安全余裕（新工場のriskTolerance別係数など。既定0）
 */
export function evaluateInvestmentAffordability(
  assessment: LiquidityAssessment,
  proposedInvestmentPaymentsUsd: number,
  alreadyApprovedThisTurnUsd: number,
  safetyMarginRatio = 0,
  /** 当四半期に出る支払。省略時はhorizon合計と同額とみなす（保守側）。 */
  proposedPaymentsThisQuarterUsd?: number,
  /** 同一Turnに先に承認した提案の、当四半期に出る支払合計。 */
  alreadyApprovedThisQuarterUsd = 0
): InvestmentAffordability {
  const safetyMarginUsd = Math.max(0, proposedInvestmentPaymentsUsd) * Math.max(0, safetyMarginRatio);
  const thisQuarterUsd = proposedPaymentsThisQuarterUsd ?? proposedInvestmentPaymentsUsd;

  // ① horizon（当期＋今後）: 借入余力も含めた流動性で見る＝Debtを使った成長投資を許す。
  const postInvestmentLiquidityUsd =
    assessment.liquidityHeadroomUsd - alreadyApprovedThisTurnUsd - proposedInvestmentPaymentsUsd - safetyMarginUsd;
  // ② 当四半期: 借入を一切当てにせず、手元資金だけで払えること。
  //    （借りられる保証のない金額を当期の支払原資にしない＝実装指示§2）
  const postInvestmentCashHeadroomUsd =
    assessment.cashBasedHeadroomUsd - alreadyApprovedThisQuarterUsd - thisQuarterUsd - safetyMarginUsd;

  return {
    affordable: postInvestmentLiquidityUsd >= 0 && postInvestmentCashHeadroomUsd >= 0,
    proposedInvestmentPaymentsUsd,
    proposedPaymentsThisQuarterUsd: thisQuarterUsd,
    alreadyApprovedThisTurnUsd,
    postInvestmentLiquidityUsd,
    postInvestmentCashHeadroomUsd,
    safetyMarginUsd,
  };
}

/**
 * 【実装指示§3】提案しようとしている案件が、horizon内（当期＋次期以降）に要求する支払額。
 * 承認前の候補なので paymentSchedule はまだ無く、テンプレートの paymentRatios から求める。
 * 承認済み案件と同じ式（予算 × 比率）であり、新しい支払ルールは作らない。
 */
export function plannedInvestmentPaymentsWithinHorizonUsd(
  standardBudgetUsd: number,
  paymentRatios: readonly number[],
  horizonQuarters: number
): number {
  return paymentRatios.slice(0, Math.max(0, horizonQuarters)).reduce((sum, ratio) => sum + standardBudgetUsd * ratio, 0);
}
