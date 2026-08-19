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

  // --- 中心となる2項（実装指示§31: base strategic gap × opportunity support） ---
  /** Vision参照規模に対する不足率（0〜1）。 */
  readonly strategicScaleGapRatio: number;
  /** 観測上の市場機会 ÷ 現在この会社が実際に取りに行っている量。 */
  readonly observableOpportunityRatio: number;
  /** 上の比率を0〜1へ写した支持度（1.0倍で0、飽和比率で1）。 */
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
  /** 現在この会社が実際に取りに行っている量（Commercial Commitmentの提出目標）。 */
  readonly currentSubmissionCeilingTons: number;
  /** 上2つの差＝現行capで捨てている観測機会。 */
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

  /** 既存のdiagnostic architectureと同じreason code語彙（reasonCodes.tsに登録済み）。 */
  readonly reasonCodes: readonly StandardAiReasonCode[];
}
