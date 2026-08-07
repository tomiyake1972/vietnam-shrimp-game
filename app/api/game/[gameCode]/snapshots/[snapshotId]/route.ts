import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../../lib/redis";
import { GameSession } from "../../../../../lib/gameTypes";
import { gameKey } from "../../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession } from "../../../../../lib/gameSession";
import { deleteGameSnapshot, getGameSnapshot } from "../../../../../lib/gameSnapshot";
import { assertStagingAdmin } from "../../../../../lib/stagingAdmin";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ gameCode: string; snapshotId: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode, snapshotId } = await params;
  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  if (!isValidTestGameSession(session)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  const snapshot = await getGameSnapshot(gameCode, snapshotId);
  if (!snapshot || snapshot.gameCode !== gameCode) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }

  await deleteGameSnapshot(gameCode, snapshotId);
  return NextResponse.json({ success: true });
}
