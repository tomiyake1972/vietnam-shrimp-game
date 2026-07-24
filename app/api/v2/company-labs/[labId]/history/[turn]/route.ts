import { NextRequest, NextResponse } from "next/server";
import { withApiContext } from "../../../_lib/withApiContext";
import { handleGetHistoryEntry } from "../../../_lib/handlers";

// GET /api/v2/company-labs/[labId]/history/[turn] — 単一履歴エントリ全体取得（診断用。Phase 8C-3A §6.6）。
// 通常の一覧・状態取得とは経路を分離した診断専用route（1件あたり最大約2.5MBになりうる
// pre/postProcessingStateSnapshot・record全体を含む）。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string; turn: string }> }): Promise<NextResponse> {
  const { labId, turn } = await params;
  return withApiContext(req, (deps) => handleGetHistoryEntry(deps, labId, turn));
}
