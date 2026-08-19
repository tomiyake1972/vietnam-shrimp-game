// ShrimpX V2 — Phase SAI-GROW-1/2: Growth Pressure と Adaptive Opportunity Share
//
// 【GROW-1（Shadow）からGROW-2への変更点】
//  (1) Opportunity Signalを現行capから切り離した（実装指示§2）。
//      GROW-1では opportunitySupport = 観測機会 ÷ **現在の提出上限** だったが、
//      GROW-2ではその提出上限自体をGrowth Pressureで動かすため、分母に使うと循環する。
//      新しい分母は「現在の自社規模（currentRelevantScaleTons）」であり、
//      提出上限にも0.35/0.5にも依存しない。
//  (2) 機会は会社のorientationで重み付けする（実装指示§3・§4）。
//      全市場・全商品の需要を各社が等しく機会と見なさない。重みは既存の
//      orientation倍率をそのまま再利用し、新しい市場・商品hardcodeは作らない。
//  (3) Adaptive Opportunity Share（実装指示§8）。Growth Pressureに応じて、
//      Commercial Ambition / Commercial Commitment の機会share（現行 0.35 / 0.5）を
//      連続関数で開放する。**Growth Pressure LOWでは現行値と完全に同一**（§9）。
//
// 【GROW-2でDecisionへ接続するのはAdaptive Shareだけ】
// sales hiring / production / procurement / labor / CAPEX / finance / dividend は
// 一切変更しない（実装指示§15・§28）。営業能力engineの式も変更しない（§17）。
//
// 【bounded rationality】入力はすべて観測値と既存診断値。ScenarioDefinitionの
// 未公開将来イベント・TRUE需要・TRUE価格は引数として受け取れない。

import { Product } from "../../../market/types";
import { SalesContract } from "../../../sales/types";
import { PeriodV2, toYearQuarter } from "../../../core/period";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { computeBacklogSemantics } from "../../aiManagementMeeting/backlogSemantics";
import { COMMERCIAL_AMBITION_PARAMETERS_V1 } from "../../vision/commercialAmbition";
import { COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { STRATEGIC_GROWTH_PARAMETERS_V1 } from "../../vision/strategicGrowth";
import { GrowthAmbition, FinancialRiskTolerance, StrategicPosture } from "../../vision/types";
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
   * 【GROW-2】market headroom（自社規模に対する市場余地の倍率）がこの値に達したとき
   * 機会支持度を1とみなす。1社が競合4社と同じ観測需要を分け合う前提で、
   * 「自社規模の4倍の余地があれば機会は十分」とする控えめな飽和点。
   */
  readonly opportunityHeadroomSaturationRatio: number;
  /** bounded modifierの重み（合計±0.35以内に収める）。 */
  readonly conversionWeight: number;
  readonly forwardDemandWeight: number;
  readonly lifecycleWeight: number;
  readonly supplyPressureWeight: number;
  readonly lifecycleFullSignalTrendPerQuarter: number;
  readonly supplyPressureFullBrake: number;
  readonly marginFullSupportContributionUsdPerKg: number;
  readonly inventoryBrakeStartRatio: number;
  readonly inventoryBrakeFullRatio: number;
  readonly crisisGateByState: Readonly<Record<StandardAiCrisisState, number>>;
  readonly financeGateByTier: Readonly<Record<FinancialHealthTier, number>>;
  readonly moderateScoreThreshold: number;
  readonly highScoreThreshold: number;
  readonly urgentScoreThreshold: number;
  readonly engineCapWarningRatio: number;

  // --- 【GROW-2】Adaptive Opportunity Share ---
  /** 拡張を有効にするか。falseで完全に現行挙動（GROW-1 baseline再現用）。 */
  readonly adaptiveShareEnabled: boolean;
  /** Commercial Ambition側の機会shareの上限（現行値0.35からの開放上限）。 */
  readonly maxAmbitionOpportunityShare: number;
  /** Commercial Commitment側の提出shareの上限（現行値0.50からの開放上限）。 */
  readonly maxCommitmentOpportunityShare: number;
  /** 成約率がこの値を下回ると拡張を線形に縮小し、minimumUsableConversionで0にする。 */
  readonly conversionFeedbackFloor: number;
  /** financialRiskTolerance別の財務規律の強さ（gateの指数。大きいほど厳しい）。 */
  readonly financialDisciplineExponentByRiskTolerance: Readonly<Record<FinancialRiskTolerance, number>>;
}

/**
 * 【既定値の出所】新しい閾値の発明を最小限にするため、次は既存パラメータと同値。
 *   inventoryBrakeStartRatio = STANDARD_AI_PARAMETERS_V1.excessInventoryRatioForDiscount (1.3)
 *   inventoryBrakeFullRatio  = COMMERCIAL_AMBITION_PARAMETERS_V1.inventoryExcessHoldRatio (1.5)
 *   採算の下限                = COMMERCIAL_AMBITION_PARAMETERS_V1.minimumContributionUsdPerKg (0.05)
 *   conversionFeedbackFloor  = COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor (0.75)
 * shareの上限（0.60 / 0.85）は、5社が同時に取りに行っても engine の
 * maximumSupplierShare(0.35) を超えて成約できない構造を踏まえた上での上限であり、
 * GROW-2ベンチマークで成約率・在庫・採算の悪化が出れば下げる前提の初期値である。
 */
export const GROWTH_PRESSURE_PARAMETERS_V1: GrowthPressureParameters = {
  opportunityHeadroomSaturationRatio: 4.0,
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
  adaptiveShareEnabled: true,
  maxAmbitionOpportunityShare: 0.6,
  maxCommitmentOpportunityShare: 0.85,
  conversionFeedbackFloor: COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor,
  financialDisciplineExponentByRiskTolerance: { HIGH: 0, MEDIUM: 1, LOW: 2 },
};

/**
 * 【GROW-2】意思決定より**前**に評価できる部分。
 * Adaptive Shareはこの結果から決まるため、Commercial Ambition / Commitment より前に呼ぶ。
 * ここにはunservedOpportunity・営業採用結果など「決定後にしか分からない値」を入れない。
 */
export interface GrowthPressureCoreInput {
  readonly companyId: string;
  readonly period: PeriodV2;
  readonly observation: StandardAiObservation;
  readonly contracts: readonly SalesContract[];
  /** Vision参照規模（今Turn）。Vision不在ならnull。**Visionを販売目標にはしない**。 */
  readonly visionReferenceScaleTons: number | null;
  readonly growthAmbition: GrowthAmbition | null;
  /** VALUE_FIRSTの会社にのみ効く追加ゲートに使う（実装指示§19）。 */
  readonly strategicPosture: StrategicPosture | null;
  /** LOWの会社にのみ効く財務規律ゲートに使う（実装指示§20）。 */
  readonly financialRiskTolerance: FinancialRiskTolerance | null;
  /**
   * 現在の自社規模。既存Commercial Ambitionのbaselineと同じ量
   * （= max(能力×salesUtilizationTarget, 前期実績生産)）を渡すこと。
   * **提出量・shareには依存しない**ため、これを分母にしても循環しない。
   */
  readonly currentRelevantScaleTons: number;
  /** 観測できる採算つき獲得可能需要（engineのmaximumSupplierShareまで。AI側の控除なし）。 */
  readonly attainableProfitableTons: number;
  /** 上をorientationで重み付けした値（重みが全て1なら同値）。 */
  readonly orientationWeightedOpportunityTons: number;
  readonly weightedContributionUsdPerKg: number;
  readonly priceObservationMissing: boolean;
  readonly observedConversionRatio: number | null;
  readonly finishedGoodsExcessRatioByProduct: Readonly<Record<Product, number>>;
  readonly crisisState: StandardAiCrisisState;
  readonly lastQuarterFinancialHealthTier: FinancialHealthTier | null;
  readonly salesParams?: SalesParameters;
  readonly params?: GrowthPressureParameters;
}

export interface GrowthPressureCore {
  readonly level: GrowthPressureLevel;
  readonly score: number;
  readonly baseScore: number;
  readonly profileSensitivity: number;
  readonly strategicScaleGapRatio: number;
  readonly currentRelevantScaleTons: number;
  readonly visionReferenceScaleTons: number;
  readonly observedOpportunityTons: number;
  readonly orientationWeightedOpportunityTons: number;
  readonly observableOpportunityHeadroomTons: number;
  readonly observableOpportunityHeadroomRatio: number;
  readonly observableOpportunityRatio: number;
  readonly opportunitySupport: number;
  readonly conversionSignal: number;
  readonly marginSignal: number;
  readonly forwardDemandSignal: number;
  readonly inventoryBrake: number;
  readonly crisisBrake: number;
  readonly financeBrake: number;
  readonly marketLifecycleSignal: number;
  readonly supplyPressureBrake: number;
  // --- Adaptive Share ---
  readonly currentOpportunityShare: { readonly ambition: number; readonly commitment: number };
  readonly effectiveOpportunityShare: { readonly ambition: number; readonly commitment: number };
  readonly shareExpansionRatio: number;
  readonly conversionFeedback: number;
  readonly marginFeedback: number;
  readonly inventoryFeedback: number;
  readonly valueOrientationGate: number;
  readonly financialDisciplineGate: number;
  readonly currentSubmissionCeilingTons: number;
  readonly adaptiveSubmissionCeilingTons: number;
  readonly incrementalDesiredSalesFromGrowthTons: number;
  readonly reasonCodes: readonly StandardAiReasonCode[];
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
 * 【GROW-2の中核】意思決定より前に評価できるGrowth Pressureと、そこから決まる
 * Adaptive Opportunity Share（純粋関数）。
 */
export function computeGrowthPressureCore(input: GrowthPressureCoreInput): GrowthPressureCore {
  const params = input.params ?? GROWTH_PRESSURE_PARAMETERS_V1;
  const reasonCodes: StandardAiReasonCode[] = [];

  // --- 1. Strategic Scale Gap ---------------------------------------------
  const currentRelevantScaleTons = Math.max(0, input.currentRelevantScaleTons);
  const visionReferenceScaleTons = input.visionReferenceScaleTons ?? 0;
  const strategicScaleGapRatio =
    visionReferenceScaleTons > EPSILON
      ? clamp01((visionReferenceScaleTons - currentRelevantScaleTons) / visionReferenceScaleTons)
      : 0;

  // --- 2. Observable Opportunity Headroom（非循環・実装指示§2） -----------
  const observedOpportunityTons = Math.max(0, input.attainableProfitableTons);
  const orientationWeightedOpportunityTons = Math.max(0, input.orientationWeightedOpportunityTons);
  const observableOpportunityHeadroomTons = Math.max(0, orientationWeightedOpportunityTons - currentRelevantScaleTons);
  const observableOpportunityHeadroomRatio =
    currentRelevantScaleTons > EPSILON ? observableOpportunityHeadroomTons / currentRelevantScaleTons : 0;
  const observableOpportunityRatio =
    currentRelevantScaleTons > EPSILON ? orientationWeightedOpportunityTons / currentRelevantScaleTons : 0;
  const opportunitySupport = clamp01(observableOpportunityHeadroomRatio / Math.max(EPSILON, params.opportunityHeadroomSaturationRatio));

  // --- 3. bounded modifier ------------------------------------------------
  const conversionFloor = COMMERCIAL_COMMITMENT_PARAMETERS_V1.targetConversionFloor;
  const conversionSignal =
    input.observedConversionRatio === null
      ? 0
      : input.observedConversionRatio >= conversionFloor
        ? clamp((input.observedConversionRatio - conversionFloor) / Math.max(EPSILON, 1 - conversionFloor), 0, 1)
        : clamp((input.observedConversionRatio - conversionFloor) / Math.max(EPSILON, conversionFloor), -1, 0);

  // Healthy Forward Backlog。**Overdueは成長シグナルにしない**（実装指示§14）。
  const { year, quarter } = toYearQuarter(input.period);
  const backlog = computeBacklogSemantics(input.contracts, input.companyId, year, quarter);
  const forwardDemandSignal =
    currentRelevantScaleTons > EPSILON ? clamp01(backlog.healthyForwardTons / currentRelevantScaleTons) : 0;

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

  let supplyPressureBrake = 0;
  if (input.observation.productSupplyPressureByProduct) {
    const values = Object.values(input.observation.productSupplyPressureByProduct);
    const maxPressure = values.length > 0 ? Math.max(...values) : 0;
    supplyPressureBrake = clamp01((maxPressure - 1) / Math.max(EPSILON, params.supplyPressureFullBrake - 1));
  }

  // --- 4. gates -----------------------------------------------------------
  const minimumContribution = COMMERCIAL_AMBITION_PARAMETERS_V1.minimumContributionUsdPerKg;
  const marginSignal = input.priceObservationMissing
    ? 1
    : clamp01(
        (input.weightedContributionUsdPerKg - minimumContribution) /
          Math.max(EPSILON, params.marginFullSupportContributionUsdPerKg - minimumContribution)
      );

  const excessRatios = [
    input.finishedGoodsExcessRatioByProduct.hoso,
    input.finishedGoodsExcessRatioByProduct.pd,
    input.finishedGoodsExcessRatioByProduct.vap,
  ].filter((v) => Number.isFinite(v));
  const maxExcessRatio = excessRatios.length > 0 ? Math.max(...excessRatios) : 0;
  const inventoryBrake = clamp01(
    (maxExcessRatio - params.inventoryBrakeStartRatio) / Math.max(EPSILON, params.inventoryBrakeFullRatio - params.inventoryBrakeStartRatio)
  );

  const crisisGate = params.crisisGateByState[input.crisisState] ?? 1;
  const crisisBrake = 1 - crisisGate;
  const financeGate =
    input.lastQuarterFinancialHealthTier === null ? 1 : (params.financeGateByTier[input.lastQuarterFinancialHealthTier] ?? 0);
  const financeBrake = 1 - financeGate;

  // --- 5. score -----------------------------------------------------------
  const core = strategicScaleGapRatio * opportunitySupport;
  const modifierSum =
    params.conversionWeight * conversionSignal +
    params.forwardDemandWeight * forwardDemandSignal +
    params.lifecycleWeight * marketLifecycleSignal -
    params.supplyPressureWeight * supplyPressureBrake;
  const gated = clamp01(core * (1 + modifierSum)) * marginSignal * (1 - inventoryBrake) * crisisGate * financeGate;
  const baseScore = clamp01(gated);
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

  // --- 6. Adaptive Opportunity Share（実装指示§8〜§13・§18〜§20） --------
  const legacyAmbitionShare = COMMERCIAL_AMBITION_PARAMETERS_V1.realisticShareOfProfitableOpportunity;
  const legacyCommitmentShare = COMMERCIAL_COMMITMENT_PARAMETERS_V1.realisticShareOfOpportunity;

  // 成約フィードバック（実装指示§11）: 目標帯下限を下回るほど拡張を縮小する。
  // 観測が無い（ゲーム開始直後）場合は縮小しない（scoreそのものが低いため過剰にならない）。
  const conversionFeedback =
    input.observedConversionRatio === null
      ? 1
      : clamp01(
          (input.observedConversionRatio - COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumUsableConversion) /
            Math.max(EPSILON, params.conversionFeedbackFloor - COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumUsableConversion)
        );
  const marginFeedback = marginSignal; // 実装指示§12
  const inventoryFeedback = 1 - inventoryBrake; // 実装指示§13
  // 【実装指示§19】value志向（VALUE_FIRST）の会社は、量のgapだけでshareを開けない。
  // 採算（期待貢献）が伴う場合にのみ拡張する。VAP専用のhackではなく、posture条件である。
  const valueOrientationGate = input.strategicPosture === "VALUE_FIRST" ? marginSignal : 1;
  // 【実装指示§20】財務規律。financialRiskToleranceがLOWの会社ほど、採算と財務健全性を
  // 強く要求する（gateを指数で効かせる）。HIGHの会社は追加要求なし。
  const disciplineExponent = input.financialRiskTolerance
    ? params.financialDisciplineExponentByRiskTolerance[input.financialRiskTolerance]
    : 1;
  const financialDisciplineGate = Math.pow(clamp01(marginSignal * financeGate * crisisGate), disciplineExponent);

  const rawExpansion = clamp01((score - params.moderateScoreThreshold) / Math.max(EPSILON, 1 - params.moderateScoreThreshold));
  const shareExpansionRatio = params.adaptiveShareEnabled
    ? clamp01(rawExpansion * conversionFeedback * marginFeedback * inventoryFeedback * valueOrientationGate * financialDisciplineGate)
    : 0;

  const effectiveAmbitionShare =
    legacyAmbitionShare + (params.maxAmbitionOpportunityShare - legacyAmbitionShare) * shareExpansionRatio;
  const effectiveCommitmentShare =
    legacyCommitmentShare + (params.maxCommitmentOpportunityShare - legacyCommitmentShare) * shareExpansionRatio;

  // 提出上限の見込み（診断用。実際の提出量は下流のcommitmentが他の上限とあわせて決める）。
  const currentSubmissionCeilingTons = observedOpportunityTons * legacyCommitmentShare;
  const adaptiveSubmissionCeilingTons = observedOpportunityTons * effectiveCommitmentShare;
  const incrementalDesiredSalesFromGrowthTons = Math.max(0, adaptiveSubmissionCeilingTons - currentSubmissionCeilingTons);

  if (shareExpansionRatio <= EPSILON) {
    reasonCodes.push("GROWTH_SHARE_HELD_LOW");
  } else if (shareExpansionRatio < 0.3) {
    reasonCodes.push("GROWTH_SHARE_EXPANDED_MODERATE");
  } else {
    reasonCodes.push("GROWTH_SHARE_EXPANDED_HIGH");
  }
  if (rawExpansion > EPSILON) {
    if (conversionFeedback < 1 - EPSILON) reasonCodes.push("GROWTH_SHARE_REDUCED_BY_CONVERSION");
    if (marginFeedback < 1 - EPSILON || valueOrientationGate < 1 - EPSILON) reasonCodes.push("GROWTH_SHARE_REDUCED_BY_MARGIN");
    if (inventoryFeedback < 1 - EPSILON) reasonCodes.push("GROWTH_SHARE_REDUCED_BY_INVENTORY");
  }

  return {
    level,
    score,
    baseScore,
    profileSensitivity,
    strategicScaleGapRatio,
    currentRelevantScaleTons,
    visionReferenceScaleTons,
    observedOpportunityTons,
    orientationWeightedOpportunityTons,
    observableOpportunityHeadroomTons,
    observableOpportunityHeadroomRatio,
    observableOpportunityRatio,
    opportunitySupport,
    conversionSignal,
    marginSignal,
    forwardDemandSignal,
    inventoryBrake,
    crisisBrake,
    financeBrake,
    marketLifecycleSignal,
    supplyPressureBrake,
    currentOpportunityShare: { ambition: legacyAmbitionShare, commitment: legacyCommitmentShare },
    effectiveOpportunityShare: { ambition: effectiveAmbitionShare, commitment: effectiveCommitmentShare },
    shareExpansionRatio,
    conversionFeedback,
    marginFeedback,
    inventoryFeedback,
    valueOrientationGate,
    financialDisciplineGate,
    currentSubmissionCeilingTons,
    adaptiveSubmissionCeilingTons,
    incrementalDesiredSalesFromGrowthTons,
    reasonCodes,
  };
}

/** 決定後にしか分からない値（Constraint Routing用）。 */
export interface GrowthConstraintRoutingInput {
  readonly core: GrowthPressureCore;
  readonly observation: StandardAiObservation;
  readonly unservedOpportunity: UnservedOpportunity;
  readonly salesHiringZeroReason: string | null;
  readonly salesForceHireCount: number;
  readonly newCapexProposalCount: number;
  readonly salesParams?: SalesParameters;
  readonly params?: GrowthPressureParameters;
}

/**
 * Growth Pressure本体（core）に、決定後の情報からのConstraint Routingを足して
 * 最終的な診断オブジェクトにする（純粋関数）。
 */
export function assessGrowthPressure(input: GrowthConstraintRoutingInput): GrowthPressureAssessment {
  const params = input.params ?? GROWTH_PRESSURE_PARAMETERS_V1;
  const salesParams = input.salesParams ?? SALES_PARAMETERS_V1;
  const core = input.core;
  const reasonCodes: StandardAiReasonCode[] = [...core.reasonCodes];

  const constraints: GrowthConstraintCategory[] = [];
  const noMarketOpportunity = core.observedOpportunityTons <= EPSILON || core.opportunitySupport <= EPSILON;
  if (noMarketOpportunity) constraints.push("NO_MARKET_OPPORTUNITY");
  if (core.crisisBrake > EPSILON || core.financeBrake > EPSILON) constraints.push("FINANCE");
  if (core.inventoryBrake > EPSILON) constraints.push("INVENTORY");
  if (core.marginSignal <= EPSILON) constraints.push("MARGIN");
  if (input.unservedOpportunity.blockedByRawMaterialTons > EPSILON) constraints.push("RAW_MATERIAL");
  if (input.unservedOpportunity.blockedByLaborTons > EPSILON) constraints.push("LABOR");
  if (input.unservedOpportunity.blockedByProductionCapacityTons > EPSILON) constraints.push("PRODUCTION_CAPACITY");
  if (input.unservedOpportunity.blockedBySalesCapacityTons > EPSILON) constraints.push("COMMERCIAL");

  const salesHiringBlockedByProduction = input.salesHiringZeroReason === "SALES_HIRING_BLOCKED_BY_PRODUCTION";
  const commercialDeadlock =
    salesHiringBlockedByProduction && !noMarketOpportunity && input.unservedOpportunity.blockedByProductionCapacityTons <= EPSILON;
  if (commercialDeadlock) {
    reasonCodes.push("COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION");
    if (!constraints.includes("COMMERCIAL")) constraints.unshift("COMMERCIAL");
  }

  const ceilingSuppressedOpportunityTons = Math.max(0, core.observedOpportunityTons - core.adaptiveSubmissionCeilingTons);
  if (
    (core.level === "HIGH" || core.level === "URGENT") &&
    ceilingSuppressedOpportunityTons > EPSILON &&
    input.unservedOpportunity.blockedByProductionCapacityTons <= EPSILON
  ) {
    reasonCodes.push("GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE");
  }

  // 営業能力engineの漸近上限（実装指示§17）。式は変更しない。
  const model = salesParams.salesCapacityModel;
  if (model && model.kind !== "perMarket") {
    const asymptoteEffortTons = model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons;
    const requiredEffortForVision = core.visionReferenceScaleTons * averageSalesEffortCoefficient(input.observation, salesParams);
    if (requiredEffortForVision > asymptoteEffortTons * params.engineCapWarningRatio) {
      reasonCodes.push("GROWTH_BLOCKED_BY_ENGINE_CAP");
      reasonCodes.push("EXTERNAL_ENGINE_CAPACITY_LIMIT");
    }
  }
  if (ceilingSuppressedOpportunityTons > EPSILON) reasonCodes.push("GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP");
  if (!noMarketOpportunity && core.observedOpportunityTons > EPSILON) reasonCodes.push("GROWTH_OPPORTUNITY_AVAILABLE");

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

  return {
    level: core.level,
    score: core.score,
    strategicScaleGapRatio: core.strategicScaleGapRatio,
    observableOpportunityRatio: core.observableOpportunityRatio,
    observableOpportunityHeadroomTons: core.observableOpportunityHeadroomTons,
    observableOpportunityHeadroomRatio: core.observableOpportunityHeadroomRatio,
    orientationWeightedOpportunityTons: core.orientationWeightedOpportunityTons,
    opportunitySupport: core.opportunitySupport,
    conversionSignal: core.conversionSignal,
    marginSignal: core.marginSignal,
    forwardDemandSignal: core.forwardDemandSignal,
    inventoryBrake: core.inventoryBrake,
    crisisBrake: core.crisisBrake,
    financeBrake: core.financeBrake,
    marketLifecycleSignal: core.marketLifecycleSignal,
    supplyPressureBrake: core.supplyPressureBrake,
    observedOpportunityTons: core.observedOpportunityTons,
    ceilingSuppressedOpportunityTons,
    visionReferenceScaleTons: core.visionReferenceScaleTons,
    currentRelevantScaleTons: core.currentRelevantScaleTons,
    profileSensitivity: core.profileSensitivity,
    baseScore: core.baseScore,
    primaryGrowthConstraint,
    secondaryGrowthConstraints,
    recommendedPressureDestination: destinationByConstraint[primaryGrowthConstraint],
    nearTermGrowthActionExists: input.salesForceHireCount > 0 || input.newCapexProposalCount > 0,
    currentOpportunityShare: core.currentOpportunityShare,
    effectiveOpportunityShare: core.effectiveOpportunityShare,
    shareExpansionRatio: core.shareExpansionRatio,
    conversionFeedback: core.conversionFeedback,
    marginFeedback: core.marginFeedback,
    inventoryFeedback: core.inventoryFeedback,
    valueOrientationGate: core.valueOrientationGate,
    financialDisciplineGate: core.financialDisciplineGate,
    currentSubmissionCeilingTons: core.currentSubmissionCeilingTons,
    adaptiveSubmissionCeilingTons: core.adaptiveSubmissionCeilingTons,
    incrementalDesiredSalesFromGrowthTons: core.incrementalDesiredSalesFromGrowthTons,
    reasonCodes,
  };
}
