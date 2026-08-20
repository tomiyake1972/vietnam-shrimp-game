// ShrimpX V2 — Independent Player Flow: 参加リンクclaim
//
// joinId（URLパスパラメータ）そのものがjoin secret（十分なentropyを持つトークン）。
// Redisにはこの平文を一切保存しない（PlayerRepository.claimJoinSecret参照）。
// claimに成功したらHttpOnly Player Session Cookieを発行する。

import { NextRequest, NextResponse } from "next/server";
import { isProduction } from "../../../../../lib/env";
import { createPlayerRepository } from "../../../simulation-runs/_lib/context";
import { PlayerAuthError } from "../../../../../lib/v2/player/types";
import { setPlayerSessionCookie } from "../../../../../lib/v2/player/sessionCookie";

interface RouteContext {
  readonly params: Promise<{ readonly joinId: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

const AUTH_ERROR_STATUS: Readonly<Record<PlayerAuthError["code"], number>> = {
  JOIN_NOT_FOUND: 404,
  JOIN_ALREADY_CLAIMED: 409,
  JOIN_REVOKED: 410,
  SESSION_NOT_FOUND: 401,
  SESSION_REVOKED: 401,
  SESSION_COMPANY_MISMATCH: 403,
  NO_SESSION_COOKIE: 401,
};

// POST /api/v2/play/join/{joinId} — 参加リンクをclaimし、Player Session Cookieを発行する。
export async function POST(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (isProduction) {
    return NextResponse.json({ error: { code: "NOT_AVAILABLE", message: "この機能は本番環境では利用できません。" } }, { status: 403 });
  }
  const { joinId } = await context.params;
  if (typeof joinId !== "string" || joinId.length < 16) {
    return NextResponse.json({ error: { code: "BAD_REQUEST", message: "参加リンクの形式が不正です。" } }, { status: 400 });
  }

  const playerRepository = await createPlayerRepository();
  try {
    const { session, seat } = await playerRepository.claimJoinSecret(joinId, nowIso());
    const cookieSet = await setPlayerSessionCookie(session.sessionId);
    if (!cookieSet) {
      return NextResponse.json(
        { error: { code: "INTERNAL_ERROR", message: "セッションCookieの発行に失敗しました（サーバー設定を確認してください）。" } },
        { status: 500 }
      );
    }
    return NextResponse.json({ runId: seat.runId, companyId: seat.companyId }, { status: 200 });
  } catch (e) {
    if (e instanceof PlayerAuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: AUTH_ERROR_STATUS[e.code] });
    }
    console.error("[play join api] 予期しないエラー:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "サーバー内部で予期しないエラーが発生しました。" } }, { status: 500 });
  }
}
