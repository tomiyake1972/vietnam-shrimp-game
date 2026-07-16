import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { GameSession } from "../../../../lib/gameTypes";
import { gameKey, gamesListKey, listGameRelatedKeys } from "../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession } from "../../../../lib/gameSession";
import { deleteAllGameSnapshots } from "../../../../lib/gameSnapshot";
import { assertStagingAdmin } from "../../../../lib/stagingAdmin";

// テストゲームを完全に削除する。GameSession・全期間の意思決定・ターン結果・
// スナップショットをすべて削除し、gamesリストから対象コードのみをLREMで除外する。
// Redis全体や他ゲームのキーには一切触れない。
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode } = await params;
  const body = await req.json().catch(() => ({}));
  const { confirmGameCode } = body as { confirmGameCode?: string };
  if (confirmGameCode !== gameCode) {
    return NextResponse.json({ error: "確認用のゲームコードが一致しません。" }, { status: 400 });
  }

  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  if (!isValidTestGameSession(session)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  await deleteAllGameSnapshots(gameCode);

  const keys = await listGameRelatedKeys(gameCode, session);
  for (const key of keys) {
    await redis.del(key);
  }
  await redis.lrem(gamesListKey(), 0, gameCode);

  return NextResponse.json({ success: true });
}
