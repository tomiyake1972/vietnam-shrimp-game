// ShrimpX V2 — 相談役AI  出力スキーマ（実装指示§24・§25）
//
// 【完全free textにしない理由】
// 相談役AIは自由に推論してよいが、「どれが事実で、どれがStandard AIの見解で、
// どれが相談役AI自身の推論で、どれが開発記録に基づく話か」を利用者が区別できなければ、
// 自由推論はそのまま誤情報になる。そこで本文（answer）は自然文のままにしつつ、
// 根拠をsections（type付き）として並行して受け取る。
//
// UIの主表示はanswer。sectionのtypeとsourceは小さく添えるだけにする。

import { z } from "zod";
import { SOURCE_AUTHORITIES, SOURCE_TYPES } from "./sourceTags";

export const ADVISOR_OUTPUT_LIMITS = {
  maxSections: 6,
  maxSourcesPerSection: 3,
  maxRelatedReasonCodes: 6,
  maxSuggestedFollowUps: 3,
} as const;

/**
 * sectionの種類（実装指示§25）。
 *   FACT                 … contextに実在する状態・数値
 *   STANDARD_AI_VIEW     … Standard AI自身の判断（diagnostics/reason codeにあるもの）
 *   ADVISOR_INFERENCE    … 相談役AI自身の推論・意見。事実ではない
 *   DEVELOPMENT_RATIONALE… 開発記録に基づく設計意図・経緯
 *   UNCERTAINTY          … 分からないこと・確定していないこと
 */
export const advisorSectionTypeSchema = z.enum([
  "FACT",
  "STANDARD_AI_VIEW",
  "ADVISOR_INFERENCE",
  "DEVELOPMENT_RATIONALE",
  "UNCERTAINTY",
]);
export type AdvisorSectionType = z.infer<typeof advisorSectionTypeSchema>;

const advisorSourceRefSchema = z.object({
  title: z.string().nullable(),
  path: z.string().nullable(),
  authority: z.enum(SOURCE_AUTHORITIES).nullable(),
});

const advisorSectionSchema = z.object({
  type: advisorSectionTypeSchema,
  text: z.string(),
  sourceTypes: z.array(z.enum(SOURCE_TYPES)),
  sources: z.array(advisorSourceRefSchema),
});

export const advisorAnswerSchema = z.object({
  /** UIの主表示。自然な日本語の回答本文。 */
  answer: z.string(),
  sections: z.array(advisorSectionSchema),
  /** 参照したStandard AIの理由コード（diagnosticEntriesに実在するものだけ）。 */
  relatedReasonCodes: z.array(z.string()),
  /** 続けて聞くとよい質問。 */
  suggestedFollowUps: z.array(z.string()),
});

export type AdvisorAnswer = z.infer<typeof advisorAnswerSchema>;

export const ADVISOR_ANSWER_TOOL_NAME = "submit_advisor_answer";

/** Anthropic tool定義のinput_schema。上のZodスキーマと1対1で対応させること。 */
export const ADVISOR_ANSWER_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "利用者へ見せる回答本文。自然な日本語。経営者と一緒に考える相談役としての口調で。",
    },
    sections: {
      type: "array",
      maxItems: ADVISOR_OUTPUT_LIMITS.maxSections,
      description:
        "回答の根拠を種類ごとに分けたもの。事実・Standard AIの見解・自分の推論・開発記録・不確実性を必ず区別すること。",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["FACT", "STANDARD_AI_VIEW", "ADVISOR_INFERENCE", "DEVELOPMENT_RATIONALE", "UNCERTAINTY"],
          },
          text: { type: "string" },
          sourceTypes: {
            type: "array",
            items: { type: "string", enum: [...SOURCE_TYPES] },
            description:
              "この節が依拠した情報の種類。ゲーム内部の真値を使った場合は必ずGAME_INTERNAL_TRUEを含めること。",
          },
          sources: {
            type: "array",
            maxItems: ADVISOR_OUTPUT_LIMITS.maxSourcesPerSection,
            description: "開発記録・仕様書を根拠にした場合の出所。渡された抜粋のpathだけを書くこと（存在しないpathを作らない）。",
            items: {
              type: "object",
              properties: {
                title: { type: ["string", "null"] },
                path: { type: ["string", "null"] },
                authority: { type: ["string", "null"], enum: [...SOURCE_AUTHORITIES, null] },
              },
              required: ["title", "path", "authority"],
            },
          },
        },
        required: ["type", "text", "sourceTypes", "sources"],
      },
    },
    relatedReasonCodes: {
      type: "array",
      maxItems: ADVISOR_OUTPUT_LIMITS.maxRelatedReasonCodes,
      description: "diagnosticEntriesに実在するcodeだけ。存在しないコード名を作らないこと。",
      items: { type: "string" },
    },
    suggestedFollowUps: {
      type: "array",
      maxItems: ADVISOR_OUTPUT_LIMITS.maxSuggestedFollowUps,
      description: "続けて聞くとよい質問（短く）。",
      items: { type: "string" },
    },
  },
  required: ["answer", "sections", "relatedReasonCodes", "suggestedFollowUps"],
} as const;
