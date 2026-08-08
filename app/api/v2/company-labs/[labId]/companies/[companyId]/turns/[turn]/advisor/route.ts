import { NextRequest, NextResponse } from "next/server";
import { withAiExplanationApiContext } from "../ai-explanation/_lib/withApiContext";
import { handleDeleteAdvisorConversation, handleGetAdvisorConversation, handlePostAdvisor } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string; turn: string }> };

// POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/advisor
// — 相談役AI（Game Owner Mode）。ゲーム状態・Standard AI・正式仕様・開発背景を参照して
// 自由な経営相談に答える。ゲーム状態・意思決定は一切変更しない（read-only）。
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "リクエストボディをJSONとして解釈できませんでした。" } }, { status: 400 });
  }
  return withAiExplanationApiContext(req, (deps) => handlePostAdvisor(deps, labId, companyId, turn, body, new Date().toISOString()));
}

// GET — 保存済み会話の復元（副作用なし）。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  return withAiExplanationApiContext(req, (deps) => handleGetAdvisorConversation(deps, labId, companyId, turn));
}

// DELETE — 会話の消去（clear conversation）。
export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  return withAiExplanationApiContext(req, (deps) => handleDeleteAdvisorConversation(deps, labId, companyId, turn, new Date().toISOString()));
}
