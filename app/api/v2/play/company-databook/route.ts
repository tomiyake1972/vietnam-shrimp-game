// ShrimpX V2 — Independent Player Flow: 受講者自身の会社Databook（Excel生成route）
//
// 【なぜ必要か】GMが管制室から入る個社オペレーション画面（/v2/management/player）には
// 「会社Databook」のダウンロードがあるが、受講者が参加リンクから入る画面には無く、
// 同じ会社の同じ情報を受講者が取り出せなかった（2026-11 テストプレイで指摘）。
//
// 【GM側routeをそのまま使えない理由】/api/v2/management/company-databook は、
// ブラウザのメモリにしか無いGMのSimulationSessionから組み立てた
// CompanyLabQuarterHistoryEntry をクライアントが送ってくる前提の変換routeである。
// 受講者の画面はSimulationSessionを持たない（PlayerDecisionContextという
// 絞り込み済みDTOしか持たない）ため、同じ入力を作れない。そこでこのrouteは
// サーバー側で保存済みRunを読み、resumePayloadからセッションを復元してから
// 同じ組み立て関数を呼ぶ。
//
// 【計算ロジックを増やさない】entry組み立ては buildCompanyDatabookQuarterEntry、
// DTOは buildCompanyExportPayload、Excel生成は buildCompanyExportExcelWorkbook と、
// いずれもGM側・通常プレイと同一の関数をそのまま呼ぶ。スコープ隔離（他社の
// 非公開情報を含めない）も既存のフィルタリングにそのまま従う。
//
// 【対象会社はCookieからのみ決める】companyId はリクエストから受け取らず、
// Player session（PlayerRepository.loadSession）が持つ companyId だけを使う。
// 他社のDatabookは原理的に要求できない（play API 共通の原則）。

import { NextResponse } from "next/server";
import { resolvePlayerApiContext } from "../_lib/context";
import { buildCompanyDatabookQuarterEntry, DatabookNotAvailableError } from "../../../../v2/management/lib/companyDatabookPayload";
import { restoreSessionFromResumePayload } from "../../../../lib/v2/companyLab/simulation/persistence/resume";
import { buildCompanyExportPayload } from "../../exports/_lib/exportDto";
import { buildCompanyExportExcelWorkbook } from "../../../../lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** POST /api/v2/play/company-databook — 自分の会社ぶんだけのDatabook（xlsx）。 */
export async function POST(): Promise<NextResponse> {
  const auth = await resolvePlayerApiContext();
  if (!auth.ok) return NextResponse.json(auth.result.body, { status: auth.result.status });

  const { session: playerSession, simulationRunRepository } = auth.context;
  const stored = await simulationRunRepository.loadRun(playerSession.runId);
  if (!stored) {
    return errorResponse(404, "RUN_NOT_FOUND", "この Simulation Run は見つかりません。");
  }
  if (!stored.resumePayload) {
    return errorResponse(409, "RESUME_PAYLOAD_MISSING", "このRunには続きからプレイするための保存物がないため、Databookを作れません。");
  }

  try {
    const session = restoreSessionFromResumePayload(stored.run, stored.resumePayload, stored.packCapture, stored.dataset);
    const entry = buildCompanyDatabookQuarterEntry(session, playerSession.companyId);
    const payload = buildCompanyExportPayload({
      labId: stored.run.simulationRunId,
      companyId: playerSession.companyId,
      entry,
      generatedAt: new Date().toISOString(),
      fixtures: session.fixtures,
    });
    const buffer = await buildCompanyExportExcelWorkbook(payload);
    const fileName = `ShrimpX_${playerSession.companyId}_Turn${entry.turn}_Databook.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof DatabookNotAvailableError) {
      return errorResponse(409, "DATABOOK_NOT_AVAILABLE", e.message);
    }
    console.error("[play company-databook] Excel生成に失敗しました:", e);
    return errorResponse(500, "INTERNAL_ERROR", "Excelの生成中にエラーが発生しました。");
  }
}
