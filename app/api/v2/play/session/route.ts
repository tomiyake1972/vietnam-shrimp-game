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

/**
 * GET /api/v2/play/session — 現在のRun/Company/Turn/意思決定入力に必要な最小限のcontext。
 *
 * 【BW-1・転送量削減】この画面は4秒ごとにここを叩く。context の組み立てには
 * dataset・resumePayload・packCapture が要るため、毎回 loadRun すると
 * 1人のPlayerが1分間に約15回、巨大なパートを読むことになる。
 * 保存物が変わらない限り返す内容も変わらないので、クライアントが持っている
 * revision を受け取り、変わっていなければ manifest だけ読んで「変化なし」を返す。
 * 提出・Turn進行はいずれも revision を上げるため、更新を取りこぼさない。
 * 認証・権限確認（withPlayerApiContext）は従来どおり毎回行う。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const knownRevisionRaw = new URL(request.url).searchParams.get("knownRevision");
  const knownRevision = knownRevisionRaw !== null && /^\d+$/.test(knownRevisionRaw) ? Number(knownRevisionRaw) : null;

  return withPlayerApiContext(async ({ session, simulationRunRepository }) => {
    const persistenceRevision = await simulationRunRepository.currentPublishedRevision(session.runId);
    if (knownRevision !== null && persistenceRevision > 0 && knownRevision === persistenceRevision) {
      return { status: 200, body: { unchanged: true, persistenceRevision } };
    }

    const stored = await simulationRunRepository.loadRun(session.runId);
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: "この Simulation Run は見つかりません。" } } };
    }
    try {
      const context = buildPlayerDecisionContext(stored, session.companyId);
      return {
        status: 200,
        body: { ...context, unchanged: false, persistenceRevision: stored.persistenceRevision ?? persistenceRevision },
      };
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
