// ShrimpX V2 — Independent Player Flow: GM代理操作の提出記録（Seat側の副次的な監査情報）
//
// 【なぜ必要か】GMが「この会社を操作」で代理入力する既存フローは、
// resumePayload.confirmedPlayerDecisionsへ直接書き込む（PlayerWorkspace.tsxの
// 既存handleConfirm、変更していない）。一方でTurn Advance gate
// （app/lib/v2/player/turnAdvanceGate.ts）は「参加link発行済みの会社」については
// Seat.lastSubmittedTurnを見て判定する。GMが参加linkを発行した会社を、それでも
// GM自身が代理操作した場合にSeat側の記録が更新されないと、実際には決定済みなのに
// gateがブロックし続けてしまう。この小さな追加APIは、GM代理提出のたびにSeatの
// 副次情報だけを追いつかせる（意思決定そのものの真実はresumePayload側のまま、
// ここでは何も計算し直さない）。

import { NextRequest, NextResponse } from "next/server";
import { withPlayerSeatManagementApiContext } from "../../../_lib/context";
import { parseJsonBody } from "../../../_lib/context";

interface RouteContext {
  readonly params: Promise<{ readonly runId: string; readonly companyId: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId, companyId } = await context.params;
  return withPlayerSeatManagementApiContext(req, async ({ playerRepository }) => {
    const body = await parseJsonBody(req);
    const turn = typeof body === "object" && body !== null ? (body as { turn?: unknown }).turn : undefined;
    if (typeof turn !== "number" || !Number.isFinite(turn)) {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message: "turn が数値ではありません。" } } };
    }
    const seat = await playerRepository.recordSubmission(runId, companyId, turn, nowIso());
    return { status: 200, body: { runId: seat.runId, companyId: seat.companyId, lastSubmittedTurn: seat.lastSubmittedTurn } };
  });
}
