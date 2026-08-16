// ShrimpX V2 — AI Management Meeting: 会話状態の永続化（AMM-M0/M1）
//
// 【ゲーム状態SSoTとの分離】ここで永続化するAiMeetingConversationStateは、
// 「conversation artifact」として、ゲーム状態SSoT（CompanyLabState・
// CompanyDecisionDraft等）とは完全に別のRedis名前空間（companylab:v2:...:aiMeeting:...）
// に保存する。会話メッセージがゲームの意思決定・状態を直接変更することはない
// （変更する経路自体が存在しない）。
//
// 【既存Redis経路の再利用】aiExplanation/reportCache.tsと同じCompanyLabRedisClient・
// withTimeoutパターンをそのまま使う。新しいRedis接続方法は増やさない。
//
// 【会話履歴のtruncation（三宅さんの追加指示§12）】永続化自体は全メッセージを保持する
// （プレイヤーが後で会話全体を見返せるようにするため）が、Claudeへ毎回送るのは
// 直近6-10件＋古い部分の簡潔な要約のみ（buildRecentHistoryForPrompt）。この要約は
// 追加のClaude呼び出しをせず、決定論的な文字列圧縮（各発言の先頭80文字を連結）で
// 作る（コスト・レイテンシを増やさないための意図的な単純化）。

import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { AiMeetingConversationState, AiMeetingIntent, AiMeetingMessage, ValidatedAiMeetingProposal } from "./types";

export const AI_MEETING_CACHE_TIMEOUT_MS = 8_000;
/** Claudeへ毎回送る直近メッセージ数（6-10件の範囲で実装指示に従い8を採用）。 */
export const AI_MEETING_RECENT_MESSAGE_COUNT = 8;
const COMPACT_SUMMARY_CHARS_PER_MESSAGE = 80;

class AiMeetingCacheTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`[aiManagementMeeting/conversation] Redis操作(${operation})が${timeoutMs}msでタイムアウトしました。`);
    this.name = "AiMeetingCacheTimeoutError";
  }
}

function withTimeout<T>(operation: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AiMeetingCacheTimeoutError(operation, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** 明示的なmeetingIdが未指定の場合の既定値（1turn＝1ミーティングとして扱う）。 */
export function defaultMeetingId(labId: string, companyId: string, turn: number): string {
  return `${labId}:${companyId}:turn${turn}`;
}

function conversationKey(labId: string, companyId: string, meetingId: string): string {
  return `companylab:v2:${labId}:${companyId}:aiMeeting:${meetingId}`;
}

export async function loadConversation(client: CompanyLabRedisClient, labId: string, companyId: string, meetingId: string): Promise<AiMeetingConversationState | null> {
  const key = conversationKey(labId, companyId, meetingId);
  const raw = await withTimeout("get", client.get(key), AI_MEETING_CACHE_TIMEOUT_MS);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as AiMeetingConversationState;
    } catch {
      return null;
    }
  }
  return raw as AiMeetingConversationState;
}

export async function saveConversation(client: CompanyLabRedisClient, state: AiMeetingConversationState): Promise<void> {
  const key = conversationKey(state.labId, state.companyId, state.meetingId);
  await withTimeout("set", client.set(key, JSON.stringify(state)), AI_MEETING_CACHE_TIMEOUT_MS);
}

export function newConversation(labId: string, companyId: string, turn: number, meetingId: string): AiMeetingConversationState {
  return { meetingId, labId, companyId, turn, messages: [], lastMeetingIntent: null, lastValidatedProposals: [], compactSummary: null };
}

/** 新しいメッセージを会話へ追記した、更新後の状態を返す（副作用なし。呼び出し側がsaveConversationする）。 */
export function appendMessages(
  state: AiMeetingConversationState,
  newMessages: readonly AiMeetingMessage[],
  update: { readonly meetingIntent?: AiMeetingIntent; readonly validatedProposals?: readonly ValidatedAiMeetingProposal[] }
): AiMeetingConversationState {
  return {
    ...state,
    messages: [...state.messages, ...newMessages],
    lastMeetingIntent: update.meetingIntent ?? state.lastMeetingIntent,
    lastValidatedProposals: update.validatedProposals ?? state.lastValidatedProposals,
  };
}

export interface RecentHistoryForPrompt {
  readonly recent: readonly AiMeetingMessage[];
  readonly compactSummary: string | null;
}

/**
 * 永続化済みの全メッセージから、Claudeへ実際に送る「直近N件＋古い部分の簡潔な要約」を作る。
 * 追加のAPI呼び出しはしない（決定論的な文字列圧縮のみ）。
 */
export function buildRecentHistoryForPrompt(messages: readonly AiMeetingMessage[]): RecentHistoryForPrompt {
  if (messages.length <= AI_MEETING_RECENT_MESSAGE_COUNT) {
    return { recent: messages, compactSummary: null };
  }
  const splitAt = messages.length - AI_MEETING_RECENT_MESSAGE_COUNT;
  const older = messages.slice(0, splitAt);
  const recent = messages.slice(splitAt);
  const compactSummary = older
    .map((m) => `${m.speaker}: ${m.text.length > COMPACT_SUMMARY_CHARS_PER_MESSAGE ? `${m.text.slice(0, COMPACT_SUMMARY_CHARS_PER_MESSAGE)}…` : m.text}`)
    .join(" / ");
  return { recent, compactSummary };
}
