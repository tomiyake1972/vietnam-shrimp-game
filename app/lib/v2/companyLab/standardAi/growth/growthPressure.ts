// ShrimpX V2 — Phase SAI-GROW-1: Shadow Growth Pressure（診断専用）
//
// 【何のための層か（実装指示§0）】
// 「この会社はまだ成長したいのか／なぜか／何が止めているのか／次にどこへ
// 経営資源を向けるべきか」を、毎Turn deterministicに診断できるようにする。
// **今回はDecisionへ一切接続しない。** 販売希望量・営業採用・生産・調達・CAPEX・
// 配当のいずれもGROW-1では変更しない（§37 変更禁止）。
//
// 【固定販売目標の禁止（実装指示§3・§32）】
// 「MASSだから100,000t」のような会社別ハードコードは存在しない。会社差は
// Vision（人間が与える志）と既存のprofile感度だけから生じる。
//
// 【bounded rationality（実装指示§15）】
// 入力はすべて、Standard AIが既に観測している値と、既存モジュールが既に計算した
// 診断値である。ScenarioDefinitionの未公開将来イベント（T25 Ecuador災害等）は
// 引数として受け取れない形にしてある。
//
// 【係数を乱造しない（実装指示§31）】
// 中心は「strategic gap × opportunity support」の2項だけ。成約率・採算・在庫・
// crisis・財務・ライフサイクル・供給圧力は、bounded modifier か multiplicative gate
// としてのみ効く。閾値は可能な限り既存パラメータを再利用する。

import { Product } from "../../../market/types";
import { SalesContract } from "../../../sales/types";
import { PeriodV2, toYearQuarter } from "../../../core/period";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { computeBacklogSemantics } from "../../aiManagementMeeting/backlogSemantics";
import { CommercialAmbition, COMMERCIAL_AMBITION_PARAMETERS_V1 } from "../../vision/commercialAmbition";
import { CommercialCommitmentState, COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { STRATEGIC_GROWTH_PARAMETERS_V1 } from "../../vision/strategicGrowth";
import { GrowthAmbition } from "../../vision/types";
import { UnservedOpportunity } from "../../vision/unservedOpportunity";
import { StandardAiCrisisState } from "../crisisState";
import { FinancialHealthTier } from "../../../financing/types";
import { StandardAiObservation } from "../types";
import { StandardAiReasonCode } from "../reasonCodes";
import {
  GrowthConstraintCategory,
  GrowthPressureAssessment,
  GrowthPressureDestination,
  GrowthPressureLevel,
} from "./types";

const EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
const clamp01 = (v: number) => clamp(v, 0, 1);

export interface GrowthPressureParameters {
  /**
   * 「観測機会 ÷ 現在取りに行っている量」がこの比率に達したとき、機会支持度を1とみなす。
   * 1.0（＝機会と提出量が同じ）で0、2.0（＝倍の機会がある）で1。
   */
  readonly opportunitySupportSaturationRatio: number;
  /** bounded modifierの重み（合計±0.35以内に収める）。 */
  readonly conversionWeight: number;
  readonly forwardDemandWeight: number;
  readonly lifecycleWeight: number;
  readonly supplyPressureWeight: number;
  /** ライフサイクルトレンドがこの値（1四半期あたり）で±1のシグナルになる。 */
  readonly lifecycleFullSignalTrendPerQuarter: number;
  /** 供給圧力EWMAがこの値で完全な抑制（1.0）になる。 */
  readonly supplyPressureFullBrake: number;
  /** 期待貢献がこの値以上なら採算ゲートを完全に開く（USD/HOSO換算kg）。下限は既存のminimumContributionUsdPerKg。 */
  readonly marginFullSupportContributionUsdPerKg: number;
  /** 在庫過剰比率がこの値を超えると抑制が始まる（既定は既存のexcessInventoryRatioForDiscountと同値）。 */
  readonly inventoryBrakeStartRatio: number;
  /** 在庫過剰比率がこの値に達すると完全抑制（既定は既存のinventoryExcessHoldRatioと同値）。 */
  readonly inventoryBrakeFullRatio: number;
  /** Crisis Stateごとのゲート値。 */
  readonly crisisGateByState: Readonly<Record<StandardAiCrisisState, number>>;
  /** 財務健全性ごとのゲート値。 */
  readonly financeGateByTier: Readonly<Record<FinancialHealthTier, number>>;
  /** level判定のscore閾値（未満でその段階）。 */
  readonly moderateScoreThreshold: number;
  readonly highScoreThreshold: number;
  readonly urgentScoreThreshold: number;
  /**
   * 営業能力engineの漸近上限に対して、必要営業工数がこの比率を超えたら
   * EXTERNAL_ENGINE_CAPACITY_LIMITとして診断する（実装指示§23）。
   */
  readonly engineCapWarningRatio: number;
}

/**
 * 【既定値の出所】新しい閾値の発明を最小限にするため、次の値は既存パラメータと同値にしてある。
 *   inventoryBrakeStartRatio = STANDARD_AI_PARAMETERS_V1.excessInventoryRatioForDiscount (1.3)
 *   inventoryBrakeFullRatio  = COMMERCIAL_AMBITION_PARAMETERS_V1.inventoryExcessHoldRatio (1.5)
 *   採算の下限                = COMMERCIAL_AMBITION_PARAMETERS_V1.minimumContributionUsdPerKg (0.05)
 *   成約率の目標帯            = COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor/Ceiling
 *   supplyPressureFullBrake  = STANDARD_AI_PARAMETERS_V1.capexOversupplyPressureThreshold (1.2) より上の1.5
 * それ以外（重み・score閾値）はGROW-1のベンチマークで感度を観察するための初期値であり、
 * **Decisionに一切影響しない**ため、この段階では校正済みであることを主張しない。
 */
export const GROWTH_PRESSURE_PARAMETERS_V1: GrowthPressureParameters = {
  opportunitySupportSaturationRatio: 2.0,
  conversionWeight: 0.1,
  forwardDemandWeight: 0.1,
  lifecycleWeight: 0.05,
  supplyPressureWeight: 0.1,
  lifecycleFullSignalTrendPerQuarter: 0.01,
  supplyPressureFullBrake: 1.5,
  marginFullSupportContributionUsdPerKg: 0.2,
  inventoryBrakeStartRatio: 1.3,
  inventoryBrakeFullRatio: COMMERCIAL_AMBITION_PARAMETERS_V1.inventoryExcessHoldRatio,
  crisisGateByState: { NORMAL: 1, LIQUIDITY_STRESS: 0.4, SEVERE_DISTRESS: 0 },
  financeGateByTier: {
    healthy: 1,
    watch: 0.7,
    stressed: 0.3,
    covenantBreach: 0.2,
    paymentArrears: 0.1,
    insolvent: 0,
    paymentDefault: 0,
  },
  moderateScoreThreshold: 0.08,
  highScoreThreshold: 0.25,
  urgentScoreThreshold: 0.5,
  engineCapWarningRatio: 0.95,
};

export interface GrowthPressureInput {
  readonly companyId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly observation: StandardAiObservation;
  /** 自社の契約（Healthy Forward Backlogの分離に使う。M2.xの正式定義を再利用する）。 */
  readonly contracts: readonly SalesContract[];
  /**
   * Vision参照規模（今Turn）。**Visionそのものを販売目標にしない**（実装指示§6・§32）。
   * Visionが与えられていない会社ではnull（架空のVisionを作らない）。
   * 数値で受け取るのは、Vision Shadow Sweep（§30）で候補Visionを差し替えて
   * 比較できるようにするためである。
   */
  readonly visionReferenceScaleTons: number | null;
  /** profile感度に使う成長意欲（Vision不在ならnull＝感度1.0）。 */
  readonly growthAmbition: GrowthAmbition | null;
  /** 既存のCommercial Ambition（baselineTons＝現在の現実的な規模基準として再利用する）。 */
  readonly commercialAmbition: CommercialAmbition;
  /** 既存のCommercial Commitment（現在この会社が取りに行っている量）。 */
  readonly commercialCommitment: CommercialCommitmentState;
  /** 観測上の採算つき獲得可能需要（decision/sales.tsのcomputeObservableCommercialOpportunityの出力）。 */
  readonly attainableProfitableTons: number;
  readonly weightedContributionUsdPerKg: number;
  readonly priceObservationMissing: boolean;
  /** 直近の提出→成約転換率（観測できなければnull）。 */
  readonly observedConversionRatio: number | null;
  /** 完成品在庫の過剰比率（商品別の最大値と商品別の内訳）。 */
  readonly finishedGoodsExcessRatioByProduct: Readonly<Record<Product, number>>;
  readonly crisisState: StandardAiCrisisState;
  readonly lastQuarterFinancialHealthTier: FinancialHealthTier | null;
  /** 未充足機会の原因分解（既存vision/unservedOpportunity.tsの出力）。 */
  readonly unservedOpportunity: UnservedOpportunity;
  /** 営業採用が0だった理由（既存salesForceHiring.tsのzeroHireReason）。 */
  readonly salesHiringZeroReason: string | null;
  /** 当期の意思決定に含まれる成長行動（診断のみ。§33のDIV-5接続用）。 */
  readonly salesForceHireCount: number;
  readonly newCapexProposalCount: number;
  readonly salesParams?: SalesParameters;
  readonly params?: GrowthPressureParameters;
}

/** 前期実績の商品構成（観測できなければ均等）から、1トンあたりの平均営業工数係数を求める。 */
function averageSalesEffortCoefficient(observation: StandardAiObservation, salesParams: SalesParameters): number {
  const coefficients = salesParams.salesEffortCoefficients;
  const actual = observation.lastQuarterActualProductionByProduct;
  const total = (actual.hoso ?? 0) + (actual.pd ?? 0) + (actual.vap ?? 0);
  if (total <= EPSILON) {
    return (coefficients.hoso + coefficients.pd + coefficients.vap) / 3;
  }
  return (
    ((actual.hoso ?? 0) * coefficients.hoso + (actual.pd ?? 0) * coefficients.pd + (actual.vap ?? 0) * coefficients.vap) / total
  );
}

/**
 * Shadow Growth Pressureを評価する（純粋関数）。
 * 同一入力なら常に同一出力であり、内部状態・乱数・現在時刻を持たない。
 */
export function assessGrowthPressure(input: GrowthPressureInput): GrowthPressureAssessment {
  const params = input.params ?? GROWTH_PRESSURE_PARAMETERS_V1;
  const salesParams = input.salesParams ?? SALES_PARAMETERS_V1;
  const reasonCodes: StandardAiReasonCode[] = [];

  // --- 1. Strategic Scale Gap（実装指示§6） -------------------------------
  // currentRelevantScaleには、既存のCommercial Ambitionが出発点として使っている
  // baselineTons（= max(能力×salesUtilizationTarget, 前期実績生産)）をそのまま使う。
  // ここで独自の「都合のよい規模指標」を新設しない（実装指示§6）。
  const currentRelevantScaleTons = Math.max(0, input.commercialAmbition.baselineTons);
  const visionReferenceScaleTons = input.visionReferenceScaleTons ?? 0;
  const strategicScaleGapRatio =
    visionReferenceScaleTons > EPSILON
      ? clamp01((visionReferenceScaleTons - currentRelevantScaleTons) / visionReferenceScaleTons)
      : 0;

  // --- 2. Observable Opportunity（実装指示§8・§9・§24） -------------------
  // 【重要】AI側の控えめ係数（commercialAmbitionの0.35 / commercialCommitmentの0.5）は
  // ここで**使わない**。それらを再利用すると、現行の30kt ceilingをShadowにも
  // そのまま持ち込んでしまう（実装指示§9）。engineのmaximumSupplierShareまでは
  // 制度上取りうるため、observedOpportunityTonsはそこまでを機会として数える。
  const observedOpportunityTons = Math.max(0, input.attainableProfitableTons);
  const currentSubmissionCeilingTons = Math.max(0, input.commercialCommitment.submissionTargetTons);
  const ceilingSuppressedOpportunityTons = Math.max(0, observedOpportunityTons - currentSubmissionCeilingTons);
  const observableOpportunityRatio =
    currentSubmissionCeilingTons > EPSILON ? observedOpportunityTons / currentSubmissionCeilingTons : observedOpportunityTons > EPSILON ? Infinity : 0;
  const opportunitySupport = Number.isFinite(observableOpportunityRatio)
    ? clamp01((observableOpportunityRatio - 1) / (params.opportunitySupportSaturationRatio - 1))
    : 1;

  // --- 3. bounded modifier ------------------------------------------------
  // 成約率（実装指示§10）。目標帯の下限を基準に、上回れば+・下回れば−。
  // 高成約率だけでは無限に伸びない（opportunitySupportとの積で中心項が決まるため）。
  const conversionFloor = COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor;
  const conversionSignal =
    input.observedConversionRatio === null
      ? 0
      : input.observedConversionRatio >= conversionFloor
        ? clamp((input.observedConversionRatio - conversionFloor) / Math.max(EPSILON, 1 - conversionFloor), 0, 1)
        : clamp((input.observedConversionRatio - conversionFloor) / Math.max(EPSILON, conversionFloor), -1, 0);

  // Healthy Forward Backlog（実装指示§12）。**Overdueは成長シグナルにしない。**
  // due semanticsはM2.5の正式定義（computeBacklogSemantics）をそのまま使う。
  const { year, quarter } = toYearQuarter(input.period);
  const backlog = computeBacklogSemantics(input.contracts, input.companyId, year, quarter);
  const forwardDemandSignal =
    currentRelevantScaleTons > EPSILON ? clamp01(backlog.healthyForwardTons / currentRelevantScaleTons) : 0;

  // 公開ライフサイクルトレンド（実装指示§8・§15）。
  let marketLifecycleSignal = 0;
  if (input.observation.lifecycleTrendByMarket) {
    const trends: number[] = [];
    for (const byProduct of Object.values(input.observation.lifecycleTrendByMarket)) {
      for (const v of Object.values(byProduct)) trends.push(v);
    }
    if (trends.length > 0) {
      const avg = trends.reduce((s, v) => s + v, 0) / trends.length;
      marketLifecycleSignal = clamp(avg / params.lifecycleFullSignalTrendPerQuarter, -1, 1);
    }
  }

  // 公開供給圧力（過多なら抑制）。
  let supplyPressureBrake = 0;
  if (input.observation.productSupplyPressureByProduct) {
    const values = Object.values(input.observation.productSupplyPressureByProduct);
    const maxPressure = values.length > 0 ? Math.max(...values) : 0;
    supplyPressureBrake = clamp01((maxPressure - 1) / Math.max(EPSILON, params.supplyPressureFullBrake - 1));
  }

  // --- 4. gates（multiplicative） ----------------------------------------
  // 採算（実装指示§11）。参照売価が1つも観測できていない場合は採算を断定せず、
  // 「悪い」とも「良い」とも決めつけない中庸値（1.0＝抑制しない）にする。
  const minimumContribution = COMMERCIAL_AMBITION_PARAMETERS_V1.minimumContributionUsdPerKg;
  const marginSignal = input.priceObservationMissing
    ? 1
    : clamp01(
        (input.weightedContributionUsdPerKg - minimumContribution) /
          Math.max(EPSILON, params.marginFullSupportContributionUsdPerKg - minimumContribution)
      );

  // 在庫（実装指示§13）。商品別の最大過剰比率で見る（1商品でも大幅に余っていれば
  // 「まず売り切る」局面であるため。既存commercialAmbitionのhold判定と同じ見方）。
  const excessRatios = [
    input.finishedGoodsExcessRatioByProduct.hoso,
    input.finishedGoodsExcessRatioByProduct.pd,
    input.finishedGoodsExcessRatioByProduct.vap,
  ].filter((v) => Number.isFinite(v));
  const maxExcessRatio = excessRatios.length > 0 ? Math.max(...excessRatios) : 0;
  const inventoryBrake = clamp01(
    (maxExcessRatio - params.inventoryBrakeStartRatio) / Math.max(EPSILON, params.inventoryBrakeFullRatio - params.inventoryBrakeStartRatio)
  );

  // Crisis / 財務（実装指示§14）。新しいcredit modelは作らず既存判定をそのまま読む。
  const crisisGate = params.crisisGateByState[input.crisisState] ?? 1;
  const crisisBrake = 1 - crisisGate;
  // まだ1Turnも確定していない場合（Turn1）は「healthyであることを確認できていない」が、
  // 危機であるとも言えない。Shadow診断では抑制しない（1.0）でおき、財務ゲートの
  // 判定材料が無いことはreasonCodeで残さない（既存のdividend Gate Bのような
  // 安全側の停止判断はDecisionに接続するときに別途行う）。
  const financeGate = input.lastQuarterFinancialHealthTier === null ? 1 : (params.financeGateByTier[input.lastQuarterFinancialHealthTier] ?? 0);
  const financeBrake = 1 - financeGate;

  // --- 5. score（実装指示§31: 巨大な多変量scoreにしない） -----------------
  const core = strategicScaleGapRatio * opportunitySupport;
  // 【modifierは加算ではなく乗算】加算にすると、Vision gapが無い（＝志に追いついた）会社や
  // 市場機会が無い会社でも、成約率が良いというだけで圧力が発生してしまう。
  // 成長圧力の定義（実装指示§3）は「Visionまで余地があり、かつ市場機会があるとき」なので、
  // 中心項が0なら圧力も0になる形にする。modifierは±方向の増幅・減衰にとどめる。
  const modifierSum =
    params.conversionWeight * conversionSignal +
    params.forwardDemandWeight * forwardDemandSignal +
    params.lifecycleWeight * marketLifecycleSignal -
    params.supplyPressureWeight * supplyPressureBrake;
  const gated = clamp01(core * (1 + modifierSum)) * marginSignal * (1 - inventoryBrake) * crisisGate * financeGate;
  const baseScore = clamp01(gated);
  // profile差は既存のambitionSensitivity（HIGH 1.2 / MEDIUM 1.0 / LOW 0.7）を再利用する。
  // 新しいprofile parameterを増やさない（実装指示§17）。
  const profileSensitivity = input.growthAmbition ? STRATEGIC_GROWTH_PARAMETERS_V1.ambitionSensitivity[input.growthAmbition] : 1;
  const score = clamp01(baseScore * profileSensitivity);

  const level: GrowthPressureLevel =
    score >= params.urgentScoreThreshold
      ? "URGENT"
      : score >= params.highScoreThreshold
        ? "HIGH"
        : score >= params.moderateScoreThreshold
          ? "MODERATE"
          : "LOW";
  reasonCodes.push(`GROWTH_PRESSURE_${level}` as StandardAiReasonCode);

  // --- 6. Constraint Routing（実装指示§18・§19） -------------------------
  const constraints: GrowthConstraintCategory[] = [];
  const noMarketOpportunity = observedOpportunityTons <= EPSILON || opportunitySupport <= EPSILON;
  if (noMarketOpportunity) constraints.push("NO_MARKET_OPPORTUNITY");
  if (crisisGate < 1 || financeGate < 1) constraints.push("FINANCE");
  if (inventoryBrake > EPSILON) constraints.push("INVENTORY");
  if (marginSignal <= EPSILON) constraints.push("MARGIN");
  if (input.unservedOpportunity.blockedByRawMaterialTons > EPSILON) constraints.push("RAW_MATERIAL");
  if (input.unservedOpportunity.blockedByLaborTons > EPSILON) constraints.push("LABOR");
  if (input.unservedOpportunity.blockedByProductionCapacityTons > EPSILON) constraints.push("PRODUCTION_CAPACITY");
  if (input.unservedOpportunity.blockedBySalesCapacityTons > EPSILON) constraints.push("COMMERCIAL");

  // 【実装指示§21】営業採用が「現在の生産能力」で止められているのに、生産能力側には
  // 余力がある（生産能力起因の未充足が無い）ケース。これは能力不足ではなく、
  // 営業能力を増やせないことが成長を止めている＝COMMERCIALである。
  const salesHiringBlockedByProduction = input.salesHiringZeroReason === "SALES_HIRING_BLOCKED_BY_PRODUCTION";
  const commercialDeadlock =
    salesHiringBlockedByProduction &&
    !noMarketOpportunity &&
    input.unservedOpportunity.blockedByProductionCapacityTons <= EPSILON;
  if (commercialDeadlock) {
    reasonCodes.push("COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION");
    if (!constraints.includes("COMMERCIAL")) constraints.unshift("COMMERCIAL");
  }

  // 【実装指示§22】Growth Pressureが高いのに、現行の需要根拠（需要/能力）が
  // 自社の販売目標から自己参照的に決まっているために能力投資へ進めないケース。
  if (
    (level === "HIGH" || level === "URGENT") &&
    ceilingSuppressedOpportunityTons > EPSILON &&
    input.unservedOpportunity.blockedByProductionCapacityTons <= EPSILON
  ) {
    reasonCodes.push("GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE");
  }

  // 【実装指示§23】営業能力engineの漸近上限。Standard AI側では式を変更しない。
  const model = salesParams.salesCapacityModel;
  if (model && model.kind !== "perMarket") {
    const asymptoteEffortTons = model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons;
    const requiredEffortForVision = visionReferenceScaleTons * averageSalesEffortCoefficient(input.observation, salesParams);
    if (requiredEffortForVision > asymptoteEffortTons * params.engineCapWarningRatio) {
      reasonCodes.push("GROWTH_BLOCKED_BY_ENGINE_CAP");
      reasonCodes.push("EXTERNAL_ENGINE_CAPACITY_LIMIT");
    }
  }

  if (ceilingSuppressedOpportunityTons > EPSILON) {
    reasonCodes.push("GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP");
  }
  if (!noMarketOpportunity && observedOpportunityTons > EPSILON) {
    reasonCodes.push("GROWTH_OPPORTUNITY_AVAILABLE");
  }

  const primaryGrowthConstraint: GrowthConstraintCategory = constraints.length > 0 ? constraints[0] : "NONE";
  const secondaryGrowthConstraints = constraints.slice(1);
  const constraintReasonCode: Readonly<Record<GrowthConstraintCategory, StandardAiReasonCode | null>> = {
    COMMERCIAL: "GROWTH_BLOCKED_BY_COMMERCIAL",
    PRODUCTION_CAPACITY: "GROWTH_BLOCKED_BY_PRODUCTION_CAPACITY",
    RAW_MATERIAL: "GROWTH_BLOCKED_BY_RAW_MATERIAL",
    LABOR: "GROWTH_BLOCKED_BY_LABOR",
    FINANCE: "GROWTH_BLOCKED_BY_FINANCE",
    MARGIN: "GROWTH_BLOCKED_BY_MARGIN",
    INVENTORY: "GROWTH_BLOCKED_BY_INVENTORY",
    NO_MARKET_OPPORTUNITY: "GROWTH_NO_MARKET_OPPORTUNITY",
    NONE: null,
  };
  for (const c of constraints) {
    const code = constraintReasonCode[c];
    if (code && !reasonCodes.includes(code)) reasonCodes.push(code);
  }

  // --- 7. Pressure Destination（実装指示§20） ----------------------------
  const destinationByConstraint: Readonly<Record<GrowthConstraintCategory, GrowthPressureDestination>> = {
    COMMERCIAL: "SALES_HIRING",
    PRODUCTION_CAPACITY: "CAPEX",
    RAW_MATERIAL: "PROCUREMENT_EXPANSION",
    LABOR: "WORKFORCE_EXPANSION",
    FINANCE: "HOLD_GROWTH",
    MARGIN: "IMPROVE_MIX_OR_PRICE",
    INVENTORY: "HOLD_GROWTH",
    NO_MARKET_OPPORTUNITY: "HOLD_GROWTH",
    NONE: "SALES_EXPANSION",
  };
  const recommendedPressureDestination = destinationByConstraint[primaryGrowthConstraint];

  return {
    level,
    score,
    strategicScaleGapRatio,
    observableOpportunityRatio: Number.isFinite(observableOpportunityRatio) ? observableOpportunityRatio : 0,
    opportunitySupport,
    conversionSignal,
    marginSignal,
    forwardDemandSignal,
    inventoryBrake,
    crisisBrake,
    financeBrake,
    marketLifecycleSignal,
    supplyPressureBrake,
    observedOpportunityTons,
    currentSubmissionCeilingTons,
    ceilingSuppressedOpportunityTons,
    visionReferenceScaleTons,
    currentRelevantScaleTons,
    profileSensitivity,
    baseScore,
    primaryGrowthConstraint,
    secondaryGrowthConstraints,
    recommendedPressureDestination,
    nearTermGrowthActionExists: input.salesForceHireCount > 0 || input.newCapexProposalCount > 0,
    reasonCodes,
  };
}
