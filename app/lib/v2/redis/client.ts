// ShrimpX V2 — 実際のRedisクライアントへの接続（Phase 5.7）
//
// app/lib/redis.ts（V1/V2で共有する既存Redisクライアントfacade。
// docs/v2/CORE_ARCHITECTURE_v0.1.md §3「既存のRedisクライアント自体は
// V1/V2で共有する前提」）を、V2RedisClientインターフェースへ変換する。
//
// app/lib/redis.ts はモジュール読み込み時点で環境変数
// （本番用 KV_REST_API_URL/TOKEN、非本番用 STAGING_KV_REST_API_URL/TOKEN）を
// 必須チェックする設計になっている。本ファイルのトップレベルで
// `import { redis } from "../../redis"` を書いてしまうと、このモジュールを
// importしただけで（実際にRedis操作を1つも呼ばなくても）環境変数エラーが
// 発生してしまい、テスト・ビルドのページデータ収集を壊す
// （既知の `/api/game/[gameCode]/admin/clone` の問題と同じ理由）。
//
// そのため、実クライアントへの依存は`createDefaultV2RedisClient`関数の中で
// 動的importにとどめ、実際に呼び出されるまでapp/lib/redis.tsを評価しない。
// これにより、本ファイル・repository.tsをテスト・ビルドから安全にimportできる
// （Redis環境変数が未設定でも、実際にRedisへ接続する関数を呼ばない限り失敗しない）。

import { V2RedisClient } from "./types";

/**
 * 実際のUpstash Redis（app/lib/redis.tsが提供する共有クライアント）へ接続する
 * V2RedisClientを作る。将来のV2 Application/APIレイヤーが、V2Repositoryを
 * 実際に構築する際にこの関数を呼ぶ想定（本Phaseではこの関数自体を呼び出す
 * コードは追加しない。呼び出せば実際にRedis接続が発生することの確認のみ）。
 */
export async function createDefaultV2RedisClient(): Promise<V2RedisClient> {
  const { redis } = await import("../../redis");
  return {
    get: (key: string) => redis.get(key),
    set: (key: string, value: string) => redis.set(key, value),
    exists: (key: string) => redis.exists(key),
    del: (key: string) => redis.del(key),
  };
}
