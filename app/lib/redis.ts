import { Redis } from "@upstash/redis";
import { appEnvironment, isProduction } from "./env";
import { assertAllowedKeys as assertAllowedKeysPure } from "./redisKeyGuard";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[redis] 環境変数 "${name}" が設定されていません（appEnvironment="${appEnvironment}"）。` +
        " 本番用とテスト用は環境変数名を分けて設定する必要があり、" +
        " 他方の環境変数への暗黙のフォールバックは行いません。Vercelのプロジェクト設定を確認してください。"
    );
  }
  return value;
}

// 本番（isProduction）は既存の本番用環境変数（KV_REST_API_URL / KV_REST_API_TOKEN）をそのまま使う。
// それ以外（staging / development）は STAGING_KV_REST_API_URL / STAGING_KV_REST_API_TOKEN を使う。
//
// 設計変更: 本番用とテスト用は、現在は同一のUpstash Redisデータベースを指す前提になった
// （Vercel Marketplaceの仕様変更により、無料プランで別データベースを追加できなくなったため）。
// 環境変数名を分けたまま維持しているのは、「設定し忘れたら明確なエラーで停止する」という
// 安全性を保つためであり、値そのもの（接続先）が同じであっても構わない。
// このため、キーのプレフィックス（staging:）による論理分離が唯一の分離手段となり、
// 下の書き込み前検証（assertAllowedKeys）がその最後の防波堤になる。
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

const rawRedis = createRedisClient();

// 実際の検証ロジックは app/lib/redisKeyGuard.ts の純粋関数に委譲する
// （isProduction を注入する薄いラッパー。ロジック本体は単体テスト対象）。
function assertAllowedKeys(keys: string[]): void {
  assertAllowedKeysPure(keys, isProduction);
}

// アプリケーションのコードは、@upstash/redis のクライアントを直接使わず、必ずこの
// facadeを経由すること。実際に使っている命令（get/set/del/lpush/lrem/lrange/exists/scan）
// だけをここで公開し、書き込み系（set/del/lpush/lrem）は発行前に assertAllowedKeys
// を必ず通す。検証ロジックをAPIごとに個別実装しないための一本化。
export const redis = {
  // 読み取り専用の命令はそのまま素通しする（bindはオーバーロード付きの型定義を
  // スプレッド引数のアロー関数より正しく保持できるため、こちらを使う）。
  get: rawRedis.get.bind(rawRedis),
  exists: rawRedis.exists.bind(rawRedis),
  lrange: rawRedis.lrange.bind(rawRedis),
  scan: rawRedis.scan.bind(rawRedis),

  set: (...args: Parameters<typeof rawRedis.set>) => {
    assertAllowedKeys([args[0]]);
    return rawRedis.set(...args);
  },
  del: (...args: Parameters<typeof rawRedis.del>) => {
    assertAllowedKeys(args);
    return rawRedis.del(...args);
  },
  lpush: (...args: Parameters<typeof rawRedis.lpush>) => {
    assertAllowedKeys([args[0]]);
    return rawRedis.lpush(...args);
  },
  lrem: (...args: Parameters<typeof rawRedis.lrem>) => {
    assertAllowedKeys([args[0]]);
    return rawRedis.lrem(...args);
  },
};

// @upstash/redis auto-deserializes JSON values, so redis.get() already returns
// a parsed object rather than a string. Handle both shapes defensively.
export function parseStored<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
