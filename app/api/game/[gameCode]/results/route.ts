import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { GameSession, TurnResult } from "../../../../lib/gameTypes";
import { gameKey, resultsKey } from "../../../../lib/redisKeys";
import { normalizeGameSession } from "../../../../lib/gameSession";
import { normalizeTurnResult } from "../../../../lib/turnResult";

export async function GET(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const quarterKey = req.nextUrl.searchParams.get("quarter");

  const sessionData = await redis.get(gameKey(gameCode));
  const storedSession = parseStored<GameSession>(sessionData);
  if (!storedSession) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(storedSession);

  if (quarterKey) {
    const raw = await redis.get(resultsKey(gameCode, quarterKey));
    const parsed = parseStored<TurnResult>(raw);
    if (!parsed) return NextResponse.json({ error: "Result not found" }, { status: 404 });
    return NextResponse.json({ result: normalizeTurnResult(parsed) });
  }

  const history = session.history;
  const results = await Promise.all(
    history.map(async (key) => {
      const parsed = parseStored<TurnResult>(await redis.get(resultsKey(gameCode, key)));
      return parsed ? normalizeTurnResult(parsed) : null;
    })
  );
  return NextResponse.json({ results: results.filter((r): r is TurnResult => r !== null) });
}
