// ShrimpX V2 — バージョン/環境の明示的検証（Phase 0A）
//
// 設計方針:
//   - V1の app/lib/env.ts は一切importしない。V1コードとV2コードの分離を
//     徹底するため、環境変数の読み取り・検証はV2側で独立して行う。
//   - APP_VERSION / APP_ENV が未設定・不正値の場合は「fail closed」とし、
//     デフォルト値へフォールバックせず必ず例外を投げる。
//   - APP_ENV はV1が許容する "development"/"preview" を含まず、
//     V2では "production" | "staging" のみを正とする
//     （ユーザー指示「production または staging」に厳密対応。V1より厳格な
//     ポリシーであり、docs/v2/CORE_ARCHITECTURE_v0.1.md に逸脱点として明記する）。

export class VersionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionValidationError";
  }
}

/** V2が認識するアプリバージョン。schemaVersion/redisキー分離の基準になる。 */
export type AppVersion = "v1" | "v2";

/** V2が認識する実行環境。V1のdevelopment/previewは含まない（意図的に厳格）。 */
export type AppEnvV2 = "production" | "staging";

const VALID_APP_VERSIONS: readonly AppVersion[] = ["v1", "v2"];
const VALID_APP_ENVS: readonly AppEnvV2[] = ["production", "staging"];

/** 値がAppVersionとして妥当かどうかを判定する（型ガード）。 */
export function isValidAppVersion(v: unknown): v is AppVersion {
  return typeof v === "string" && (VALID_APP_VERSIONS as readonly string[]).includes(v);
}

/** 値がAppEnvV2として妥当かどうかを判定する（型ガード）。 */
export function isValidAppEnvV2(v: unknown): v is AppEnvV2 {
  return typeof v === "string" && (VALID_APP_ENVS as readonly string[]).includes(v);
}

/**
 * 任意の文字列（未設定ならundefined）をAppVersionとして検証する純粋関数。
 * env読み取りに依存しないため、テストでは process.env なしで直接呼び出せる。
 */
export function assertAppVersion(value: string | undefined): AppVersion {
  if (value === undefined || value === "") {
    throw new VersionValidationError(
      "APP_VERSION が未設定です。'v1' または 'v2' を明示的に設定してください。"
    );
  }
  if (!isValidAppVersion(value)) {
    throw new VersionValidationError(
      `APP_VERSION の値が不正です。'v1' または 'v2' のいずれかである必要があります。受け取った値: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * 任意の文字列（未設定ならundefined）をAppEnvV2として検証する純粋関数。
 * V1のAPP_ENVと変数名は共有するが、許容値はV2独自に "production"/"staging" のみ。
 */
export function assertAppEnvV2(value: string | undefined): AppEnvV2 {
  if (value === undefined || value === "") {
    throw new VersionValidationError(
      "APP_ENV が未設定です。'production' または 'staging' を明示的に設定してください。"
    );
  }
  if (!isValidAppEnvV2(value)) {
    throw new VersionValidationError(
      `APP_ENV の値が不正です（V2は 'production'/'staging' のみ許容）。受け取った値: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** 実行時の process.env から APP_VERSION を読み取り検証する（サーバ起動経路用）。 */
export function readAppVersionFromEnv(): AppVersion {
  return assertAppVersion(process.env.APP_VERSION);
}

/** 実行時の process.env から APP_ENV を読み取り検証する（サーバ起動経路用）。 */
export function readAppEnvV2FromEnv(): AppEnvV2 {
  return assertAppEnvV2(process.env.APP_ENV);
}

// ---------------------------------------------------------------------
// V2共通バージョン定数。schemaVersion/engineVersion/balanceVersionの
// 定義箇所をここへ集約する（要件: 「schemaVersion, engineVersion,
// balanceVersion の共通定義」）。
// ---------------------------------------------------------------------

/** V2 GameSessionのスキーマバージョン。V1は1、V2はこの定数で2固定。 */
export const SCHEMA_VERSION_V2 = 2 as const;

/**
 * V2ドメインエンジンのバージョン。ゲームロジック（計算式・状態機械）が
 * 変わるたびに上げる。Phase 0時点では初期値。
 */
export const ENGINE_VERSION_V2 = "2.0.0-phase0" as const;

/**
 * V2バランス調整（数値パラメータ）のバージョン。エンジンのコード自体は
 * 変えず、価格・コスト等の定数だけを調整した場合はこちらを上げる。
 * Phase 0では市場価格計算を実装しないため暫定値。
 */
export const BALANCE_VERSION_V2 = "0.1.0-phase0" as const;
