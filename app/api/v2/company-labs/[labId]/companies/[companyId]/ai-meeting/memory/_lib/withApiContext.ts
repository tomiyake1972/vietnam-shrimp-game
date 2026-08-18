// ShrimpX V2 — Run Advisory Memory Management API route.ts 共通アダプター（AMM-M2.6）
//
// 既存のai-meeting/messages/_lib/withApiContext.tsと同じ定型処理（管理トークン認証 →
// 依存関係組み立て → ハンドラー呼び出し → 例外のJSON応答化）。新しい認証機構は
// 導入しない（既存のassertStagingAdminをそのまま再利用する）。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../../../../../../lib/stagingAdmin";
import { createRunAdvisoryMemoryApiDependencies, RunAdvisoryMemoryApiDependencies } from "./dependencies";
import { RunAdvisoryMemoryApiResult } from "./handlers";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（依存関係の初期化に失敗しました）。時間をおいて再度お試しください。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

export async function withRunAdvisoryMemoryApiContext(
  req: NextRequest,
  handlerFn: (deps: RunAdvisoryMemoryApiDependencies) => Promise<RunAdvisoryMemoryApiResult>
): Promise<NextResponse> {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: auth.error } }, { status: auth.status });
  }

  let deps: RunAdvisoryMemoryApiDependencies;
  try {
    deps = await createRunAdvisoryMemoryApiDependencies();
  } catch (e) {
    console.error("[run-advisory-memory api] 依存関係の組み立てに失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  try {
    const result = await handlerFn(deps);
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[run-advisory-memory api] ハンドラーで予期しないエラーが発生しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}
