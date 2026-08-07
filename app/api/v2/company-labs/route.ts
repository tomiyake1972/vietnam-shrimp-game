import { NextRequest, NextResponse } from "next/server";
import { withApiContext, parseJsonBody } from "./_lib/withApiContext";
import { handleCreateLab, handleListLabs } from "./_lib/handlers";

// POST /api/v2/company-labs — ラボ作成（Phase 8C-3A §6.1）。
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJsonBody(req);
  return withApiContext(req, (deps) => handleCreateLab(deps, body, new Date().toISOString()));
}

// GET /api/v2/company-labs — ラボ一覧取得（Phase 8C-3A §6.2）。
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withApiContext(req, (deps) => handleListLabs(deps));
}
