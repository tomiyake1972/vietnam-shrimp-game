// ShrimpX V2 — Independent Player Flow: GM Console用 Player Seat一覧
//
// 会社ごとに assigned/unassigned（companyControlModes）・joined/unjoined
// （seat.claimedSessionId）・submitted/unsubmitted（resumePayload.confirmedPlayerDecisions、
// GM Advance Turn gatingと同じ信号）・submittedAt（Seatの副次情報）を返す。
// join URLの平文は絶対に含めない（発行/再発行APIが1回だけ返す）。

import { NextRequest, NextResponse } from "next/server";
import { withPlayerSeatManagementApiContext } from "../_lib/context";

interface RouteContext {
  readonly params: Promise<{ readonly runId: string }>;
}

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId } = await context.params;
  return withPlayerSeatManagementApiContext(_req, async ({ playerRepository, simulationRunRepository }) => {
    const stored = await simulationRunRepository.loadRun(runId);
    if (!stored) {
      return { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: `Simulation Run が見つかりません（runId=${runId}）。` } } };
    }
    const fixtures = stored.resumePayload?.fixtures ?? [];
    const companyIds = fixtures.map((f) => f.companyId);
    const seats = await playerRepository.listSeatsForRun(runId, companyIds);
    const seatByCompanyId = new Map(seats.map((s) => [s.companyId, s]));
    const controlModes = stored.run.companyControlModes ?? {};
    const confirmedPlayerDecisions = stored.resumePayload?.confirmedPlayerDecisions ?? {};
    const currentTurn = stored.resumePayload?.state.scenarioState.currentTurn ?? null;

    const companies = fixtures.map((fixture) => {
      const seat = seatByCompanyId.get(fixture.companyId) ?? null;
      return {
        companyId: fixture.companyId,
        displayName: fixture.displayName,
        controlMode: controlModes[fixture.companyId] ?? "STANDARD_AI",
        hasSeat: seat !== null,
        joinIssued: Boolean(seat?.joinIssuedAt) && !seat?.joinRevokedAt,
        joined: Boolean(seat?.claimedSessionId),
        hasSubmittedThisTurn: confirmedPlayerDecisions[fixture.companyId] !== undefined,
        lastSubmittedTurn: seat?.lastSubmittedTurn ?? null,
        lastSubmittedAt: seat?.lastSubmittedAt ?? null,
      };
    });

    return { status: 200, body: { runId, currentTurn, gameEndedAt: stored.run.gameEndedAt ?? null, companies } };
  });
}
