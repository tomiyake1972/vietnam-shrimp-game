// ShrimpX V2 — 品質・信頼・納期ダッシュボード（Phase 7B） 成約競争力説明文テスト
//
// 対応する重要テスト項目（実装指示より）:
//   9. 成約競争力の説明が、保存された価格・品質・信頼・納期データと矛盾しない
//   10. 価格競争力上限時に「追加値下げ余地あり」と誤表示しない

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompetitivenessExplanationRow } from "../dashboardViewModel";
import { buildCompetitivenessExplanationText, buildWeightTrendNote } from "../dashboardExplanation";

function makeRow(overrides: Partial<CompetitivenessExplanationRow> = {}): CompetitivenessExplanationRow {
  return {
    market: "US",
    product: "hoso",
    askPrice: 5.0,
    basePrice: 5.0,
    priceDeviationRatio: 0,
    isPriceScoreAtCeiling: false,
    isPriceScoreAtFloor: false,
    qualityReputation: 50,
    customerRelationship: 50,
    deliveryReliability: 50,
    coverageScore: 0.6,
    priceContribution: 0.2,
    coverageContribution: 0.15,
    relationshipContribution: 0.08,
    qualityContribution: 0.08,
    deliveryReliabilityContribution: 0.05,
    competitivenessWeight: 0.56,
    desiredQuantity: 1000,
    allocatedQuantity: 500,
    weightTrend: "unknown",
    ...overrides,
  };
}

// --- 10: 価格競争力上限時に「追加値下げ余地あり」と誤表示しない ---

test("受入確認E-1: isPriceScoreAtCeiling=trueの場合、説明文は必ず「上限」「追加値下げの効果はありません」を含み、値引きが有利であるかのような文言は含まない", () => {
  const row = makeRow({ isPriceScoreAtCeiling: true, priceDeviationRatio: -0.3 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(text.includes("上限"), `説明文に「上限」が含まれるはず: ${text}`);
  assert.ok(text.includes("追加値下げの効果はありません"), `説明文: ${text}`);
  assert.ok(!text.includes("優位"), `価格競争力が上限到達済みの場合、値引きが「優位」であるかのような矛盾した文言を含んではならない: ${text}`);
});

test("受入確認E-2: isPriceScoreAtCeiling=falseかつ大幅値引き(-10%)の場合は「値引き」により価格条件が優位である旨の文言になる（矛盾しない）", () => {
  const row = makeRow({ isPriceScoreAtCeiling: false, priceDeviationRatio: -0.1 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(text.includes("値引き"), `説明文: ${text}`);
  assert.ok(!text.includes("上限"), `上限に達していない場合は「上限」文言を含まない: ${text}`);
});

// --- 9: 説明が保存データと矛盾しない ---

test("受入確認E-3: 品質評価が高い(80点)場合、説明文に「高い品質評価」が含まれる（保存データと整合）", () => {
  const row = makeRow({ qualityReputation: 80, customerRelationship: 50, deliveryReliability: 50 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(text.includes("高い品質評価"), `説明文: ${text}`);
});

test("受入確認E-4: 品質評価が低い(20点)場合、説明文に「低い品質評価」が含まれ、「高い品質評価」は含まれない", () => {
  const row = makeRow({ qualityReputation: 20, customerRelationship: 50, deliveryReliability: 50 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(text.includes("低い品質評価"), `説明文: ${text}`);
  assert.ok(!text.includes("高い品質評価"), `説明文: ${text}`);
});

test("受入確認E-5: 品質・顧客関係・納期信頼性のすべてが中立値(50点)付近かつ価格も同業平均並みの場合、断定的な押し上げ/押し下げ文言を含まない（表示根拠のない断定を避ける）", () => {
  const row = makeRow({ qualityReputation: 50, customerRelationship: 50, deliveryReliability: 50, coverageScore: 0.6, priceDeviationRatio: 0 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(!text.includes("押し上げました"), `説明文: ${text}`);
  assert.ok(!text.includes("押し下げました"), `説明文: ${text}`);
});

test("受入確認E-6: qualityReputation等がundefined（未接続）の場合はエラーにならず、中立扱いとして断定を避ける", () => {
  const row = makeRow({ qualityReputation: undefined, customerRelationship: undefined, deliveryReliability: undefined });
  assert.doesNotThrow(() => buildCompetitivenessExplanationText(row));
});

test("受入確認E-7: 高い品質評価と低い納期信頼性が同時にある場合、両方の文言が含まれる（一方だけを恣意的に隠さない）", () => {
  const row = makeRow({ qualityReputation: 85, customerRelationship: 50, deliveryReliability: 15 });
  const text = buildCompetitivenessExplanationText(row);
  assert.ok(text.includes("高い品質評価"), `説明文: ${text}`);
  assert.ok(text.includes("低い納期信頼性"), `説明文: ${text}`);
});

// --- buildWeightTrendNote: 前期比較 ---

test("受入確認E-8: previousCompetitivenessWeightが未定義の場合、前期比コメントは空文字（前期データがないのに断定しない）", () => {
  const row = makeRow({ previousCompetitivenessWeight: undefined });
  assert.equal(buildWeightTrendNote(row), "");
});

test("受入確認E-9: 前期よりcompetitivenessWeightが上昇していれば「改善」、低下していれば「悪化」の文言になる", () => {
  const improved = makeRow({ competitivenessWeight: 0.6, previousCompetitivenessWeight: 0.5 });
  const worsened = makeRow({ competitivenessWeight: 0.5, previousCompetitivenessWeight: 0.6 });
  assert.ok(buildWeightTrendNote(improved).includes("改善"));
  assert.ok(buildWeightTrendNote(worsened).includes("悪化"));
});
