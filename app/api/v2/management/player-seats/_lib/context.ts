// ShrimpX V2 — Independent Player Flow: GM向けPlayer Seat管理API共通コンテキスト
//
// 【既存GM/admin認証をそのまま使う】simulation-runs API（withSimulationRunApiContext）
// と全く同じ認証方式（Bearer STAGING_ADMIN_TOKEN または Company Lab UI session
// Cookie）。Player Seatの発行・再発行・取り消しはGM操作であり、Player認証
// （app/api/v2/play/_lib/context.ts）とは完全に別の経路。

import { NextRequest, NextResponse } from "next/server";
import { assertStagingAdmin } from "../../../../../lib/stagingAdmin";
import { hasValidStagingSession } from "../../../../../lib/companyLabUiSession";
import { createPlayerRepository, createSimulationRunRepository } from "../../../simulation-runs/_lib/context";
import { PlayerRepository } from "../../../../../lib/v2/player/repository";
import { SimulationRunRepository } from "../../../../../lib/v2/companyLab/simulation/persistence/repository";

export interface PlayerSeatApiResult {
  readonly status: number;
  readonly body: unknown;
}

export interface PlayerSeatApiContext {
  readonly playerRepository: PlayerRepository;
  readonly simulationRunRepository: SimulationRunRepository;
}

export async function withPlayerSeatManagementApiContext(
  req: NextRequest,
  handlerFn: (ctx: PlayerSeatApiContext) => Promise<PlayerSeatApiResult>
): Promise<NextResponse> {
  const bearer = assertStagingAdmin(req);
  if (!bearer.ok) {
    const session = await hasValidStagingSession();
    if (!session) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: bearer.error } }, { status: bearer.status });
    }
  }

  try {
    const playerRepository = await createPlayerRepository();
    const simulationRunRepository = await createSimulationRunRepository();
    const result = await handlerFn({ playerRepository, simulationRunRepository });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error("[player-seats api] 予期しないエラー:", e);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "サーバー内部で予期しないエラーが発生しました。" } }, { status: 500 });
  }
}

export async function parseJsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
