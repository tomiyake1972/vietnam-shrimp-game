import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { isProduction } from "./env";

// テスト環境の破壊的操作（初期化・削除・複製・スナップショット操作）用の認証。
// 各管理APIで個別に認証処理を書かず、必ずこの関数を通すこと。
//
// 認証方式: `Authorization: Bearer {STAGING_ADMIN_TOKEN}` ヘッダー。
// トークンの値自体はクライアントに一切公開しない（NEXT_PUBLIC_*は使わない）。
export interface StagingAdminCheckResult {
  ok: boolean;
  status: number;
  error?: string;
}

// トークン比較にはSHA-256でハッシュ化してから固定長のtimingSafeEqualで比較する。
// 生の文字列同士をtimingSafeEqualに渡すと長さが違う場合に例外を投げてしまい、
// それ自体が「長さの手がかり」になりうるため、常に同じ長さのハッシュ値を比較する。
function safeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}

const GENERIC_AUTH_ERROR = "管理操作の認証に失敗しました。";

/**
 * 【Phase 8C-3B】生のトークン文字列（Bearerヘッダーから取り出した値でも、ログイン
 * フォームの入力値でも構わない）をSTAGING_ADMIN_TOKENと比較する、リクエストに
 * 依存しない共通ロジック。assertStagingAdmin（既存のBearerヘッダー方式）と、
 * 新しいCompany Lab UIのセッションログイン（app/lib/companyLabUiSession.ts）の
 * 両方がこれを再利用し、本番判定・トークン比較ロジックを重複実装しない。
 */
export function checkStagingAdminToken(provided: string | null | undefined): StagingAdminCheckResult {
  if (isProduction) {
    return { ok: false, status: 403, error: "この操作は本番環境では利用できません。" };
  }

  const expected = process.env.STAGING_ADMIN_TOKEN;
  if (!expected) {
    return { ok: false, status: 403, error: GENERIC_AUTH_ERROR };
  }

  if (!provided || !safeCompare(provided, expected)) {
    return { ok: false, status: 403, error: GENERIC_AUTH_ERROR };
  }

  return { ok: true, status: 200 };
}

// 正しいトークンが設定されているかどうかを、エラー内容から推測できないようにする。
// 「本番環境である」ことだけは環境の話であり、トークンの正当性とは無関係なので
// 別のメッセージにしている。それ以外（トークン未設定／ヘッダーなし／トークン不一致）は
// すべて同一のメッセージ・ステータスにする。
export function assertStagingAdmin(request: NextRequest): StagingAdminCheckResult {
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return checkStagingAdminToken(provided);
}
