// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 データ取得元
//
// 【設計方針・三宅さんの指示への対応】
//   - このモジュールだけがSTAGING_EXPORT_TOKENを読み取り、Authorizationヘッダーを
//     組み立てる（サーバー側だけで完結する）。ブラウザ・クライアントコンポーネント
//     へはトークンはもちろん、このモジュール自体も一切公開しない
//     （app/api/v2/admin/export-download/**のroute.tsからのみ呼ぶ）。
//   - 既存の読み取り専用Export API（/api/v2/exports/**）を、データ取得の唯一の
//     正式な境界として使う。Redis・CompanyLabStateRepository・CompanyLabReadOnlyRepository
//     等へは本モジュールから一切importしない（importしていないこと自体がtsc上で
//     確認できる）。
//   - 取得結果・エラーメッセージのいずれにも、トークン値・Authorizationヘッダーの
//     値を一切含めない。

import { isProduction } from "../../../env";

export type CompanyLabAdminExportFailureReason =
  | "productionDisabled"
  | "secretNotConfigured"
  | "labNotFound"
  | "turnNotConfirmed"
  | "companyNotFound"
  | "upstreamError";

export interface CompanyLabAdminExportFailure {
  readonly ok: false;
  readonly reason: CompanyLabAdminExportFailureReason;
  /** 三宅さん向けの分かりやすい日本語メッセージ（内部エラーコード・スタックトレースは含めない）。 */
  readonly userMessage: string;
}

export interface CompanyLabAdminExportSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /** 監査・manifest記載用。実際にfetchしたExport APIのパス（クエリ・ヘッダーは含めない）。 */
  readonly sourcePath: string;
}

export type CompanyLabAdminExportResult<T> = CompanyLabAdminExportSuccess<T> | CompanyLabAdminExportFailure;

function failure(reason: CompanyLabAdminExportFailureReason, userMessage: string): CompanyLabAdminExportFailure {
  return { ok: false, reason, userMessage };
}

/**
 * STAGING_EXPORT_TOKENが利用可能かどうかだけを返す（値は一切返さない）。
 * Production環境では常にfalse（isProductionの判定源はapp/lib/env.ts、他の
 * fail-closed判定と共通）。
 */
export function isExportSecretAvailable(): boolean {
  if (isProduction) return false;
  return Boolean(process.env.STAGING_EXPORT_TOKEN);
}

/**
 * 呼び出し前の一括ガード。Production・Secret未設定を、実際にfetchする前に
 * 弾いておくためのヘルパー（呼び出し側で毎回同じチェックを重複させない）。
 */
export function checkAdminExportPreconditions(): CompanyLabAdminExportFailure | null {
  if (isProduction) {
    return failure("productionDisabled", "この機能は本番環境では利用できません。");
  }
  if (!process.env.STAGING_EXPORT_TOKEN) {
    return failure("secretNotConfigured", "Export用Secret（STAGING_EXPORT_TOKEN）がこの環境に設定されていないため、エクスポートできません。Vercelの環境変数設定をご確認ください。");
  }
  return null;
}

async function fetchExportJson<T>(origin: string, path: string): Promise<CompanyLabAdminExportResult<T>> {
  const precondition = checkAdminExportPreconditions();
  if (precondition) return precondition;

  const token = process.env.STAGING_EXPORT_TOKEN as string; // checkAdminExportPreconditionsで存在確認済み
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    // ネットワークエラー等。トークン値・Authorizationヘッダーの値は例外オブジェクトにも
    // 含まれないため、そのままログへ出しても安全だが、ユーザー向けメッセージは定型文にする。
    return failure("upstreamError", "Export APIへの接続に失敗しました。時間をおいて再度お試しください。");
  }

  if (response.status === 404) {
    // このAPI設計では、ラボ不存在・turn未確定のいずれも404（LAB_NOT_FOUND / HISTORY_ENTRY_NOT_FOUND）。
    // 呼び出し側（route.ts）が、どちらの404かを文脈で判断してより具体的なメッセージへ差し替える。
    return failure("upstreamError", "指定したデータが見つかりませんでした（Lab未存在またはTurn未確定の可能性があります）。");
  }
  if (response.status === 403) {
    // 通常は起こらない想定（トークンはこのモジュールが正しく組み立てる）が、万一の
    // トークン不一致・Production誤判定等に備えて汎用メッセージにする。
    return failure("secretNotConfigured", "Export APIの認証に失敗しました。STAGING_EXPORT_TOKENの設定をご確認ください。");
  }
  if (!response.ok) {
    return failure("upstreamError", `Export APIがエラーを返しました（status ${response.status}）。`);
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    return failure("upstreamError", "Export APIの応答を解析できませんでした。");
  }
  return { ok: true, data, sourcePath: path };
}

export interface CompanyLabAdminExportLabIndex {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly labId: string;
  readonly engineVersion: string;
  readonly dataStatus: string;
  readonly playerCompanyId: string;
  readonly availableTurns: readonly number[];
  readonly latestProcessedTurn: number | null;
}

export async function fetchLabIndex(origin: string, labId: string): Promise<CompanyLabAdminExportResult<CompanyLabAdminExportLabIndex>> {
  const result = await fetchExportJson<CompanyLabAdminExportLabIndex>(origin, `/api/v2/exports/company-labs/${encodeURIComponent(labId)}`);
  if (!result.ok && result.reason === "upstreamError" && result.userMessage.includes("見つかりませんでした")) {
    return failure("labNotFound", "指定したLab（labId）が見つかりませんでした。IDをご確認ください。");
  }
  return result;
}

export async function fetchCompanyTurnExport(origin: string, labId: string, turn: number, companyId: string): Promise<CompanyLabAdminExportResult<unknown>> {
  const result = await fetchExportJson<unknown>(
    origin,
    `/api/v2/exports/company-labs/${encodeURIComponent(labId)}/turns/${encodeURIComponent(String(turn))}/companies/${encodeURIComponent(companyId)}`,
  );
  if (!result.ok && result.reason === "upstreamError" && result.userMessage.includes("見つかりませんでした")) {
    return failure("turnNotConfirmed", `Turn ${turn} はまだ確定していません（未処理の可能性があります）。`);
  }
  return result;
}

export async function fetchAllCompaniesTurnExport(origin: string, labId: string, turn: number): Promise<CompanyLabAdminExportResult<unknown>> {
  const result = await fetchExportJson<unknown>(origin, `/api/v2/exports/company-labs/${encodeURIComponent(labId)}/turns/${encodeURIComponent(String(turn))}`);
  if (!result.ok && result.reason === "upstreamError" && result.userMessage.includes("見つかりませんでした")) {
    return failure("turnNotConfirmed", `Turn ${turn} はまだ確定していません（未処理の可能性があります）。`);
  }
  return result;
}

export async function fetchMarketTurnExport(origin: string, labId: string, turn: number): Promise<CompanyLabAdminExportResult<unknown>> {
  const result = await fetchExportJson<unknown>(origin, `/api/v2/exports/company-labs/${encodeURIComponent(labId)}/turns/${encodeURIComponent(String(turn))}/market`);
  if (!result.ok && result.reason === "upstreamError" && result.userMessage.includes("見つかりませんでした")) {
    return failure("turnNotConfirmed", `Turn ${turn} はまだ確定していません（未処理の可能性があります）。`);
  }
  return result;
}
