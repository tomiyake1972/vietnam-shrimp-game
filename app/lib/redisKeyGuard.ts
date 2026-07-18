import { STAGING_KEY_PREFIX } from "./env";

// Redisへ書き込む対象キーが、環境ごとに許可されたキー形式に一致するかを検証する。
// 本番Redisとテスト環境が同一データベースを共有するため、これがキー空間の混濁を防ぐ
// 最後の砦になる。1件でも条件を満たさないキーがあれば、実際にRedisへ書き込み・削除を
// 発行する前に例外で処理を中断する。
//
// 許可されるキー形式:
//   本番（isProd=true）  : "games"  または  "game:*"
//   非本番（isProd=false）: "staging:games"  または  "staging:game:*"
//
// これにより、staging:foo や staging:v2:game:* のような誤ったプレフィックスパターンも弾く。
//
// isProduction を直接参照せず引数で受け取る（副作用のない純粋関数にする）ことで、
// Redisクライアントの初期化（環境変数必須）を経由せずに単体テストできるようにしている。
// app/lib/redis.ts はこの関数を isProduction を渡して呼び出す薄いラッパーに徹する。
export function assertAllowedKeys(keys: string[], isProd: boolean): void {
  if (isProd) {
    for (const key of keys) {
      if (key !== "games" && !key.startsWith("game:")) {
        throw new Error(
          `[redis] 本番環境への書き込み対象キー ${JSON.stringify(key)} が` +
            ` 許可されたキー形式（"games" または "game:*"）に一致しません。` +
            ` app/lib/redisKeys.ts のキー生成関数を経由しているか確認してください。`
        );
      }
    }
    return;
  }
  // 非本番（staging/development）: staging:games または staging:game:* のみ許可
  const allowedPrefix = `${STAGING_KEY_PREFIX}game:`;
  const allowedList = `${STAGING_KEY_PREFIX}games`;
  for (const key of keys) {
    if (key !== allowedList && !key.startsWith(allowedPrefix)) {
      throw new Error(
        `[redis] 非本番環境からの書き込み対象キー ${JSON.stringify(key)} が` +
          ` 許可されたキー形式（"${allowedList}" または "${allowedPrefix}*"）に一致しません。` +
          ` 本番Redisとテスト環境は同一データベースを共有しているため、安全のためこの操作を中断しました。` +
          ` app/lib/redisKeys.ts のキー生成関数を経由しているか確認してください。`
      );
    }
  }
}
