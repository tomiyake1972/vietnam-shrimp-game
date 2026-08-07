// ShrimpX V2 — Standard AI経営説明レポート機能 出力スキーマ（MVP）
//
// Claudeの応答テキストをJSONとしてパースした後、必ずこのZodスキーマで検証してから
// 呼び出し側（route.ts・キャッシュ）へ渡す。スキーマに一致しない応答は
// 「意思決定に使ってよい構造化データ」として扱わない（claudeClient.tsの
// schema_mismatchエラー分類を参照）。

import { z } from "zod";

/**
 * 【2026-08-02・25秒問題対応・出力量削減】各配列フィールドの件数の「目安」。
 * あくまでClaudeへの指示（tool定義のmaxItems・systemPromptの明示文言）として使う
 * 単一の定義元であり、下のZodスキーマ側では意図的にこの値をハードな検証上限として
 * 使わない（後述の理由）。claudeClient.tsのEXPLANATION_REPORT_TOOL_INPUT_SCHEMAと
 * systemPrompt.tsの両方がこの定数を参照することで、「schemaのmaxItems」と
 * 「promptの件数指示」が常に一致した状態を保つ（数値のドリフトを防ぐ）。
 *
 * 【Zod検証側で件数の上限を追加しない理由】tool_choiceで渡すJSON Schemaの
 * maxItemsはあくまでClaudeへの"お願い"（Anthropic側で厳密に強制されるハード制約
 * ではない）であり、Claudeが目安をわずかに超えて返す可能性は排除できない。
 * ここでのZod検証にも同じ件数上限を追加すると、目安をわずかに超えただけの
 * 応答まで新たにschema_mismatch（＝2回目のAPI呼び出しによる遅延の倍増）として
 * 扱ってしまい、今回の目的（25秒以内に安定して収める）に逆行する。そのため
 * Zod側は件数を検証しない（＝今回の変更で新たなschema_mismatch要因を増やさない）。
 */
export const EXPLANATION_OUTPUT_LIMITS = {
  maxRecommendations: 3,
  maxReasonsPerRecommendation: 2,
  maxKeyRisks: 3,
  maxQuestionsForPlayer: 2,
  maxDataLimitations: 2,
} as const;

const recommendationReasonSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const recommendationSchema = z.object({
  area: z.string(),
  title: z.string(),
  action: z.string(),
  reasons: z.array(recommendationReasonSchema),
});

const keyRiskSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  title: z.string(),
  description: z.string(),
});

export const standardAiManagementReportSchema = z.object({
  headline: z.string(),
  executiveSummary: z.string(),
  recommendations: z.array(recommendationSchema),
  keyRisks: z.array(keyRiskSchema),
  questionsForPlayer: z.array(z.string()),
  dataLimitations: z.array(z.string()),
});

export type StandardAiManagementReport = z.infer<typeof standardAiManagementReportSchema>;
