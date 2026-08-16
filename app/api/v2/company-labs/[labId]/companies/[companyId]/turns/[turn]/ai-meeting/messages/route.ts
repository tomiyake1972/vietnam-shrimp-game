import { NextRequest, NextResponse } from "next/server";
import { withAiMeetingApiContext } from "./_lib/withApiContext";
import { handleGetAiMeetingConversation, handlePostAiMeetingMessage, PostAiMeetingRequestBody } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string; turn: string }> };

// POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages
// — プレイヤー発言を送信し、AI Management Meeting（CEO/CFO/COO/Commercial Director）の
// 構造化応答（発言・提案）を生成する（AMM-M0/M1）。ゲーム状態は一切変更しない。
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  let body: PostAiMeetingRequestBody;
  try {
    body = (await req.json()) as PostAiMeetingRequestBody;
  } catch {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "リクエストボディがJSONとして解釈できません。" } }, { status: 400 });
  }
  return withAiMeetingApiContext(req, (deps) => handlePostAiMeetingMessage(deps, labId, companyId, turn, body));
}

// GET /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages?meetingId=...
// — 読み取り専用。既存の会話状態を返す。副作用なし（Claudeは呼ばない）。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId } = await params;
  const meetingId = req.nextUrl.searchParams.get("meetingId");
  if (!meetingId) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "meetingId クエリパラメータは必須です。" } }, { status: 400 });
  }
  return withAiMeetingApiContext(req, (deps) => handleGetAiMeetingConversation(deps, labId, companyId, meetingId));
}
