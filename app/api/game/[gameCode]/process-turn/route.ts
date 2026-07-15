import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { CompanyId } from "../../../../lib/gameData";
import { CompanyDecision, CompanyState, GameSession, TurnResult } from "../../../../lib/gameTypes";
import { nextQuarter, resolveCompanyTurn } from "../../../../lib/gameEngine";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

export async function POST(_req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;

  const sessionData = await redis.get(`game:${gameCode}`);
  const session = parseStored<GameSession>(sessionData);
  if (!session) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const states: Record<CompanyId, CompanyState> = {} as Record<CompanyId, CompanyState>;
  for (const id of COMPANY_IDS) {
    const raw = await redis.get(`game:${gameCode}:company:${id}`);
    const parsed = parseStored<CompanyState>(raw);
    if (!parsed) return NextResponse.json({ error: `Missing company state for ${id}` }, { status: 500 });
    states[id] = parsed;
  }

  const decisions: Partial<Record<CompanyId, CompanyDecision>> = {};
  for (const id of COMPANY_IDS) {
    const raw = await redis.get(`game:${gameCode}:decisions:${session.currentYear}Q${session.currentQuarter}:${id}`);
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
    await redis.set(`game:${gameCode}:company:${id}`, JSON.stringify(result.stateAfter));
  }

  const quarterKey = `${session.currentYear}Q${session.currentQuarter}`;
  await redis.set(`game:${gameCode}:results:${quarterKey}`, JSON.stringify(turnResult));

  const { year: nextYear, quarter: nextQ } = nextQuarter(session.currentYear, session.currentQuarter);
  const updatedSession: GameSession = {
    ...session,
    currentYear: nextYear,
    currentQuarter: nextQ,
    currentPhase: 0,
    history: [...(session.history ?? []), quarterKey],
  };
  await redis.set(`game:${gameCode}`, JSON.stringify(updatedSession));

  return NextResponse.json({ session: updatedSession, result: turnResult });
}
