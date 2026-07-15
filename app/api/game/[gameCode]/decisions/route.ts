import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { CompanyDecision, GameSession } from "../../../../lib/gameTypes";
import { CompanyId } from "../../../../lib/gameData";
import { decisionsKey, formatPeriod, gameKey } from "../../../../lib/redisKeys";
import { normalizeGameSession } from "../../../../lib/gameSession";
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const body = await req.json();
  const { companyId, phases } = body;
  const gameData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(gameData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);
  const key = decisionsKey(gameCode, formatPeriod(session.currentYear, session.currentQuarter), companyId);
  const decision = { companyId, gameCode, year: session.currentYear, quarter: session.currentQuarter, submittedAt: new Date().toISOString(), phases };
  await redis.set(key, JSON.stringify(decision));
  const updatedSession: GameSession = { ...session, updatedAt: new Date().toISOString() };
  await redis.set(gameKey(gameCode), JSON.stringify(updatedSession));
  return NextResponse.json({ success: true });
}
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const gameData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(gameData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);
  const decisions: Partial<Record<CompanyId, CompanyDecision>> = {};
  const period = formatPeriod(session.currentYear, session.currentQuarter);
  for (const id of ["A","B","C","D","E"] as CompanyId[]) {
    const data = await redis.get(decisionsKey(gameCode, period, id));
    const parsed = parseStored<CompanyDecision>(data);
    if (parsed) decisions[id] = parsed;
  }
  return NextResponse.json(decisions);
}
