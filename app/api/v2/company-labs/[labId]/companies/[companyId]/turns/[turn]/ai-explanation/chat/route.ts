import { NextRequest, NextResponse } from "next/server";
import { withAiExplanationApiContext } from "../_lib/withApiContext";
import { handlePostAiExplanationChat } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string; turn: string }> };

// POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation/chat
// — 「Standard AIに質問する」対話機能（Phase 1 MVP）。そのTurnのStandard AI判断について
// 1件の質問へ回答する。Standard AIの意思決定値は一切変更しない（説明専用）。
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "リクエストボディをJSONとして解釈できませんでした。" } }, { status: 400 });
  }
  return withAiExplanationApiContext(req, (deps) =>
    handlePostAiExplanationChat(deps, labId, companyId, turn, body, new Date().toISOString())
  );
}
