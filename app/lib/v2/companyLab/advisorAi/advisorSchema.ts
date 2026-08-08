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
  maxEvidenceRefsPerSection: 5,
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
  /**
   * 【数値の根拠追跡（品質強化Batch 1・§14）】
   * その節が数値を述べた場合に、その数値がcontextのどのフィールド由来かを書かせる。
   * 例: "liveGameState.financials.current.operatingIncomeUsd"
   *
   * 【なぜ必要か】相談役AIの最も危険な失敗は「もっともらしい数値を作ること」である。
   * 出典文書（sources）は文章の根拠しか辿れず、数値には効かない。数値については
   * 「contextのどのキーを読んだか」を書かせることで、後から機械的に検証できる形にする。
   *
   * 【なぜ検証を強制しないか（MVPの範囲）】contextは入れ子のJSONであり、Claudeが書く
   * パス表記は完全一致しないことがある。今回は「必ず書かせて、書かれていない
   * FACT節の件数をログへ出す」ところまでを行い、パスの厳密照合はまだ行わない
   * （厳密照合を先に入れると、正しい回答を誤って落とすリスクの方が大きい）。
   * 【捏造禁止】検証していないものを「検証済み」としてUIへ出さないこと。
   *
   * 古い保存済み会話にはこのフィールドが無いため、既定値を空配列にしてある。
   */
  evidenceRefs: z.array(z.string()).default([]),
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
          evidenceRefs: {
            type: "array",
            maxItems: ADVISOR_OUTPUT_LIMITS.maxEvidenceRefsPerSection,
            description:
              "この節で述べた数値の出所を、渡されたcontextのフィールドパスで書く" +
              "（例: liveGameState.financials.current.operatingIncomeUsd、" +
              "standardAiState.chatContext.bottleneck）。" +
              "数値を1つでも述べたなら必ず1つ以上書くこと。数値を述べていない節では空配列でよい。" +
              "contextに存在しないパスを書いてはいけない。",
            items: { type: "string" },
          },
        },
        required: ["type", "text", "sourceTypes", "sources", "evidenceRefs"],
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
