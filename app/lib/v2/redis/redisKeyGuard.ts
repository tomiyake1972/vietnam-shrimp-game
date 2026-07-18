// ShrimpX V2 — Redisキー許可判定（Phase 0A）
//
// 純粋関数として実装し、env変数読み取りや実際のRedis接続に依存しない
// （テストではAppVersion/AppEnvV2を直接引数として渡すだけでよい）。
//
// 意図的に app/lib/redisKeyGuard.ts（V1用）を一切importしない。
// v1行のルールがここに重複するが、V1とV2のキー検証ロジックが
// 誤って結合し、片方の変更がもう片方へ波及することを避けるための
// 明示的な設計判断（docs/v2/CORE_ARCHITECTURE_v0.1.md に記載）。
//
// 許可テーブル（ユーザー仕様どおり）:
//   v1 / production -> "games", "game:*"
//   v1 / staging     -> "staging:games", "staging:game:*"
//   v2 / production -> "v2:games", "v2:game:*"
//   v2 / staging     -> "staging:v2:games", "staging:v2:game:*"
//
// 近似衝突（例: "staging:v2:foo" や "staging:v2:game:X" をv1-staging行で
// 誤許可しないこと等）を防ぐため、prefixチェックは「exact list key」または
// 「exact prefix + 何らかの続き」の2パターンのみを許可し、単純な部分一致は
// 一切用いない。

import { AppVersion, AppEnvV2 } from "../core/version";

export class RedisKeyGuardV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisKeyGuardV2Error";
  }
}

interface KeyRule {
  readonly listKey: string;
  readonly itemPrefix: string;
}

function ruleFor(appVersion: AppVersion, appEnv: AppEnvV2): KeyRule {
  if (appVersion === "v1" && appEnv === "production") {
    return { listKey: "games", itemPrefix: "game:" };
  }
  if (appVersion === "v1" && appEnv === "staging") {
    return { listKey: "staging:games", itemPrefix: "staging:game:" };
  }
  if (appVersion === "v2" && appEnv === "production") {
    return { listKey: "v2:games", itemPrefix: "v2:game:" };
  }
  // v2 / staging
  return { listKey: "staging:v2:games", itemPrefix: "staging:v2:game:" };
}

function isKeyAllowed(key: string, rule: KeyRule): boolean {
  if (key === rule.listKey) return true;
  if (key.startsWith(rule.itemPrefix) && key.length > rule.itemPrefix.length) return true;
  return false;
}

/**
 * 与えられたRedisキー群が (appVersion, appEnv) の名前空間で許可されているかを
 * 検証する。1件でも許可外があれば例外を投げる（fail closed）。
 * 例外メッセージには許可された名前空間ルールのみを含め、実際の値・トークン等の
 * 秘密情報は一切含めない。
 */
export function assertAllowedKeysV2(
  keys: readonly string[],
  appVersion: AppVersion,
  appEnv: AppEnvV2
): void {
  const rule = ruleFor(appVersion, appEnv);
  const rejected = keys.filter((k) => !isKeyAllowed(k, rule));
  if (rejected.length > 0) {
    throw new RedisKeyGuardV2Error(
      `許可されていないRedisキーが含まれています（appVersion=${appVersion}, appEnv=${appEnv}）。` +
        `許可される形式: "${rule.listKey}" または "${rule.itemPrefix}*"。` +
        `拒否されたキー: ${JSON.stringify(rejected)}`
    );
  }
}

/** 単一キーの許可判定（真偽値のみ、例外を投げない版）。 */
export function isAllowedKeyV2(key: string, appVersion: AppVersion, appEnv: AppEnvV2): boolean {
  return isKeyAllowed(key, ruleFor(appVersion, appEnv));
}
