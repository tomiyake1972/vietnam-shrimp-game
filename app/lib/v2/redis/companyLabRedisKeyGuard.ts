// ShrimpX V2 — 会社ラボ専用Redisキー許可判定（Phase 8C-1）
//
// 純粋関数として実装し、env変数読み取りや実際のRedis接続に依存しない。
// 既存のredisKeyGuard.ts（無印/v2本番ゲーム専用）とは意図的に一切importしない
// （V1/V2キーガードが互いに独立している既存方針と同じ考え方。片方の変更が
// もう片方へ波及することを避ける）。
//
// 許可される形式（labId指定時）:
//   v2:companyLab:{labId}:current
//   v2:companyLab:{labId}:draft
//   v2:companyLab:{labId}:lock
//   v2:companyLab:{labId}:history:index
//   v2:companyLab:{labId}:history:{正の整数turn}
//   staging: 各キーの先頭にstaging:を付けた形
// 加えて、labIdに依存しない一覧キー:
//   v2:companyLab:labs / staging:v2:companyLab:labs

import { AppEnvV2 } from "../core/version";

export class CompanyLabRedisKeyGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyLabRedisKeyGuardError";
  }
}

function prefixFor(appEnv: AppEnvV2): string {
  return appEnv === "production" ? "v2:companyLab:" : "staging:v2:companyLab:";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidLabId(labId: string): boolean {
  // labIdはキーのセグメント区切り(":")を含んではならない。空文字も不可。
  return typeof labId === "string" && labId.length > 0 && !labId.includes(":");
}

/** 会社ラボ一覧キー（labIdに依存しない、production/staging別）。 */
export function isAllowedCompanyLabListKey(key: string, appEnv: AppEnvV2): boolean {
  return key === `${prefixFor(appEnv)}labs`;
}

/**
 * 指定した (appEnv, labId) の名前空間で、与えられたキーが許可されるかどうかを
 * 判定する。labId自体が不正（空・":"を含む等）な場合は、いかなるキーも
 * 許可しない（fail closed）。history:{turn}のturnが正の整数でない場合も拒否する
 * （「不正なlabId・turnを拒否」の要求）。
 */
export function isAllowedCompanyLabKey(key: string, appEnv: AppEnvV2, labId: string): boolean {
  if (!isValidLabId(labId)) return false;
  const prefix = prefixFor(appEnv);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}${escapeRegExp(labId)}:(current|draft|lock|history:index|history:(\\d+))$`);
  const m = pattern.exec(key);
  if (!m) return false;
  if (m[2] !== undefined) {
    const turn = Number(m[2]);
    if (!Number.isInteger(turn) || turn < 1) return false;
  }
  return true;
}

/**
 * 与えられたRedisキー群が (appEnv, labId) の名前空間で許可されているか検証する
 * （書き込み・削除の直前に必ず呼ぶ）。1件でも許可外があれば例外を投げる
 * （fail closed）。一覧キー（companyLabListKeyV2相当）はlabIdに依存せず常に許可する。
 */
export function assertAllowedCompanyLabKeys(keys: readonly string[], appEnv: AppEnvV2, labId: string): void {
  const rejected = keys.filter((k) => !isAllowedCompanyLabKey(k, appEnv, labId) && !isAllowedCompanyLabListKey(k, appEnv));
  if (rejected.length > 0) {
    throw new CompanyLabRedisKeyGuardError(
      `許可されていない会社ラボRedisキーが含まれています（appEnv=${appEnv}, labId=${JSON.stringify(labId)}）。` +
        `許可される形式: "${prefixFor(appEnv)}${labId}:current" 等（current/draft/lock/history:index/history:<turn>）、` +
        `または一覧キー "${prefixFor(appEnv)}labs"。拒否されたキー: ${JSON.stringify(rejected)}`
    );
  }
}

/**
 * 一覧キー（companyLabListKeyV2）のみを対象とした許可判定
 * （ラボ作成時の一覧更新等、labIdに紐づかない操作で使う）。
 */
export function assertAllowedCompanyLabListKey(key: string, appEnv: AppEnvV2): void {
  if (!isAllowedCompanyLabListKey(key, appEnv)) {
    throw new CompanyLabRedisKeyGuardError(`許可されていない会社ラボ一覧キーです（appEnv=${appEnv}）。受け取ったキー: ${JSON.stringify(key)}`);
  }
}
