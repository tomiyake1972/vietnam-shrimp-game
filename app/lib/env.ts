// サーバー側の環境判定。公開環境変数（NEXT_PUBLIC_*）は一切参照しない。
// Redis接続先・キー分離・管理API許可判定は、必ずこのモジュールの isProduction / isStaging を使うこと。
// GameSession.environment（Step 3）もこの型をそのまま再利用し、値の食い違いを防ぐ。
export type AppEnvironment = "production" | "staging" | "development" | "preview";

const VALID_APP_ENVIRONMENTS: readonly AppEnvironment[] = ["production", "staging", "development", "preview"];

function isValidAppEnvironment(value: string | undefined): value is AppEnvironment {
  return VALID_APP_ENVIRONMENTS.includes(value as AppEnvironment);
}

function resolveAppEnvironment(): AppEnvironment {
  const appEnv = process.env.APP_ENV;
  if (isValidAppEnvironment(appEnv)) {
    return appEnv;
  }

  // 本番Redisとテスト環境が同一データベースを共有する設計（staging:プレフィックスによる
  // 論理分離）に変更したため、VERCEL_ENV=production への自動フォールバックはもう使わない。
  // このフォールバックを残すと、APP_ENVの設定漏れによってテスト用Vercelプロジェクトの
  // 本番相当デプロイ（VERCEL_ENV=production は該当プロジェクトのProduction Branchの
  // デプロイに自動で付与される）が「本番」と誤判定され、プレフィックスなしで本番データと
  // 同じキー空間に書き込んでしまう事故につながる。そのため、Vercel上ではAPP_ENVの
  // 明示設定を必須とし、未設定・不正値の場合は起動を継続させず例外で停止する。
  //
  // Vercel上で動作しているかどうかは、Vercelが自動的に設定する VERCEL 環境変数の有無で判定する
  // （VERCEL_ENVそのものは上記の理由により信用しないが、「Vercel上かどうか」の判定には使ってよい）。
  const runningOnVercel = Boolean(process.env.VERCEL);
  if (runningOnVercel) {
    throw new Error(
      `[env] Vercel上ではAPP_ENV環境変数を "production" または "staging" に明示的に設定する必要があります` +
        `（現在の値: ${appEnv === undefined ? "未設定" : JSON.stringify(appEnv)}）。` +
        " VERCEL_ENVへの自動フォールバックは行いません。Vercelのプロジェクト設定でAPP_ENVを設定してください。"
    );
  }

  // ローカル環境（Vercel外、例えばこのリポジトリを手元やテスト用コンテナで動かす場合）で
  // APP_ENVが未設定・不正値の場合のみ、安全側のdevelopmentとして扱う。
  return "development";
}

export const appEnvironment: AppEnvironment = resolveAppEnvironment();

// 本番であると明確に確認できた場合のみ true。判定不能な場合は false（＝本番Redisを使わない）側に倒す。
export const isProduction: boolean = appEnvironment === "production";

// 本番でない（staging/development/preview のいずれか）場合に true。
// Redisキーの staging: プレフィックス付与や、テスト環境限定機能（テストゲーム作成・GM全社操作等）の
// 表示可否に使う。
export const isStaging: boolean = !isProduction;

// 非本番環境で使うRedisキーのプレフィックス。本番Redisとテスト環境が同一データベースを
// 共有する設計（プレフィックスによる論理分離）における唯一の分離手段のため、
// app/lib/redisKeys.ts（キー生成）とapp/lib/redis.ts（書き込み前の検証）の両方が
// このモジュールの値を参照する（値の二重管理・食い違いを防ぐため、ここを唯一の定義元にする）。
export const STAGING_KEY_PREFIX = "staging:";
