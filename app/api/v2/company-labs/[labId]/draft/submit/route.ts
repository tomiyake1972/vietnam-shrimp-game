import { NextRequest, NextResponse } from "next/server";
import { withApiContext } from "../../../_lib/withApiContext";
import { handleSubmitDraft } from "../../../_lib/handlers";

// POST /api/v2/company-labs/[labId]/draft/submit — ドラフト提出（Phase 8C-3A §6.4）。
export async function POST(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  return withApiContext(req, (deps) => handleSubmitDraft(deps, labId, new Date().toISOString()));
}
