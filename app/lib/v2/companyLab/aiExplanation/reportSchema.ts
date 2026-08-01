// ShrimpX V2 — Standard AI経営説明レポート機能 出力スキーマ（MVP）
//
// Claudeの応答テキストをJSONとしてパースした後、必ずこのZodスキーマで検証してから
// 呼び出し側（route.ts・キャッシュ）へ渡す。スキーマに一致しない応答は
// 「意思決定に使ってよい構造化データ」として扱わない（claudeClient.tsの
// schema_mismatchエラー分類を参照）。

import { z } from "zod";

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
