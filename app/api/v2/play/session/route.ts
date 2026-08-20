// ShrimpX V2 — Independent Player Flow: 現在のPlayer Session状態
//
// GET: Cookieから解決したrunId/companyIdで、Playerへ返してよい最小限のcontext
// （PlayerDecisionContext）を組み立てて返す。GM向け全知state（resumePayload全体・
// 他社の内部状態）は絶対に返さない。
// DELETE: ログアウト（Cookie削除 + サーバー側セッションの失効）。

import { NextResponse } from "next/server";
import { withPlayerApiContext } from "../_lib/context";
import { buildPlayerDecisionContext, PlayerDecisionContextError } from "../../../../lib/v2/player/decisionContext";
import { clearPlayerSessionCookie } from "../../../../lib/v2/player/sessionCookie";

function nowIso(): string {
  return new Date().toISOString();
}

// GET /api/v2/play/session — 現在のRun/Company/Turn/意思決定入力に必要な最小限のcontext。
export async function GET(): Promise<NextResponse> {
  return withPlayerApiContext(async ({ session, simulationRunRepository }) => {
    const stored = await simulationRunRepository.loadRun(session.runId);
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: "この Simulation Run は見つかりません。" } } };
    }
    try {
      const context = buildPlayerDecisionContext(stored, session.companyId);
      return { status: 200, body: context };
    } catch (e) {
      if (e instanceof PlayerDecisionContextError) {
        return { status: 409, body: { error: { code: e.code, message: e.message } } };
      }
      throw e;
    }
  });
}

// DELETE /api/v2/play/session — ログアウト。
export async function DELETE(): Promise<NextResponse> {
  return withPlayerApiContext(async ({ session, playerRepository }) => {
    await playerRepository.revokeSession(session.sessionId, nowIso());
    await clearPlayerSessionCookie();
    return { status: 200, body: { ok: true } };
  });
}
