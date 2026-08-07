// ShrimpX V2 — Standard AI経営説明レポートAPI route.ts 共通アダプター（MVP）
//
// 既存の app/api/v2/company-labs/_lib/withApiContext.ts と同じ定型処理
// （管理トークン認証 → 依存関係組み立て → ハンドラー呼び出し → 例外のJSON応答化）を、
// 本機能専用の依存関係型（AiExplanationApiDependencies、Redisクライアントを追加で持つ）
// に合わせてここへ用意する。認証方式・追加の新しい認証機構は導入しない
// （既存のassertStagingAdminをそのまま再利用する。実装指示「既存の認証ゲートを
// 再利用することで“自由に叩けない”要件を満たす」に対応）。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../../../../../../../lib/stagingAdmin";
import { AiExplanationApiDependencies, createAiExplanationApiDependencies } from "./dependencies";
import { AiExplanationApiResult } from "./handlers";

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（依存関係の初期化に失敗しました）。時間をおいて再度お試しください。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

export async function withAiExplanationApiContext(
  req: NextRequest,
  handlerFn: (deps: AiExplanationApiDependencies) => Promise<AiExplanationApiResult>
): Promise<NextResponse> {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: auth.error } }, { status: auth.status });
  }

  let deps: AiExplanationApiDependencies;
  try {
    deps = await createAiExplanationApiDependencies();
  } catch (e) {
    console.error("[ai-explanation api] 依存関係の組み立てに失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  try {
    const result = await handlerFn(deps);
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[ai-explanation api] ハンドラーで予期しないエラーが発生しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}
