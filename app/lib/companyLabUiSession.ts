// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） サーバー側セッション境界
//
// 【設計方針・指示§7への対応】
//   STAGING_ADMIN_TOKENはブラウザへ一切渡さない。Client Component・JSバンドル・
//   localStorage/sessionStorage・通常Cookie・URL・HTML・API応答・client側ログへも
//   出さない。ブラウザから既存の管理API（Bearerトークン付き）へ直接fetchする構成も
//   採らない。
//
//   ログインフォーム（Server Action）だけがトークンをサーバー側で一度だけ検証し
//   （app/lib/stagingAdmin.tsのcheckStagingAdminToken、既存のBearerヘッダー方式と
//   同じ比較ロジックを再利用。重複実装しない）、成功したら「トークンそのものでは
//   ない」署名付きの opaque セッション値をHttpOnly・Secure・SameSite=Laxの
//   Cookieへ書き込む。以後の各ページ・Server Actionはこのセッション値だけを検証し、
//   STAGING_ADMIN_TOKEN自体を読み返すことは一切ない。
//
//   セッション値はステートレス（サーバー側の追加ストレージを持たない）に、
//   HMAC-SHA256で署名する。署名鍵はSTAGING_ADMIN_TOKENから導出する
//   （"company-lab-ui-session-v1:" を前置してドメイン分離し、Bearerトークン比較
//   用途とは別の値になるようにしてある）。これにより、STAGING_ADMIN_TOKEN自体を
//   ローテーションすれば、発行済みの全セッションも同時に無効化される。
//
//   セッション値は「固定値」ではなく、発行のたびにランダムなnonceと発行時刻
//   （iat）・有効期限（exp）を含むペイロードを署名するため、推測可能な固定
//   Cookie値にはならない。

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkStagingAdminToken } from "./stagingAdmin";
import { isProduction } from "./env";

export const COMPANY_LAB_UI_SESSION_COOKIE_NAME = "shrimpx_company_lab_ui_session";
/**
 * 【Persistence Architecture Phase 3・dataset HTTP 403調査】このセッションCookieは
 * Company Lab UIログインだけでなく、Management ConsoleのSimulation Run API
 * （app/api/v2/simulation-runs/_lib/context.ts:withSimulationRunApiContext）の
 * 唯一の認証経路にもなっている。32Q Runは実プレイで数時間かかり得るため、
 * 旧8時間のTTLは「一度ログインしたまま長時間の32Qプレイを続ける」という
 * Management Consoleの実際の使い方に対して余裕が無さすぎた（実stagingで、
 * Turn18のsave/resumeは成功していたのに、Turn26付近のserver dataset保存が
 * HTTP 403で失敗する不具合を確認。時間経過に起因するセッション失効が最も説明力の
 * 高い仮説であり、他の原因―body sizeやVercel deployment protection等―は
 * 実測で否定的または未確認。断定できない部分は最終報告で明記する）。
 * 24時間へ延ばし、1日がかりのstaging検証セッションの途中で切れる可能性を下げる。
 */
const SESSION_TTL_MILLISECONDS = 24 * 60 * 60 * 1000; // 24時間（staging用の短命セッション）
const SESSION_SECRET_DOMAIN_PREFIX = "company-lab-ui-session-v1:";

export const COMPANY_LAB_UI_LOGIN_PATH = "/v2/company-lab/play/login";
export const COMPANY_LAB_UI_HOME_PATH = "/v2/company-lab/play";

interface SessionPayload {
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

/** 【Phase 8C-3B §13.2】STAGING_ADMIN_TOKENから毎回導出する（キャッシュしない）。exportはテスト専用（次項参照）。 */
export function deriveSessionSecret(): Buffer | null {
  // 【本番環境防御】本番（APP_ENV=production）ではセッション署名鍵自体を導出しない。
  // これによりcreateSessionToken（発行）だけでなくverifySessionToken（検証）も本番では
  // 必ず失敗し、仮に本番環境にSTAGING_ADMIN_TOKENが誤って設定されていて、かつ
  // 非本番環境で正しく署名されたCookie値を持ち込まれても、決して有効と判定されない。
  // ログイン経路はcheckStagingAdminToken（stagingAdmin.ts）が既に本番で常に403を返すが、
  // 「発行済みCookieの検証」はログイン経路を通らないため、検証側にも同じisProduction
  // 判定（app/lib/env.ts、判定源を一元化）を置く多重防御が必要になる。
  if (isProduction) return null;
  const token = process.env.STAGING_ADMIN_TOKEN;
  if (!token) return null;
  return createHash("sha256").update(SESSION_SECRET_DOMAIN_PREFIX + token, "utf8").digest();
}

function signPayload(payloadB64: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payloadB64, "utf8").digest("hex");
}

/**
 * ログイン成功時にのみ呼ぶ。STAGING_ADMIN_TOKEN自体は含まれない、署名付きopaque値を返す。
 *
 * 【Phase 8C-3B §13.2】本関数・verifySessionTokenはnext/headers等のリクエストスコープ
 * APIに一切依存しない（process.env・crypto・Date.nowのみ）。そのためnode:testから
 * Next.jsのリクエストコンテキストをモックすることなく直接ユニットテストできる。
 * セキュリティ上重要な署名検証・有効期限・nonceのランダム性はここで直接検証し、
 * cookies()自体を使う薄いラッパー（attemptStagingLogin/hasValidStagingSession）は
 * ブラウザE2E（指示§14）で検証する。
 */
export function createSessionToken(): string | null {
  const secret = deriveSessionSecret();
  if (!secret) return null;
  const now = Date.now();
  const payload: SessionPayload = { iat: now, exp: now + SESSION_TTL_MILLISECONDS, nonce: randomBytes(16).toString("hex") };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signPayload(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const secret = deriveSessionSecret();
  if (!secret) return false; // STAGING_ADMIN_TOKEN未設定＝どのセッションも有効化できない
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;
  const expectedSignature = signPayload(payloadB64, secret);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false;
  return Date.now() < payload.exp;
}

/**
 * ログインフォームのServer Actionから呼ぶ。渡されたトークン文字列を
 * checkStagingAdminToken（stagingAdmin.tsと共有）で検証し、成功したらセッション
 * Cookieを発行する。呼び出し元へは成否のみを返し、詳細な失敗理由（トークン不一致か
 * 未設定か等）は返さない（既存のGENERIC_AUTH_ERROR方針を踏襲。エラーからの推測を防ぐ）。
 */
export async function attemptStagingLogin(providedToken: string): Promise<{ readonly ok: boolean }> {
  const check = checkStagingAdminToken(providedToken);
  if (!check.ok) return { ok: false };
  const token = createSessionToken();
  if (!token) return { ok: false };
  const store = await cookies();
  store.set(COMPANY_LAB_UI_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MILLISECONDS / 1000),
  });
  return { ok: true };
}

/** ログアウト。Cookieを削除するだけで、サーバー側の追加ストレージは持たない（ステートレス設計）ため他に消すものはない。 */
export async function clearStagingSession(): Promise<void> {
  const store = await cookies();
  store.delete(COMPANY_LAB_UI_SESSION_COOKIE_NAME);
}

/** 現在のリクエストが有効なセッションを持つかどうかだけを返す（リダイレクトしない）。 */
export async function hasValidStagingSession(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(COMPANY_LAB_UI_SESSION_COOKIE_NAME)?.value);
}

/**
 * Server Component・Server Actionの先頭で呼ぶ。セッションが無効ならログイン画面へ
 * リダイレクトする（Next.jsのredirect()は例外として実装されており、呼び出し元の
 * 残りの処理は実行されない）。
 */
export async function requireStagingSession(): Promise<void> {
  if (!(await hasValidStagingSession())) {
    redirect(COMPANY_LAB_UI_LOGIN_PATH);
  }
}

/**
 * 状態変更を伴うServer Action（createLab/saveDraft/submitDraft/processQuarter/
 * login等）の先頭で呼ぶ、CSRF対策の多重防御（指示§7「state-changing操作では
 * same-origin／Origin確認等」）。
 *
 * Next.jsのServer Actions自体、`Origin`ヘッダーがデプロイ先のホストと一致しない
 * リクエストを標準機能として拒否する（Server Actionsの組み込みCSRF対策）。本関数は
 * それに加えて、Originヘッダーが本リクエストのHostヘッダーと一致することを
 * アプリケーション層でも明示的に確認する多重防御であり、Next.jsの内部実装詳細に
 * 単独で依存しないようにする。
 */
/**
 * 【Phase 8C-3B §13.2】assertSameOriginRequestの判定本体（純粋関数）。headers()自体には
 * 依存しないため、Next.jsのリクエストコンテキスト無しで直接ユニットテストできる。
 */
export function isSameOriginHost(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export async function assertSameOriginRequest(): Promise<{ readonly ok: boolean }> {
  const h = await headers();
  return { ok: isSameOriginHost(h.get("origin"), h.get("host")) };
}
