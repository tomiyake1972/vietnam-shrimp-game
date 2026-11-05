// ShrimpX V2 — Independent Player Flow: Player API 共通コンテキスト
//
// 【既存staging admin sessionを流用しない】GM/adminの認証（assertStagingAdmin /
// hasValidStagingSession）は一切通らない、完全に別の認証経路。Player API は
// 常にCookie（shrimpx_player_session）のsessionIdだけを信頼の起点にし、
// runId/companyIdは必ずPlayerRepository.loadSessionから解決する
// （query parameterのcompanyを信頼しない、という指示のための唯一の実装箇所）。
//
// 本番では一切提供しない（既存のcompanyLabUiSession.ts・simulation-runs API と
// 同じ、staging専用機能としての多重防御）。

import { NextResponse } from "next/server";
import { isProduction } from "../../../../lib/env";
import { readPlayerSessionIdFromCookie } from "../../../../lib/v2/player/sessionCookie";
import { createPlayerRepository, createSimulationRunRepository } from "../../simulation-runs/_lib/context";
import { PlayerRepository } from "../../../../lib/v2/player/repository";
import { PlayerSessionRecord } from "../../../../lib/v2/player/types";
import { SimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/repository";

export interface PlayerApiResult {
  readonly status: number;
  readonly body: unknown;
}

export interface PlayerApiContext {
  readonly session: PlayerSessionRecord;
  readonly playerRepository: PlayerRepository;
  readonly simulationRunRepository: SimulationRunRepository;
}

function authError(code: string, message: string, status = 401): PlayerApiResult {
  return { status, body: { error: { code, message } } };
}

const GENERIC_DEPENDENCY_ERROR = "サーバー内部でエラーが発生しました（保存先の初期化に失敗しました）。";
const GENERIC_UNEXPECTED_ERROR = "サーバー内部で予期しないエラーが発生しました。";

/**
 * 認証の結果。解決できたらcontext、できなければそのまま返すべきエラー。
 *
 * 【PLAY-PARITY-1】Excel等のバイナリを返すrouteでも、JSONを返すrouteと
 * まったく同じ認証・失効確認を通すために切り出した。認証の分岐をここ1箇所に
 * 保ち、route側で書き直さない（query parameterのcompanyを信頼しない、という
 * 既存の原則もここで守られる）。
 */
export type PlayerApiAuth = { readonly ok: true; readonly context: PlayerApiContext } | { readonly ok: false; readonly result: PlayerApiResult };

export async function resolvePlayerApiContext(): Promise<PlayerApiAuth> {
  if (isProduction) {
    return { ok: false, result: { status: 403, body: { error: { code: "NOT_AVAILABLE", message: "この機能は本番環境では利用できません。" } } } };
  }

  const sessionId = await readPlayerSessionIdFromCookie();
  if (!sessionId) {
    return { ok: false, result: authError("NO_SESSION_COOKIE", "ログインセッションが見つかりません。参加リンクから再度参加してください。") };
  }

  let playerRepository: PlayerRepository;
  let simulationRunRepository: SimulationRunRepository;
  try {
    playerRepository = await createPlayerRepository();
    simulationRunRepository = await createSimulationRunRepository();
  } catch (e) {
    console.error("[play api] 保存先の初期化に失敗しました:", e);
    return { ok: false, result: { status: 500, body: { error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } } } };
  }

  const session = await playerRepository.loadSession(sessionId);
  if (!session) {
    return { ok: false, result: authError("SESSION_NOT_FOUND", "このセッションは見つかりません。参加リンクから再度参加してください。") };
  }
  if (session.revokedAt) {
    return {
      ok: false,
      result: authError(
        "SESSION_REVOKED",
        "このセッションは無効化されています（GMが参加リンクを再発行したか、参加を取り消した可能性があります）。参加リンクから再度参加してください。"
      ),
    };
  }

  void playerRepository.touchSession(sessionId, new Date().toISOString()); // best-effort、失敗しても本処理を止めない
  return { ok: true, context: { session, playerRepository, simulationRunRepository } };
}

/**
 * Cookieからsessionidを取り出し、PlayerRepositoryで現在の有効性（revokedAt）を
 * 確認したうえでhandlerFnを呼ぶ。本番では常に401（Player機能自体を提供しない）。
 */
export async function withPlayerApiContext(handlerFn: (ctx: PlayerApiContext) => Promise<PlayerApiResult>): Promise<NextResponse> {
  const auth = await resolvePlayerApiContext();
  if (!auth.ok) return NextResponse.json(auth.result.body, { status: auth.result.status });

  try {
    const result = await handlerFn(auth.context);
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[play api] ハンドラーで予期しないエラーが発生しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_UNEXPECTED_ERROR } }, { status: 500 });
  }
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
