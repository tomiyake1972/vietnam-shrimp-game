// ShrimpX V2 — Independent Player Flow: GM Console用 Player Seat 発行/再発行/取り消し
//
// POST: 参加リンクを発行（Seatが無ければlazy-create）または再発行する。
// 旧credential・旧claim（既に参加していたPlayer Session）は即座に失効する
// （指示: 「GMによる再発行時は旧credentialを失効させる」）。
// レスポンスのjoinUrlは平文のjoin secretを含む唯一の応答（1回だけ）。
// DELETE: 参加リンク・参加中セッションの両方を取り消す。

import { NextRequest, NextResponse } from "next/server";
import { withPlayerSeatManagementApiContext } from "../../_lib/context";

interface RouteContext {
  readonly params: Promise<{ readonly runId: string; readonly companyId: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId, companyId } = await context.params;
  return withPlayerSeatManagementApiContext(req, async ({ playerRepository, simulationRunRepository }) => {
    const stored = await simulationRunRepository.loadRun(runId);
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: `Simulation Run が見つかりません（runId=${runId}）。` } } };
    }
    const fixtureExists = (stored.resumePayload?.fixtures ?? []).some((f) => f.companyId === companyId);
    if (!fixtureExists) {
      return { status: 404, body: { error: { code: "COMPANY_NOT_FOUND", message: `会社 ${companyId} はこのRunに存在しません。` } } };
    }
    const { seat, joinSecret } = await playerRepository.issueJoinCredential(runId, companyId, nowIso());
    const joinUrl = new URL(`/v2/play/join/${joinSecret}`, req.nextUrl.origin).toString();
    return { status: 200, body: { runId: seat.runId, companyId: seat.companyId, joinUrl, issuedAt: seat.joinIssuedAt } };
  });
}

export async function DELETE(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId, companyId } = await context.params;
  return withPlayerSeatManagementApiContext(req, async ({ playerRepository }) => {
    const seat = await playerRepository.revokeSeat(runId, companyId, nowIso());
    if (!seat) {
      return { status: 200, body: { runId, companyId, revoked: false, reason: "no-seat" } };
    }
    return { status: 200, body: { runId, companyId, revoked: true } };
  });
}
