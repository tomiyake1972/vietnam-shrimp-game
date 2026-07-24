// ShrimpX V2 — 会社ラボ専用永続化 Repository（Phase 8C-1、Phase 8C-2で契約統一・拡張）
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
//
// 【Repository共通契約（Phase 8C-2指示§7で統一。インメモリ実装・Redis実装の両方が
//   同一の意味論を持ち、同じ契約テスト（repositoryContract.ts）で検証される）】
//   - 存在しないlabIdへの操作（loadCurrentState・saveDraft・loadDraft・
//     loadHistoryEntry・loadHistoryIndex・loadFullHistory・loadLatestHistoryEntry・
//     loadHistoryPage）: CompanyLabNotFoundErrorを投げる。
//   - 既に存在するlabIdでのcreateLab: CompanyLabAlreadyExistsErrorを投げ、
//     既存のcurrent・history・labs一覧を一切変更しない。
//   - 存在するラボにdraftがない: loadDraftはnullを返す。
//   - 存在するラボにhistoryがない: loadHistoryIndex・loadFullHistoryは空配列、
//     loadLatestHistoryEntryはnullを返す。
//   - labs一覧: createLab成功時にlabIdが作成順で一覧へ追加され、listLabs()で
//     列挙できる。作成失敗（重複）時は追加されない。

import { CompanyFixture, CompanyLabConfig } from "../types";
import {
  CompanyLabDraftEnvelope,
  CompanyLabPersistedStateV1,
  CompanyLabQuarterHistoryEntry,
  CompanyLabRuntimeSnapshot,
  CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
} from "./types";
import { AtomicQuarterCommitResult, decideAtomicQuarterCommit } from "./atomicCommit";
import { CompanyLabAlreadyExistsError, CompanyLabHistoryEntryNotFoundError, CompanyLabNotFoundError, CompanyLabRepositoryError } from "./errors";

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

/** 履歴ページング入力（Phase 8C-2指示§9）。 */
export interface CompanyLabHistoryPageInput {
  /** このturnより後（>afterTurn）のエントリから返す。省略時は先頭から。 */
  readonly afterTurn?: number;
  /** 1ページの最大件数（1以上）。 */
  readonly limit: number;
}

/** 履歴ページング結果。 */
export interface CompanyLabHistoryPage {
  readonly entries: readonly CompanyLabQuarterHistoryEntry[];
  /** 続きがある場合、次ページのafterTurnに渡す値。続きがなければnull。 */
  readonly nextAfterTurn: number | null;
}

/** 四半期処理ロック取得の入力（Phase 8C-2指示§6.4）。 */
export interface AcquireProcessingLockInput {
  readonly labId: string;
  /** 処理ごとに一意なトークン。原子コミットのexpectedLockTokenと同じ値を渡す。 */
  readonly token: string;
  /** ロックのTTL（ミリ秒）。処理時間に対して十分な余裕を持つ値にすること。 */
  readonly ttlMilliseconds: number;
  /**
   * 取得時点のISO8601日時。Redis実装はTTLをRedis側のPXで管理するためこの値を
   * 使わないが、インメモリ実装は決定論的なテストのため、この論理時刻を基準に
   * 期限切れロックの上書き可否を判定する。
   */
  readonly now: string;
}

export interface CompanyLabStateRepository {
  /**
   * ラボ現在状態の作成（revision=0、draftなし、履歴なしの初期状態）＋labs一覧への追加。
   * 既に同じlabIdが存在する場合はCompanyLabAlreadyExistsErrorを投げ、何も変更しない
   * （Redis実装はLuaにより存在確認・current作成・一覧追加を単一の原子処理で行う）。
   */
  createLab(input: CreateCompanyLabInput): Promise<CompanyLabPersistedStateV1>;
  /** ラボ現在状態の読込（draftは常にnullで返る。draftはloadDraftで個別取得）。 */
  loadCurrentState(labId: string): Promise<CompanyLabPersistedStateV1>;
  /** 存在確認。 */
  labExists(labId: string): Promise<boolean>;
  /** 作成済みラボの一覧（作成順のlabId配列）。 */
  listLabs(): Promise<readonly string[]>;
  /** ドラフトの保存。ラボ不存在ならCompanyLabNotFoundError。 */
  saveDraft(envelope: CompanyLabDraftEnvelope): Promise<void>;
  /** ドラフトの読込（ラボ不存在ならCompanyLabNotFoundError、ラボはあるがドラフトなしならnull）。 */
  loadDraft(labId: string): Promise<CompanyLabDraftEnvelope | null>;
  /** 単一履歴の読込。ラボ不存在ならCompanyLabNotFoundError、履歴不存在ならCompanyLabHistoryEntryNotFoundError。 */
  loadHistoryEntry(labId: string, turn: number): Promise<CompanyLabQuarterHistoryEntry>;
  /** 履歴indexの読込（昇順のturn番号一覧。履歴なしなら空配列）。 */
  loadHistoryIndex(labId: string): Promise<readonly number[]>;
  /**
   * 全履歴の順序付き読込（indexを読んでから各turnを取得する）。
   * 【注意】診断・テスト用。四半期が進むと合計数十MBに達するため、通常の
   * Application Service・将来のAPI層からは使わず、loadHistoryPage/
   * loadHistoryEntry/loadLatestHistoryEntryを使うこと（Phase 8C-2指示§9）。
   */
  loadFullHistory(labId: string): Promise<readonly CompanyLabQuarterHistoryEntry[]>;
  /** 直近（最大turn）の確定履歴エントリの読込。履歴がなければnull（再開時の直近履歴注入に使う）。 */
  loadLatestHistoryEntry(labId: string): Promise<CompanyLabQuarterHistoryEntry | null>;
  /** 履歴のページング読込（afterTurnより後のエントリを昇順で最大limit件）。 */
  loadHistoryPage(labId: string, input: CompanyLabHistoryPageInput): Promise<CompanyLabHistoryPage>;
  /** 四半期処理ロックの取得（SET NX PX相当）。取得できればtrue。 */
  acquireProcessingLock(input: AcquireProcessingLockInput): Promise<boolean>;
  /** 四半期処理ロックの解放。自分のtokenと一致するロックだけを解放する（解放できた場合true）。 */
  releaseProcessingLock(labId: string, token: string): Promise<boolean>;
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
// 2b. ページング計算（両実装で共有する純粋関数。ページ境界の意味論を一致させる）
// ---------------------------------------------------------------------

/** 昇順のturn一覧から、ページに含めるturnと次ページカーソルを計算する。 */
export function sliceHistoryPageTurns(sortedTurns: readonly number[], input: CompanyLabHistoryPageInput): { readonly turns: readonly number[]; readonly nextAfterTurn: number | null } {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new CompanyLabRepositoryError(`loadHistoryPage: limitは1以上の整数である必要があります。受け取った値: ${JSON.stringify(input.limit)}`);
  }
  const after = input.afterTurn ?? Number.NEGATIVE_INFINITY;
  const candidates = sortedTurns.filter((t) => t > after);
  const turns = candidates.slice(0, input.limit);
  const hasMore = candidates.length > turns.length;
  return { turns, nextAfterTurn: hasMore && turns.length > 0 ? turns[turns.length - 1] : null };
}

// ---------------------------------------------------------------------
// 3. インメモリ実装（テスト・開発用フェイク。Redis実装と同一のRepository契約
//    テストを流すことで、両実装の挙動が一致することを検証する）
// ---------------------------------------------------------------------

interface InMemoryProcessingLock {
  token: string;
  /** 論理的な期限（acquire時のnow + TTL）。エポックミリ秒。 */
  expiresAtEpochMs: number;
}

interface InMemoryLabRecord {
  /** draftを除いたCompanyLabPersistedStateV1（"current"キー相当）。 */
  stored: Omit<CompanyLabPersistedStateV1, "draft">;
  draft: CompanyLabDraftEnvelope | null;
  /** turn番号 → 履歴エントリ。 */
  history: Map<number, CompanyLabQuarterHistoryEntry>;
  /**
   * 四半期処理ロック。Redis実装ではTTL到達でキー自体が消滅するが、インメモリ実装は
   * 掃除スレッドを持たないため、acquire時に論理時刻（input.now）と比較して期限切れ
   * ロックを上書き可能とみなす。【意図的な軽微差異】期限切れ後・誰も再取得していない
   * 状態でのコミットは、Redis実装ではロックキー不存在によりlockConflictになるが、
   * インメモリ実装では古いトークンが残っているため成功しうる。この差異はTTL掃除の
   * 実装有無に起因するもので、「期限切れ後に別処理がロックを取得したら古い処理は
   * コミットできない」という安全性の中核（両実装で成立）には影響しない。
   */
  lock: InMemoryProcessingLock | null;
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
    if (labs.has(input.labId)) {
      throw new CompanyLabAlreadyExistsError(input.labId);
    }
    const stored: Omit<CompanyLabPersistedStateV1, "draft"> = {
      schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
      engineVersion: input.engineVersion,
      labId: input.labId,
      config: input.config,
      fixtures: input.fixtures,
      currentState: { runtime: input.runtime, revision: 0 },
      metadata: { createdAt: input.now, updatedAt: input.now },
    };
    // Mapは挿入順を保持するため、labs一覧（listLabs）は自然に作成順になる
    // （Redis実装のZSET score=作成時ZCARDと同じ意味論）。
    labs.set(input.labId, { stored, draft: null, history: new Map(), lock: null });
    return { ...stored, draft: null };
  }

  async function listLabs(): Promise<readonly string[]> {
    return [...labs.keys()];
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

  async function loadLatestHistoryEntry(labId: string): Promise<CompanyLabQuarterHistoryEntry | null> {
    const record = getRecordOrThrow(labId);
    const turns = [...record.history.keys()];
    if (turns.length === 0) return null;
    const maxTurn = Math.max(...turns);
    return record.history.get(maxTurn) as CompanyLabQuarterHistoryEntry;
  }

  async function loadHistoryPage(labId: string, input: CompanyLabHistoryPageInput): Promise<CompanyLabHistoryPage> {
    const record = getRecordOrThrow(labId);
    const sortedTurns = [...record.history.keys()].sort((a, b) => a - b);
    const { turns, nextAfterTurn } = sliceHistoryPageTurns(sortedTurns, input);
    return { entries: turns.map((t) => record.history.get(t) as CompanyLabQuarterHistoryEntry), nextAfterTurn };
  }

  async function acquireProcessingLock(input: AcquireProcessingLockInput): Promise<boolean> {
    const record = getRecordOrThrow(input.labId);
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new CompanyLabRepositoryError(`acquireProcessingLock: nowがISO8601日時として解釈できません。受け取った値: ${JSON.stringify(input.now)}`);
    }
    if (!Number.isInteger(input.ttlMilliseconds) || input.ttlMilliseconds < 1) {
      throw new CompanyLabRepositoryError(`acquireProcessingLock: ttlMillisecondsは1以上の整数である必要があります。受け取った値: ${JSON.stringify(input.ttlMilliseconds)}`);
    }
    if (record.lock !== null && record.lock.expiresAtEpochMs > nowMs) {
      // 有効なロックが存在する（自分自身のトークンでも再取得はしない。SET NXと同じ意味論）。
      return false;
    }
    record.lock = { token: input.token, expiresAtEpochMs: nowMs + input.ttlMilliseconds };
    return true;
  }

  async function releaseProcessingLock(labId: string, token: string): Promise<boolean> {
    const record = labs.get(labId);
    if (!record || record.lock === null) return false;
    if (record.lock.token !== token) return false; // 他の処理のロックは削除しない
    record.lock = null;
    return true;
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
        lockToken: record && record.lock ? record.lock.token : null,
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
    listLabs,
    saveDraft,
    loadDraft,
    loadHistoryEntry,
    loadHistoryIndex,
    loadFullHistory,
    loadLatestHistoryEntry,
    loadHistoryPage,
    acquireProcessingLock,
    releaseProcessingLock,
    commitQuarterAtomically,
  };
}
