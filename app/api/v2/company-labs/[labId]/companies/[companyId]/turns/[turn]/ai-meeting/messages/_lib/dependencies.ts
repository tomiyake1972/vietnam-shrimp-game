// ShrimpX V2 — AI Management Meeting API 依存関係の生成（MVP）
//
// 既存の createCompanyLabApiDependencies をそのまま再利用し、会話永続化に必要な
// 生のCompanyLabRedisClientだけを追加で持たせる（ai-explanation/_lib/dependencies.tsと
// 同じ方針）。新しいRedis接続経路は導入しない。

import { readAppEnvV2FromEnv } from "../../../../../../../../../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../../../../../../../../../lib/v2/redis/companyLabClient";
import { CompanyLabRedisClient } from "../../../../../../../../../../../lib/v2/redis/companyLabTypes";
import { CompanyLabApiDependencies, createCompanyLabApiDependencies } from "../../../../../../../../_lib/dependencies";

export interface AiMeetingApiDependencies extends CompanyLabApiDependencies {
  readonly redisClient: CompanyLabRedisClient;
}

export async function createAiMeetingApiDependencies(): Promise<AiMeetingApiDependencies> {
  const base = await createCompanyLabApiDependencies();
  const appEnv = readAppEnvV2FromEnv();
  const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
  return { ...base, redisClient };
}
