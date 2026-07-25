// ShrimpX V2 — 読み取り専用エクスポートAPI（/api/v2/exports/**） route.ts 共通アダプター
//
// 既存の app/api/v2/company-labs/_lib/withApiContext.ts と同じ役割（認証 →
// 依存関係組み立て → ハンドラー呼び出し → 例外のJSON応答化）を、エクスポートAPI用に
// 提供する。以下の点が既存版と異なる：
//   - 認証は assertStagingExport（STAGING_EXPORT_TOKEN）を使う。assertStagingAdminは
//     一切参照しない（STAGING_ADMIN_TOKENをエクスポート経路へ持ち込まない）。
//   - 認証の成否・レスポンスstatusにかかわらず、監査ログへ1件追記する
//     （三宅さんの指示：「export監査ログ専用キーは追記のみ許可」＝ゼロ書き込みでは
//     なく、監査ログへの書き込みは必須）。監査ログにはトークンの値・Authorization
//     ヘッダーの値を一切含めない（entryの型定義自体にそのフィールドが存在しない）。
//   - 依存関係の組み立てに失敗した場合（環境変数未設定・Redis接続不可等）も、
//     labIdが分かっていれば監査ログへ記録を試みる（失敗してもレスポンス自体は
//     500として返す。監査ログ書き込み自体の失敗でAPI応答を壊さない）。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingExport } from "../../../../lib/stagingExport";
import { CompanyLabExportApiDependencies, createCompanyLabExportApiDependencies } from "./dependencies";
import { CompanyLabExportLogEntry } from "../../../../lib/v2/redis/companyLabExportAuditLog";
import { ApiResult } from "./handlers";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（依存関係の初期化に失敗しました）。時間をおいて再度お試しください。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

export interface ExportRequestScopeInfo {
  readonly route: string;
  readonly labId: string;
  readonly turn: number | null;
  readonly companyIdScope: string | null;
  readonly scope: CompanyLabExportLogEntry["scope"];
}

function extractRequestMeta(req: NextRequest): { readonly ip: string | null; readonly userAgent: string | null } {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const ip = forwardedFor ? forwardedFor.split(",")[0]?.trim() ?? null : null;
  const userAgent = req.headers.get("user-agent");
  return { ip, userAgent: userAgent ?? null };
}

/** 監査ログへの書き込み失敗はAPI応答へ伝播させない（サーバーログにのみ残す）。 */
async function tryAppendAuditLog(deps: CompanyLabExportApiDependencies | null, entry: CompanyLabExportLogEntry): Promise<void> {
  if (!deps) return;
  try {
    await deps.auditLog.append(entry);
  } catch (e) {
    console.error("[exports api] 監査ログの追記に失敗しました:", e);
  }
}

/**
 * STAGING_EXPORT_TOKEN認証 → 読み取り専用依存関係組み立て → handlerFn呼び出し →
 * 監査ログ追記 → NextResponse変換、を一括して行う。
 */
export async function withExportApiContext(
  req: NextRequest,
  scopeInfo: ExportRequestScopeInfo,
  handlerFn: (deps: CompanyLabExportApiDependencies, now: string) => Promise<ApiResult>,
): Promise<NextResponse> {
  const now = new Date().toISOString();
  const { ip, userAgent } = extractRequestMeta(req);

  const auth = assertStagingExport(req);
  if (!auth.ok) {
    // 認証失敗時は依存関係を組み立てず（＝Redis接続を発生させず）に即403応答するが、
    // 監査ログには「認証失敗のアクセスがあった」事実を記録する（トークン値は含めない）。
    // 依存関係を経由せずに監査ログへ書き込めるよう、認証失敗時専用に軽量な組み立てを試みる。
    let deps: CompanyLabExportApiDependencies | null = null;
    try {
      deps = await createCompanyLabExportApiDependencies();
    } catch {
      deps = null;
    }
    await tryAppendAuditLog(deps, {
      timestamp: now,
      labId: scopeInfo.labId,
      route: scopeInfo.route,
      turn: scopeInfo.turn,
      companyIdScope: scopeInfo.companyIdScope,
      scope: scopeInfo.scope,
      tokenScope: "gm",
      status: auth.status,
      ip,
      userAgent,
    });
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: auth.error } }, { status: auth.status });
  }

  let deps: CompanyLabExportApiDependencies;
  try {
    deps = await createCompanyLabExportApiDependencies();
  } catch (e) {
    console.error("[exports api] 依存関係の組み立てに失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  try {
    const result = await handlerFn(deps, now);
    await tryAppendAuditLog(deps, {
      timestamp: now,
      labId: scopeInfo.labId,
      route: scopeInfo.route,
      turn: scopeInfo.turn,
      companyIdScope: scopeInfo.companyIdScope,
      scope: scopeInfo.scope,
      tokenScope: "gm",
      status: result.status,
      ip,
      userAgent,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[exports api] ハンドラーで予期しないエラーが発生しました:", e);
    await tryAppendAuditLog(deps, {
      timestamp: now,
      labId: scopeInfo.labId,
      route: scopeInfo.route,
      turn: scopeInfo.turn,
      companyIdScope: scopeInfo.companyIdScope,
      scope: scopeInfo.scope,
      tokenScope: "gm",
      status: 500,
      ip,
      userAgent,
    });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}
