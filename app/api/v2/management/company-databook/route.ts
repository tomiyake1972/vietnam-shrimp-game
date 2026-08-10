// ShrimpX V2 — 32Q Management Console Phase 9: PLAYER Company Databook（Excel生成route）
//
// 【なぜサーバー側が要るか】Excel生成本体（buildCompanyExportExcelWorkbook、
// companyLabAdminExcelBuilder.ts）は node:child_process（git情報取得。取得失敗しても
// 例外は投げない）に依存しており、ブラウザでは実行できない。
// 一方、Management ConsoleのSimulationSessionはブラウザのメモリ（liveSessionRegistry）
// にしか無く、サーバー側のRedis・Repositoryには（resumePayloadとして保存されたRun以外は）
// 存在しない。そのため、このrouteはRedis・Repositoryへは一切触れず、クライアントが
// 自分のSimulationSessionから組み立てて送ってきたCompanyLabQuarterHistoryEntry
// 一式をそのまま使ってExcelを生成するだけの、状態を持たない変換routeにする
// （＝ゲーム状態の作成・更新・削除は一切行わない）。
//
// 【計算ロジックを増やさない】DTO組み立てはbuildCompanyExportPayload
// （app/api/v2/exports/_lib/exportDto.ts＝通常プレイのExport APIと同一関数）を、
// Excel生成はbuildCompanyExportExcelWorkbook（同じくcompanyLabAdminExcelBuilder.ts）を
// そのまま呼ぶ。スコープ隔離（他社の非公開情報を含めない）は両関数の既存の
// フィルタリングにそのまま従う。

import { NextRequest, NextResponse } from "next/server";
import { buildCompanyExportPayload } from "../../exports/_lib/exportDto";
import { buildCompanyExportExcelWorkbook } from "../../../../lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder";
import { CompanyLabQuarterHistoryEntry } from "../../../../lib/v2/companyLab/persistence/types";
import { CompanyFixture } from "../../../../lib/v2/companyLab/types";
import { isProduction } from "../../../../lib/env";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface CompanyDatabookRequestBody {
  readonly simulationRunId: string;
  readonly companyId: string;
  readonly entry: CompanyLabQuarterHistoryEntry;
  readonly fixtures: readonly CompanyFixture[];
}

function errorResponse(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 【指示E】Management Consoleは本番環境では使わないテスト用画面である
  // （既存のadmin export-downloadルートと同じ方針）。
  if (isProduction) {
    return errorResponse(403, "本番環境では利用できません。");
  }

  let body: CompanyDatabookRequestBody;
  try {
    body = (await req.json()) as CompanyDatabookRequestBody;
  } catch {
    return errorResponse(400, "リクエストボディがJSONとして解釈できません。");
  }

  const { simulationRunId, companyId, entry, fixtures } = body;
  if (typeof simulationRunId !== "string" || simulationRunId.length === 0) {
    return errorResponse(400, "simulationRunId が指定されていません。");
  }
  if (typeof companyId !== "string" || companyId.length === 0) {
    return errorResponse(400, "companyId が指定されていません。");
  }
  if (!entry || typeof entry !== "object") {
    return errorResponse(400, "entry（CompanyLabQuarterHistoryEntry）が指定されていません。");
  }
  if (!Array.isArray(fixtures) || !fixtures.some((f) => f.companyId === companyId)) {
    return errorResponse(400, `会社「${companyId}」はこのRunのfixturesに含まれていません。`);
  }
  if (entry.playerSubmission?.companyId !== companyId) {
    return errorResponse(400, "entry.playerSubmission が指定されたcompanyIdと一致しません。");
  }

  try {
    const payload = buildCompanyExportPayload({
      labId: simulationRunId,
      companyId,
      entry,
      generatedAt: new Date().toISOString(),
      fixtures,
    });
    // 【指示B】単一Turn分のDatabook（このRun・このTurn・この会社）を出力する。
    // 通常プレイの「これまでの全Turn履歴を含むtrend付きDatabook」とは異なり、
    // ここではhistory引数を渡さない（Management Console側は他ターンのpayloadを
    // 別途保持していないため、無いものを捏造しない）。
    const buffer = await buildCompanyExportExcelWorkbook(payload);
    const fileName = `ShrimpX_${companyId}_Turn${entry.turn}_Databook.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    console.error("[company-databook] Excel生成に失敗しました:", e);
    return errorResponse(500, "Excelの生成中にエラーが発生しました。");
  }
}
