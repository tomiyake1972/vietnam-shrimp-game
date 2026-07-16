import { Redis } from "@upstash/redis";
import { appEnvironment, isProduction, STAGING_KEY_PREFIX } from "./env";

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
// 下の書き込み前検証（assertStagingScopedKeys）がその最後の防波堤になる。
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

// 非本番環境でRedisへ書き込む対象キーが、必ずstaging:プレフィックスを持つことを検証する。
// 本番Redisとテスト環境が同一データベースを共有するようになったため、これがプレフィックスに
// よる論理分離を守る最後の砦になる。1件でも条件を満たさないキーがあれば、実際にRedisへ
// 書き込み・削除を発行する前に例外で処理を中断する。
//
// 本番環境（isProduction）では、既存の本番キー形式（プレフィックスなし）をそのまま使う設計の
// ため、このチェックの対象外とする。
function assertStagingScopedKeys(keys: string[]): void {
  if (isProduction) return;
  for (const key of keys) {
    if (!key.startsWith(STAGING_KEY_PREFIX)) {
      throw new Error(
        `[redis] 非本番環境からの書き込み対象キー ${JSON.stringify(key)} が ` +
          `"${STAGING_KEY_PREFIX}" で始まっていません。本番Redisとテスト環境は同一データベースを` +
          " 共有しているため、安全のためこの操作を中断しました。app/lib/redisKeys.ts の" +
          " キー生成関数を経由しているか確認してください。"
      );
    }
  }
}

// アプリケーションのコードは、@upstash/redis のクライアントを直接使わず、必ずこの
// facadeを経由すること。実際に使っている命令（get/set/del/lpush/lrem/lrange/exists/scan）
// だけをここで公開し、書き込み系（set/del/lpush/lrem）は発行前に assertStagingScopedKeys
// を必ず通す。検証ロジックをAPIごとに個別実装しないための一本化。
export const redis = {
  // 読み取り専用の命令はそのまま素通しする（bindはオーバーロード付きの型定義を
  // スプレッド引数のアロー関数より正しく保持できるため、こちらを使う）。
  get: rawRedis.get.bind(rawRedis),
  exists: rawRedis.exists.bind(rawRedis),
  lrange: rawRedis.lrange.bind(rawRedis),
  scan: rawRedis.scan.bind(rawRedis),

  set: (...args: Parameters<typeof rawRedis.set>) => {
    assertStagingScopedKeys([args[0]]);
    return rawRedis.set(...args);
  },
  del: (...args: Parameters<typeof rawRedis.del>) => {
    assertStagingScopedKeys(args);
    return rawRedis.del(...args);
  },
  lpush: (...args: Parameters<typeof rawRedis.lpush>) => {
    assertStagingScopedKeys([args[0]]);
    return rawRedis.lpush(...args);
  },
  lrem: (...args: Parameters<typeof rawRedis.lrem>) => {
    assertStagingScopedKeys([args[0]]);
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
