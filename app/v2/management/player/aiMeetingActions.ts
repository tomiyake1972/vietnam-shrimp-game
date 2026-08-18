"use server";

// ShrimpX V2 — PLAYER Company Workspace: AI Management Meeting Server Actions（Simulation Run 経路）
//
// 【自己HTTP fetchはしない】Company Lab 経路の actions.ts と同じ方針で、route.ts が呼ぶのと
// 同じハンドラー（handlePostRunAiMeetingMessage / handleGetRunAiMeetingConversation）を
// Server Action から直接呼ぶ。ANTHROPIC_API_KEY・STAGING_ADMIN_TOKEN 等の秘密情報は
// サーバー側の環境変数からのみ読まれ、クライアントへは一切渡らない。
//
// 【redirect しない】Company Lab 経路は requireStagingSession() でログイン画面へ redirect
// するが、この経路の呼び出し元は Management Console から開いた PLAYER Workspace であり、
// Console 自体はログイン無しでも開ける。会議を開いた瞬間に画面ごとログインへ飛ばすのは
// 挙動として乱暴なので、ここでは hasValidStagingSession()（redirect しない判定）を使い、
// 未ログインならパネル内に理由を出す。
//
// 【client から会社状態を受け取らない】引数は simulationRunId / companyId / turn /
// 発言テキストだけ。会社の数値はサーバー側が保存済み Simulation Run から読む。

import { unstable_rethrow } from "next/navigation";
import { assertSameOriginRequest, hasValidStagingSession } from "../../../lib/companyLabUiSession";
import { readAppEnvV2FromEnv } from "../../../lib/v2/core/version";
import { createDefaultCompanyLabRedisClient } from "../../../lib/v2/redis/companyLabClient";
import { createSimulationRunRepository } from "../../../api/v2/simulation-runs/_lib/context";
import {
  handleGetRunAiMeetingConversation,
  handleGetRunOpeningBrief,
  handlePostRunAiMeetingMessage,
  RunAiMeetingDependencies,
} from "../../../api/v2/simulation-runs/[simulationRunId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";
import { AiMeetingCallDiagnostics, AiMeetingIntent, AiMeetingMessage, OpeningExecutiveBrief, ValidatedAiMeetingProposal } from "../../../lib/v2/companyLab/aiManagementMeeting/types";

const NOT_LOGGED_IN_MESSAGE =
  "AI経営会議を使うには staging 管理ログインが必要です（/v2/company-lab/play/login）。ログイン後、この画面へ戻って再度お試しください。ゲームの状態には影響ありません。";

type GuardResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function guard(): Promise<GuardResult> {
  const session = await hasValidStagingSession();
  if (!session) return { ok: false, message: NOT_LOGGED_IN_MESSAGE };
  const origin = await assertSameOriginRequest();
  if (!origin.ok) return { ok: false, message: "不正なリクエスト元です。ページを再読み込みしてやり直してください。" };
  return { ok: true };
}

async function resolveDependencies(): Promise<RunAiMeetingDependencies> {
  const repository = await createSimulationRunRepository();
  const appEnv = readAppEnvV2FromEnv();
  const redisClient = await createDefaultCompanyLabRedisClient(appEnv);
  return { repository, redisClient };
}

export interface RunAiMeetingSendActionResult {
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

export async function sendRunAiMeetingMessageAction(
  simulationRunId: string,
  companyId: string,
  turn: number,
  playerMessage: string,
  meetingId?: string
): Promise<RunAiMeetingSendActionResult> {
  const logPrefix = `[sendRunAiMeetingMessageAction] run=${simulationRunId} company=${companyId} turn=${turn}`;
  try {
    const g = await guard();
    if (!g.ok) return { ok: false, errorMessage: g.message };

    const deps = await resolveDependencies();
    const result = await handlePostRunAiMeetingMessage(deps, simulationRunId, companyId, String(turn), { meetingId, playerMessage });

    if (result.status !== 200) {
      const body = result.body as { error?: { message?: string } } | undefined;
      console.log(`${logPrefix} 失敗 status=${result.status}`);
      return { ok: false, errorMessage: body?.error?.message ?? "AI経営会議の呼び出しに失敗しました。ゲームの状態には影響ありません。" };
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

export interface RunAiMeetingFetchActionResult {
  readonly ok: boolean;
  readonly found: boolean;
  readonly meetingId?: string;
  readonly messages?: readonly AiMeetingMessage[];
  readonly lastValidatedProposals?: readonly ValidatedAiMeetingProposal[];
  readonly errorMessage?: string;
}

export async function fetchRunAiMeetingConversationAction(
  simulationRunId: string,
  companyId: string,
  meetingId: string
): Promise<RunAiMeetingFetchActionResult> {
  const logPrefix = `[fetchRunAiMeetingConversationAction] run=${simulationRunId} company=${companyId} meetingId=${meetingId}`;
  try {
    const g = await guard();
    if (!g.ok) return { ok: false, found: false, errorMessage: g.message };

    const deps = await resolveDependencies();
    const result = await handleGetRunAiMeetingConversation(deps, simulationRunId, companyId, meetingId);

    if (result.status === 404) return { ok: true, found: false };
    if (result.status !== 200) {
      const body = result.body as { error?: { message?: string } } | undefined;
      return { ok: false, found: false, errorMessage: body?.error?.message ?? "会話の復元に失敗しました。" };
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

// ---------------------------------------------------------------------
// 【M2.7配線・Fast Track統合】Opening Executive Brief
//
// 新しいTurnの意思決定画面へ入った直後に、プレイヤーが何も質問しなくても
// CEOが「前四半期から何が変わったか」を短く説明する。cache（同一turn再訪では
// 再生成しない）・割り込み禁止（既にプレイヤーが発言済みなら生成しない）は
// いずれもサーバー側（session.ts runOpeningBrief）が判定する。
// ---------------------------------------------------------------------

export interface RunOpeningBriefActionResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly cached?: boolean;
  readonly meetingId?: string;
  /** 生成された場合の本体（cachedのときはmessageのみ返る）。 */
  readonly openingBrief?: OpeningExecutiveBrief;
  /** cache hit時に返る、会話へ既に記録済みのOPENING_BRIEFメッセージ。 */
  readonly message?: AiMeetingMessage;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

export async function fetchRunOpeningBriefAction(simulationRunId: string, companyId: string, turn: number): Promise<RunOpeningBriefActionResult> {
  const logPrefix = `[fetchRunOpeningBriefAction] run=${simulationRunId} company=${companyId} turn=${turn}`;
  try {
    const g = await guard();
    if (!g.ok) return { ok: false, available: false, errorMessage: g.message };

    const deps = await resolveDependencies();
    const result = await handleGetRunOpeningBrief(deps, simulationRunId, companyId, String(turn));

    if (result.status !== 200) {
      const body = result.body as { error?: { message?: string } } | undefined;
      return { ok: false, available: false, errorMessage: body?.error?.message ?? "Opening Briefの取得に失敗しました。" };
    }
    const body = result.body as {
      available: boolean;
      cached?: boolean;
      meetingId?: string;
      openingBrief?: OpeningExecutiveBrief;
      message?: AiMeetingMessage;
      unavailableReason?: string;
    };
    return {
      ok: true,
      available: body.available,
      cached: body.cached,
      meetingId: body.meetingId,
      openingBrief: body.openingBrief,
      message: body.message,
      unavailableReason: body.unavailableReason,
    };
  } catch (e) {
    unstable_rethrow(e);
    console.error(`${logPrefix} 予期しない例外を捕捉しました:`, e instanceof Error ? e.message : String(e));
    return { ok: false, available: false, errorMessage: "サーバー内部で予期しないエラーが発生しました。" };
  }
}
