// ShrimpX V2 — AI Management Meeting: Run Advisory Memory（AMM-M2.6）
//
// 【このモジュールの位置づけ】これはStandard AIの学習でもGame Engineの学習でもない。
// AI Management Meeting専用の、Run-scoped advisory memoryである。プレイヤーが会話中に
// 明示した訂正・方針・制約・優先順位・未確認見解を短い構造化memoryとして保持し、
// 同一Run（=labId）・同一Companyの後続turnでAI役員が参照できるようにするだけの
// 「conversation artifact」（conversation.tsと同じ位置づけ）。Game State SSoT・
// Standard AI・Vision/ManagementProfile・Finance/Sales/Production/Trust/CAPEXの
// 意思決定ロジックへは一切書き込まない・参照させない（変更する経路自体が存在しない）。
//
// 【永続化】既存AI Meeting Redis namespace（companylab:v2:...）・CompanyLabRedisClient・
// withTimeoutパターンをそのまま再利用する（conversation.tsと同じ設計）。新しいRedis
// 接続方法は増やさない。key粒度はrunId(=labId)×companyId（実装指示§6推奨）。
//
// 【AIに保存可否を最終決定させない（実装指示§14）】Claudeが返すmemoryCandidatesは
// あくまで「候補」。ここで型・scope・文字数・重複・上限をserver-sideで検証してから
// 初めて永続化する。

import { randomUUID } from "crypto";
import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import { BacklogDueStatus } from "./backlogSemantics";
import {
  ExecutiveRole,
  RunAdvisoryMemoryCandidate,
  RunAdvisoryMemoryRecord,
  RunAdvisoryMemoryTopic,
  RunAdvisoryMemoryType,
  RunAdvisoryMemoryVerificationStatus,
  RUN_ADVISORY_MEMORY_SCOPES,
  RUN_ADVISORY_MEMORY_TOPICS,
  RUN_ADVISORY_MEMORY_TYPES,
  RUN_ADVISORY_MEMORY_VERSION,
} from "./types";

export const AI_MEETING_MEMORY_CACHE_TIMEOUT_MS = 8_000;

/** 実装指示§10「MVP目安：最大20件程度」。 */
export const MAX_ACTIVE_RUN_MEMORY = 20;

class AiMeetingMemoryTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`[aiManagementMeeting/runAdvisoryMemory] Redis操作(${operation})が${timeoutMs}msでタイムアウトしました。`);
    this.name = "AiMeetingMemoryTimeoutError";
  }
}

function withTimeout<T>(operation: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AiMeetingMemoryTimeoutError(operation, timeoutMs)), timeoutMs);
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

function memoryKey(labId: string, companyId: string): string {
  return `companylab:v2:${labId}:${companyId}:aiMeetingMemory`;
}

interface RunAdvisoryMemoryStore {
  readonly version: string;
  readonly records: readonly RunAdvisoryMemoryRecord[];
}

/**
 * 【実装指示§38】Redis read/write失敗時もAI Meetingそのものを停止しない。
 * 呼び出し側がtry/catchで包み、失敗時はnullを渡してmemoryなしで会話継続する
 * （このモジュール自体は例外を投げてよい。フォールバックの判断はhandlers.ts側で行う）。
 */
export async function loadRunMemories(client: CompanyLabRedisClient, labId: string, companyId: string): Promise<readonly RunAdvisoryMemoryRecord[]> {
  const key = memoryKey(labId, companyId);
  const raw = await withTimeout("get", client.get(key), AI_MEETING_MEMORY_CACHE_TIMEOUT_MS);
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as RunAdvisoryMemoryStore;
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

export async function saveRunMemories(client: CompanyLabRedisClient, labId: string, companyId: string, records: readonly RunAdvisoryMemoryRecord[]): Promise<void> {
  const key = memoryKey(labId, companyId);
  const store: RunAdvisoryMemoryStore = { version: RUN_ADVISORY_MEMORY_VERSION, records };
  await withTimeout("set", client.set(key, JSON.stringify(store)), AI_MEETING_MEMORY_CACHE_TIMEOUT_MS);
}

/** 実装指示§18「期限切れ後はactive=false」。副作用なし（呼び出し側が保存する）。 */
export function expireRunMemories(records: readonly RunAdvisoryMemoryRecord[], currentTurn: number, now: string): readonly RunAdvisoryMemoryRecord[] {
  return records.map((r) => {
    if (r.isActive && r.expiresAfterTurn !== undefined && currentTurn > r.expiresAfterTurn) {
      return { ...r, isActive: false, updatedTurn: currentTurn, updatedAt: now };
    }
    return r;
  });
}

/**
 * 実装指示§14「server-side validationを通す」。型・enum自体はzod（proposalSchema.ts）が
 * 既に保証しているため、ここでは意味論的なvalidation（statement長・重複・所有権・
 * 上限）を行う。
 */
export interface CandidateValidationContext {
  readonly runId: string;
  readonly companyId: string;
  readonly currentTurn: number;
  readonly sourceMessageId: string;
  readonly existingRecords: readonly RunAdvisoryMemoryRecord[];
}

export interface CandidateValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

const MIN_STATEMENT_CHARS = 3;
const MAX_STATEMENT_CHARS = 200;

/** statement長・topic/type/scope妥当性（zodで既に保証されているが二重防御）・所有権を確認する。 */
export function validateCandidateShape(candidate: RunAdvisoryMemoryCandidate): CandidateValidationResult {
  if (candidate.statement.trim().length < MIN_STATEMENT_CHARS) return { ok: false, reason: "statement_too_short" };
  if (candidate.statement.length > MAX_STATEMENT_CHARS) return { ok: false, reason: "statement_too_long" };
  if (!(RUN_ADVISORY_MEMORY_TYPES as readonly string[]).includes(candidate.type)) return { ok: false, reason: "invalid_type" };
  if (!(RUN_ADVISORY_MEMORY_TOPICS as readonly string[]).includes(candidate.topic)) return { ok: false, reason: "invalid_topic" };
  if (!(RUN_ADVISORY_MEMORY_SCOPES as readonly string[]).includes(candidate.requestedScope)) return { ok: false, reason: "invalid_scope" };
  return { ok: true };
}

function activeCount(records: readonly RunAdvisoryMemoryRecord[]): number {
  return records.filter((r) => r.isActive).length;
}

/** 実装指示§10「同一topicのmemoryが重複する場合はmerge/replaceを検討」。CUSTOM topicは文言の完全一致（大小・空白正規化）で重複判定する。 */
function findDuplicate(records: readonly RunAdvisoryMemoryRecord[], candidate: RunAdvisoryMemoryCandidate, runId: string, companyId: string): RunAdvisoryMemoryRecord | null {
  const active = records.filter((r) => r.isActive && r.runId === runId && r.companyId === companyId);
  if (candidate.topic === "CUSTOM") {
    const normalized = candidate.statement.trim().toLowerCase();
    return active.find((r) => r.topic === "CUSTOM" && r.type === candidate.type && r.statement.trim().toLowerCase() === normalized) ?? null;
  }
  return active.find((r) => r.topic === candidate.topic && r.type === candidate.type) ?? null;
}

/**
 * 実装指示§30の推奨対応: BACKLOG_SEMANTICSのCONFIRMED_CORRECTIONは、M2.5で既に
 * server-side deterministic status（overdue/dueThisTurn/futureDue）とprompt側の
 * 強い語彙ガードによってsystem ruleとして正式に扱われているため、重複してRUN
 * memory化しない（dedupeして保存しない）。
 */
function isRedundantWithSystemRule(candidate: RunAdvisoryMemoryCandidate): boolean {
  return candidate.topic === "BACKLOG_SEMANTICS" && candidate.type === "CONFIRMED_CORRECTION";
}

export interface ApplyCandidateResult {
  readonly records: readonly RunAdvisoryMemoryRecord[];
  /** SAVEが実際に反映された場合の対象record id（skip/FORGETの場合はnull）。 */
  readonly savedId: string | null;
  /** FORGETで無効化されたrecordのid一覧。 */
  readonly forgottenIds: readonly string[];
  readonly skippedReason?: string;
}

/**
 * 1件のcandidateをexisting recordsへ適用する（副作用なし。呼び出し側がsaveする）。
 * type/topic/scopeの正しさはzodが保証済みの前提。verificationStatus/finalTypeは
 * confirmMemoryCandidateで確定済みのものを受け取る（このモジュールでは再判定しない）。
 */
export function applyCandidate(
  candidate: RunAdvisoryMemoryCandidate,
  finalType: RunAdvisoryMemoryType,
  verificationStatus: RunAdvisoryMemoryVerificationStatus,
  context: CandidateValidationContext,
  now: string
): ApplyCandidateResult {
  const shape = validateCandidateShape(candidate);
  if (!shape.ok) return { records: context.existingRecords, savedId: null, forgottenIds: [], skippedReason: shape.reason };

  if (candidate.action === "FORGET") {
    // 実装指示§25「完全削除よりinactive推奨」。topic（＋type一致があれば絞り込み）でactive recordを無効化する。
    const forgottenIds: string[] = [];
    const records = context.existingRecords.map((r) => {
      if (r.isActive && r.runId === context.runId && r.companyId === context.companyId && r.topic === candidate.topic && r.type === finalType) {
        forgottenIds.push(r.id);
        return { ...r, isActive: false, updatedTurn: context.currentTurn, updatedAt: now };
      }
      return r;
    });
    return { records, savedId: null, forgottenIds };
  }

  if (isRedundantWithSystemRule(candidate)) {
    return { records: context.existingRecords, savedId: null, forgottenIds: [], skippedReason: "redundant_with_system_rule" };
  }

  const duplicate = findDuplicate(context.existingRecords, candidate, context.runId, context.companyId);
  if (duplicate) {
    // 実装指示§10・§22「新しい明示発言を優先し、同一topic memoryを更新する」。
    const updated: RunAdvisoryMemoryRecord = {
      ...duplicate,
      statement: candidate.statement,
      normalizedValue: candidate.normalizedValue,
      verificationStatus,
      sourceMessageId: context.sourceMessageId,
      expiresAfterTurn: candidate.expiresAfterTurn,
      updatedTurn: context.currentTurn,
      updatedAt: now,
    };
    const records = context.existingRecords.map((r) => (r.id === duplicate.id ? updated : r));
    return { records, savedId: duplicate.id, forgottenIds: [] };
  }

  if (activeCount(context.existingRecords) >= MAX_ACTIVE_RUN_MEMORY) {
    // 実装指示§10「token肥大化防止のため上限」。上限到達時は新規保存を見送る（既存を勝手に削除しない）。
    return { records: context.existingRecords, savedId: null, forgottenIds: [], skippedReason: "max_active_count_reached" };
  }

  const id = randomUUID();
  const record: RunAdvisoryMemoryRecord = {
    id,
    runId: context.runId,
    companyId: context.companyId,
    createdTurn: context.currentTurn,
    updatedTurn: context.currentTurn,
    scope: candidate.requestedScope,
    type: finalType,
    topic: candidate.topic,
    statement: candidate.statement,
    normalizedValue: candidate.normalizedValue,
    verificationStatus,
    sourceMessageId: context.sourceMessageId,
    isActive: true,
    expiresAfterTurn: candidate.expiresAfterTurn,
    createdAt: now,
    updatedAt: now,
  };
  return { records: [...context.existingRecords, record], savedId: id, forgottenIds: [] };
}

/**
 * 実装指示§4・§15「機械的に検証できる場合のみ照合。Claudeだけでconfirmedにしない」。
 * MVPでは、BACKLOG_SEMANTICSのCONFIRMED_CORRECTION候補のみ、既存M2.5のdue status
 * （server-side deterministic）と直接照合できる。それ以外のtopicは機械照合の手段が
 * 無いため、CONFIRMED_CORRECTION候補であってもNOT_VERIFIABLEとしてUNVERIFIED_CLAIMへ
 * 降格する。PLAYER_PREFERENCE/STRATEGIC_INTENT/TEMPORARY_CONSTRAINT/OPEN_QUESTIONは
 * 事実照合の対象外（NOT_VERIFIABLEのまま保持）。
 */
export interface MemoryConfirmationFacts {
  readonly backlogStatus?: BacklogDueStatus;
}

export interface MemoryConfirmationResult {
  readonly verificationStatus: RunAdvisoryMemoryVerificationStatus;
  readonly finalType: RunAdvisoryMemoryType;
}

export function confirmMemoryCandidate(candidate: RunAdvisoryMemoryCandidate, facts: MemoryConfirmationFacts): MemoryConfirmationResult {
  if (candidate.type !== "CONFIRMED_CORRECTION") {
    return { verificationStatus: "NOT_VERIFIABLE", finalType: candidate.type };
  }
  if (candidate.topic === "BACKLOG_SEMANTICS" && facts.backlogStatus !== undefined) {
    if (facts.backlogStatus !== "OVERDUE") {
      return { verificationStatus: "SUPPORTED", finalType: "CONFIRMED_CORRECTION" };
    }
    return { verificationStatus: "CONTRADICTED", finalType: "UNVERIFIED_CLAIM" };
  }
  // 機械照合の手段が無いtopic: Claudeだけでconfirmedにしない（実装指示§15最終行）。
  return { verificationStatus: "NOT_VERIFIABLE", finalType: "UNVERIFIED_CLAIM" };
}

// ---------------------------------------------------------------------
// role relevance filtering（実装指示§20）
// ---------------------------------------------------------------------

const ROLE_RELEVANT_TOPICS: Readonly<Record<ExecutiveRole, readonly RunAdvisoryMemoryTopic[]>> = {
  CFO: ["CASH_FLOOR", "DEBT_TOLERANCE", "CAPEX_POSTURE", "MARGIN_PRIORITY"],
  COO: ["CAPEX_POSTURE", "INVENTORY_POLICY", "PRODUCT_PRIORITY", "QUALITY_PRIORITY"],
  COMMERCIAL: ["MARKET_PRIORITY", "PRODUCT_PRIORITY", "GROWTH_PRIORITY", "MARGIN_PRIORITY"],
  CEO: [...RUN_ADVISORY_MEMORY_TOPICS],
};

function relevantRolesForTopic(topic: RunAdvisoryMemoryTopic): readonly ExecutiveRole[] {
  return (Object.keys(ROLE_RELEVANT_TOPICS) as ExecutiveRole[]).filter((role) => role === "CEO" || ROLE_RELEVANT_TOPICS[role].includes(topic));
}

export interface RunAdvisoryMemorySummaryItem {
  readonly id: string;
  readonly statement: string;
  readonly relevantRoles: readonly ExecutiveRole[];
  readonly expiresAfterTurn?: number;
  readonly normalizedValue?: number;
}

/** 実装指示§19。ExecutiveBriefingPacketとは別にpromptへcompactに追加するsummary。役員ごとの厳密なフィルタは行わず、各itemにrelevantRolesを付与し、Claude側が発言者ごとに参照可否を判断する（実装指示§20の精神を、単一structured callアーキテクチャに合わせて実装したもの）。 */
export interface RunAdvisoryMemorySummary {
  readonly confirmedCorrections: readonly RunAdvisoryMemorySummaryItem[];
  readonly playerPreferences: readonly RunAdvisoryMemorySummaryItem[];
  readonly strategicIntents: readonly RunAdvisoryMemorySummaryItem[];
  readonly temporaryConstraints: readonly RunAdvisoryMemorySummaryItem[];
  readonly unverifiedClaims: readonly RunAdvisoryMemorySummaryItem[];
  readonly openQuestions: readonly RunAdvisoryMemorySummaryItem[];
}

const SUMMARY_ITEMS_PER_CATEGORY = 5;

function toSummaryItem(r: RunAdvisoryMemoryRecord): RunAdvisoryMemorySummaryItem {
  return { id: r.id, statement: r.statement, relevantRoles: relevantRolesForTopic(r.topic), expiresAfterTurn: r.expiresAfterTurn, normalizedValue: r.normalizedValue };
}

function topByRecency(records: readonly RunAdvisoryMemoryRecord[], type: RunAdvisoryMemoryType): readonly RunAdvisoryMemorySummaryItem[] {
  return records
    .filter((r) => r.isActive && r.type === type)
    .sort((a, b) => b.updatedTurn - a.updatedTurn)
    .slice(0, SUMMARY_ITEMS_PER_CATEGORY)
    .map(toSummaryItem);
}

/**
 * 実装指示§39「active memory summaryはcompact。各statementは短文化。」既に
 * statement自体が短文（保存時に制限済み）なので、ここではカテゴリごとにtop N件
 * （更新turnが新しい順）へ絞るだけ（追加のAPI呼び出し・要約生成はしない）。
 */
export function buildRunAdvisoryMemorySummary(records: readonly RunAdvisoryMemoryRecord[]): RunAdvisoryMemorySummary {
  return {
    confirmedCorrections: topByRecency(records, "CONFIRMED_CORRECTION"),
    playerPreferences: topByRecency(records, "PLAYER_PREFERENCE"),
    strategicIntents: topByRecency(records, "STRATEGIC_INTENT"),
    temporaryConstraints: topByRecency(records, "TEMPORARY_CONSTRAINT"),
    unverifiedClaims: topByRecency(records, "UNVERIFIED_CLAIM"),
    openQuestions: topByRecency(records, "OPEN_QUESTION"),
  };
}
