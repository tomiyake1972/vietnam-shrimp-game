// ShrimpX V2 — Phase SAI-GROW-1: Shadow Growth Pressure の型定義
//
// 【この層の位置づけ（実装指示§0）】これは **diagnostic only** である。
// 販売希望量・営業採用・生産・調達・CAPEX・配当のいずれにも接続しない。
// GROW-1の成功条件は「Growth Pressureを入れてもStandard AIの判断が完全に
// 従来どおりであること」であり、意思決定への配線はGROW-2以降で行う。

import { StandardAiReasonCode } from "../reasonCodes";

/** 成長圧力の段階。既存のvision/strategicGrowth.tsのGrowthPressureと同じ語彙を使う（新しい語彙を作らない）。 */
export type GrowthPressureLevel = "LOW" | "MODERATE" | "HIGH" | "URGENT";

/**
 * 今その会社の成長を止めている主因（実装指示§18）。
 * 既存のvision/unservedOpportunity.tsのGrowthConstraintとは別enumである
 * （あちらは「未充足機会の原因分解」、こちらは「経営資源をどこへ向けるべきか」の分類）。
 */
export type GrowthConstraintCategory =
  | "COMMERCIAL"
  | "PRODUCTION_CAPACITY"
  | "RAW_MATERIAL"
  | "LABOR"
  | "FINANCE"
  | "MARGIN"
  | "INVENTORY"
  | "NO_MARKET_OPPORTUNITY"
  | "NONE";

/** 成長圧力の向け先（実装指示§20）。GROW-1では診断としてのみ出力する。 */
export type GrowthPressureDestination =
  | "SALES_HIRING"
  | "CAPEX"
  | "PROCUREMENT_EXPANSION"
  | "WORKFORCE_EXPANSION"
  | "IMPROVE_MIX_OR_PRICE"
  | "HOLD_GROWTH"
  | "SALES_EXPANSION";

/**
 * 実装指示§5のGrowthPressureAssessment。
 * すべて純粋な観測・既存診断からの導出であり、未来のTRUE WORLDは含まれない。
 */
export interface GrowthPressureAssessment {
  readonly level: GrowthPressureLevel;
  /** 0〜1。GROW-1ではDecisionに一切使用しない（診断・ベンチマーク専用）。 */
  readonly score: number;

  // --- 中心となる2項（GROW-1 §31: base strategic gap × opportunity support） ---
  /** Vision参照規模に対する不足率（0〜1）。 */
  readonly strategicScaleGapRatio: number;
  /**
   * 【GROW-2で意味を変更】観測機会 ÷ **現在の自社規模**（currentRelevantScaleTons）。
   * GROW-1では分母に現在の提出上限を使っていたが、GROW-2ではその提出上限自体を
   * Growth Pressureで動かすため、分母に使うと循環する（実装指示§2）。
   */
  readonly observableOpportunityRatio: number;
  /**
   * 【GROW-2新設・実装指示§2】現行capから独立した市場headroom。
   *   headroomTons  = max(0, orientation重み付き観測機会 − 現在の自社規模)
   *   headroomRatio = headroomTons / 現在の自社規模
   */
  readonly observableOpportunityHeadroomTons: number;
  readonly observableOpportunityHeadroomRatio: number;
  /** 会社の志向で重み付けした観測機会（重みが全て1なら観測機会そのもの）。 */
  readonly orientationWeightedOpportunityTons: number;
  /** headroomRatioを0〜1へ写した支持度（飽和比率で1）。 */
  readonly opportunitySupport: number;

  // --- bounded modifier（実装指示§31: 係数を乱造しない） ---
  /** 成約率シグナル。−1（悪化）〜+1（良好）。観測が無ければ0。 */
  readonly conversionSignal: number;
  /** 採算シグナル。0（採算なし）〜1（十分）。marginGateとしても使う。 */
  readonly marginSignal: number;
  /** Healthy Forward Backlog由来の将来需要可視性。0〜1。**Overdueは含めない**（実装指示§12）。 */
  readonly forwardDemandSignal: number;
  /** 完成品在庫による抑制。0（抑制なし）〜1（完全抑制）。 */
  readonly inventoryBrake: number;
  /** Crisis Stateによる抑制。0〜1。 */
  readonly crisisBrake: number;
  /** 財務健全性による抑制。0〜1。 */
  readonly financeBrake: number;
  /** 公開ライフサイクルトレンド。−1〜+1。 */
  readonly marketLifecycleSignal: number;
  /** 公開供給圧力による抑制。0〜1。 */
  readonly supplyPressureBrake: number;

  // --- 現行capが捨てている機会（実装指示§24。GROW-2の主要判断材料） ---
  /** 観測上、engineのmaximumSupplierShareまでなら取りうる採算つき需要（AI側の追加控除なし）。 */
  readonly observedOpportunityTons: number;
  /** observedOpportunityTons − currentSubmissionCeilingTons ＝ 現行capで捨てている観測機会。 */
  readonly ceilingSuppressedOpportunityTons: number;

  // --- 参照値（監査用。ここから式を再計算しないための一次情報） --- 
  readonly visionReferenceScaleTons: number;
  readonly currentRelevantScaleTons: number;
  /** profile差（既存のambitionSensitivityを再利用。Vision不在なら1.0）。 */
  readonly profileSensitivity: number;
  /** sensitivity適用前のscore。 */
  readonly baseScore: number;

  // --- Constraint Routing（実装指示§18〜§20） ---
  readonly primaryGrowthConstraint: GrowthConstraintCategory;
  readonly secondaryGrowthConstraints: readonly GrowthConstraintCategory[];
  readonly recommendedPressureDestination: GrowthPressureDestination;

  // --- 将来DIV-5が参照するための最小情報（実装指示§33） ---
  /** 当期の意思決定に、実際に成長のための行動（営業採用・新規CAPEX提案）が含まれるか。 */
  readonly nearTermGrowthActionExists: boolean;

  // --- 【GROW-2】Adaptive Opportunity Share（実際にDecisionへ接続する唯一の値） ---
  /** 拡張前（現行）の機会share。ambition側 / commitment側。 */
  readonly currentOpportunityShare: { readonly ambition: number; readonly commitment: number };
  /** 実際に適用したshare。Growth Pressure LOWでは現行と完全同一。 */
  readonly effectiveOpportunityShare: { readonly ambition: number; readonly commitment: number };
  /** 0〜1。0なら現行と完全同一（拡張なし）。 */
  readonly shareExpansionRatio: number;
  /** 成約率フィードバック（0〜1。拡張を縮小する方向にのみ効く）。 */
  readonly conversionFeedback: number;
  /** 採算フィードバック（0〜1）。 */
  readonly marginFeedback: number;
  /** 在庫フィードバック（0〜1）。 */
  readonly inventoryFeedback: number;
  /** value志向（VALUE_FIRST）の会社にのみ効く追加ゲート（0〜1）。 */
  readonly valueOrientationGate: number;
  /** 財務規律ゲート（financialRiskTolerance=LOWの会社にのみ追加で効く。0〜1）。 */
  readonly financialDisciplineGate: number;
  /** 現行shareでの提出上限（＝GROW-1と同じ値）。 */
  readonly currentSubmissionCeilingTons: number;
  /** 拡張後のshareで見込まれる提出上限（実測値は下流のcommitmentが決める）。 */
  readonly adaptiveSubmissionCeilingTons: number;
  /** 上2つの差＝Growth Pressureによって増えた販売希望の上限幅。 */
  readonly incrementalDesiredSalesFromGrowthTons: number;

  // --- 【GROW-3A】Adaptive Growth Step（1四半期の伸び幅上限） ---
  /** 拡張前の伸び幅（maxStep × intensity）。 */
  readonly baseStepLimit: number;
  /** 実際に適用した伸び幅（baseStepLimit × growthEvidenceMultiplier）。 */
  readonly effectiveStepLimit: number;
  /** step limitへ掛けた倍率（1.0＝従来と完全同一）。 */
  readonly growthEvidenceMultiplier: number;
  /** 0〜1。step拡大の根拠の強さ（GROW-2のshareExpansionRatioを再利用）。 */
  readonly growthStepExpansionRatio: number;
  /** step limitが無ければ到達していたambition（min(visionCeiling, realisticOpportunity)）。 */
  readonly ambitionBeforeStepLimit: number;
  /** 実際のambition（step limit適用後）。 */
  readonly ambitionAfterStepLimit: number;
  /** step拡大によって増えた販売希望量（baseStepでのambitionとの差）。 */
  readonly incrementalDesiredSalesFromAdaptiveStep: number;
  /** Commercial Ambition側のlimiter（STEP_LIMIT / VISION_ON_TRACK / MARKET_WEAK 等）。 */
  readonly ambitionLimiter: string;

  /** 既存のdiagnostic architectureと同じreason code語彙（reasonCodes.tsに登録済み）。 */
  readonly reasonCodes: readonly StandardAiReasonCode[];
}
