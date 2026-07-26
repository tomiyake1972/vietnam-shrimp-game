import { NextRequest, NextResponse } from "next/server";
import { withApiContext } from "../../../_lib/withApiContext";
import { handleWithdrawDraft } from "../../../_lib/handlers";

// POST /api/v2/company-labs/[labId]/draft/withdraw — 提出取り消し（Phase 8G）。
// submitのちょうど逆で、ドラフト本体は変更せずsubmittedAtだけをnullへ戻す。
export async function POST(req: NextRequest, { params }: { params: Promise<{ labId: string }> }): Promise<NextResponse> {
  const { labId } = await params;
  return withApiContext(req, (deps) => handleWithdrawDraft(deps, labId, new Date().toISOString()));
}
