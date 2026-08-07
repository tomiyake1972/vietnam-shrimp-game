import { NextRequest, NextResponse } from "next/server";
import { withExportApiContext } from "../../_lib/withExportApiContext";
import { handleExportLabIndex } from "../../_lib/handlers";

// GET /api/v2/exports/company-labs/[labId] — ラボindex（作成済みturn一覧・完了状態）。
// GETハンドラーのみを定義する（POST/PUT/PATCH/DELETEはこのファイルに一切存在しない。
// Next.jsのroute.tsは、定義されていないHTTPメソッドへは自動的に405 Method Not Allowed
// を返す＝実装コード自体が存在しないため、書き込み系メソッドで取得・変更する経路がない）。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  return withExportApiContext(
    req,
    { route: "GET /api/v2/exports/company-labs/[labId]", labId, turn: null, companyIdScope: null, scope: "index" },
    (deps, now) => handleExportLabIndex(deps, labId, now),
  );
}
