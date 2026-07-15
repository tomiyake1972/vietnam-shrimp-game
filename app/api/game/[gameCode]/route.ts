import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../lib/redis";
import { CompanyState, GameSession } from "../../../lib/gameTypes";
import { CompanyId } from "../../../lib/gameData";
import { companyStateKey, gameKey } from "../../../lib/redisKeys";
import { normalizeGameSession } from "../../../lib/gameSession";
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const data = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(data);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);
  const companyStates: Partial<Record<CompanyId, CompanyState>> = {};
  for (const id of ["A","B","C","D","E"] as CompanyId[]) {
    const state = await redis.get(companyStateKey(gameCode, id));
    const parsed = parseStored<CompanyState>(state);
    if (parsed) companyStates[id] = parsed;
  }
  return NextResponse.json({ session, companyStates });
}
