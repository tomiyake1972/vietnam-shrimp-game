// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 ダウンロードroute
//
// 【認証】既存のCompany Lab管理者UIセッション（app/lib/companyLabUiSession.ts、
// STAGING_ADMIN_TOKENから導出した署名付きCookie）を再利用する。ブラウザは
// STAGING_EXPORT_TOKENを一切知らず、送らない。STAGING_EXPORT_TOKENは
// companyLabAdminExportSource.ts内でサーバー側のみが読み取り、Authorizationヘッダーを
// 組み立てる（本route.tsもトークン値には一切触れない）。
//
// 【書き込み権限】本routeはGETのみ。ゲーム状態の作成・更新・削除・初期化・復元を
// 行うコードは一切含まれていない。データ取得はすべて読み取り専用Export API
// （/api/v2/exports/**）経由（companyLabAdminExportSource.ts）であり、Redis・
// CompanyLabStateRepository・CompanyLabReadOnlyRepositoryへは本ファイル・
// 依存モジュールのいずれからも一切importしていない。
//
// 【Production】isProduction時は常に403（checkAdminExportPreconditions経由）。
// さらに、Production環境ではSTAGING_ADMIN_TOKENセッション自体が発行され得ない
// （companyLabUiSession.ts のderiveSessionSecretがisProduction時null）ため、
// 二重に保護されている。

import { NextRequest, NextResponse } from "next/server";
import { hasValidStagingSession } from "../../../../../../lib/companyLabUiSession";
import { isProduction } from "../../../../../../lib/env";
import {
  checkAdminExportPreconditions,
  fetchAllCompaniesTurnExport,
  fetchCompanyTurnExport,
  fetchLabIndex,
  fetchMarketTurnExport,
} from "../../../../../../lib/v2/companyLab/adminExport/companyLabAdminExportSource";
import { buildCompanyLabAdminExportZip } from "../../../../../../lib/v2/companyLab/adminExport/companyLabAdminExportZip";
import {
  buildAllCompaniesExportExcelWorkbook,
  buildCompanyExportExcelWorkbook,
} from "../../../../../../lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder";
import { listCompanyOptionsForUi } from "../../../../../../v2/company-lab/play/_lib/companyOptions";
import type { AllCompaniesExportPayload, CompanyExportPayload } from "../../../../../v2/exports/_lib/exportDto";

type ExportMode = "bundle" | "company" | "all" | "market" | "excel-company" | "excel-industry";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 【Test15】Turn1〜対象Turnまでの履歴をまとめて取得する。
 *
 * 1本でも失敗したらExcel全体を諦める、ということはしない（履歴が欠けても他のシートは
 * 有効なため）。取得できたturnだけを昇順で返し、欠けたturnは単に含めない。
 * 取得は既存の読み取り専用Export API経由のみで、Redis・Repositoryへは触れない。
 */
async function fetchTurnHistory<T>(
  availableTurns: readonly number[],
  upToTurn: number,
  fetchOne: (turn: number) => Promise<{ readonly ok: boolean; readonly data?: unknown }>,
  periodOf: (data: unknown) => string
): Promise<readonly { readonly turn: number; readonly period: string; readonly payload: T }[]> {
  const targets = availableTurns.filter((t) => t <= upToTurn).sort((a, b) => a - b);
  const results = await Promise.all(
    targets.map(async (turn) => {
      try {
        const r = await fetchOne(turn);
        if (!r.ok || r.data === undefined) return null;
        return { turn, period: periodOf(r.data), payload: r.data as T };
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is { turn: number; period: string; payload: T } => r !== null);
}

function periodFromPayload(data: unknown): string {
  const meta = (data as { meta?: { period?: unknown } } | null)?.meta;
  return typeof meta?.period === "string" ? meta.period : "";
}

function xlsxDownloadResponse(buffer: Buffer, fileName: string): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": XLSX_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}

function friendlyErrorPage(status: number, title: string, message: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8" /><title>${title}</title>
<style>body{font-family:Arial,sans-serif;background:#111827;color:#e5e7eb;padding:2rem;}h1{font-size:1.1rem;}p{color:#9ca3af;}</style>
</head><body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function parseMode(value: string | null): ExportMode {
  if (value === "company" || value === "all" || value === "market") return value;
  // 【Test15】Company Lab / Test15画面のボタンから直接xlsxを取得するモード。
  if (value === "excel-company" || value === "excel-industry") return value;
  return "bundle";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ labId: string; turn: string }> }): Promise<NextResponse> {
  if (isProduction) {
    return friendlyErrorPage(403, "本番環境では利用できません", "この機能はstaging/Preview環境専用です。");
  }
  if (!(await hasValidStagingSession())) {
    return NextResponse.redirect(new URL("/v2/company-lab/play/login", req.url));
  }

  const precondition = checkAdminExportPreconditions();
  if (precondition) {
    return friendlyErrorPage(503, "Export用Secretが未設定です", precondition.userMessage);
  }

  const { labId, turn: turnParam } = await params;
  const turn = Number(turnParam);
  if (!Number.isInteger(turn) || turn < 1) {
    return friendlyErrorPage(400, "turnの指定が不正です", "turnは1以上の整数で指定してください。");
  }

  const url = new URL(req.url);
  const origin = url.origin;
  const mode = parseMode(url.searchParams.get("mode"));

  const indexResult = await fetchLabIndex(origin, labId);
  if (!indexResult.ok) {
    return friendlyErrorPage(404, "Labが見つかりません", indexResult.userMessage);
  }
  if (!indexResult.data.availableTurns.includes(turn)) {
    return friendlyErrorPage(409, "Turnが未確定です", `Turn ${turn} はまだ処理・確定されていません。確定済みturn: ${indexResult.data.availableTurns.join(", ") || "(なし)"}`);
  }

  const requestedCompanyId = url.searchParams.get("companyId") ?? indexResult.data.playerCompanyId;
  const knownCompanyIds = new Set(listCompanyOptionsForUi().map((c) => c.companyId));
  if (!knownCompanyIds.has(requestedCompanyId)) {
    return friendlyErrorPage(404, "対象会社が見つかりません", `会社ID「${requestedCompanyId}」はこのラボの会社一覧に存在しません。`);
  }

  const generatedAt = new Date().toISOString();

  if (mode === "company") {
    const result = await fetchCompanyTurnExport(origin, labId, turn, requestedCompanyId);
    if (!result.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", result.userMessage);
    return jsonDownloadResponse(result.data, `${requestedCompanyId}_${labId}_turn${turn}_company.json`);
  }
  if (mode === "all") {
    const result = await fetchAllCompaniesTurnExport(origin, labId, turn);
    if (!result.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", result.userMessage);
    return jsonDownloadResponse(result.data, `${labId}_turn${turn}_all_companies.json`);
  }
  if (mode === "market") {
    const result = await fetchMarketTurnExport(origin, labId, turn);
    if (!result.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", result.userMessage);
    return jsonDownloadResponse(result.data, `${labId}_turn${turn}_market.json`);
  }

  // 【Test15】自社データブック（xlsx直接ダウンロード）。
  if (mode === "excel-company") {
    const result = await fetchCompanyTurnExport(origin, labId, turn, requestedCompanyId);
    if (!result.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", result.userMessage);
    const history = await fetchTurnHistory<CompanyExportPayload>(
      indexResult.data.availableTurns,
      turn,
      (t) => fetchCompanyTurnExport(origin, labId, t, requestedCompanyId),
      periodFromPayload
    );
    try {
      const buffer = await buildCompanyExportExcelWorkbook(result.data as CompanyExportPayload, history);
      return xlsxDownloadResponse(buffer, `Test15_${requestedCompanyId}_Turn${turn}_Databook.xlsx`);
    } catch (e) {
      console.error("[admin export-download] 自社データブックの生成に失敗しました:", e);
      return friendlyErrorPage(500, "ダウンロード生成に失敗しました", "Excelの生成中にエラーが発生しました。時間をおいて再度お試しください。");
    }
  }

  // 【Test15】業界比較ブック（xlsx直接ダウンロード。全5社の非公開意思決定を含む）。
  if (mode === "excel-industry") {
    const result = await fetchAllCompaniesTurnExport(origin, labId, turn);
    if (!result.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", result.userMessage);
    const history = await fetchTurnHistory<AllCompaniesExportPayload>(
      indexResult.data.availableTurns,
      turn,
      (t) => fetchAllCompaniesTurnExport(origin, labId, t),
      periodFromPayload
    );
    try {
      const buffer = await buildAllCompaniesExportExcelWorkbook(result.data as AllCompaniesExportPayload, history);
      return xlsxDownloadResponse(buffer, `Test15_Industry_Turn${turn}.xlsx`);
    } catch (e) {
      console.error("[admin export-download] 業界比較ブックの生成に失敗しました:", e);
      return friendlyErrorPage(500, "ダウンロード生成に失敗しました", "Excelの生成中にエラーが発生しました。時間をおいて再度お試しください。");
    }
  }

  // mode === "bundle"（一括ダウンロード）
  const [companyResult, allResult, marketResult] = await Promise.all([
    fetchCompanyTurnExport(origin, labId, turn, requestedCompanyId),
    fetchAllCompaniesTurnExport(origin, labId, turn),
    fetchMarketTurnExport(origin, labId, turn),
  ]);
  if (!companyResult.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", companyResult.userMessage);
  if (!allResult.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", allResult.userMessage);
  if (!marketResult.ok) return friendlyErrorPage(502, "ダウンロード生成に失敗しました", marketResult.userMessage);

  let zipBuffer: Buffer;
  try {
    zipBuffer = await buildCompanyLabAdminExportZip({
      labId,
      turn,
      companyId: requestedCompanyId,
      generatedAt,
      labIndexJson: indexResult.data,
      companyJson: companyResult.data as CompanyExportPayload,
      allCompaniesJson: allResult.data,
      gmExcelPayload: allResult.data as AllCompaniesExportPayload,
      marketJson: marketResult.data,
      includeExcel: true,
    });
  } catch (e) {
    console.error("[admin export-download] ZIP/Excel生成に失敗しました:", e);
    return friendlyErrorPage(500, "ダウンロード生成に失敗しました", "ZIP/Excelの生成中にエラーが発生しました。時間をおいて再度お試しください。");
  }

  const fileName = `${labId}_${requestedCompanyId}_turn${turn}_export.zip`;
  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}

function jsonDownloadResponse(data: unknown, fileName: string): NextResponse {
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}
