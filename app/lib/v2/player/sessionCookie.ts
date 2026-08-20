// ShrimpX V2 — Independent Player Flow: Player Session Cookie
//
// 【既存staging admin sessionを流用しない】app/lib/companyLabUiSession.tsとは
// 完全に別のCookie・別の署名鍵ドメインを使う（同じ暗号パターン＝HMAC-SHA256で
// {payload}.{signature}を作る、というテンプレートだけを踏襲する）。
//
// 【Cookieはsessionidだけを署名して運ぶ】runId/companyIdはCookieへ一切埋め込まない。
// 以後のPlayer APIは必ずCookieのsessionIdからPlayerRepository.loadSessionで
// runId/companyIdを解決する（指示: 「query parameterのcompanyを信頼しない」）。
// これによりGMがPlayer Seatを取り消す／再発行すると、既に発行済みのCookieが
// 署名としては有効なままでも、次のAPI呼び出しで即座に無効化される
// （署名検証だけでなく、必ずRedisの現在状態を見る）。

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { isProduction } from "../../env";

export const PLAYER_SESSION_COOKIE_NAME = "shrimpx_player_session";

/** 【本番では発行・検証しない】staging専用機能。既存のcompanyLabUiSession.tsと同じ多重防御。 */
const SESSION_SECRET_DOMAIN_PREFIX = "shrimpx-player-session-v1:";
/** Playerは複数Turn・複数日にまたがってプレイし得るため、admin sessionの24hより長めに取る。 */
const SESSION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000; // 30日

interface PlayerCookiePayload {
  readonly sessionId: string;
  readonly iat: number;
  readonly exp: number;
}

/** テスト用にexport（app/lib/companyLabUiSession.tsのderiveSessionSecretと同じ理由）。 */
export function derivePlayerSessionSecret(): Buffer | null {
  if (isProduction) return null;
  const token = process.env.STAGING_ADMIN_TOKEN;
  if (!token) return null;
  return createHash("sha256").update(SESSION_SECRET_DOMAIN_PREFIX + token, "utf8").digest();
}

function signPayload(payloadB64: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
}

/** sessionId（PlayerRepositoryが発行した既存のsessionId）をCookie値へ署名する。 */
export function signPlayerCookieValue(sessionId: string): string | null {
  const secret = derivePlayerSessionSecret();
  if (!secret) return null;
  const now = Date.now();
  const payload: PlayerCookiePayload = { sessionId, iat: now, exp: now + SESSION_TTL_MILLISECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

/**
 * Cookie値の署名・有効期限だけを検証し、sessionIdを返す（有効でなければnull）。
 * 【重要】これはCookieの改ざん検知・期限切れ検知のみを行う。runId/companyIdが
 * 今も有効か（Seatが取り消されていないか等）は、この関数の戻り値のsessionIdを
 * 使ってPlayerRepository.loadSessionを呼び、そちらのrevokedAtで判定すること。
 */
export function verifyPlayerCookieValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const secret = derivePlayerSessionSecret();
  if (!secret) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expected = signPayload(payloadB64, secret);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: PlayerCookiePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || typeof payload.sessionId !== "string") return null;
  if (Date.now() >= payload.exp) return null;
  return payload.sessionId;
}

export async function setPlayerSessionCookie(sessionId: string): Promise<boolean> {
  const value = signPlayerCookieValue(sessionId);
  if (!value) return false;
  const store = await cookies();
  store.set(PLAYER_SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MILLISECONDS / 1000),
  });
  return true;
}

export async function readPlayerSessionIdFromCookie(): Promise<string | null> {
  const store = await cookies();
  return verifyPlayerCookieValue(store.get(PLAYER_SESSION_COOKIE_NAME)?.value);
}

export async function clearPlayerSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(PLAYER_SESSION_COOKIE_NAME);
}
