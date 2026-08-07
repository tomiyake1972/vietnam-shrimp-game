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

/**
 * Vercelの「Deployment Protection」は、Preview環境の全ルート（このRoute Handler自身が
 * 発行するサーバー→サーバーの自己fetchも含む）を対象に認証を要求する。ブラウザ側は
 * 三宅さんが一度SSO/共有リンクで認証すればCookieにより通過できるが、サーバー内部で
 * 発行するfetch（このモジュール）は別リクエストとして扱われ、そのままではVercel側の
 * 認証ページ（HTML）が返り、Export APIのJSONとして解析できずに失敗する。
 *
 * Vercelが公式に提供する回避策が「Protection Bypass for Automation」で、有効化すると
 * VERCEL_AUTOMATION_BYPASS_SECRETが環境変数として自動的に払い出される。このモジュールは
 * その値をサーバー側だけで読み取り、x-vercel-protection-bypassヘッダーとして自己fetchへ
 * 添付する。STAGING_EXPORT_TOKENと同じ扱い（ブラウザ・URL・ログへは一切出さない）。
 * 未設定の場合は単にヘッダーを付けない（Deployment Protectionが無効な環境、または
 * まだ有効化されていない環境でも従来通り動作する）。
 */
function buildProtectionBypassHeaders(): Record<string, string> {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!bypassSecret) return {};
  // x-vercel-set-bypass-cookieは付けない: このヘッダーを付けるとVercelがCookie設定用の
  // リダイレクトを返すことがあり、Cookieを保持しない一回限りのサーバー間fetchでは
  // そのリダイレクトが解消されず「redirect count exceeded」で失敗する（実機検証で確認）。
  // このモジュールは1リクエストごとにbypassヘッダーを毎回付け直すため、Cookieによる
  // 継続は不要。
  return { "x-vercel-protection-bypass": bypassSecret };
}

async function fetchExportJson<T>(origin: string, path: string): Promise<CompanyLabAdminExportResult<T>> {
  const precondition = checkAdminExportPreconditions();
  if (precondition) return precondition;

  const token = process.env.STAGING_EXPORT_TOKEN as string; // checkAdminExportPreconditionsで存在確認済み
  const targetUrl = `${origin}${path}`;
  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, ...buildProtectionBypassHeaders() },
      cache: "no-store",
    });
  } catch (err) {
    // ネットワークエラー等。トークン値・Authorizationヘッダーの値は例外オブジェクトにも
    // 含まれないため、そのままログへ出しても安全だが、ユーザー向けメッセージは定型文にする。
    // 運用調査用ログ（URL・エラーメッセージ・causeのみ。トークン値は含まない）。将来の
    // 自己fetch障害（例: リダイレクトループ、DNS等）の切り分けに使う。
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    console.error("[companyLabAdminExportSource] self-fetch failed", {
      targetUrl,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      causeName: cause instanceof Error ? cause.name : typeof cause,
      causeMessage: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
      causeCode: cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined,
    });
    return failure("upstreamError", "Export APIへの接続に失敗しました。時間をおいて再度お試しください。");
  }

  if (response.status === 401) {
    // Vercelの Deployment Protection がこの自己fetch自体を認証要求ページ（HTML）で
    // ブロックしている可能性が高い（Export API自体はSTAGING_EXPORT_TOKENのみで認証する
    // 設計であり、401を自ら返すことはない）。VERCEL_AUTOMATION_BYPASS_SECRETが未設定・
    // 無効な場合にここに到達する。
    return failure("upstreamError", "この環境のデプロイ保護（Deployment Protection）により、サーバー内部からのデータ取得がブロックされています。Vercelプロジェクト設定の「Protection Bypass for Automation」を有効にしてください。");
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
