import { NextRequest, NextResponse } from "next/server";
import { withExportApiContext } from "../../../../../_lib/withExportApiContext";
import { handleExportMarketTurn } from "../../../../../_lib/handlers";

// GET /api/v2/exports/company-labs/[labId]/turns/[turn]/market — 市場結果（会社非公開情報を含まない公開データ）。
export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string; turn: string }> }): Promise<NextResponse> {
  const { labId, turn } = await params;
  return withExportApiContext(
    req,
    { route: "GET /api/v2/exports/company-labs/[labId]/turns/[turn]/market", labId, turn: Number(turn) || null, companyIdScope: null, scope: "market" },
    (deps, now) => handleExportMarketTurn(deps, labId, turn, now),
  );
}
