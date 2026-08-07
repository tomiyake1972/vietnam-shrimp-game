// ShrimpX V2 — 会社ラボ専用Redisクライアント テスト用フェイク（Phase 8C-1、Phase 8C-2で拡張）
//
// CompanyLabRedisClient契約を、実際のRedisサーバーなしに満たすテスト用実装。
// テストファイル自体ではない（他のテストファイルからimportして使う）。
//
// eval()は、会社ラボ永続化モジュールが定義する3つのLuaスクリプト
// （四半期確定コミット・ラボ原子的作成・ロック解放）を、渡されたスクリプト文字列で
// 判別し、それぞれと論理的に完全に同一の判定・更新手順を、Luaではなくこのプロセス内の
// Mapに対して、一切awaitを挟まない同期的な関数本体として実行する
// （インメモリRepository実装（persistence/repository.ts）が採用しているのと同じ
// 「JS単一スレッドの特性を利用した原子性の再現」という考え方）。
// 実際のLuaスクリプトテキスト自体が本物のRedis（redis-server）に対して正しく動作
// することは、Phase 8C-1完了報告§Bに記載の手動検証（redis-cli --eval）で別途確認済み。
//
// 【Phase 8C-2での拡張】
//   - set()のNX/PXオプション対応（ロック取得用）。PXの期限はプロセスの実時計
//     （Date.now）で遅延評価する。TTL到達を待つテストは書かず、TTL切れの安全性は
//     「キーを直接削除して期限切れを模す」決定論的な方法で検証する（テスト側参照）。
//   - ラボ原子的作成スクリプト（COMPANY_LAB_CREATE_LAB_LUA_SCRIPT）のエミュレート。
//   - ロック解放スクリプト（COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT）のエミュレート。

import { COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT } from "../../companyLab/persistence/atomicCommit";
import { COMPANY_LAB_CREATE_LAB_LUA_SCRIPT } from "../../companyLab/persistence/atomicCreateLab";
import { COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT } from "../../companyLab/persistence/processingLock";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../companyLabTypes";

export function createFakeCompanyLabRedisClient(): CompanyLabRedisClient {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  /** キー → PX期限（エポックミリ秒）。期限なしキーはこのMapに入らない。 */
  const expirations = new Map<string, number>();

  /** PX期限を遅延評価し、期限切れキーを削除する（Redisの遅延削除の簡易再現）。 */
  function evictIfExpired(key: string): void {
    const expiresAt = expirations.get(key);
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      store.delete(key);
      expirations.delete(key);
    }
  }

  function has(key: string): boolean {
    evictIfExpired(key);
    return store.has(key);
  }

  return {
    async get(key: string): Promise<unknown> {
      return has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string, options?: CompanyLabRedisSetOptions): Promise<unknown> {
      if (options?.nx && has(key)) {
        return null; // SET NX: 既存キーがあれば書き込まない（@upstash/redisはnullを返す）
      }
      store.set(key, value);
      if (options?.pxMilliseconds !== undefined) {
        expirations.set(key, Date.now() + options.pxMilliseconds);
      } else {
        expirations.delete(key);
      }
      return "OK";
    },
    async exists(key: string): Promise<number> {
      return has(key) ? 1 : 0;
    },
    async del(key: string): Promise<unknown> {
      const existed = has(key) && store.delete(key);
      expirations.delete(key);
      return existed ? 1 : 0;
    },
    async zrange(key: string, start: number, end: number): Promise<unknown[]> {
      const zset = zsets.get(key);
      if (!zset) return [];
      const members = [...zset.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      if (start === 0 && end === -1) return members;
      const normalizedEnd = end < 0 ? members.length + end + 1 : end + 1;
      return members.slice(start, normalizedEnd);
    },
    async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
      // --- ラボ原子的作成スクリプト ---
      if (script === COMPANY_LAB_CREATE_LAB_LUA_SCRIPT) {
        const [currentKey, labsListKey] = keys;
        const [labId, serializedState] = args as unknown as string[];
        // ここから同期区間（原子性の再現）
        if (has(currentKey)) {
          return ["alreadyExists", ""] as unknown as TData;
        }
        store.set(currentKey, serializedState);
        let labsZset = zsets.get(labsListKey);
        if (!labsZset) {
          labsZset = new Map();
          zsets.set(labsListKey, labsZset);
        }
        if (!labsZset.has(labId)) {
          labsZset.set(labId, labsZset.size); // score = 挿入時のZCARD（作成順）。NX相当。
        }
        return ["created", ""] as unknown as TData;
      }

      // --- ロック解放スクリプト（自トークン一致時のみDEL） ---
      if (script === COMPANY_LAB_RELEASE_LOCK_LUA_SCRIPT) {
        const [lockKey] = keys;
        const [token] = args as unknown as string[];
        if (has(lockKey) && store.get(lockKey) === token) {
          store.delete(lockKey);
          expirations.delete(lockKey);
          return 1 as unknown as TData;
        }
        return 0 as unknown as TData;
      }

      if (script !== COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT) {
        throw new Error("フェイククライアントへ渡されたLuaスクリプトが、会社ラボ永続化モジュールの既知のスクリプト定数のいずれとも一致しません。");
      }
      const [currentKey, historyEntryKey, historyIndexKey, draftKey, lockKey] = keys;
      const [turnId, turnStr, expectedRevisionStr, nextStoredStateJson, historyEntryJson, expectedLockToken, newRevisionStr] = args as unknown as string[];
      // ロックキーのPX期限を先に遅延評価しておく（Redisでは期限切れキーはGET時に存在しない）。
      evictIfExpired(lockKey);

      // --- ここから判定〜更新までawaitを一切挟まない同期区間（原子性の要） ---
      const currentRaw = store.get(currentKey);
      if (currentRaw === undefined) {
        return ["currentNotFound", ""] as unknown as TData;
      }
      const current = JSON.parse(currentRaw) as { currentState: { revision: number } };

      const historyRaw = store.get(historyEntryKey);
      if (historyRaw !== undefined) {
        const existing = JSON.parse(historyRaw) as { turnId: string };
        if (existing.turnId === turnId) {
          return ["alreadyCommitted", String(current.currentState.revision)] as unknown as TData;
        }
        return ["historyConflict", existing.turnId] as unknown as TData;
      }

      if (String(current.currentState.revision) !== expectedRevisionStr) {
        return ["revisionConflict", String(current.currentState.revision)] as unknown as TData;
      }

      const draftRaw = store.get(draftKey);
      if (draftRaw === undefined) {
        return ["draftNotFound", ""] as unknown as TData;
      }
      const draft = JSON.parse(draftRaw) as { turnId: string; submittedAt: string | null };
      if (draft.turnId !== turnId) {
        return ["draftTurnMismatch", draft.turnId] as unknown as TData;
      }
      if (draft.submittedAt === null || draft.submittedAt === undefined) {
        return ["draftNotSubmitted", ""] as unknown as TData;
      }

      if (expectedLockToken !== "") {
        const lockRaw = store.get(lockKey);
        if (lockRaw === undefined || lockRaw !== expectedLockToken) {
          return ["lockConflict", ""] as unknown as TData;
        }
      }

      store.set(currentKey, nextStoredStateJson);
      store.set(historyEntryKey, historyEntryJson);
      let zset = zsets.get(historyIndexKey);
      if (!zset) {
        zset = new Map();
        zsets.set(historyIndexKey, zset);
      }
      zset.set(turnStr, Number(turnStr));
      store.delete(draftKey);

      return ["committed", newRevisionStr] as unknown as TData;
      // --- 同期区間ここまで ---
    },
  };
}
