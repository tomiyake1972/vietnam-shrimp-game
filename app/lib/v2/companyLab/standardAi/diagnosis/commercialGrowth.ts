// ShrimpX V2 — Vision駆動の商業成長：診断と人間向け説明（Phase 6・2026-08-09新設）
//
// 【生成AIを一切使わない】説明文は決定論的なテンプレートである。
// 同じ入力からは常に同じ文章が出る。
//
// 【建てなかった／伸ばさなかった理由も記録する】規模を上げなかった四半期にも
// 必ず理由コードを残す。「上げなかった」ことも経営判断だからである。

import { CompanyVision } from "../../vision/types";
import { StrategicGrowthState } from "../../vision/strategicGrowth";
import { CommercialAmbition } from "../../vision/commercialAmbition";
import { GrowthConstraint, UnservedOpportunity } from "../../vision/unservedOpportunity";
import { ObservableCommercialOpportunity } from "../decision/sales";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";

const t = (v: number) => `${Math.round(v).toLocaleString()}t`;

const CONSTRAINT_LABELS: Readonly<Record<GrowthConstraint, string>> = {
  SALES_CAPACITY: "営業能力",
  PRODUCTION_CAPACITY: "生産能力",
  LABOR: "労働力",
  RAW_MATERIAL: "原料",
  INVENTORY_POLICY: "在庫方針",
  OTHER: "その他",
  NONE: "なし",
};

/** 未充足機会の主因に対応する理由コード。 */
const UNSERVED_CODE_BY_CONSTRAINT: Readonly<Partial<Record<GrowthConstraint, StandardAiReasonCode>>> = {
  SALES_CAPACITY: "UNSERVED_BY_SALES_CAPACITY",
  PRODUCTION_CAPACITY: "UNSERVED_BY_PRODUCTION_CAPACITY",
  LABOR: "UNSERVED_BY_LABOR",
  RAW_MATERIAL: "UNSERVED_BY_RAW_MATERIAL",
};

export interface CommercialGrowthDiagnosticsInput {
  readonly companyId: string;
  readonly vision: CompanyVision | null;
  readonly strategicGrowth: StrategicGrowthState | null;
  readonly opportunity: ObservableCommercialOpportunity;
  readonly ambition: CommercialAmbition;
  readonly unserved: UnservedOpportunity;
  readonly submittedSalesTons: number;
}

/**
 * 人間向けの一文（決定論的テンプレート）。
 * 「なぜ今期この規模を目指したのか／目指さなかったのか」を1文で言い切る。
 */
export function buildCommercialGrowthExplanation(input: CommercialGrowthDiagnosticsInput): string {
  const { companyId, vision, ambition, unserved, opportunity } = input;
  if (!vision) return `${companyId}にはVisionが与えられていないため、販売規模の目標は現在の生産能力から決まっている。`;

  if (ambition.expanded) {
    const constraint = CONSTRAINT_LABELS[unserved.primaryConstraint];
    const tail =
      unserved.unservedProfitableTons > 0
        ? `ただし${constraint}の制約で${t(unserved.unservedProfitableTons)}を取り切れていない。`
        : "今期は制約なく狙えている。";
    return (
      `${companyId}は${vision.preferredEndState}のVisionに対して販売規模が遅れている。` +
      `観測上、採算の取れる販売機会が${t(opportunity.attainableProfitableTons)}残っているため、` +
      `今期は販売規模を${t(ambition.baselineTons)}から${t(ambition.ambitionTons)}へ引き上げて狙う。${tail}`
    );
  }

  switch (ambition.limiter) {
    case "VISION_ON_TRACK":
      return `${companyId}はVisionの参考成長軌道に対して遅れていないため、今期は販売規模の拡大を狙わない。`;
    case "MARKET_WEAK":
      return `${companyId}はVision上は成長したいが、観測できる採算の取れる市場機会が現在の規模を上回らないため、販売規模拡大を見送る。`;
    case "MARGIN_WEAK":
      return `${companyId}はVision上は成長したいが、直近の期待貢献が薄いため、量的な販売規模拡大を見送る。`;
    case "INVENTORY_EXCESS":
      return `${companyId}は完成品在庫が過剰なため、新たな規模拡大より先に在庫を売り切ることを優先する。`;
    default:
      return `${companyId}は今期、販売規模を現状水準に据え置く。`;
  }
}

/**
 * 商業成長の診断エントリ一式（純粋関数）。
 * 値はすべて既に計算済みのものを詰め直すだけで、ここで新しい判断はしない。
 */
export function buildCommercialGrowthDiagnostics(input: CommercialGrowthDiagnosticsInput): readonly StandardAiDiagnosticEntry[] {
  const { companyId, vision, strategicGrowth, ambition, unserved, opportunity, submittedSalesTons } = input;
  const entries: StandardAiDiagnosticEntry[] = [];
  const push = (code: StandardAiReasonCode, keyValues: Record<string, number>, decisionSummary: string, message: string) =>
    entries.push({ code, domain: "sales", companyId, severity: "info", keyValues, decisionSummary, message });

  if (!vision || !strategicGrowth) return entries;

  const growthKeyValues = {
    visionReferenceScaleTons: strategicGrowth.visionTargetScaleAtCurrentTurn,
    commercialAmbitionTons: ambition.ambitionTons,
    baselineTons: ambition.baselineTons,
    ambitionMultiplier: ambition.ambitionMultiplier,
    submittedSalesTons,
    observableDemandTons: opportunity.observableDemandTons,
    attainableProfitableTons: opportunity.attainableProfitableTons,
    weightedContributionUsdPerKg: opportunity.weightedContributionUsdPerKg,
    realisticOpportunityTons: ambition.realisticOpportunityTons,
  };

  // --- 志に対する商業的な遅れ ---
  if (ambition.baselineTons < strategicGrowth.visionTargetScaleAtCurrentTurn) {
    push(
      "COMMERCIAL_SCALE_BELOW_VISION_PATH",
      growthKeyValues,
      `販売規模 ${t(ambition.baselineTons)} が Vision の参考規模 ${t(strategicGrowth.visionTargetScaleAtCurrentTurn)} を下回る`,
      `現在の販売規模はVisionの参考成長軌道を${t(strategicGrowth.visionTargetScaleAtCurrentTurn - ambition.baselineTons)}下回っている。`
    );
    push(
      "VISION_COMMERCIAL_GROWTH_PRESSURE",
      growthKeyValues,
      `商業的な成長圧力 ${strategicGrowth.growthPressure}`,
      "志に対して販売規模が遅れており、商業的な成長圧力がある。これは達成義務ではなく、今期の規模判断の入口である。"
    );
  }

  // --- 観測できる採算つき機会 ---
  if (opportunity.attainableProfitableTons > ambition.baselineTons) {
    push(
      "PROFITABLE_MARKET_OPPORTUNITY_AVAILABLE",
      growthKeyValues,
      `採算の取れる観測機会 ${t(opportunity.attainableProfitableTons)}`,
      `観測できる範囲（原則2四半期遅行の公開実績）で、採算の取れる獲得可能需要が${t(
        opportunity.attainableProfitableTons
      )}ある。期待貢献の加重平均は${opportunity.weightedContributionUsdPerKg.toFixed(2)}USD/kg。`
    );
  }

  // --- 規模を上げたか、上げなかったか ---
  if (ambition.expanded) {
    push(
      "COMMERCIAL_AMBITION_EXPANDED",
      growthKeyValues,
      `目指す販売規模を ${t(ambition.baselineTons)} → ${t(ambition.ambitionTons)} へ引き上げ`,
      buildCommercialGrowthExplanation(input)
    );
  } else {
    const code: StandardAiReasonCode =
      ambition.limiter === "MARKET_WEAK"
        ? "COMMERCIAL_AMBITION_HELD_MARKET_WEAK"
        : ambition.limiter === "MARGIN_WEAK"
          ? "COMMERCIAL_AMBITION_HELD_MARGIN_WEAK"
          : ambition.limiter === "INVENTORY_EXCESS"
            ? "COMMERCIAL_AMBITION_HELD_INVENTORY"
            : "COMMERCIAL_GROWTH_ON_TRACK";
    push(code, growthKeyValues, `販売規模を ${t(ambition.baselineTons)} に据え置き`, buildCommercialGrowthExplanation(input));
  }

  // --- 取りたかったが取れなかった分と、その主因 ---
  if (unserved.unservedProfitableTons > 0) {
    const breakdown = {
      unservedProfitableTons: unserved.unservedProfitableTons,
      blockedBySalesCapacityTons: unserved.blockedBySalesCapacityTons,
      blockedByProductionCapacityTons: unserved.blockedByProductionCapacityTons,
      blockedByLaborTons: unserved.blockedByLaborTons,
      blockedByRawMaterialTons: unserved.blockedByRawMaterialTons,
      blockedByInventoryPolicyTons: unserved.blockedByInventoryPolicyTons,
      otherTons: unserved.otherTons,
    };
    push(
      "UNSERVED_PROFITABLE_OPPORTUNITY",
      breakdown,
      `取り切れなかった採算つき機会 ${t(unserved.unservedProfitableTons)}（主因: ${CONSTRAINT_LABELS[unserved.primaryConstraint]}）`,
      `今期目指した販売規模${t(ambition.ambitionTons)}に対し、実際に提出できた販売計画は${t(
        submittedSalesTons
      )}だった。差の${t(unserved.unservedProfitableTons)}が未充足の採算つき機会であり、主因は${
        CONSTRAINT_LABELS[unserved.primaryConstraint]
      }である。`
    );
    const constraintCode = UNSERVED_CODE_BY_CONSTRAINT[unserved.primaryConstraint];
    if (constraintCode) {
      push(
        constraintCode,
        breakdown,
        `未充足の主因: ${CONSTRAINT_LABELS[unserved.primaryConstraint]}`,
        unserved.primaryConstraint === "PRODUCTION_CAPACITY"
          ? "取りたい需要はあるが生産能力が足りない。これは能力投資（既存増設または新工場）で解決しうる不足である。"
          : "取りたい需要はあるが、工場能力以外の要因で取れていない。工場を建てても解決しない不足である。"
      );
    }
  }

  return entries;
}
