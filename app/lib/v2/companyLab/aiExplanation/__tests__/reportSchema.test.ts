// ShrimpX V2 — Standard AI経営説明レポート機能 出力スキーマのテスト（MVP）

import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLANATION_OUTPUT_LIMITS, standardAiManagementReportSchema } from "../reportSchema";

function validPayload() {
  return {
    headline: "今期はVAP増産が奏功",
    executiveSummary: "受注残の消化が順調に進んでいます。",
    recommendations: [
      {
        area: "sales",
        title: "VAP販売の拡大余地",
        action: "VAPの営業配分を維持する",
        reasons: [{ label: "受注残", value: "120トン" }],
      },
    ],
    keyRisks: [{ severity: "medium", title: "原料在庫の減少", description: "来期に原料不足の恐れがあります。" }],
    questionsForPlayer: ["原料の追加輸入を検討しますか？"],
    dataLimitations: ["前四半期の市場実績データはまだありません。"],
  };
}

test("reportSchema: 正しい形のペイロードはパースに成功する", () => {
  const result = standardAiManagementReportSchema.safeParse(validPayload());
  assert.equal(result.success, true);
});

test("reportSchema: headlineが欠けている場合は失敗する", () => {
  const payload = validPayload() as Record<string, unknown>;
  delete payload.headline;
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("reportSchema: recommendationsが配列でない場合は失敗する", () => {
  const payload = { ...validPayload(), recommendations: "not-an-array" };
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("reportSchema: keyRisks.severityが不正な値の場合は失敗する", () => {
  const payload = validPayload();
  payload.keyRisks = [{ severity: "extreme", title: "x", description: "y" }] as never;
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("reportSchema: questionsForPlayerが文字列配列でない場合は失敗する", () => {
  const payload = { ...validPayload(), questionsForPlayer: [1, 2, 3] };
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("reportSchema: dataLimitationsが空配列でも成功する（データ制約が無いことの正当な表現）", () => {
  const payload = { ...validPayload(), dataLimitations: [] };
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, true);
});

test("reportSchema: recommendations[].reasonsが欠けている場合は失敗する", () => {
  const payload = validPayload();
  payload.recommendations = [{ area: "sales", title: "t", action: "a" }] as never;
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, false);
});

test("reportSchema: 余分なトップレベルフィールドがあっても既知フィールドの型が正しければ成功する（zodの既定=非strict）", () => {
  const payload = { ...validPayload(), unexpectedExtraField: "should be ignored by default parsing" };
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, true);
});

test("reportSchema: nullペイロードは失敗する", () => {
  const result = standardAiManagementReportSchema.safeParse(null);
  assert.equal(result.success, false);
});

// 【2026-08-02・25秒問題対応・出力量削減の回帰テスト】EXPLANATION_OUTPUT_LIMITSは
// あくまでClaudeへの目安指示（tool定義のmaxItems・systemPromptの文言）であり、
// Zod検証側では意図的に件数上限を強制しない（reportSchema.tsのコメント参照）。
// このテストは、目安件数をわずかに超えた既存の正常な形の応答が、今回の変更後も
// 引き続きparseに成功すること（＝新たなschema_mismatchを生まないこと）を確認する。
test("reportSchema: EXPLANATION_OUTPUT_LIMITSの目安件数を超えていても、形が正しければ引き続きパースに成功する(Zod側は件数を強制しない)", () => {
  const payload = {
    headline: "見出し",
    executiveSummary: "要約。",
    recommendations: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxRecommendations + 2 }, (_, i) => ({
      area: "sales",
      title: `提案${i}`,
      action: "action",
      reasons: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxReasonsPerRecommendation + 2 }, (_, j) => ({
        label: `label${j}`,
        value: `value${j}`,
      })),
    })),
    keyRisks: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxKeyRisks + 2 }, (_, i) => ({
      severity: "low" as const,
      title: `risk${i}`,
      description: "desc",
    })),
    questionsForPlayer: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxQuestionsForPlayer + 2 }, (_, i) => `q${i}`),
    dataLimitations: Array.from({ length: EXPLANATION_OUTPUT_LIMITS.maxDataLimitations + 2 }, (_, i) => `d${i}`),
  };
  const result = standardAiManagementReportSchema.safeParse(payload);
  assert.equal(result.success, true, "目安件数を超えた応答でも、意図的にschema_mismatchにはしない設計であるはず");
});
