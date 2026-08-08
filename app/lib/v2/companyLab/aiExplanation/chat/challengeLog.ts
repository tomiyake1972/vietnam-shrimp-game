// ShrimpX V2 — Human Challenge Log（実装指示§18・§19）
//
// 【目的】将来、人間からの質問・反論を Standard AI Training Harness へ
// HUMAN_AI_CHALLENGE として戻し、Standard AI改善の教師情報として利用するための
// machine-readableな記録。
//
// 【MVPでの制約】
//   - 自動学習・自動修正は一切行わない（記録するだけ）。
//   - Training Harnessのdecision logicは変更しない。
//   - 記録の成否は回答の成否に影響しない（保存に失敗しても回答はそのまま返す）。

import { CompanyLabRedisClient } from "../../../redis/companyLabTypes";
import { StandardAiChatAnswer } from "./chatSchema";

/** この記録フォーマットのバージョン。フィールドを変更したら上げること。 */
export const HUMAN_CHALLENGE_SCHEMA_VERSION = 1;

/**
 * 質問の分類（実装指示§18）。
 * 【重要】これは質問文のキーワードによる決定論的なヒューリスティック分類であり、
 * 意味理解ではない。誤分類はありうる（Harness側で再分類できるよう、questionの
 * 原文も必ず一緒に保存する）。分類のためにClaudeを追加で呼ぶことはしない。
 */
export type HumanChallengeType = "WHY" | "DISAGREEMENT" | "ALTERNATIVE_REQUEST" | "BOTTLENECK_QUESTION" | "OTHER";

const DISAGREEMENT_MARKERS = ["おかしい", "変じゃない", "変では", "本当に合理的", "合理的なの", "間違って", "納得できない", "妥当なの", "疑問"];
const ALTERNATIVE_MARKERS = ["他に", "ほかに", "代わりに", "別の案", "選択肢", "代替", "オプション"];
const BOTTLENECK_MARKERS = ["ボトルネック", "最大の制約", "制約は", "何が効いて", "律速"];
const WHY_MARKERS = ["なぜ", "なんで", "どうして", "理由"];

/**
 * 質問文を分類する。優先順位は「反論 > 代替案要求 > ボトルネック質問 > なぜ質問 > その他」。
 * 反論を最優先にするのは、Standard AI改善の教師情報として最も価値が高いため
 * （「なぜ〜が変じゃない？」のように複数マーカーを含む場合、反論として扱いたい）。
 */
export function classifyChallengeType(question: string): HumanChallengeType {
  const q = question.trim();
  if (DISAGREEMENT_MARKERS.some((m) => q.includes(m))) return "DISAGREEMENT";
  if (ALTERNATIVE_MARKERS.some((m) => q.includes(m))) return "ALTERNATIVE_REQUEST";
  if (BOTTLENECK_MARKERS.some((m) => q.includes(m))) return "BOTTLENECK_QUESTION";
  if (WHY_MARKERS.some((m) => q.includes(m))) return "WHY";
  return "OTHER";
}

/**
 * 1件ぶんのHuman Challenge記録。
 * 【将来のHarness接続（§19）】State（contextHash＋labId/companyId/turnで一意に再現可能）、
 * Standard AI Decision・Reason Codes（同一contextHashのStandard AI提案から再取得可能）、
 * Human Question、Claude Explanation が揃っている。
 */
export interface HumanChallengeRecord {
  readonly schemaVersion: number;
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly contextHash: string;
  readonly chatPromptVersion: string;
  readonly chatContextSchemaVersion: number;
  readonly model: string;
  readonly challengeType: HumanChallengeType;
  readonly question: string;
  /** Claudeの回答（構造化されたまま保存する。要約・加工はしない）。失敗時はnull。 */
  readonly answer: StandardAiChatAnswer | null;
  /** 回答が失敗した場合のカテゴリ（成功時はnull）。 */
  readonly errorCategory: string | null;
  /** 回答が参照した理由コード（answerがnullの場合は空配列）。 */
  readonly relatedReasonCodes: readonly string[];
  readonly timestamp: string;
}

export interface BuildHumanChallengeRecordInput {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly contextHash: string;
  readonly chatPromptVersion: string;
  readonly chatContextSchemaVersion: number;
  readonly model: string;
  readonly question: string;
  readonly answer: StandardAiChatAnswer | null;
  readonly errorCategory: string | null;
  readonly timestamp: string;
}

export function buildHumanChallengeRecord(input: BuildHumanChallengeRecordInput): HumanChallengeRecord {
  return {
    schemaVersion: HUMAN_CHALLENGE_SCHEMA_VERSION,
    labId: input.labId,
    companyId: input.companyId,
    turn: input.turn,
    contextHash: input.contextHash,
    chatPromptVersion: input.chatPromptVersion,
    chatContextSchemaVersion: input.chatContextSchemaVersion,
    model: input.model,
    challengeType: classifyChallengeType(input.question),
    question: input.question,
    answer: input.answer,
    errorCategory: input.errorCategory,
    relatedReasonCodes: input.answer ? [...input.answer.relatedReasonCodes] : [],
    timestamp: input.timestamp,
  };
}

/**
 * 記録の保存キー。既存の会社ラボRedisキー命名（companylab:v2:...）を踏襲する。
 * 1件1キー（連番はtimestamp＋通し番号）ではなく、labId:companyId:turn単位の
 * JSON配列として追記する（MVPでは件数が少なく、Harnessへ渡す際も
 * turn単位でまとめて読めた方が扱いやすいため）。
 */
export function buildChallengeLogKey(labId: string, companyId: string, turn: number): string {
  return `companylab:v2:${labId}:${companyId}:${turn}:humanChallengeLog`;
}

/** 1つのturnに保存する記録の上限。無制限に伸びてRedis値が肥大化することを防ぐ。 */
export const MAX_CHALLENGE_RECORDS_PER_TURN = 50;

/**
 * 記録を追記する。**この関数は例外を投げない**（保存失敗が回答を壊さないため）。
 * 戻り値は保存できたかどうか（ログ・テスト用）。
 */
export async function appendHumanChallengeRecord(
  client: CompanyLabRedisClient,
  record: HumanChallengeRecord
): Promise<boolean> {
  const key = buildChallengeLogKey(record.labId, record.companyId, record.turn);
  try {
    const raw = await client.get(key);
    let existing: HumanChallengeRecord[] = [];
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as HumanChallengeRecord[];
    } else if (Array.isArray(raw)) {
      // @upstash/redisは値をJSONとして自動パースして返すことがある。
      existing = raw as HumanChallengeRecord[];
    }
    const next = [...existing, record].slice(-MAX_CHALLENGE_RECORDS_PER_TURN);
    await client.set(key, JSON.stringify(next));
    return true;
  } catch (e) {
    console.error(`[challengeLog] 保存に失敗しました（回答は影響を受けません） key=${key}:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}
