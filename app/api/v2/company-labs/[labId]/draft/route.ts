import { NextRequest, NextResponse } from "next/server";
import { withApiContext, parseJsonBody } from "../../_lib/withApiContext";
import { handleSaveDraft } from "../../_lib/handlers";

// PUT /api/v2/company-labs/[labId]/draft — ドラフト保存（Phase 8C-3A §6.3）。
export async function PUT(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  const body = await parseJsonBody(req);
  return withApiContext(req, (deps) => handleSaveDraft(deps, labId, body, new Date().toISOString()));
}
