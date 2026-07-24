// ShrimpX V2 — 会社ラボ専用Redisクライアント テスト用フェイク（Phase 8C-1）
//
// CompanyLabRedisClient契約を、実際のRedisサーバーなしに満たすテスト用実装。
// テストファイル自体ではない（他のテストファイルからimportして使う）。
//
// eval()は、companyLab/persistence/atomicCommit.tsのCOMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT
// と論理的に完全に同一の判定・更新手順を、Luaではなくこのプロセス内のMapに対して、
// 一切awaitを挟まない同期的な関数本体として実行する（インメモリRepository実装
// （persistence/repository.ts）が採用しているのと同じ「JS単一スレッドの特性を
// 利用した原子性の再現」という考え方を、Redisバックエンド実装のテストにも適用する）。
// 実際のLuaスクリプトテキスト自体が本物のRedis（redis-server）に対して正しく動作
// することは、Phase 8C-1完了報告§Bに記載の手動検証（redis-cli --eval）で別途確認済み。
//
// 渡されたLuaスクリプト文字列が想定どおりCOMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPTと
// 一致することも確認し、Redis Repository実装が本当にその定数を使っていることの
// 簡易的な裏付けとする。

import { COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT } from "../../companyLab/persistence/atomicCommit";
import { CompanyLabRedisClient } from "../companyLabTypes";

export function createFakeCompanyLabRedisClient(): CompanyLabRedisClient {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();

  return {
    async get(key: string): Promise<unknown> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string): Promise<unknown> {
      store.set(key, value);
      return "OK";
    },
    async exists(key: string): Promise<number> {
      return store.has(key) ? 1 : 0;
    },
    async del(key: string): Promise<unknown> {
      const existed = store.delete(key);
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
      if (script !== COMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPT) {
        throw new Error("フェイククライアントへ渡されたLuaスクリプトがCOMPANY_LAB_QUARTER_COMMIT_LUA_SCRIPTと一致しません。");
      }
      const [currentKey, historyEntryKey, historyIndexKey, draftKey, lockKey] = keys;
      const [turnId, turnStr, expectedRevisionStr, nextStoredStateJson, historyEntryJson, expectedLockToken, newRevisionStr] = args as unknown as string[];

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
