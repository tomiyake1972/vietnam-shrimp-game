import { NextRequest, NextResponse } from "next/server";
import { withApiContext } from "../_lib/withApiContext";
import { handleGetLabState } from "../_lib/handlers";

// GET /api/v2/company-labs/[labId] — ラボ状態取得（Phase 8C-3A §6.2）。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  return withApiContext(req, (deps) => handleGetLabState(deps, labId));
}
