// ShrimpX V2 — 会社ラボ専用永続化 Redis Repository（Phase 8C-1、Phase 8C-2で契約統一・拡張）
//
// repository.tsのCompanyLabStateRepository契約を、実際のRedis（CompanyLabRedisClient
// 経由）に対して実装する。キー生成はcompanyLabRedisKeys.ts、書き込み直前の
// キー許可検証はcompanyLabRedisKeyGuard.tsへ委譲し、四半期確定の原子コミットは
// atomicCommit.tsのexecuteAtomicQuarterCommit（Redis EVAL）を1回呼ぶだけで完結させる
// （TypeScript側での「load→比較→複数回SET」は一切行わない）。
//
// 【Phase 8C-2での変更】
//   - ラボ作成をatomicCreateLab.tsのLua（存在確認・current作成・labs一覧追加を
//     単一原子処理）へ変更。重複labIdはCompanyLabAlreadyExistsError。
//   - 存在しないラボへのsaveDraft/loadDraft/loadHistoryEntry/loadHistoryIndex/
//     loadFullHistory等をCompanyLabNotFoundErrorへ統一（インメモリ実装と同一契約）。
//   - listLabs・loadLatestHistoryEntry・loadHistoryPage・acquireProcessingLock・
//     releaseProcessingLockを追加。

import { AppEnvV2 } from "../../core/version";
import { CompanyLabRedisClient } from "../../redis/companyLabTypes";
import {
  companyLabCurrentStateKeyV2,
  companyLabDraftKeyV2,
  companyLabHistoryEntryKeyV2,
  companyLabHistoryIndexKeyV2,
  companyLabListKeyV2,
  companyLabLockKeyV2,
} from "../../redis/companyLabRedisKeys";
import { assertAllowedCompanyLabKeys, assertAllowedCompanyLabListKey } from "../../redis/companyLabRedisKeyGuard";
import { CompanyLabPersistedStateV1, CompanyLabQuarterHistoryEntry, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "./types";
import { decodeCompanyLabPersistedStateFromStored, encodeCompanyLabPersistedState } from "./codec";
import { validateCompanyLabDraftEnvelope, validateCompanyLabQuarterHistoryEntry } from "./schema";
import { executeAtomicQuarterCommit, AtomicQuarterCommitResult } from "./atomicCommit";
import { executeAtomicCreateLab } from "./atomicCreateLab";
import { acquireProcessingLockOnRedis, releaseProcessingLockOnRedis } from "./processingLock";
import {
  CompanyLabAlreadyExistsError,
  CompanyLabHistoryEntryNotFoundError,
  CompanyLabNotFoundError,
  CompanyLabRepositoryError,
  CompanyLabSerializationError,
} from "./errors";
import {
  AcquireProcessingLockInput,
  CompanyLabHistoryPage,
  CompanyLabHistoryPageInput,
  CompanyLabStateRepository,
  CompanyLabQuarterCommitInput,
  CreateCompanyLabInput,
  assertCommitInputInvariants,
  sliceHistoryPageTurns,
} from "./repository";
import { CompanyLabDraftEnvelope } from "./types";

export interface CompanyLabStateRepositoryDependencies {
  readonly client: CompanyLabRedisClient;
  readonly appEnv: AppEnvV2;
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Redis上の会社ラボ永続化状態を読み書きするRepositoryを作る。
 * client・appEnvは明示的に注入する（純粋な依存注入。テストでは実際のRedis接続も
 * 不要にするため。既存のcreateGameStateRepositoryと同じ設計方針）。
 * 実運用ではcompanyLabClient.tsのcreateDefaultCompanyLabRedisClient()と
 * app/lib/v2/core/version.tsのreadAppEnvV2FromEnv()を渡す想定（本Phaseではこの
 * 配線コード自体は追加しない。8C-2のApplication/API層の責務）。
 */
export function createCompanyLabStateRepository(deps: CompanyLabStateRepositoryDependencies): CompanyLabStateRepository {
  const { client, appEnv } = deps;

  function keysFor(labId: string) {
    return {
      current: companyLabCurrentStateKeyV2(appEnv, labId),
      draft: companyLabDraftKeyV2(appEnv, labId),
      historyIndex: companyLabHistoryIndexKeyV2(appEnv, labId),
      lock: companyLabLockKeyV2(appEnv, labId),
      historyEntry: (turn: number) => companyLabHistoryEntryKeyV2(appEnv, labId, turn),
    };
  }

  /** ラボの存在確認。存在しなければCompanyLabNotFoundError（契約統一。§7）。 */
  async function assertLabExists(labId: string): Promise<void> {
    const key = keysFor(labId).current;
    let count: number;
    try {
      count = await client.exists(key);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisへの存在確認に失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (count <= 0) throw new CompanyLabNotFoundError(labId);
  }

  async function createLab(input: CreateCompanyLabInput): Promise<CompanyLabPersistedStateV1> {
    const stored: CompanyLabPersistedStateV1 = {
      schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
      engineVersion: input.engineVersion,
      labId: input.labId,
      config: input.config,
      fixtures: input.fixtures,
      currentState: { runtime: input.runtime, revision: 0 },
      draft: null,
      metadata: { createdAt: input.now, updatedAt: input.now },
    };
    const currentKey = keysFor(input.labId).current;
    const labsListKey = companyLabListKeyV2(appEnv);
    assertAllowedCompanyLabKeys([currentKey], appEnv, input.labId);
    assertAllowedCompanyLabListKey(labsListKey, appEnv);
    let serialized: string;
    try {
      serialized = encodeCompanyLabPersistedState(stored);
    } catch (e) {
      throw new CompanyLabSerializationError(`会社ラボ状態のencodeに失敗しました（labId=${input.labId}）: ${toErrorMessage(e)}`);
    }
    // 存在確認・current作成・labs一覧追加を単一のLua（原子処理）で行う。
    // 事前のEXISTSチェックとSETの間に別の作成が割り込む競合や、current作成と
    // 一覧追加が別々に失敗する不整合を構造的に排除する（§3.1・§8）。
    let result;
    try {
      result = await executeAtomicCreateLab(client, { currentKey, labsListKey, labId: input.labId, serializedState: serialized });
    } catch (e) {
      throw new CompanyLabRepositoryError(`ラボの原子的作成に失敗しました（labId=${input.labId}）: ${toErrorMessage(e)}`);
    }
    if (result.status === "alreadyExists") {
      throw new CompanyLabAlreadyExistsError(input.labId);
    }
    return stored;
  }

  async function listLabs(): Promise<readonly string[]> {
    const labsListKey = companyLabListKeyV2(appEnv);
    let raw: unknown[];
    try {
      raw = await client.zrange(labsListKey, 0, -1);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisからのラボ一覧読み込みに失敗しました（key=${labsListKey}）: ${toErrorMessage(e)}`);
    }
    return raw.map((v) => String(v));
  }

  async function loadCurrentState(labId: string): Promise<CompanyLabPersistedStateV1> {
    const key = keysFor(labId).current;
    let raw: unknown;
    try {
      raw = await client.get(key);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisからの読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) {
      throw new CompanyLabNotFoundError(labId);
    }
    try {
      return decodeCompanyLabPersistedStateFromStored(raw);
    } catch (e) {
      throw new CompanyLabSerializationError(`保存されていた会社ラボ状態のdecodeに失敗しました（labId=${labId}）: ${toErrorMessage(e)}`);
    }
  }

  async function labExists(labId: string): Promise<boolean> {
    const key = keysFor(labId).current;
    try {
      const count = await client.exists(key);
      return count > 0;
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisへの存在確認に失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
  }

  async function saveDraft(envelope: CompanyLabDraftEnvelope): Promise<void> {
    await assertLabExists(envelope.labId);
    const key = keysFor(envelope.labId).draft;
    assertAllowedCompanyLabKeys([key], appEnv, envelope.labId);
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (e) {
      throw new CompanyLabSerializationError(`ドラフトのencodeに失敗しました（labId=${envelope.labId}）: ${toErrorMessage(e)}`);
    }
    try {
      await client.set(key, serialized);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisへの書き込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
  }

  async function loadDraft(labId: string): Promise<CompanyLabDraftEnvelope | null> {
    await assertLabExists(labId);
    const key = keysFor(labId).draft;
    let raw: unknown;
    try {
      raw = await client.get(key);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisからの読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    try {
      return validateCompanyLabDraftEnvelope(parsed, "$");
    } catch (e) {
      throw new CompanyLabSerializationError(`保存されていたドラフトのdecodeに失敗しました（labId=${labId}）: ${toErrorMessage(e)}`);
    }
  }

  async function loadHistoryEntry(labId: string, turn: number): Promise<CompanyLabQuarterHistoryEntry> {
    await assertLabExists(labId);
    const key = keysFor(labId).historyEntry(turn);
    let raw: unknown;
    try {
      raw = await client.get(key);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisからの読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    if (raw === null || raw === undefined) {
      throw new CompanyLabHistoryEntryNotFoundError(labId, turn);
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    try {
      return validateCompanyLabQuarterHistoryEntry(parsed, "$");
    } catch (e) {
      throw new CompanyLabSerializationError(`保存されていた四半期履歴のdecodeに失敗しました（labId=${labId}, turn=${turn}）: ${toErrorMessage(e)}`);
    }
  }

  async function loadHistoryIndex(labId: string): Promise<readonly number[]> {
    await assertLabExists(labId);
    const key = keysFor(labId).historyIndex;
    let raw: unknown[];
    try {
      raw = await client.zrange(key, 0, -1);
    } catch (e) {
      throw new CompanyLabRepositoryError(`Redisからの履歴index読み込みに失敗しました（key=${key}）: ${toErrorMessage(e)}`);
    }
    return raw.map((v) => Number(v)).sort((a, b) => a - b);
  }

  async function loadFullHistory(labId: string): Promise<readonly CompanyLabQuarterHistoryEntry[]> {
    const turns = await loadHistoryIndex(labId);
    const entries: CompanyLabQuarterHistoryEntry[] = [];
    for (const turn of turns) {
      entries.push(await loadHistoryEntry(labId, turn));
    }
    return entries;
  }

  async function loadLatestHistoryEntry(labId: string): Promise<CompanyLabQuarterHistoryEntry | null> {
    const turns = await loadHistoryIndex(labId);
    if (turns.length === 0) return null;
    return loadHistoryEntry(labId, turns[turns.length - 1]);
  }

  async function loadHistoryPage(labId: string, input: CompanyLabHistoryPageInput): Promise<CompanyLabHistoryPage> {
    const sortedTurns = await loadHistoryIndex(labId);
    const { turns, nextAfterTurn } = sliceHistoryPageTurns(sortedTurns, input);
    const entries: CompanyLabQuarterHistoryEntry[] = [];
    for (const turn of turns) {
      entries.push(await loadHistoryEntry(labId, turn));
    }
    return { entries, nextAfterTurn };
  }

  async function acquireProcessingLock(input: AcquireProcessingLockInput): Promise<boolean> {
    await assertLabExists(input.labId);
    const lockKey = keysFor(input.labId).lock;
    assertAllowedCompanyLabKeys([lockKey], appEnv, input.labId);
    if (!Number.isInteger(input.ttlMilliseconds) || input.ttlMilliseconds < 1) {
      throw new CompanyLabRepositoryError(`acquireProcessingLock: ttlMillisecondsは1以上の整数である必要があります。受け取った値: ${JSON.stringify(input.ttlMilliseconds)}`);
    }
    try {
      // TTLはRedis側のPXで管理する（input.nowはインメモリ実装の決定論的テスト用であり、ここでは使わない）。
      return await acquireProcessingLockOnRedis(client, lockKey, input.token, input.ttlMilliseconds);
    } catch (e) {
      throw new CompanyLabRepositoryError(`ロック取得に失敗しました（key=${lockKey}）: ${toErrorMessage(e)}`);
    }
  }

  async function releaseProcessingLock(labId: string, token: string): Promise<boolean> {
    const lockKey = keysFor(labId).lock;
    assertAllowedCompanyLabKeys([lockKey], appEnv, labId);
    try {
      // 自トークン一致時のみDELするLua（compare-and-delete）。他処理のロックは削除しない。
      return await releaseProcessingLockOnRedis(client, lockKey, token);
    } catch (e) {
      throw new CompanyLabRepositoryError(`ロック解放に失敗しました（key=${lockKey}）: ${toErrorMessage(e)}`);
    }
  }

  async function commitQuarterAtomically(input: CompanyLabQuarterCommitInput): Promise<AtomicQuarterCommitResult> {
    assertCommitInputInvariants(input);
    const k = keysFor(input.labId);
    const historyKey = k.historyEntry(input.turn);
    assertAllowedCompanyLabKeys([k.current, k.draft, k.historyIndex, k.lock, historyKey], appEnv, input.labId);

    let nextStoredStateJson: string;
    let historyEntryJson: string;
    try {
      nextStoredStateJson = encodeCompanyLabPersistedState(input.nextStoredState);
      historyEntryJson = JSON.stringify(input.historyEntry);
    } catch (e) {
      throw new CompanyLabSerializationError(`原子コミット対象のencodeに失敗しました（labId=${input.labId}）: ${toErrorMessage(e)}`);
    }

    try {
      return await executeAtomicQuarterCommit(client, {
        currentKey: k.current,
        historyEntryKey: historyKey,
        historyIndexKey: k.historyIndex,
        draftKey: k.draft,
        lockKey: k.lock,
        turnId: input.turnId,
        turn: input.turn,
        expectedRevision: input.expectedRevision,
        newRevision: input.expectedRevision + 1,
        nextStoredStateJson,
        historyEntryJson,
        expectedLockToken: input.expectedLockToken,
      });
    } catch (e) {
      throw new CompanyLabRepositoryError(`原子コミットの実行に失敗しました（labId=${input.labId}, turn=${input.turn}）: ${toErrorMessage(e)}`);
    }
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
