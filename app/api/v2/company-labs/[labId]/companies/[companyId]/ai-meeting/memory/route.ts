import { NextRequest, NextResponse } from "next/server";
import { withRunAdvisoryMemoryApiContext } from "./_lib/withApiContext";
import { handleDeactivateRunAdvisoryMemory, handleGetRunAdvisoryMemories } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string }> };

// GET /api/v2/company-labs/[labId]/companies/[companyId]/ai-meeting/memory
// — Run Advisory Memory（AMM-M2.6）のactive memory一覧を返す。読み取り専用、副作用なし。
// MVPでUI実装は不要（実装指示§23・§42）だが、将来のmemory管理panel用にAPI contractを用意する。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId } = await params;
  return withRunAdvisoryMemoryApiContext(req, (deps) => handleGetRunAdvisoryMemories(deps, labId, companyId));
}

// DELETE /api/v2/company-labs/[labId]/companies/[companyId]/ai-meeting/memory?id=...
// — 個別memoryをinactive化する（実装指示§25「完全削除よりinactive推奨」）。
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId } = await params;
  const memoryId = req.nextUrl.searchParams.get("id");
  if (!memoryId) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "id クエリパラメータは必須です。" } }, { status: 400 });
  }
  return withRunAdvisoryMemoryApiContext(req, (deps) => handleDeactivateRunAdvisoryMemory(deps, labId, companyId, memoryId));
}
