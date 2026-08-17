import { NextRequest, NextResponse } from "next/server";
import { withRunAiMeetingApiContext } from "./_lib/context";
import { handleGetRunAiMeetingConversation, handlePostRunAiMeetingMessage, PostRunAiMeetingRequestBody } from "./_lib/handlers";

type RouteParams = { params: Promise<{ simulationRunId: string; companyId: string; turn: string }> };

// POST /api/v2/simulation-runs/[simulationRunId]/companies/[companyId]/turns/[turn]/ai-meeting/messages
// — Management Console の Simulation Run で進行中の会社について、プレイヤー発言を送信し
// AI Management Meeting の構造化応答を生成する。会社状態はサーバー側が保存済み Run から
// 読むため、client は数値を一切送らない。ゲーム状態は一切変更しない
// （company-labs 側の同名 route と同じ AI Management Meeting service を通る）。
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { simulationRunId, companyId, turn } = await params;
  let body: PostRunAiMeetingRequestBody;
  try {
    body = (await req.json()) as PostRunAiMeetingRequestBody;
  } catch {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "リクエストボディがJSONとして解釈できません。" } }, { status: 400 });
  }
  return withRunAiMeetingApiContext(req, (deps) => handlePostRunAiMeetingMessage(deps, simulationRunId, companyId, turn, body));
}

// GET /api/v2/simulation-runs/[simulationRunId]/companies/[companyId]/turns/[turn]/ai-meeting/messages?meetingId=...
// — 読み取り専用。既存の会話状態を返す。副作用なし（Claudeは呼ばない）。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { simulationRunId, companyId } = await params;
  const meetingId = req.nextUrl.searchParams.get("meetingId");
  if (!meetingId) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "meetingId クエリパラメータは必須です。" } }, { status: 400 });
  }
  return withRunAiMeetingApiContext(req, (deps) => handleGetRunAiMeetingConversation(deps, simulationRunId, companyId, meetingId));
}
