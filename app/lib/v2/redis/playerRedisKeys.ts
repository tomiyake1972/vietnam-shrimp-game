// ShrimpX V2 — Independent Player Flow: Player Seat / Join Credential / Session 専用Redisキー生成
//
// Simulation Run本体（simulationRunRedisKeys.ts）・会社ラボ本体（companyLabRedisKeys.ts）
// とは独立した名前空間を使う。Player Seat / Session metadataは、既存Run本体
// （StoredSimulationRun）とはライフサイクルが異なる（Runが削除されてもSeat/Sessionの
// 監査情報は残ってよい・Seat/SessionはRun本体のスキーマを変更せずに追加できる）ため、
// 同じキー空間へ混ぜない。
//
//   v2:player:join:{sha256(joinSecret)}          （production。join secretのhashのみ保存）
//   staging:v2:player:join:{sha256(joinSecret)}  （staging）
//   v2:player:seat:{runId}:{companyId}
//   v2:player:session:{sessionId}
//
// 生成したキーは必ずassertAllowedPlayerKeysを通してから書き込むこと。
//
// 【secretを平文で保存しない】join URLの秘密部分（joinSecret）はRedisのキー名にも
// 値にも一切平文で残さない。キー名にはsha256ハッシュだけを使う（キー名からjoinSecretを
// 逆算することはできない）。

import { createHash } from "crypto";
import { AppEnvV2 } from "../core/version";
import { assertValidSimulationRunId } from "./simulationRunRedisKeys";

const COMPANY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function assertValidCompanyId(companyId: string): void {
  if (typeof companyId !== "string" || !COMPANY_ID_PATTERN.test(companyId)) {
    throw new Error(`companyId は英数字・ドット・ハイフン・アンダースコアのみ、1〜64文字である必要があります。受け取った値: ${JSON.stringify(companyId)}`);
  }
}

export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`sessionId の形式が不正です。受け取った値: ${JSON.stringify(sessionId)}`);
  }
}

function prefixFor(appEnv: AppEnvV2): string {
  return appEnv === "production" ? "v2:player:" : "staging:v2:player:";
}

/** joinSecret（URL中の秘密トークン）をハッシュ化する。Redisのキー名にはこのハッシュだけを使う。 */
export function hashJoinSecret(joinSecret: string): string {
  return createHash("sha256").update("shrimpx-player-join-v1:" + joinSecret).digest("hex");
}

/** join credential（ハッシュ済み）→ {runId, companyId} を引くキー。 */
export function playerJoinKeyV2(appEnv: AppEnvV2, joinSecretHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(joinSecretHash)) {
    throw new Error(`joinSecretHash はsha256の16進64文字である必要があります。`);
  }
  return `${prefixFor(appEnv)}join:${joinSecretHash}`;
}

/** Player Seat（会社ごとの参加状況・現在有効なjoin credentialのhash・提出状況）。 */
export function playerSeatKeyV2(appEnv: AppEnvV2, runId: string, companyId: string): string {
  assertValidSimulationRunId(runId);
  assertValidCompanyId(companyId);
  return `${prefixFor(appEnv)}seat:${runId}:${companyId}`;
}

/**
 * 【index不要】指定Runの全Seatは、呼び出し側が既に知っているcompanyId一覧
 * （fixturesは常に5社固定・GM Console側が既に持っている）から
 * playerSeatKeyV2を直接組み立てて読む。会社数が小さく固定のため、
 * 別途indexキーは持たない（読み出しはO(会社数)で十分軽い）。
 */

/**
 * claim（参加）の排他ロック。SET NXで「同時に2人が同じjoin URLを開いても
 * 片方だけがclaimできる」ことを保証する唯一の場所。GMが参加linkを再発行した
 * ときはこのキーを削除し、新しいclaimを受け付けられる状態へ戻す。
 */
export function playerSeatClaimLockKeyV2(appEnv: AppEnvV2, runId: string, companyId: string): string {
  assertValidSimulationRunId(runId);
  assertValidCompanyId(companyId);
  return `${prefixFor(appEnv)}claimLock:${runId}:${companyId}`;
}

/** Player Session本体。Cookieが保持するのはsessionIdのみで、runId/companyIdは必ずここから解決する。 */
export function playerSessionKeyV2(appEnv: AppEnvV2, sessionId: string): string {
  assertValidSessionId(sessionId);
  return `${prefixFor(appEnv)}session:${sessionId}`;
}

/**
 * 書き込み直前のキー許可検証。Player以外の名前空間（Simulation Run本体・会社ラボ本体）へ
 * 絶対に書き込まないことを構造的に保証する。
 */
export function assertAllowedPlayerKeys(keys: readonly string[], appEnv: AppEnvV2): void {
  const prefix = prefixFor(appEnv);
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      throw new Error(`Player Seat/Session以外のキーへ書き込もうとしました（key=${key}, 期待するprefix=${prefix}）。`);
    }
  }
}
