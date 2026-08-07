// ShrimpX V2 — 会社経営統合テスト環境 品質・信頼・納期ダッシュボード（Phase 7B）
// 成約競争力の説明文生成
//
// CompetitivenessExplanationRow（dashboardViewModel.tsが既に抽出したPhase 4/6.3/7A
// の実績値）から、固定ルールによる簡潔な日本語説明文を組み立てる。生成AIは
// 使用しない。表示根拠のない断定は行わない（スコアが中立値付近の場合はその
// 要因に触れない）。成約競争力の計算式そのものはここでは一切再計算しない
// （すべてsales/allocation.tsのcomputeCompetitivenessBreakdownが既に算出した
// 値の分岐・文字列化のみ）。

import { CompetitivenessExplanationRow } from "./dashboardViewModel";

const HIGH_SCORE_THRESHOLD = 65;
const LOW_SCORE_THRESHOLD = 35;

type FactorLevel = "high" | "low" | "neutral";

function factorLevel(score: number | undefined): FactorLevel {
  if (score === undefined) return "neutral";
  if (score >= HIGH_SCORE_THRESHOLD) return "high";
  if (score <= LOW_SCORE_THRESHOLD) return "low";
  return "neutral";
}

function priceClause(row: CompetitivenessExplanationRow): string {
  if (row.isPriceScoreAtCeiling) {
    return "価格競争力は上限に達しており、追加値下げの効果はありません";
  }
  const deviationPct = row.priceDeviationRatio * 100;
  if (deviationPct <= -5) {
    return `値引き提示（基準価格比${deviationPct.toFixed(0)}%）により価格条件で優位`;
  }
  if (deviationPct >= 5) {
    return `強気の価格設定（基準価格比+${deviationPct.toFixed(0)}%）により価格条件はやや不利`;
  }
  return "価格条件は同業平均並み";
}

function nonPriceClause(row: CompetitivenessExplanationRow): string | undefined {
  const qualityLevel = factorLevel(row.qualityReputation);
  const relationshipLevel = factorLevel(row.customerRelationship);
  const reliabilityLevel = factorLevel(row.deliveryReliability);

  const highFactors: string[] = [];
  const lowFactors: string[] = [];
  if (qualityLevel === "high") highFactors.push("高い品質評価");
  if (qualityLevel === "low") lowFactors.push("低い品質評価");
  if (relationshipLevel === "high") highFactors.push("高い顧客信頼");
  if (relationshipLevel === "low") lowFactors.push("低い顧客信頼");
  if (reliabilityLevel === "high") highFactors.push("高い納期信頼性");
  if (reliabilityLevel === "low") lowFactors.push("低い納期信頼性");

  if (row.coverageScore < 0.4) lowFactors.push("低い営業カバレッジ");
  else if (row.coverageScore > 0.85) highFactors.push("高い営業カバレッジ");

  const clauses: string[] = [];
  if (highFactors.length > 0) clauses.push(`${highFactors.join("・")}が成約を押し上げました`);
  if (lowFactors.length > 0) clauses.push(`${lowFactors.join("・")}が競争力を押し下げました`);
  if (clauses.length === 0) return undefined;
  return clauses.join("。一方、");
}

/**
 * 1件のmarket×product成約競争力説明文を組み立てる（固定ルール、生成AI不使用）。
 * 表示根拠が乏しい場合（価格・非価格要因のいずれも中立に近い場合）は、断定を
 * 避けた中立的な文にする。
 */
export function buildCompetitivenessExplanationText(row: CompetitivenessExplanationRow): string {
  const price = priceClause(row);
  const nonPrice = nonPriceClause(row);

  if (row.isPriceScoreAtCeiling && nonPrice === undefined) {
    return `${price}。品質・顧客信頼・納期信頼性は同業平均並みのため、これ以上の差別化には品質・信頼面の改善が必要です。`;
  }
  if (nonPrice === undefined) {
    return `${price}。品質・顧客信頼・納期信頼性のいずれも同業平均並みで、突出した押し上げ・押し下げ要因は見当たりません。`;
  }
  return `${price}が、${nonPrice}。`;
}

/** 前期比の一言（成約競争力ウェイトの変化）。表示根拠のない断定を避けるため、前期データがない場合は空文字。 */
export function buildWeightTrendNote(row: CompetitivenessExplanationRow): string {
  if (row.previousCompetitivenessWeight === undefined) return "";
  const delta = row.competitivenessWeight - row.previousCompetitivenessWeight;
  if (Math.abs(delta) < 1e-4) return "前期からほぼ横ばいです。";
  return delta > 0 ? "前期より成約条件は改善しています。" : "前期より成約条件は悪化しています。";
}
