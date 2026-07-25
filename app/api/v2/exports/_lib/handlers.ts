// ShrimpX V2 — 読み取り専用エクスポートAPI（/api/v2/exports/**） ハンドラー
//
// 各関数は CompanyLabExportApiDependencies（読み取り専用リポジトリ＋監査ログ）だけを
// 受け取り、例外を投げず ApiResult（{status, body}）を返す（既存の
// app/api/v2/company-labs/_lib/handlers.ts と同じ契約）。ドメインエラーは既存の
// mapDomainErrorToHttp をそのまま再利用する（このマッピング自体は書き込み系操作に
// 依存しない、エラー分類ロジックのみ）。

import { CompanyLabExportApiDependencies } from "./dependencies";
import { mapDomainErrorToHttp } from "../../company-labs/_lib/errorResponse";
import { CompanyId } from "../../../../lib/v2/sales/types";
import {
  buildAllCompaniesExportPayload,
  buildCompanyExportPayload,
  buildLabIndexExportPayload,
  buildMarketExportPayload,
} from "./exportDto";

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
export type ApiResult = { readonly status: number; readonly body: unknown };

function badRequest(message: string): ApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

function parseTurn(turnParam: string): number | null {
  const turn = Number(turnParam);
  if (!Number.isInteger(turn) || turn < 1) return null;
  return turn;
}

// ---------------------------------------------------------------------
// GET /api/v2/exports/company-labs/{labId} — ラボindex（作成済みturn一覧・完了状態）
// ---------------------------------------------------------------------

export async function handleExportLabIndex(deps: CompanyLabExportApiDependencies, labId: string, now: string): Promise<ApiResult> {
  try {
    const state = await deps.readOnlyRepository.loadCurrentState(labId);
    const historyIndex = await deps.readOnlyRepository.loadHistoryIndex(labId);
    const body = buildLabIndexExportPayload({ labId, state, historyIndex, generatedAt: now });
    return { status: 200, body };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/exports/company-labs/{labId}/turns/{turn}/companies/{companyId}
// ---------------------------------------------------------------------

export async function handleExportCompanyTurn(
  deps: CompanyLabExportApiDependencies,
  labId: string,
  turnParam: string,
  companyId: string,
  now: string,
): Promise<ApiResult> {
  const turn = parseTurn(turnParam);
  if (turn === null) return badRequest(`turn は1以上の整数である必要があります。受け取った値: ${JSON.stringify(turnParam)}`);
  if (!companyId) return badRequest("companyId は空でない文字列である必要があります。");

  try {
    const entry = await deps.readOnlyRepository.loadHistoryEntry(labId, turn);
    const body = buildCompanyExportPayload({ labId, companyId: companyId as CompanyId, entry, generatedAt: now });
    return { status: 200, body };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/exports/company-labs/{labId}/turns/{turn} — 全社スコープ（GMフルスコープのみ）
// ---------------------------------------------------------------------

export async function handleExportAllCompaniesTurn(
  deps: CompanyLabExportApiDependencies,
  labId: string,
  turnParam: string,
  now: string,
): Promise<ApiResult> {
  const turn = parseTurn(turnParam);
  if (turn === null) return badRequest(`turn は1以上の整数である必要があります。受け取った値: ${JSON.stringify(turnParam)}`);

  try {
    const entry = await deps.readOnlyRepository.loadHistoryEntry(labId, turn);
    const companyIds = entry.record.companySummaries.map((s) => s.companyId);
    const body = buildAllCompaniesExportPayload({ labId, entry, companyIds, generatedAt: now });
    return { status: 200, body };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/exports/company-labs/{labId}/turns/{turn}/market — 市場結果（公開情報）
// ---------------------------------------------------------------------

export async function handleExportMarketTurn(
  deps: CompanyLabExportApiDependencies,
  labId: string,
  turnParam: string,
  now: string,
): Promise<ApiResult> {
  const turn = parseTurn(turnParam);
  if (turn === null) return badRequest(`turn は1以上の整数である必要があります。受け取った値: ${JSON.stringify(turnParam)}`);

  try {
    const entry = await deps.readOnlyRepository.loadHistoryEntry(labId, turn);
    const body = buildMarketExportPayload({ labId, entry, generatedAt: now });
    return { status: 200, body };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}
