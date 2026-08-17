import { NextRequest, NextResponse } from "next/server";
import { withAiMeetingApiContext } from "../messages/_lib/withApiContext";
import { handleGetOpeningBrief } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string; turn: string }> };

// GET /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/opening-brief
// — Turn開始時のOpening Executive Brief（CEOによる前四半期からの変化の短い要約）を
// 返す（AMM-M2.7）。副作用は会話artifactへの追記のみ（Game SSoTは一切変更しない）。
// 同一turnで既に生成済みなら、Claudeを再度呼ばずキャッシュを返す。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  return withAiMeetingApiContext(req, (deps) => handleGetOpeningBrief(deps, labId, companyId, turn));
}
