import { NextRequest, NextResponse } from "next/server";
import { withApiContext } from "../../_lib/withApiContext";
import { handleGetHistoryPage } from "../../_lib/handlers";

// GET /api/v2/company-labs/[labId]/history?afterTurn=&limit= — 履歴ページング取得（Phase 8C-3A §6.6）。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  return withApiContext(req, (deps) => handleGetHistoryPage(deps, labId, req.nextUrl.searchParams));
}
