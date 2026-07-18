// ShrimpX V2 — Redisキー生成（Phase 0A）
//
// APP_ENVに応じたV2名前空間のキーだけを生成する。V1の app/lib/redisKeys.ts は
// importしない（V1/V2分離の原則）。生成されたキーは必ず redisKeyGuard.ts の
// assertAllowedKeysV2 を通してからRedisへ書き込むこと。

import { AppEnvV2 } from "../core/version";

/** V2ゲーム一覧キー。production: "v2:games" / staging: "staging:v2:games"。 */
export function gamesListKeyV2(appEnv: AppEnvV2): string {
  return appEnv === "production" ? "v2:games" : "staging:v2:games";
}

/** V2個別ゲームキー。production: "v2:game:<code>" / staging: "staging:v2:game:<code>"。 */
export function gameKeyV2(appEnv: AppEnvV2, gameCode: string): string {
  if (!gameCode) {
    throw new Error("gameKeyV2: gameCode は空にできません。");
  }
  const prefix = appEnv === "production" ? "v2:game:" : "staging:v2:game:";
  return `${prefix}${gameCode}`;
}
