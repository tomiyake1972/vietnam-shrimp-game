import { NextRequest, NextResponse } from "next/server";
import { withAiExplanationApiContext } from "../ai-explanation/_lib/withApiContext";
import { handleDeleteAdvisorConversation, handleGetAdvisorConversation, handlePostAdvisor } from "./_lib/handlers";

/**
 * 【Vercel Functionのタイムアウト（品質強化Batch 1・§1）】
 * Next.js App Routerでは、route segmentごとに `maxDuration`（秒）をexportすると
 * Vercel Function のタイムアウトになる。既定値は相談役AIの所要時間より短く、
 * これを設定しないとサーバー側timeout(120秒)・全体予算(150秒)に到達する前に
 * Functionごと切られる。
 *
 * 【この機能だけに効く】route segment単位の設定であり、
 * Explanation / Standard AI Q&A のrouteには影響しない。
 *
 * 【注意】この値はプランの上限を超えるとビルドが失敗する。プレビューデプロイの
 * ビルド成否で実際に検証すること（想像で決めない）。
 *
 * 【なぜ定数をimportせずリテラルで書くか】route segment configはビルド時に
 * 静的解析される。importした値は解析できず設定が効かないため、必ずリテラルで書く。
 * 値の根拠は advisorClient.ts の ADVISOR_FUNCTION_MAX_DURATION_SECONDS のコメントを参照。
 */
export const maxDuration = 240;

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
