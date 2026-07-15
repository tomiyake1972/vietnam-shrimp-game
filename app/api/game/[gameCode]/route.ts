import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../lib/redis";
import { CompanyState, GameSession } from "../../../lib/gameTypes";
import { CompanyId } from "../../../lib/gameData";
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const data = await redis.get(`game:${gameCode}`);
  const session = parseStored<GameSession>(data);
  if (!session) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const companyStates: Partial<Record<CompanyId, CompanyState>> = {};
  for (const id of ["A","B","C","D","E"] as CompanyId[]) {
    const state = await redis.get(`game:${gameCode}:company:${id}`);
    const parsed = parseStored<CompanyState>(state);
    if (parsed) companyStates[id] = parsed;
  }
  return NextResponse.json({ session, companyStates });
}
