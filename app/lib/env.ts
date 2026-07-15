// サーバー側の環境判定。公開環境変数（NEXT_PUBLIC_*）は一切参照しない。
// Redis接続先・キー分離・管理API許可判定は、必ずこのモジュールの isProduction / isStaging を使うこと。
// GameSession.environment（Step 3）もこの型をそのまま再利用し、値の食い違いを防ぐ。
export type AppEnvironment = "production" | "staging" | "development" | "preview";

function resolveAppEnvironment(): AppEnvironment {
  // 1. APP_ENV が明示的に設定されていれば最優先で信用する。
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production" || appEnv === "staging" || appEnv === "development" || appEnv === "preview") {
    return appEnv;
  }

  // 2. Vercelが自動設定する VERCEL_ENV（production/preview/development）を次に信用する。
  //    "preview" はラベルとして区別して保持するが、本番Redisへの接続可否（isProduction）や
  //    Redisキーのプレフィックス付与（isStaging）の判定上は staging と全く同じ扱いにする
  //    （下のisProduction/isStagingの定義を参照）。
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "preview";
  if (vercelEnv === "development") return "development";

  // 3. APP_ENV・VERCEL_ENVのどちらからも本番であるという明確な signal が得られない場合、
  //    NODE_ENV=production だけを根拠に「本番」とは判定しない（安全側に倒す）。
  //    `next build && next start` はローカルでも NODE_ENV=production になるため、
  //    これだけを本番判定に使うと、意図せず本番Redisへ接続する事故につながりうる。
  return "development";
}

export const appEnvironment: AppEnvironment = resolveAppEnvironment();

// 本番であると明確に確認できた場合のみ true。判定不能な場合は false（＝本番Redisを使わない）側に倒す。
export const isProduction: boolean = appEnvironment === "production";

// 本番でない（staging/development/preview のいずれか）場合に true。
// Redisキーの staging: プレフィックス付与や、テスト環境限定機能（テストゲーム作成・GM全社操作等）の
// 表示可否に使う。
export const isStaging: boolean = !isProduction;
