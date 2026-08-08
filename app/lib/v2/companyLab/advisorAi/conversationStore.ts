// ShrimpX V2 — 相談役AI  会話の保存・復元（実装指示§34・§35・§36・§50）
//
// 【保存方針】
//   ・既存のCompanyLabRedisClientをそのまま使う（新しい永続化経路を作らない）。
//   ・キーは labId + companyId 単位。MVPでは1本のactive conversationのみ（§35）。
//     将来の複数thread化に備えて、値の中にconversationIdを持たせてある。
//   ・turnはメッセージごとに保持する（§33：現在turnと発言時turnを区別するため）。
//   ・保存の失敗は回答を壊さない（回答は返し、保存失敗はログに残すだけ）。
//
// 【将来のAI経営会議設計への利用（§50・§51）】
// どの情報源が実際によく使われたか、どの論点が頻出するか、利用者がどこで反論したかを
// 後から分析できるよう、質問原文・カテゴリ・使用したsourceType・参照文書・
// reason codeを保存する。分類は誤りうるため原文を必ず残す。

import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { AdvisorAnswer } from "./advisorSchema";
import { AdvisorQuestionCategory } from "./questionRouting";
import { AdvisorSourceType } from "./sourceTags";

export const ADVISOR_CONVERSATION_SCHEMA_VERSION = 1;

/** 保持するメッセージ数の上限（§32：往復12 → メッセージ24。余裕を持って30）。 */
export const ADVISOR_MAX_STORED_MESSAGES = 30;

export type AdvisorMessageRole = "user" | "advisor";

export interface AdvisorStoredMessage {
  readonly role: AdvisorMessageRole;
  readonly message: string;
  /** このメッセージが発せられた時点のturn（現在turnと区別するため）。 */
  readonly turn: number;
  readonly timestamp: string;
  // --- 以下はadvisorメッセージのみ設定される（分析用） ---
  readonly category?: AdvisorQuestionCategory;
  readonly sourceTypesUsed?: readonly AdvisorSourceType[];
  readonly sourceDocuments?: readonly string[];
  readonly relatedReasonCodes?: readonly string[];
  readonly contextHash?: string;
  readonly model?: string;
  /** 構造化された回答全体（sectionsを含む）。UI復元にそのまま使う。 */
  readonly answer?: AdvisorAnswer;
  /** 失敗した場合のカテゴリ。 */
  readonly errorCategory?: string;
}

export interface AdvisorConversation {
  readonly schemaVersion: number;
  readonly conversationId: string;
  readonly labId: string;
  readonly companyId: string;
  /** 会話が開始された時点のturn（現在turnとは別。§33）。 */
  readonly startedAtTurn: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly AdvisorStoredMessage[];
  /**
   * 【二重送信防止（品質強化Batch 1・§18）】直近で**成功**したリクエストのID。
   * 同じIDが再送された場合、Claudeを呼び直さず保存済みの回答をそのまま返す。
   *
   * 【失敗を記録しない理由（§20）】失敗したrequestIdを覚えてしまうと、
   * 「同じ質問を再送する」ボタンが永久に同じ失敗を返すようになる。
   * これは既存Explanation層で実際に起きた失敗キャッシュ問題であり、再導入しない。
   * したがってここには成功時のIDだけを書く。
   */
  readonly lastSucceededRequestId?: string;
}

/** 会話の保存キー。既存の会社ラボRedisキー命名（companylab:v2:...）を踏襲する。 */
export function buildAdvisorConversationKey(labId: string, companyId: string): string {
  return `companylab:v2:${labId}:${companyId}:advisorConversation`;
}

/**
 * conversationIdの生成。
 * 【Date.now()を使う理由】この値は識別子であり、ゲームの決定論性に影響しない
 * （ゲームエンジン側の乱数・時刻依存は一切変更していない）。
 */
export function newConversationId(nowIso: string): string {
  return `adv-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createEmptyConversation(labId: string, companyId: string, turn: number, nowIso: string): AdvisorConversation {
  return {
    schemaVersion: ADVISOR_CONVERSATION_SCHEMA_VERSION,
    conversationId: newConversationId(nowIso),
    labId,
    companyId,
    startedAtTurn: turn,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages: [],
  };
}

function parseConversation(raw: unknown): AdvisorConversation | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object") return null;
  const c = value as Partial<AdvisorConversation>;
  if (typeof c.conversationId !== "string" || !Array.isArray(c.messages)) return null;
  // 【後方互換】schemaVersionが将来上がったときに古い会話を壊さないよう、
  // 想定外のバージョンは「復元しない（新しい会話を始める）」ことで安全側に倒す。
  if (c.schemaVersion !== ADVISOR_CONVERSATION_SCHEMA_VERSION) return null;
  return value as AdvisorConversation;
}

/** 会話を読み込む。失敗しても例外を投げず null を返す（新規会話として扱う）。 */
export async function loadAdvisorConversation(
  client: CompanyLabRedisClient,
  labId: string,
  companyId: string
): Promise<AdvisorConversation | null> {
  try {
    const raw = await client.get(buildAdvisorConversationKey(labId, companyId));
    if (raw === null || raw === undefined) return null;
    return parseConversation(raw);
  } catch (e) {
    console.error(`[advisorConversation] 読み込みに失敗しました（新規会話として続行） lab=${labId}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 会話を保存する。失敗しても例外を投げない（回答は返す）。 */
export async function saveAdvisorConversation(client: CompanyLabRedisClient, conversation: AdvisorConversation): Promise<boolean> {
  try {
    const trimmed: AdvisorConversation = {
      ...conversation,
      messages: conversation.messages.slice(-ADVISOR_MAX_STORED_MESSAGES),
    };
    await client.set(buildAdvisorConversationKey(conversation.labId, conversation.companyId), JSON.stringify(trimmed));
    return true;
  } catch (e) {
    console.error(
      `[advisorConversation] 保存に失敗しました（回答は影響を受けません） lab=${conversation.labId}:`,
      e instanceof Error ? e.message : String(e)
    );
    return false;
  }
}

/**
 * 会話を消す（実装指示§36）。削除後は新しいconversationIdの空会話を返す。
 * 確認UIはクライアント側の責務。
 */
export async function clearAdvisorConversation(
  client: CompanyLabRedisClient,
  labId: string,
  companyId: string,
  turn: number,
  nowIso: string
): Promise<AdvisorConversation> {
  const fresh = createEmptyConversation(labId, companyId, turn, nowIso);
  await saveAdvisorConversation(client, fresh);
  return fresh;
}

/** 保存済み会話から、Claudeへ渡す往復履歴を組み立てる（user→advisorの対を作る）。 */
export function toHistoryTurns(
  conversation: AdvisorConversation | null,
  maxTurns: number
): readonly { readonly question: string; readonly answer: string; readonly originalTurn: number }[] {
  if (conversation === null) return [];
  const pairs: { question: string; answer: string; originalTurn: number }[] = [];
  let pendingQuestion: AdvisorStoredMessage | null = null;
  for (const message of conversation.messages) {
    if (message.role === "user") {
      pendingQuestion = message;
      continue;
    }
    if (pendingQuestion !== null) {
      pairs.push({ question: pendingQuestion.message, answer: message.message, originalTurn: pendingQuestion.turn });
      pendingQuestion = null;
    }
  }
  return pairs.slice(-maxTurns);
}

/** 回答から、分析用のsourceType・参照文書を抽出する（誤分類を避けるため回答の申告値をそのまま使う）。 */
export function extractAnswerMetadata(answer: AdvisorAnswer): {
  readonly sourceTypesUsed: readonly AdvisorSourceType[];
  readonly sourceDocuments: readonly string[];
} {
  const sourceTypes = new Set<AdvisorSourceType>();
  const documents = new Set<string>();
  for (const section of answer.sections) {
    for (const t of section.sourceTypes) sourceTypes.add(t);
    for (const s of section.sources) {
      if (s.path) documents.add(s.path);
    }
  }
  return { sourceTypesUsed: [...sourceTypes], sourceDocuments: [...documents] };
}
