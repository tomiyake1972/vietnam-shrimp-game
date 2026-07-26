// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） プレイヤー画面のServer Actions
//
// 【重要】ここではhandlers.ts（Phase 8C-3A・API層）のhandleSaveDraft/handleSubmitDraft/
// handleProcessQuarterを直接呼び出す。ブラウザ→この関数→（Redisへ）という経路であり、
// 同一Next.jsアプリ内での自己HTTP fetchは行わない（指示§7「gratuitous self-HTTP-fetching
// を避ける」）。入力検証・turnId導出・エラー分類はhandlers.ts側の既存ロジックをそのまま
// 再利用し、ここでは重複実装しない。
//
// 【CSRF対策】各Actionの先頭でrequireStagingSession()（セッションCookie検証。無効なら
// ログイン画面へredirect）とassertSameOriginRequest()（Origin/Host一致確認）を行う
// （Server Actions自体の組み込みOrigin検証への多重防御。指示§7）。
//
// 【冪等性】turnIdはここでは一切クライアントから受け取らない。handlers.ts側の
// resolveNewDraftTurnId/resolveInFlightTurnId（turnId.ts）が、現在の永続状態から
// 決定論的に導出する。processQuarterはこの導出turnIdに対してApplication Service層の
// 冪等判定（alreadyProcessed）が働くため、二重送信・応答消失後の再送でも四半期が
// 二重処理されない（指示§10）。

"use server";

import { revalidatePath } from "next/cache";
import { requireStagingSession, assertSameOriginRequest } from "../../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies } from "../_lib/uiDependencies";
import { ApiResult, handleProcessQuarter, handleSaveDraft, handleSubmitDraft, handleWithdrawDraft } from "../../../../api/v2/company-labs/_lib/handlers";

export interface PlayerActionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly message?: string;
}

export interface ProcessQuarterActionResult extends PlayerActionResult {
  readonly quarterStatus?: "processed" | "alreadyProcessed";
}

/**
 * 指示§12のHTTP status → ユーザー向け説明の対応表。handlers.ts/errorResponse.tsが
 * 既に日本語の具体的メッセージを返すため、これは「メッセージ自体が無かった場合」の
 * 保険的フォールバックとしてのみ使う（通常はresult.body.error.messageの方を使う）。
 */
function describeStatusFallback(status: number): string {
  switch (status) {
    case 400:
      return "入力内容を確認してください。";
    case 401:
    case 403:
      return "認証または環境の問題により操作できませんでした。再度ログインしてください。";
    case 404:
      return "対象のラボが見つかりません。";
    case 409:
      return "状態が変化しています。最新の状態を再取得してください。";
    case 422:
      return "入力された意思決定の内容で四半期処理を完了できませんでした。";
    case 423:
      return "他の処理が進行中です。しばらく待って再度お試しください。";
    default:
      return "サーバー内部でエラーが発生しました。時間をおいて再度お試しください。";
  }
}

function toActionResult(result: ApiResult): PlayerActionResult {
  if (result.status >= 200 && result.status < 300) {
    return { ok: true, status: result.status };
  }
  const body = result.body as { error?: { message?: string } } | undefined;
  return { ok: false, status: result.status, message: body?.error?.message ?? describeStatusFallback(result.status) };
}

type GuardResult = { readonly ok: true } | { readonly ok: false; readonly result: PlayerActionResult };

async function guard(): Promise<GuardResult> {
  // 無効なセッションの場合はredirect()が例外として実行を打ち切り、ログイン画面へ
  // 遷移する（指示§11「expired sessionsはre-authenticationへredirect」）。
  await requireStagingSession();
  const origin = await assertSameOriginRequest();
  if (!origin.ok) {
    return { ok: false, result: { ok: false, status: 403, message: "不正なリクエスト元です。ページを再読み込みしてやり直してください。" } };
  }
  return { ok: true };
}

export async function saveDraftAction(labId: string, draft: unknown): Promise<PlayerActionResult> {
  const g = await guard();
  if (!g.ok) return g.result;

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleSaveDraft(deps, labId, { draft }, new Date().toISOString());
  revalidatePath(`/v2/company-lab/play/${labId}`);
  return toActionResult(result);
}

export async function submitDraftAction(labId: string): Promise<PlayerActionResult> {
  const g = await guard();
  if (!g.ok) return g.result;

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleSubmitDraft(deps, labId, new Date().toISOString());
  revalidatePath(`/v2/company-lab/play/${labId}`);
  return toActionResult(result);
}

/**
 * 【Phase 8G】提出取り消し。submitDraftActionのちょうど逆で、ドラフト本体は
 * 変更せずsubmittedAtだけをnullへ戻す。四半期処理が失敗した後（例：営業人員の
 * 配分合計が実在人数を超えているエラー）に、プレイヤーが入力へ戻れるようにする。
 */
export async function withdrawDraftAction(labId: string): Promise<PlayerActionResult> {
  const g = await guard();
  if (!g.ok) return g.result;

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleWithdrawDraft(deps, labId, new Date().toISOString());
  revalidatePath(`/v2/company-lab/play/${labId}`);
  return toActionResult(result);
}

export async function processQuarterAction(labId: string): Promise<ProcessQuarterActionResult> {
  const g = await guard();
  if (!g.ok) return g.result;

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleProcessQuarter(deps, labId, {}, new Date().toISOString());
  revalidatePath(`/v2/company-lab/play/${labId}`);

  const base = toActionResult(result);
  if (base.ok) {
    const body = result.body as { status: "processed" | "alreadyProcessed" };
    return { ...base, quarterStatus: body.status };
  }
  return base;
}
