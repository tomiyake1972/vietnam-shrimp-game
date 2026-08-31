// ShrimpX V2 — Company Lab / Management staging管理ログインの returnTo 純粋ロジック
//
// 【なぜ companyLabUiSession.ts から分離したか（PLAY画面 管理者再ログイン導線）】
// companyLabUiSession.ts はモジュール冒頭で next/headers（cookies/headers）を
// importしている。Next.jsは"use client"なClient Componentがこのファイルの
// どのexportを使っても、ファイル全体をクライアントバンドルに含めようとし、
// next/headersはServer Component専用のため実際にビルドエラーになる
// （実機で確認済み: 「You're importing a module that depends on "next/headers"
// into a React Client Component module.」）。
//
// ここにあるのはCookie・next/headers等のリクエストスコープAPIに一切依存しない
// 純粋関数・定数だけであり、Server Component・Server Action・Client Componentの
// いずれからも安全にimportできる。companyLabUiSession.ts側はこれらを
// re-exportするだけで、既存の呼び出し元（page.tsx・actions.ts等）の
// import文は一切変更不要にしてある。

export const COMPANY_LAB_UI_LOGIN_PATH = "/v2/company-lab/play/login";
export const COMPANY_LAB_UI_HOME_PATH = "/v2/company-lab/play";

/**
 * 【Management Console認証Cookie整合性調査・指示§11/§17】ログイン後に
 * 「元いた画面」（Management ConsoleのRun等）へ戻すための returnTo を検証する。
 * open redirect対策として、必ず同一オリジン内の絶対パス（"/"始まり）だけを許可する
 * （"//evil.com"のようなprotocol-relative URLや"https://..."のような別オリジンURLは
 * 拒否する）。無効な値はnullを返し、呼び出し側は既定のCOMPANY_LAB_UI_HOME_PATHへ
 * フォールバックする。
 */
export function sanitizeReturnToPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("://")) return null;
  return raw;
}

/**
 * 【PLAY画面 管理者再ログイン導線】現在の画面（pathname・search）から、
 * ログイン画面へのreturnTo付きhrefを組み立てる純粋関数。新しい認証方式は作らず、
 * 既存のCOMPANY_LAB_UI_LOGIN_PATHと、ログイン画面側で必ず通るsanitizeReturnToPath
 * （唯一のopen redirect検証箇所）をそのまま使う。ここではURL文字列の組み立てだけを
 * 行い、検証はしない（"/"始まりのpathnameから組み立てる限り、常にsanitizeReturnToPath
 * を通過する形になる）。
 *
 * searchはURLSearchParams#toString()の結果（先頭"?"無し）を渡す。空文字列なら
 * クエリなしのpathnameだけをreturnToにする。
 */
export function buildAdminReloginHref(pathname: string, search: string): string {
  const returnTo = search.length > 0 ? `${pathname}?${search}` : pathname;
  return `${COMPANY_LAB_UI_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
