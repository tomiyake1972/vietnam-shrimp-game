// ShrimpX V2 — 会社ラボ専用永続化 Repository（Phase 8C-1）
//
// CompanyLabPersistedStateV1 ⇄ 実際のストレージ（Redis、またはテスト用インメモリ）
// の読み書きを行う。app/lib/v2/redis/repository.tsと同じ設計方針
// （キー生成→キーガード→クライアント呼び出し、encode/decodeはcodec.tsへ完全に委譲）
// を踏襲するが、会社ラボの型・レイヤーには依存しないよう本モジュールとして独立させる。
//
// 【現在状態キーが保持する内容についての規約】
//   `current`キー（companyLabCurrentStateKeyV2）は、CompanyLabPersistedStateV1の
//   うち`draft`を除いた全フィールド（schemaVersion・engineVersion・labId・config・
//   fixtures・currentState・metadata）を保持する。呼び出し側から見える
//   CompanyLabPersistedStateV1オブジェクトとしては、`draft`は常にnull固定として
//   返す（実際のdraftはドラフト専用キーに別途保存されており、loadDraft()で
//   個別に取得する。§7「現在状態とdraftを別キーに分離する」設計のとおり）。

import { CompanyFixture, CompanyLabConfig } from "../types";
import {
  CompanyLabDraftEnvelope,
  CompanyLabPersistedStateV1,
  CompanyLabQuarterHistoryEntry,
  CompanyLabRuntimeSnapshot,
  CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
} from "./types";
import { AtomicQuarterCommitResult, decideAtomicQuarterCommit } from "./atomicCommit";
import { CompanyLabHistoryEntryNotFoundError, CompanyLabNotFoundError, CompanyLabRepositoryError } from "./errors";

// ---------------------------------------------------------------------
// 1. Repository契約
// ---------------------------------------------------------------------

export interface CreateCompanyLabInput {
  readonly labId: string;
  readonly engineVersion: string;
  readonly config: CompanyLabConfig;
  readonly fixtures: readonly CompanyFixture[];
  readonly runtime: CompanyLabRuntimeSnapshot;
  readonly now: string;
}

/**
 * 四半期確定の原子コミット入力。
 *
 * 【契約】呼び出し側（8C-2のApplication Service想定。本Phaseでは自動テストのみが
 * 呼び出す）が、次の不変条件をすべて満たした状態で渡す必要がある。Repositoryは
 * 原子コミットを試みる前に、これらをここ（プロセス内、Redisへは一切問い合わせず）
 * で検証し、満たさない場合はCompanyLabRepositoryError（呼び出し契約違反。Redis上の
 * 競合とは明確に区別する）を投げる。
 *   - nextStoredState.draft は必ず null
 *   - nextStoredState.currentState.revision は必ず expectedRevision + 1
 *   - nextStoredState.currentState.lastProcessedTurnId は必ず turnId と一致
 *   - historyEntry.turn は turn と一致、historyEntry.turnId は turnId と一致
 */
export interface CompanyLabQuarterCommitInput {
  readonly labId: string;
  readonly turn: number;
  readonly turnId: string;
  readonly expectedRevision: number;
  /** 8C-2で実際のロック取得フローと接続するための任意項目。本Phaseでは通常未指定。 */
  readonly expectedLockToken?: string;
  readonly nextStoredState: CompanyLabPersistedStateV1;
  readonly historyEntry: CompanyLabQuarterHistoryEntry;
}

export interface CompanyLabStateRepository {
  /** ラボ現在状態の作成（revision=0、draftなし、履歴なしの初期状態）。 */
  createLab(input: CreateCompanyLabInput): Promise<CompanyLabPersistedStateV1>;
  /** ラボ現在状態の読込（draftは常にnullで返る。draftはloadDraftで個別取得）。 */
  loadCurrentState(labId: string): Promise<CompanyLabPersistedStateV1>;
  /** 存在確認。 */
  labExists(labId: string): Promise<boolean>;
  /** ドラフトの保存。 */
  saveDraft(envelope: CompanyLabDraftEnvelope): Promise<void>;
  /** ドラフトの読込（存在しなければnull）。 */
  loadDraft(labId: string): Promise<CompanyLabDraftEnvelope | null>;
  /** 単一履歴の読込。 */
  loadHistoryEntry(labId: string, turn: number): Promise<CompanyLabQuarterHistoryEntry>;
  /** 履歴indexの読込（昇順のturn番号一覧）。 */
  loadHistoryIndex(labId: string): Promise<readonly number[]>;
  /** 全履歴の順序付き読込（indexを読んでから各turnを取得する）。 */
  loadFullHistory(labId: string): Promise<readonly CompanyLabQuarterHistoryEntry[]>;
  /** 四半期の原子コミット（§5参照）。 */
  commitQuarterAtomically(input: CompanyLabQuarterCommitInput): Promise<AtomicQuarterCommitResult>;
}

// ---------------------------------------------------------------------
// 2. 呼び出し契約の事前検証（Redis層とは独立。プログラミングエラーの早期検出）
// ---------------------------------------------------------------------

export function assertCommitInputInvariants(input: CompanyLabQuarterCommitInput): void {
  if (input.nextStoredState.draft !== null) {
    throw new CompanyLabRepositoryError("commitQuarterAtomically: nextStoredState.draft は必ずnullである必要があります（draftは専用キーで別管理します）。");
  }
  const expectedNextRevision = input.expectedRevision + 1;
  if (input.nextStoredState.currentState.revision !== expectedNextRevision) {
    throw new CompanyLabRepositoryError(
      `commitQuarterAtomically: nextStoredState.currentState.revision(${input.nextStoredState.currentState.revision})は` +
        `expectedRevision+1(${expectedNextRevision})と一致する必要があります。`
    );
  }
  if (input.nextStoredState.currentState.lastProcessedTurnId !== input.turnId) {
    throw new CompanyLabRepositoryError(
      `commitQuarterAtomically: nextStoredState.currentState.lastProcessedTurnId(${input.nextStoredState.currentState.lastProcessedTurnId})は` +
        `turnId(${input.turnId})と一致する必要があります。`
    );
  }
  if (input.historyEntry.turn !== input.turn) {
    throw new CompanyLabRepositoryError(`commitQuarterAtomically: historyEntry.turn(${input.historyEntry.turn})はturn(${input.turn})と一致する必要があります。`);
  }
  if (input.historyEntry.turnId !== input.turnId) {
    throw new CompanyLabRepositoryError(`commitQuarterAtomically: historyEntry.turnId(${input.historyEntry.turnId})はturnId(${input.turnId})と一致する必要があります。`);
  }
}

// ---------------------------------------------------------------------
// 3. インメモリ実装（テスト・開発用フェイク。Redis実装と同一のRepository契約
//    テストを流すことで、両実装の挙動が一致することを検証する）
// ---------------------------------------------------------------------

interface InMemoryLabRecord {
  /** draftを除いたCompanyLabPersistedStateV1（"current"キー相当）。 */
  stored: Omit<CompanyLabPersistedStateV1, "draft">;
  draft: CompanyLabDraftEnvelope | null;
  /** turn番号 → 履歴エントリ。 */
  history: Map<number, CompanyLabQuarterHistoryEntry>;
  lock: string | null;
}

/**
 * インメモリのCompanyLabStateRepository実装。commitQuarterAtomicallyは、
 * decideAtomicQuarterCommit()の判定からストレージ更新までの間に一切awaitを
 * 挟まない同期的な処理として実装してあり、JS単一スレッドの特性により、
 * 複数の同時呼び出し（Promise.allで束ねた場合を含む）でも判定〜更新の間に
 * 割り込みが起きない（＝Redis EVALの原子性を、テスト用の擬似的な形で再現する）。
 */
export function createInMemoryCompanyLabStateRepository(): CompanyLabStateRepository {
  const labs = new Map<string, InMemoryLabRecord>();

  function getRecordOrThrow(labId: string): InMemoryLabRecord {
    const record = labs.get(labId);
    if (!record) throw new CompanyLabNotFoundError(labId);
    return record;
  }

  async function createLab(input: CreateCompanyLabInput): Promise<CompanyLabPersistedStateV1> {
    const stored: Omit<CompanyLabPersistedStateV1, "draft"> = {
      schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
      engineVersion: input.engineVersion,
      labId: input.labId,
      config: input.config,
      fixtures: input.fixtures,
      currentState: { runtime: input.runtime, revision: 0 },
      metadata: { createdAt: input.now, updatedAt: input.now },
    };
    labs.set(input.labId, { stored, draft: null, history: new Map(), lock: null });
    return { ...stored, draft: null };
  }

  async function loadCurrentState(labId: string): Promise<CompanyLabPersistedStateV1> {
    const record = getRecordOrThrow(labId);
    return { ...record.stored, draft: null };
  }

  async function labExists(labId: string): Promise<boolean> {
    return labs.has(labId);
  }

  async function saveDraft(envelope: CompanyLabDraftEnvelope): Promise<void> {
    const record = getRecordOrThrow(envelope.labId);
    record.draft = envelope;
  }

  async function loadDraft(labId: string): Promise<CompanyLabDraftEnvelope | null> {
    const record = getRecordOrThrow(labId);
    return record.draft;
  }

  async function loadHistoryEntry(labId: string, turn: number): Promise<CompanyLabQuarterHistoryEntry> {
    const record = getRecordOrThrow(labId);
    const entry = record.history.get(turn);
    if (!entry) throw new CompanyLabHistoryEntryNotFoundError(labId, turn);
    return entry;
  }

  async function loadHistoryIndex(labId: string): Promise<readonly number[]> {
    const record = getRecordOrThrow(labId);
    return [...record.history.keys()].sort((a, b) => a - b);
  }

  async function loadFullHistory(labId: string): Promise<readonly CompanyLabQuarterHistoryEntry[]> {
    const record = getRecordOrThrow(labId);
    const turns = [...record.history.keys()].sort((a, b) => a - b);
    return turns.map((t) => record.history.get(t) as CompanyLabQuarterHistoryEntry);
  }

  async function commitQuarterAtomically(input: CompanyLabQuarterCommitInput): Promise<AtomicQuarterCommitResult> {
    assertCommitInputInvariants(input);
    const record = labs.get(input.labId);

    // 【原子性の要】ここから判定完了までawaitを一切挟まない同期処理にする。
    const existingHistory = record ? record.history.get(input.turn) : undefined;
    const result = decideAtomicQuarterCommit(
      {
        currentExists: record !== undefined,
        currentRevision: record ? record.stored.currentState.revision : null,
        existingHistoryTurnId: existingHistory ? existingHistory.turnId : null,
        draftExists: record ? record.draft !== null : false,
        draftTurnId: record && record.draft ? record.draft.turnId : null,
        draftSubmitted: record && record.draft ? record.draft.submittedAt !== null : false,
        lockToken: record ? record.lock : null,
      },
      {
        turnId: input.turnId,
        expectedRevision: input.expectedRevision,
        expectedLockToken: input.expectedLockToken,
        newRevision: input.expectedRevision + 1,
      }
    );

    if (result.status === "committed" && record) {
      // draftは専用フィールド（record.draft）で別管理するため、nextStoredState側のdraftは
      // 意図的に読み捨てる（inputの契約上すでにnullであることはassertCommitInputInvariantsで
      // 検証済み）。
      const { draft: discardedDraft, ...storedWithoutDraft } = input.nextStoredState;
      void discardedDraft;
      record.stored = storedWithoutDraft;
      record.history.set(input.turn, input.historyEntry);
      record.draft = null;
    }
    // 判定〜更新までの同期区間はここで終わる（この後は結果を返すだけ）。

    return result;
  }

  return {
    createLab,
    loadCurrentState,
    labExists,
    saveDraft,
    loadDraft,
    loadHistoryEntry,
    loadHistoryIndex,
    loadFullHistory,
    commitQuarterAtomically,
  };
}
