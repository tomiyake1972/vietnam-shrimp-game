import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../../lib/redis";
import { GameSession } from "../../../../../lib/gameTypes";
import { CompanyId } from "../../../../../lib/gameData";
import { companyStateKey, decisionsKey, gameKey, resultsKey } from "../../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession } from "../../../../../lib/gameSession";
import { createInitialCompanyStates, createInitialGameSession } from "../../../../../lib/initialGameState";
import { relevantPeriods } from "../../../../../lib/gameSnapshot";
import { assertStagingAdmin } from "../../../../../lib/stagingAdmin";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

// テストゲームを初期状態に戻す。ゲームコード・タイトル・担当設定・isTestGame・environment・
// randomSeed・createdAtは維持し、年・四半期・フェーズ・historyのみ初期化する。
// 意思決定・ターン結果は削除するが、スナップショットは維持する（誤操作時に復元できるように）。
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode } = await params;
  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  if (!isValidTestGameSession(session)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  for (const period of relevantPeriods(session)) {
    for (const id of COMPANY_IDS) {
      await redis.del(decisionsKey(gameCode, period, id));
    }
    await redis.del(resultsKey(gameCode, period));
  }

  const now = new Date().toISOString();
  const resetSession = createInitialGameSession({
    gameCode,
    title: session.title,
    players: session.players,
    isTestGame: session.isTestGame,
    environment: session.environment,
    randomSeed: session.randomSeed,
    createdAt: session.createdAt,
    updatedAt: now,
  });
  await redis.set(gameKey(gameCode), JSON.stringify(resetSession));

  const initialStates = createInitialCompanyStates();
  for (const [id, state] of Object.entries(initialStates)) {
    await redis.set(companyStateKey(gameCode, id), JSON.stringify(state));
  }

  return NextResponse.json({ session: resetSession });
}
