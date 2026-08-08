// ShrimpX V2 — 「Standard AIに質問する」対話機能（Phase 1 MVP） 出力スキーマ
//
// Claudeの応答は必ずtool_use（構造化出力）で受け取り、このZodスキーマで検証してから
// UIへ渡す（既存Explanation層reportSchema.tsと同じ多重防御方針）。
//
// 【事実と評価の分離（実装指示§8）】回答内部で
//   FACT               : 実際の状態・数値（explanation contextに存在する値）
//   STANDARD_AI_REASON : 実際のreason code / diagnostic / threshold
//   INTERPRETATION     : その判断が何を意味するか（Claudeの解釈）
//   LIMITATION         : 根拠が無い・弱い点
// を区別する。UI上でこのラベルをそのまま表示する必要はないが、出力構造としては
// conclusion（結論）/ evidence（根拠＝FACT+STANDARD_AI_REASON）/ interpretation・
// limitations（補足）に分離して受け取る。

import { z } from "zod";

/** 件数の目安。tool定義のmaxItemsとシステムプロンプトの文言が常に一致するよう、ここを唯一の定義元にする。 */
export const CHAT_OUTPUT_LIMITS = {
  maxEvidence: 4,
  maxRelatedReasonCodes: 5,
  maxLimitations: 3,
} as const;

/**
 * 回答の種別。
 *   standard_ai_explanation : Standard AIの当該Turn判断を、ログ上の根拠で説明できた
 *   insufficient_evidence   : 質問自体は範囲内だが、Standard AIのログに根拠が無い
 *                             （＝「分からない」と明言する。もっともらしい理由を作らない）
 *   out_of_scope            : この機能の対象外（一般知識・将来予測・反実仮想・
 *                             意思決定の書き換え要求・プロンプト開示要求など）
 */
export const chatAnswerKindSchema = z.enum(["standard_ai_explanation", "insufficient_evidence", "out_of_scope"]);
export type StandardAiChatAnswerKind = z.infer<typeof chatAnswerKindSchema>;

const evidenceItemSchema = z.object({
  /** FACT（実測値）かSTANDARD_AI_REASON（AI自身の理由コード・閾値）かの区別。 */
  kind: z.enum(["FACT", "STANDARD_AI_REASON"]),
  label: z.string(),
  value: z.string(),
});

export const standardAiChatAnswerSchema = z.object({
  answerKind: chatAnswerKindSchema,
  /** 【結論】1〜2文。 */
  conclusion: z.string(),
  /** 【根拠】数値・reason code・constraint。根拠が無い場合は空配列。 */
  evidence: z.array(evidenceItemSchema),
  /** 【補足】弱点・不確実性。不要ならnull。 */
  supplement: z.string().nullable(),
  /** 参照した理由コード（診断ログに実在するものだけ）。 */
  relatedReasonCodes: z.array(z.string()),
  /** 根拠が無い・弱い点の明示（LIMITATION）。 */
  limitations: z.array(z.string()),
});

export type StandardAiChatAnswer = z.infer<typeof standardAiChatAnswerSchema>;

/** Anthropic tool定義のinput_schema（構造化出力の強制に使う）。上のZodスキーマと1対1で対応させること。 */
export const CHAT_ANSWER_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    answerKind: {
      type: "string",
      enum: ["standard_ai_explanation", "insufficient_evidence", "out_of_scope"],
      description:
        "standard_ai_explanation=ログ上の根拠で説明できた / insufficient_evidence=範囲内だが根拠がログに無い / out_of_scope=この機能の対象外の質問",
    },
    conclusion: { type: "string", description: "【結論】なぜその判断かを1〜2文で。" },
    evidence: {
      type: "array",
      maxItems: CHAT_OUTPUT_LIMITS.maxEvidence,
      description: "【根拠】contextに実在する数値、またはStandard AIの理由コード・閾値だけ。存在しないものを書かない。",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["FACT", "STANDARD_AI_REASON"] },
          label: { type: "string" },
          value: { type: "string" },
        },
        required: ["kind", "label", "value"],
      },
    },
    supplement: { type: ["string", "null"], description: "【補足】弱点・不確実性。不要ならnull。" },
    relatedReasonCodes: {
      type: "array",
      maxItems: CHAT_OUTPUT_LIMITS.maxRelatedReasonCodes,
      description: "diagnosticEntriesに実在するcodeだけを列挙する。存在しないコード名を作らない。",
      items: { type: "string" },
    },
    limitations: {
      type: "array",
      maxItems: CHAT_OUTPUT_LIMITS.maxLimitations,
      description: "根拠が無い・弱い点。Standard AIの弱点を隠さず書く。",
      items: { type: "string" },
    },
  },
  required: ["answerKind", "conclusion", "evidence", "supplement", "relatedReasonCodes", "limitations"],
} as const;

export const CHAT_ANSWER_TOOL_NAME = "submit_standard_ai_answer";
