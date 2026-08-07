import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { isProduction } from "./env";

// Company Lab 読み取り専用エクスポートAPI（/api/v2/exports/**）専用の認証。
//
// 【STAGING_ADMIN_TOKENとの意図的な分離】既存のapp/lib/stagingAdmin.tsの
// assertStagingAdminは、作成・更新・削除を含む「管理操作」全般に使う管理トークンで
// あり、これをそのままエクスポート用途に流用すると、AI（Claude/ChatSense）がこの
// トークンを扱う経路を作ってしまうことになる。エクスポートAPIは読み取り専用の
// GETしか提供しないため、STAGING_ADMIN_TOKENとは全く別の値
// （STAGING_EXPORT_TOKEN）を要求し、AI側にはこちらだけを渡す運用にする
// （三宅さんの指示: 「STAGING_ADMIN_TOKENをAIへ渡すのではなく、読み取り・出力専用の
// 安全な経路を設計する」）。
//
// 認証方式: `Authorization: Bearer {STAGING_EXPORT_TOKEN}` ヘッダーのみ
// （クエリパラメータには一切含めない。URLはアクセスログ・プロキシログ・ブラウザ
// 履歴に残りやすく、トークンをそこへ置くのは事故のもとになるため）。
//
// fail-closed方針: STAGING_EXPORT_TOKEN未設定・空文字は「常に拒否」とする
// （「トークンが設定されていないなら誰でも通す」という抜け道を作らない）。
// 本番環境では、正しいトークンが提供された場合でも常に拒否する
// （assertStagingAdminと同じ方針。エクスポートAPI自体が本番では一切提供されない）。

export interface StagingExportCheckResult {
  ok: boolean;
  status: number;
  error?: string;
}

function safeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}

const GENERIC_AUTH_ERROR = "エクスポートAPIの認証に失敗しました。";

/**
 * 生のトークン文字列（Bearerヘッダーから取り出した値）をSTAGING_EXPORT_TOKENと
 * 比較する、リクエストに依存しない共通ロジック。assertStagingExportのテストや、
 * 将来Bearerヘッダー以外の入口を追加する場合に、判定ロジックを重複実装しない
 * ために切り出している（app/lib/stagingAdmin.tsのcheckStagingAdminTokenと同じ構造）。
 */
export function checkStagingExportToken(provided: string | null | undefined): StagingExportCheckResult {
  if (isProduction) {
    return { ok: false, status: 403, error: "この操作は本番環境では利用できません。" };
  }

  const expected = process.env.STAGING_EXPORT_TOKEN;
  if (!expected) {
    // fail-closed: 未設定は「認証不要」ではなく「常に拒否」。
    return { ok: false, status: 403, error: GENERIC_AUTH_ERROR };
  }

  if (!provided || !safeCompare(provided, expected)) {
    return { ok: false, status: 403, error: GENERIC_AUTH_ERROR };
  }

  return { ok: true, status: 200 };
}

/**
 * トークンが正当かどうかにかかわらず同一のエラーメッセージ・ステータスを返す
 * （assertStagingAdminと同じ理由：エラー内容からトークンの正当性を推測できないようにする）。
 */
export function assertStagingExport(request: NextRequest): StagingExportCheckResult {
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return checkStagingExportToken(provided);
}
