import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { GameSession, TurnResult } from "../../../../lib/gameTypes";

export async function GET(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const quarterKey = req.nextUrl.searchParams.get("quarter");

  const sessionData = await redis.get(`game:${gameCode}`);
  const session = parseStored<GameSession>(sessionData);
  if (!session) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  if (quarterKey) {
    const raw = await redis.get(`game:${gameCode}:results:${quarterKey}`);
    const result = parseStored<TurnResult>(raw);
    if (!result) return NextResponse.json({ error: "Result not found" }, { status: 404 });
    return NextResponse.json({ result });
  }

  const history = session.history ?? [];
  const results = await Promise.all(
    history.map(async (key) => parseStored<TurnResult>(await redis.get(`game:${gameCode}:results:${key}`)))
  );
  return NextResponse.json({ results: results.filter((r): r is TurnResult => r !== null) });
}
