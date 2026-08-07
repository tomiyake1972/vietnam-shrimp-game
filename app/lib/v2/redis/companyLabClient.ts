// ShrimpX V2 — 会社ラボ専用Redis実クライアント接続（Phase 8C-1）
//
// app/lib/redis.ts（V1/V2共有facade）はモジュール読み込み時点で環境変数を
// 必須チェックする設計であり、かつeval操作を公開していない。会社ラボの原子コミット
// にはeval（Luaスクリプト実行）が必須のため、既存facadeを経由せず、
// @upstash/redisのRedisクライアントへ直接（動的importで）接続する専用モジュールを
// 新設する（既存のredis/client.tsが実クライアントへの依存を関数内の動的importに
// とどめている設計と同じ理由・同じパターン）。
//
// 【既存コードとの独立性】本ファイルはapp/lib/redis.tsを一切importしない
// （V1コード・既存V2本番ゲーム永続化コードのいずれも変更しない、という本Phaseの
// 方針を徹底するため）。環境変数名（KV_REST_API_URL等）自体は既存の命名を踏襲するが、
// 読み取りロジックは本ファイル内で完結する。

import { AppEnvV2 } from "../core/version";
import { CompanyLabRedisClient, CompanyLabRedisSetOptions } from "./companyLabTypes";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[companyLabClient] 環境変数 "${name}" が設定されていません。本番用とステージング用は環境変数名を分けて` +
        "設定する必要があり、他方の環境変数への暗黙のフォールバックは行いません。Vercelのプロジェクト設定を確認してください。"
    );
  }
  return value;
}

/**
 * 実際のUpstash Redisへ接続する、会社ラボ専用のCompanyLabRedisClientを作る。
 * 呼び出されるまで@upstash/redis自体をロードしない（動的import）ため、
 * 本ファイルをimportしただけでは環境変数エラーもRedis接続も発生しない
 * （テスト・ビルドから安全にimportできる。既存redis/client.tsと同じ設計）。
 *
 * 本Phaseではこの関数自体を呼び出す配線コード（API/Application層）は追加しない
 * （§10「実際の四半期処理フローへの接続」は対象外）。
 */
export async function createDefaultCompanyLabRedisClient(appEnv: AppEnvV2): Promise<CompanyLabRedisClient> {
  const { Redis } = await import("@upstash/redis");
  const url = appEnv === "production" ? requireEnv("KV_REST_API_URL") : requireEnv("STAGING_KV_REST_API_URL");
  const token = appEnv === "production" ? requireEnv("KV_REST_API_TOKEN") : requireEnv("STAGING_KV_REST_API_TOKEN");
  const client = new Redis({ url, token });
  return {
    get: (key: string) => client.get(key),
    set: (key: string, value: string, options?: CompanyLabRedisSetOptions) => {
      // @upstash/redisのset()はオプションオブジェクトの形（{nx, px}）が実際の
      // SETコマンド引数（NX/PX）へ変換される。オプション未指定時は従来どおり無条件SET。
      if (options === undefined) return client.set(key, value);
      const upstashOptions: { nx?: true; px?: number } = {};
      if (options.nx) upstashOptions.nx = true;
      if (options.pxMilliseconds !== undefined) upstashOptions.px = options.pxMilliseconds;
      return client.set(key, value, upstashOptions as never);
    },
    exists: (key: string) => client.exists(key),
    del: (key: string) => client.del(key),
    eval: <TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs) =>
      client.eval(script, keys, args) as Promise<TData>,
    zrange: (key: string, start: number, end: number) => client.zrange(key, start, end) as Promise<unknown[]>,
  };
}
