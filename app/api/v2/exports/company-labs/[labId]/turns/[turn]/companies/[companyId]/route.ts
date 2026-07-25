import { NextRequest, NextResponse } from "next/server";
import { withExportApiContext } from "../../../../../../_lib/withExportApiContext";
import { handleExportCompanyTurn } from "../../../../../../_lib/handlers";

// GET /api/v2/exports/company-labs/[labId]/turns/[turn]/companies/[companyId] — 会社スコープ。
// 指定した1社ぶんのfinancialResult/financingResult/capexResult/companySummaryのみを
// 返す（financialViewSelectors.tsの抽出関数をそのまま再利用。他社の
// otherCompaniesDecisions等は一切参照しない）。
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ labId: string; turn: string; companyId: string }> },
): Promise<NextResponse> {
  const { labId, turn, companyId } = await params;
  return withExportApiContext(
    req,
    {
      route: "GET /api/v2/exports/company-labs/[labId]/turns/[turn]/companies/[companyId]",
      labId,
      turn: Number(turn) || null,
      companyIdScope: companyId,
      scope: "company",
    },
    (deps, now) => handleExportCompanyTurn(deps, labId, turn, companyId, now),
  );
}
