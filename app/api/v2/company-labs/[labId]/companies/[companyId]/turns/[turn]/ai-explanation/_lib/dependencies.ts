// ShrimpX V2 — Standard AI経営説明レポートAPI 依存関係の生成（MVP）
//
// 既存の createCompanyLabApiDependencies（app/api/v2/company-labs/_lib/dependencies.ts）
// が組み立てる repository/service をそのまま再利用し、本機能のキャッシュ永続化に
// 必要な生のCompanyLabRedisClientだけを追加で持たせる。新しいRedis接続経路
// （createDefaultCompanyLabRedisClient以外の接続方法）は導入しない。

import { readAppEnvV2FromEnv } from "../../../../../../../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../../../../../../../lib/v2/redis/companyLabClient";
import { CompanyLabRedisClient } from "../../../../../../../../../../lib/v2/redis/companyLabTypes";
import { CompanyLabApiDependencies, createCompanyLabApiDependencies } from "../../../../../../../_lib/dependencies";

export interface AiExplanationApiDependencies extends CompanyLabApiDependencies {
  readonly redisClient: CompanyLabRedisClient;
}

/**
 * 実Redis（Upstash）に接続した依存関係一式を組み立てる。route.tsのハンドラー本体の中で、
 * リクエストごとに呼び出すこと（既存のcreateCompanyLabApiDependenciesと同じ方針）。
 */
export async function createAiExplanationApiDependencies(): Promise<AiExplanationApiDependencies> {
  const base = await createCompanyLabApiDependencies();
  const appEnv = readAppEnvV2FromEnv();
  const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
  return { ...base, redisClient };
}
