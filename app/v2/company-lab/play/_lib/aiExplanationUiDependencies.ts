// ShrimpX V2 — Company Lab プレイヤー画面 Standard AI経営説明レポート機能の依存関係解決
//
// 【原則】uiDependencies.ts（resolveCompanyLabUiDependencies）が確立した
// 「通常は実Redis（createCompanyLabApiDependencies経由）、E2E検証時のみ
// in-memoryへフォールバック」という方針をそのまま踏襲する。repository/serviceは
// resolveCompanyLabUiDependencies()をそのまま呼び出して再利用し（重複実装しない）、
// AI経営説明レポート機能に固有のRedisクライアント（キャッシュ保存用）だけをここへ追加する。
//
// 新しいRedis接続経路は増やさない: 実環境では既存のcreateDefaultCompanyLabRedisClient
// （app/lib/v2/redis/companyLabClient.ts）をそのまま使う。E2E in-memoryモードのときだけ、
// uiDependencies.tsのin-memory Repositoryフォールバックと同じ考え方で、プロセス内シングルトンの
// in-memory CompanyLabRedisClientへ切り替える。

import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../../lib/v2/redis/companyLabTypes";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { readAppEnvV2FromEnv } from "../../../../lib/v2/core/version";
import { isCompanyLabUiRunningInMemoryForE2e, resolveCompanyLabUiDependencies } from "./uiDependencies";
import { AiExplanationApiDependencies } from "../../../../api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation/_lib/dependencies";

function createInMemoryRedisClient(): CompanyLabRedisClient {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key) : null),
    set: async (key: string, value: string, options?: CompanyLabRedisSetOptions) => {
      if (options?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    del: async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    eval: async () => {
      throw new Error("[aiExplanationUiDependencies] E2E in-memoryフォールバックはevalをサポートしません（AI経営説明機能では未使用）。");
    },
    zrange: async () => [],
  };
}

// プロセス内で使い回す、E2E in-memory時のみのシングルトン（uiDependencies.tsの
// inMemoryDependenciesSingletonと同じ設計方針）。
let inMemoryRedisSingleton: CompanyLabRedisClient | null = null;

export async function resolveAiExplanationUiDependencies(): Promise<AiExplanationApiDependencies> {
  const base = await resolveCompanyLabUiDependencies();

  if (isCompanyLabUiRunningInMemoryForE2e()) {
    if (!inMemoryRedisSingleton) {
      inMemoryRedisSingleton = createInMemoryRedisClient();
    }
    return { ...base, redisClient: inMemoryRedisSingleton };
  }

  const appEnv = readAppEnvV2FromEnv();
  const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
  return { ...base, redisClient };
}
