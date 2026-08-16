// ShrimpX V2 — Company Lab プレイヤー画面 AI Management Meeting機能の依存関係解決
//
// 【原則】aiExplanationUiDependencies.tsと完全に同じ方針。uiDependencies.ts
// （resolveCompanyLabUiDependencies）が確立した「通常は実Redis
// （createCompanyLabApiDependencies経由）、E2E検証時のみin-memoryへフォールバック」
// をそのまま踏襲する。repository/serviceはresolveCompanyLabUiDependencies()をそのまま
// 再利用し（重複実装しない）、AI Management Meeting機能に固有のRedisクライアント
// （会話artifactの永続化用）だけをここへ追加する。
//
// 新しいRedis接続経路は増やさない: 実環境では既存のcreateDefaultCompanyLabRedisClient
// をそのまま使う。E2E in-memoryモードのときだけ、uiDependencies.tsのin-memory
// Repositoryフォールバックと同じ考え方で、プロセス内シングルトンのin-memory
// CompanyLabRedisClientへ切り替える。

import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "../../../../lib/v2/redis/companyLabTypes";
import { createDefaultCompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabClient";
import { readAppEnvV2FromEnv } from "../../../../lib/v2/core/version";
import { isCompanyLabUiRunningInMemoryForE2e, resolveCompanyLabUiDependencies } from "./uiDependencies";
import { AiMeetingApiDependencies } from "../../../../api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/dependencies";

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
      throw new Error("[aiMeetingUiDependencies] E2E in-memoryフォールバックはevalをサポートしません（AI Management Meeting機能では未使用）。");
    },
    zrange: async () => [],
  };
}

// プロセス内で使い回す、E2E in-memory時のみのシングルトン（uiDependencies.tsの
// inMemoryDependenciesSingletonと同じ設計方針）。
let inMemoryRedisSingleton: CompanyLabRedisClient | null = null;

export async function resolveAiMeetingUiDependencies(): Promise<AiMeetingApiDependencies> {
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
