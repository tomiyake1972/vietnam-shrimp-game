import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { CompanyId } from "../../../../lib/gameData";
import { CompanyDecision, CompanyState, GameSession, TurnResult } from "../../../../lib/gameTypes";
import { nextQuarter, resolveCompanyTurn } from "../../../../lib/gameEngine";
import { companyStateKey, decisionsKey, formatPeriod, gameKey, resultsKey } from "../../../../lib/redisKeys";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

export async function POST(_req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;

  const sessionData = await redis.get(gameKey(gameCode));
  const session = parseStored<GameSession>(sessionData);
  if (!session) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const currentPeriod = formatPeriod(session.currentYear, session.currentQuarter);

  const states: Record<CompanyId, CompanyState> = {} as Record<CompanyId, CompanyState>;
  for (const id of COMPANY_IDS) {
    const raw = await redis.get(companyStateKey(gameCode, id));
    const parsed = parseStored<CompanyState>(raw);
    if (!parsed) return NextResponse.json({ error: `Missing company state for ${id}` }, { status: 500 });
    states[id] = parsed;
  }

  const decisions: Partial<Record<CompanyId, CompanyDecision>> = {};
  for (const id of COMPANY_IDS) {
    const raw = await redis.get(decisionsKey(gameCode, currentPeriod, id));
    const parsed = parseStored<CompanyDecision>(raw);
    if (parsed) decisions[id] = parsed;
  }

  const turnResult: TurnResult = {
    gameCode,
    year: session.currentYear,
    quarter: session.currentQuarter,
    processedAt: new Date().toISOString(),
    companies: {} as TurnResult["companies"],
  };

  for (const id of COMPANY_IDS) {
    const result = resolveCompanyTurn(id, states[id], session.currentYear, session.currentQuarter, decisions[id]);
    turnResult.companies[id] = result;
    await redis.set(companyStateKey(gameCode, id), JSON.stringify(result.stateAfter));
  }

  await redis.set(resultsKey(gameCode, currentPeriod), JSON.stringify(turnResult));

  const { year: nextYear, quarter: nextQ } = nextQuarter(session.currentYear, session.currentQuarter);
  const updatedSession: GameSession = {
    ...session,
    currentYear: nextYear,
    currentQuarter: nextQ,
    currentPhase: 0,
    history: [...(session.history ?? []), currentPeriod],
  };
  await redis.set(gameKey(gameCode), JSON.stringify(updatedSession));

  return NextResponse.json({ session: updatedSession, result: turnResult });
}
