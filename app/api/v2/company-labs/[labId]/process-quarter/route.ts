import { NextRequest, NextResponse } from "next/server";
import { withApiContext, parseJsonBody } from "../../_lib/withApiContext";
import { handleProcessQuarter } from "../../_lib/handlers";

// POST /api/v2/company-labs/[labId]/process-quarter — 四半期処理（Phase 8C-3A §6.5）。
export async function POST(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  const body = await parseJsonBody(req);
  return withApiContext(req, (deps) => handleProcessQuarter(deps, labId, body, new Date().toISOString()));
}
