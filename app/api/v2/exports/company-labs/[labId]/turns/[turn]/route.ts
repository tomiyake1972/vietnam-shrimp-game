import { NextRequest, NextResponse } from "next/server";
import { withExportApiContext } from "../../../../_lib/withExportApiContext";
import { handleExportAllCompaniesTurn } from "../../../../_lib/handlers";

// GET /api/v2/exports/company-labs/[labId]/turns/[turn] — 全社スコープ（GMフルスコープのみ）。
// 【権限】STAGING_EXPORT_TOKENは現時点でGMフルスコープの1種類のみが存在するため、
// 有効なトークンを持つ呼び出し元は全員このエンドポイントを利用できる。将来プレイヤー
// 限定スコープのトークンを追加する場合は、withExportApiContext（または
// assertStagingExportの拡張）側でスコープ判定を一元化し、このroute内では判定しない。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string; turn: string }> }): Promise<NextResponse> {
  const { labId, turn } = await params;
  return withExportApiContext(
    req,
    { route: "GET /api/v2/exports/company-labs/[labId]/turns/[turn]", labId, turn: Number(turn) || null, companyIdScope: null, scope: "all" },
    (deps, now) => handleExportAllCompaniesTurn(deps, labId, turn, now),
  );
}
