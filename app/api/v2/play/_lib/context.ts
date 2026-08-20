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
 * Cookieからsessionidを取り出し、PlayerRepositoryで現在の有効性（revokedAt）を
 * 確認したうえでhandlerFnを呼ぶ。本番では常に401（Player機能自体を提供しない）。
 */
export async function withPlayerApiContext(handlerFn: (ctx: PlayerApiContext) => Promise<PlayerApiResult>): Promise<NextResponse> {
  if (isProduction) {
    return NextResponse.json({ error: { code: "NOT_AVAILABLE", message: "この機能は本番環境では利用できません。" } }, { status: 403 });
  }

  const sessionId = await readPlayerSessionIdFromCookie();
  if (!sessionId) {
    const result = authError("NO_SESSION_COOKIE", "ログインセッションが見つかりません。参加リンクから再度参加してください。");
    return NextResponse.json(result.body, { status: result.status });
  }

  let playerRepository: PlayerRepository;
  let simulationRunRepository: SimulationRunRepository;
  try {
    playerRepository = await createPlayerRepository();
    simulationRunRepository = await createSimulationRunRepository();
  } catch (e) {
    console.error("[play api] 保存先の初期化に失敗しました:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: GENERIC_DEPENDENCY_ERROR } }, { status: 500 });
  }

  const session = await playerRepository.loadSession(sessionId);
  if (!session) {
    const result = authError("SESSION_NOT_FOUND", "このセッションは見つかりません。参加リンクから再度参加してください。");
    return NextResponse.json(result.body, { status: result.status });
  }
  if (session.revokedAt) {
    const result = authError("SESSION_REVOKED", "このセッションは無効化されています（GMが参加リンクを再発行したか、参加を取り消した可能性があります）。参加リンクから再度参加してください。");
    return NextResponse.json(result.body, { status: result.status });
  }

  try {
    void playerRepository.touchSession(sessionId, new Date().toISOString()); // best-effort、失敗しても本処理を止めない
    const result = await handlerFn({ session, playerRepository, simulationRunRepository });
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
