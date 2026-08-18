// ShrimpX V2 — Run Advisory Memory Management API 依存関係の生成（AMM-M2.6）
//
// 既存のcreateCompanyLabApiDependenciesをそのまま再利用し、Run Advisory Memoryの
// 読み書きに必要な生のCompanyLabRedisClientだけを追加で持たせる
// （turns/[turn]/ai-meeting/messages/_lib/dependencies.tsと同じ方針）。
// 新しいRedis接続経路は導入しない。

import { readAppEnvV2FromEnv } from "../../../../../../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../../../../../../lib/v2/redis/companyLabClient";
import { CompanyLabRedisClient } from "../../../../../../../../../lib/v2/redis/companyLabTypes";
import { CompanyLabApiDependencies, createCompanyLabApiDependencies } from "../../../../../../_lib/dependencies";

export interface RunAdvisoryMemoryApiDependencies extends CompanyLabApiDependencies {
  readonly redisClient: CompanyLabRedisClient;
}

export async function createRunAdvisoryMemoryApiDependencies(): Promise<RunAdvisoryMemoryApiDependencies> {
  const base = await createCompanyLabApiDependencies();
  const appEnv = readAppEnvV2FromEnv();
  const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
  return { ...base, redisClient };
}
