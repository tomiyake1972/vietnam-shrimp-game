// ShrimpX V2 — Simulation Run 永続化のテスト用フェイクRedisクライアント（O1）
//
// テストファイルそのものではない（他のテストからimportして使う）。
//
// 【何を検証できて、何を検証できないか】
// eval() は redisRepository.ts が定義する SAVE_MANIFEST_SCRIPT を「そのスクリプト文字列と
// 一致すること」で判別し、Luaと論理的に同じ手順を、このプロセス内のMapに対して
// awaitを挟まない同期区間として実行する（会社ラボ側 fakeCompanyLabRedisClient.ts と同じ方式）。
// したがってこのフェイクで検証できるのは
//   - repository（TypeScript側）がどのキーへ何を渡すか
//   - CONFLICT / MISSING_PART / OK の扱い
//   - stagingパートが正規キーへ昇格すること
// であって、**Luaスクリプト本文そのものが本物のRedisで正しく動くこと**ではない。
// Lua本文の構造は simulationRunPersistenceCas.test.ts の静的契約テストで別途固定し、
// 実Redisでの実行確認は共有Redisを触らない方針（指示§5/§16）のため未実施として報告する。

import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../redis/companyLabTypes";
import { SIMULATION_RUN_SAVE_MANIFEST_SCRIPT } from "../persistence/redisRepository";

export function createFakeSimulationRunRedisClient(): CompanyLabRedisClient & {
  readonly dump: () => Map<string, string>;
  /** キーに設定されたTTL（ミリ秒）。TTL無しのキーは入らない。孤児staging keyの寿命検証用。 */
  readonly ttls: () => Map<string, number>;
  /** 契約テスト用: RENAME単体の挙動（実Redis同様、TTLをdestinationへ引き継ぐ）。 */
  readonly renameForContractTest: (from: string, to: string) => Promise<void>;
  /** 契約テスト用: PERSIST単体の挙動（消したら1、元からTTL無しなら0）。 */
  readonly persistForContractTest: (key: string) => number;
} {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();

  /** 実Redisと同じRENAME: 値を移し、残りTTLもdestinationへ引き継ぐ。 */
  function renameKey(from: string, to: string): void {
    store.set(to, store.get(from)!);
    store.delete(from);
    const inherited = ttls.get(from);
    ttls.delete(from);
    if (inherited === undefined) ttls.delete(to);
    else ttls.set(to, inherited);
  }

  /** 実Redisと同じPERSIST: TTLを消したら1、元からTTLが無ければ0。 */
  function persistKey(key: string): number {
    if (!ttls.has(key)) return 0;
    ttls.delete(key);
    return 1;
  }

  return {
    dump: () => store,
    ttls: () => ttls,
    renameForContractTest: async (from: string, to: string) => renameKey(from, to),
    persistForContractTest: (key: string) => persistKey(key),
    async get(key: string): Promise<unknown> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string, options?: CompanyLabRedisSetOptions): Promise<unknown> {
      if (options?.nx && store.has(key)) return null;
      store.set(key, value);
      if (options?.pxMilliseconds !== undefined) ttls.set(key, options.pxMilliseconds);
      else ttls.delete(key);
      return "OK";
    },
    async exists(key: string): Promise<number> {
      return store.has(key) ? 1 : 0;
    },
    async del(key: string): Promise<unknown> {
      return store.delete(key) ? 1 : 0;
    },
    async zrange(key: string, start: number, end: number): Promise<unknown[]> {
      const zset = zsets.get(key);
      if (!zset) return [];
      const members = [...zset.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      const normalizedEnd = end < 0 ? members.length + end + 1 : end + 1;
      return members.slice(start, normalizedEnd);
    },
    async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
      if (script !== SIMULATION_RUN_SAVE_MANIFEST_SCRIPT) {
        throw new Error("フェイククライアントへ渡されたLuaが、Simulation Run永続化の既知スクリプト定数と一致しません。");
      }
      const [manifestKey, summaryKey, indexKey, stagingDataset, stagingResume, stagingPack, canonicalDataset, canonicalResume, canonicalPack] = keys;
      const [manifestJson, summaryJson, scoreStr, runId, limitStr, expectedBaseStr, hasResumeStr, hasPackStr] = args as unknown as string[];

      // --- ここから同期区間（原子性の再現） ---
      // 書き込み前の引数検査（Lua側と同じ順序・同じ意味）。
      if (!Number.isFinite(Number(scoreStr)) || !Number.isFinite(Number(limitStr)) || !Number.isFinite(Number(expectedBaseStr))) {
        return ["INVALID_ARGS"] as unknown as TData;
      }
      let published = 0;
      const currentRaw = store.get(manifestKey);
      if (currentRaw !== undefined) {
        try {
          const parsed = JSON.parse(currentRaw) as { persistenceRevision?: unknown };
          if (typeof parsed?.persistenceRevision === "number") published = parsed.persistenceRevision;
        } catch {
          published = 0;
        }
      }
      if (published !== Number(expectedBaseStr)) {
        return ["CONFLICT", String(published)] as unknown as TData;
      }

      const hasResume = hasResumeStr === "1";
      const hasPack = hasPackStr === "1";
      if (!store.has(stagingDataset)) return ["MISSING_PART", "dataset"] as unknown as TData;
      if (hasResume && !store.has(stagingResume)) return ["MISSING_PART", "resume"] as unknown as TData;
      if (hasPack && !store.has(stagingPack)) return ["MISSING_PART", "pack"] as unknown as TData;

      /**
       * 【本物のRedisと同じ挙動にする】RENAMEは source の残りTTLを destination へ
       * そのまま引き継ぐ（隔離ローカルRedisで PTTL=3599983 を実測して確認済み）。
       * 以前このフェイクは rename 時に destination のTTLを勝手に消しており、
       * 「RENAMEしただけで永続になる」という実Redisに無い挙動を再現していた。
       * そのせいで、正規キーが約1時間で期限切れになる実経路の不具合を検出できなかった。
       * TTLを消すのは PERSIST の役目であり、Lua側も RENAME の直後に PERSIST を呼ぶ。
       */
      renameKey(stagingDataset, canonicalDataset);
      persistKey(canonicalDataset);
      if (hasResume) {
        renameKey(stagingResume, canonicalResume);
        persistKey(canonicalResume);
      }
      if (hasPack) {
        renameKey(stagingPack, canonicalPack);
        persistKey(canonicalPack);
      }

      store.set(manifestKey, manifestJson);
      store.set(summaryKey, summaryJson);
      let zset = zsets.get(indexKey);
      if (!zset) {
        zset = new Map();
        zsets.set(indexKey, zset);
      }
      zset.set(runId, Number(scoreStr));

      const limit = Number(limitStr);
      const result: string[] = ["OK"];
      const excess = zset.size - limit;
      if (excess > 0) {
        const ordered = [...zset.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
        for (const member of ordered.slice(0, excess)) {
          zset.delete(member);
          result.push(member);
        }
      }
      return result as unknown as TData;
      // --- 同期区間ここまで ---
    },
  };
}
