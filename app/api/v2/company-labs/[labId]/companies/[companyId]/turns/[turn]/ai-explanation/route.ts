import { NextRequest, NextResponse } from "next/server";
import { withAiExplanationApiContext } from "./_lib/withApiContext";
import { handleGetAiExplanation, handlePostAiExplanation } from "./_lib/handlers";

type RouteParams = { params: Promise<{ labId: string; companyId: string; turn: string }> };

// POST /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation
// — Standard AIの提案・診断情報から経営説明レポート（日本語）を生成する。既にキャッシュ
// 済みのレポートがあればClaudeを呼び直さずそれを返す（MVP §7）。
export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  return withAiExplanationApiContext(req, (deps) => handlePostAiExplanation(deps, labId, companyId, turn, new Date().toISOString()));
}

// GET /api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation
// — 読み取り専用。キャッシュ済みのレポートがあれば返す（副作用なし。Claudeは呼ばない）。
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { labId, companyId, turn } = await params;
  return withAiExplanationApiContext(req, (deps) => handleGetAiExplanation(deps, labId, companyId, turn));
}
