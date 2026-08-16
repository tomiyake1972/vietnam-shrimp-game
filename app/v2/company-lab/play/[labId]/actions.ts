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
import { unstable_rethrow } from "next/navigation";
import { requireStagingSession, assertSameOriginRequest } from "../../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies } from "../_lib/uiDependencies";
import { resolveAiExplanationUiDependencies } from "../_lib/aiExplanationUiDependencies";
import { resolveAiMeetingUiDependencies } from "../_lib/aiMeetingUiDependencies";
import { ApiResult, handleProcessQuarter, handleSaveDraft, handleSubmitDraft, handleWithdrawDraft } from "../../../../api/v2/company-labs/_lib/handlers";
import { handlePostAiExplanation } from "../../../../api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-explanation/_lib/handlers";
import {
  handleGetAiMeetingConversation,
  handlePostAiMeetingMessage,
} from "../../../../api/v2/company-labs/[labId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";
import { StandardAiManagementReport } from "../../../../lib/v2/companyLab/aiExplanation/reportSchema";
import {
  AiMeetingCallDiagnostics,
  AiMeetingIntent,
  AiMeetingMessage,
  ValidatedAiMeetingProposal,
} from "../../../../lib/v2/companyLab/aiManagementMeeting/types";

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

// ---------------------------------------------------------------------
// Standard AI経営説明レポート機能（MVP）— Claudeが生成した経営説明の取得
// ---------------------------------------------------------------------
//
// 【方式選択の理由】このServer Actionは、既存のsaveDraftAction等と全く同じ配線
// （requireStagingSession→resolveCompanyLabUiDependencies同様のUI用依存関係解決
// →handlers.tsの既存ハンドラーを直接呼ぶ）に揃えている。ブラウザからこの機能専用の
// 自己HTTP fetchは一切行わない（指示§7の既存方針を踏襲。ANTHROPIC_API_KEY等の
// 秘密情報はサーバー側の環境変数からのみ読まれ、クライアントへは一切渡らない）。
// handlePostAiExplanation自体は「キャッシュ済みならClaudeを呼び直さない」という
// 冪等性を既に持つため、この関数はPOST（生成トリガー）をそのまま呼べばよい。
//
// 【2026-08-01・本番Preview手動観察テストで発見された無限ローディングの事後対応】
// 従来はguard()の呼び出しがtry/catchの外側にあった。requireStagingSession()は
// セッションが無効な場合にNext.jsのredirect()（NEXT_REDIRECT digestを持つ特殊な
// 例外）を投げる。このActionはuseEffect（フォーム送信でもuseTransitionでもない
// 生の関数呼び出し）から起動されており、他のAction（save/submit/process/withdraw、
// いずれもクリックハンドラー→startXxxTransition経由）とは呼び出し経路が異なる。
// 直接の再現はできていないが、redirect()の特殊例外がこの呼び出し経路上で
// 期待どおりに伝播せず、呼び出し元のPromiseが解決も棄却もされずに無期限へ
// 保留され続ける、という筋が最も疑わしい（Vercelランタイムログにcatchブロックの
// console.errorが一切出ていない＝例外としてこのActionへ届いていない、という
// 観察と整合する）。対策として:
//   (1) guard()も含めてActionの全体をtry/catchで包む。
//   (2) catchの先頭でunstable_rethrow(e)を呼び、redirect()等Next.js内部の
//       制御用例外だけは握りつぶさずそのまま再送出する（本来のログイン誘導動作を
//       壊さない）。それ以外の例外だけを「構造化された失敗」に変換する。
//   (3) 呼び出し元（PlayerScreenClient.tsx）側にも、Promise.raceによる
//       クライアント側タイムアウトを追加し、万一この経路が今後も予期せぬ形で
//       ハングした場合の二重防御とする。

export interface AiExplanationActionResult {
  readonly ok: boolean;
  readonly report?: StandardAiManagementReport;
  readonly errorCategory?: string;
}

export async function fetchAiExplanationAction(labId: string, companyId: string, turn: number): Promise<AiExplanationActionResult> {
  const logPrefix = `[fetchAiExplanationAction] lab=${labId} company=${companyId} turn=${turn}`;
  console.log(`${logPrefix} 呼び出し開始`);
  try {
    const g = await guard();
    if (!g.ok) {
      console.log(`${logPrefix} guard()で拒否されました（未認証またはOrigin不一致）`);
      return { ok: false, errorCategory: "unauthorized" };
    }
    console.log(`${logPrefix} guard()通過`);

    const deps = await resolveAiExplanationUiDependencies();
    console.log(`${logPrefix} 依存関係解決完了`);

    const result = await handlePostAiExplanation(deps, labId, companyId, String(turn), new Date().toISOString());
    console.log(`${logPrefix} handlePostAiExplanation完了 status=${result.status}`);

    const body = result.body as { result?: "success" | "failure"; report?: StandardAiManagementReport; errorCategory?: string } | undefined;
    if (result.status === 200 && body?.result === "success" && body.report) {
      console.log(`${logPrefix} 成功として返却します`);
      return { ok: true, report: body.report };
    }
    console.log(`${logPrefix} 失敗として返却します category=${body?.errorCategory ?? "unknown"}`);
    return { ok: false, errorCategory: body?.errorCategory ?? "unknown" };
  } catch (e) {
    // 【重要】redirect()・notFound()等、Next.js自身が制御フローとして使う特殊な例外
    // （NEXT_REDIRECT digest等）は、ここで握りつぶさず必ず再送出する。それ以外
    // （依存関係の組み立て失敗・想定外の例外）だけを構造化された失敗として返す。
    unstable_rethrow(e);
    console.error(`${logPrefix} 予期しない例外を捕捉しました:`, e instanceof Error ? e.message : String(e));
    return { ok: false, errorCategory: "internal_error" };
  }
}

// ---------------------------------------------------------------------
// AI Management Meeting（AMM-M0/M1/M1.1）— Decision Studio AuxiliaryPanel向けServer Actions
//
// 【重要】route.ts（app/api/v2/company-labs/.../ai-meeting/messages/route.ts）は
// STAGING_ADMIN_TOKEN（Bearerヘッダー・サーバー専用シークレット）による認証を要求する
// 管理者/テスト用エンドポイントであり、ブラウザから直接fetchすることを想定していない
// （assertStagingAdmin参照）。実プレイヤー画面はfetchAiExplanationActionと同じ設計方針
// （このファイル冒頭のコメント参照：「同一Next.jsアプリ内での自己HTTP fetchは行わない」）
// に従い、route.tsが呼ぶのと同じhandlePostAiMeetingMessage/handleGetAiMeetingConversation
// （AI prompt・role定義・validationロジック本体）をServer Actionから直接呼び出す。
// guard()（実セッション認証・Origin検証）を通過した実プレイヤーのみが呼び出せる。
// ---------------------------------------------------------------------

export interface AiMeetingSendActionResult {
  readonly ok: boolean;
  readonly meetingId?: string;
  readonly messages?: readonly AiMeetingMessage[];
  readonly validatedProposals?: readonly ValidatedAiMeetingProposal[];
  readonly meetingIntent?: AiMeetingIntent | null;
  readonly potentialStrategicChange?: boolean;
  readonly potentialStrategicChangeNote?: string | null;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly diagnostics?: AiMeetingCallDiagnostics;
  readonly errorMessage?: string;
}

export async function sendAiMeetingMessageAction(
  labId: string,
  companyId: string,
  turn: number,
  playerMessage: string,
  meetingId?: string
): Promise<AiMeetingSendActionResult> {
  const logPrefix = `[sendAiMeetingMessageAction] lab=${labId} company=${companyId} turn=${turn}`;
  try {
    const g = await guard();
    if (!g.ok) {
      console.log(`${logPrefix} guard()で拒否されました（未認証またはOrigin不一致）`);
      return { ok: false, errorMessage: "認証に失敗しました。ページを再読み込みしてやり直してください。" };
    }

    const deps = await resolveAiMeetingUiDependencies();
    const result = await handlePostAiMeetingMessage(deps, labId, companyId, String(turn), { meetingId, playerMessage });

    if (result.status !== 200) {
      const body = result.body as { error?: { message?: string } } | undefined;
      console.log(`${logPrefix} 失敗 status=${result.status}`);
      return { ok: false, errorMessage: body?.error?.message ?? describeStatusFallback(result.status) };
    }

    const body = result.body as {
      meetingId: string;
      messages: readonly AiMeetingMessage[];
      validatedProposals: readonly ValidatedAiMeetingProposal[];
      meetingIntent: AiMeetingIntent | null;
      potentialStrategicChange: boolean;
      potentialStrategicChangeNote?: string | null;
      available: boolean;
      unavailableReason?: string;
      diagnostics: AiMeetingCallDiagnostics;
    };
    return {
      ok: true,
      meetingId: body.meetingId,
      messages: body.messages,
      validatedProposals: body.validatedProposals,
      meetingIntent: body.meetingIntent,
      potentialStrategicChange: body.potentialStrategicChange,
      potentialStrategicChangeNote: body.potentialStrategicChangeNote,
      available: body.available,
      unavailableReason: body.unavailableReason,
      diagnostics: body.diagnostics,
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error(`${logPrefix} 予期しない例外を捕捉しました:`, e instanceof Error ? e.message : String(e));
    return { ok: false, errorMessage: "サーバー内部で予期しないエラーが発生しました。ゲームの状態には影響ありません。" };
  }
}

export interface AiMeetingFetchActionResult {
  readonly ok: boolean;
  readonly found: boolean;
  readonly meetingId?: string;
  readonly messages?: readonly AiMeetingMessage[];
  readonly lastValidatedProposals?: readonly ValidatedAiMeetingProposal[];
  readonly errorMessage?: string;
}

export async function fetchAiMeetingConversationAction(labId: string, companyId: string, meetingId: string): Promise<AiMeetingFetchActionResult> {
  const logPrefix = `[fetchAiMeetingConversationAction] lab=${labId} company=${companyId} meetingId=${meetingId}`;
  try {
    const g = await guard();
    if (!g.ok) {
      console.log(`${logPrefix} guard()で拒否されました（未認証またはOrigin不一致）`);
      return { ok: false, found: false, errorMessage: "認証に失敗しました。ページを再読み込みしてやり直してください。" };
    }

    const deps = await resolveAiMeetingUiDependencies();
    const result = await handleGetAiMeetingConversation(deps, labId, companyId, meetingId);

    if (result.status === 404) {
      return { ok: true, found: false };
    }
    if (result.status !== 200) {
      const body = result.body as { error?: { message?: string } } | undefined;
      return { ok: false, found: false, errorMessage: body?.error?.message ?? describeStatusFallback(result.status) };
    }

    const body = result.body as {
      meetingId: string;
      messages: readonly AiMeetingMessage[];
      lastValidatedProposals: readonly ValidatedAiMeetingProposal[];
    };
    return { ok: true, found: true, meetingId: body.meetingId, messages: body.messages, lastValidatedProposals: body.lastValidatedProposals };
  } catch (e) {
    unstable_rethrow(e);
    console.error(`${logPrefix} 予期しない例外を捕捉しました:`, e instanceof Error ? e.message : String(e));
    return { ok: false, found: false, errorMessage: "サーバー内部で予期しないエラーが発生しました。" };
  }
}
