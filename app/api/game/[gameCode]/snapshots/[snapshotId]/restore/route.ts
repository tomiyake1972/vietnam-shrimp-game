import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../../../lib/redis";
import { GameSession } from "../../../../../../lib/gameTypes";
import { gameKey } from "../../../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession } from "../../../../../../lib/gameSession";
import {
  computeExtraKeysAfterRestore,
  createGameSnapshot,
  getGameSnapshot,
  restoreGameSnapshot,
} from "../../../../../../lib/gameSnapshot";
import { assertStagingAdmin } from "../../../../../../lib/stagingAdmin";

// スナップショットの内容へゲームを復元する。
// 復元前に現在の状態を自動保存し、対象スナップショットが同じゲームのものであることを
// 確認したうえで、gameCode/createdAt/isTestGame/environmentは現在のゲームの値を維持する
// （スナップショット側の値は信用しない）。
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string; snapshotId: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode, snapshotId } = await params;
  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const currentSession = normalizeGameSession(stored);

  if (!isValidTestGameSession(currentSession)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  const snapshot = await getGameSnapshot(gameCode, snapshotId);
  if (!snapshot || snapshot.gameCode !== gameCode) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }

  // 復元前に現在の状態を自動保存する（誤って復元しても戻せるように）。
  await createGameSnapshot(gameCode, currentSession, "復元前の自動保存");

  const extraKeysToDelete = computeExtraKeysAfterRestore(gameCode, currentSession, snapshot);
  const restoredSession = await restoreGameSnapshot(
    gameCode,
    snapshot,
    {
      createdAt: currentSession.createdAt,
      isTestGame: currentSession.isTestGame,
      environment: currentSession.environment,
    },
    extraKeysToDelete
  );

  return NextResponse.json({ session: restoredSession });
}
