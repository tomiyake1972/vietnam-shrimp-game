import { Redis } from "@upstash/redis";
import { appEnvironment, isProduction } from "./env";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[redis] 環境変数 "${name}" が設定されていません（appEnvironment="${appEnvironment}"）。` +
        " 本番用Redisとテスト用Redisは別のUpstashデータベース・別の環境変数で接続する設計のため、" +
        " 他方の環境変数への暗黙のフォールバックは行いません。Vercelのプロジェクト設定を確認してください。"
    );
  }
  return value;
}

// 本番（isProduction）は既存の本番用環境変数（KV_REST_API_URL / KV_REST_API_TOKEN）をそのまま使う。
// それ以外（staging / development）は、必ず別のUpstash Redisデータベースを指す
// STAGING_KV_REST_API_URL / STAGING_KV_REST_API_TOKEN を使う。
// どちらの場合も、対応する環境変数が欠けていれば明確なエラーで停止し、他方の接続情報へは
// フォールバックしない（本番データとテストデータの取り違えを防ぐため）。
function createRedisClient(): Redis {
  if (isProduction) {
    return new Redis({
      url: requireEnv("KV_REST_API_URL"),
      token: requireEnv("KV_REST_API_TOKEN"),
    });
  }
  return new Redis({
    url: requireEnv("STAGING_KV_REST_API_URL"),
    token: requireEnv("STAGING_KV_REST_API_TOKEN"),
  });
}

export const redis = createRedisClient();

// @upstash/redis auto-deserializes JSON values, so redis.get() already returns
// a parsed object rather than a string. Handle both shapes defensively.
export function parseStored<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
