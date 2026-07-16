import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../lib/redis";
import { GameSession, PlayerType } from "../../lib/gameTypes";
import { CompanyId } from "../../lib/gameData";
import { companyStateKey, gameKey, gamesListKey } from "../../lib/redisKeys";
import { appEnvironment, isProduction } from "../../lib/env";
import { generateRandomSeed, normalizeGameSession, sanitizeRandomSeed } from "../../lib/gameSession";
import { createInitialCompanyStates, createInitialGameSession } from "../../lib/initialGameState";

const MAX_GAME_CODE_ATTEMPTS = 10;

function generateGameCodeCandidate(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 同一環境のRedis内で既存コードと衝突しない6桁コードを発行する。
// 一定回数試行しても一意なコードが得られない場合は、呼び出し元に例外として通知する。
async function generateUniqueGameCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_GAME_CODE_ATTEMPTS; attempt++) {
    const candidate = generateGameCodeCandidate();
    const existingCount = await redis.exists(gameKey(candidate));
    if (existingCount === 0) return candidate;
  }
  throw new Error(
    `ゲームコードの生成に${MAX_GAME_CODE_ATTEMPTS}回失敗しました（既存コードとの衝突が続いています）。`
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, players, randomSeed: requestedSeed } = body as {
    title?: string;
    players?: Record<CompanyId, PlayerType>;
    randomSeed?: string;
  };

  let gameCode: string;
  try {
    gameCode = await generateUniqueGameCode();
  } catch (e) {
    const message = e instanceof Error ? e.message : "ゲームコードの生成に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // isTestGameはクライアントからの入力を一切参照せず、サーバー側の環境判定のみで決定する
  // （本番でリクエストボディを細工してもテストゲームを作成できない）。
  const isTestGame = !isProduction;
  const randomSeed = isTestGame ? (sanitizeRandomSeed(requestedSeed) ?? generateRandomSeed()) : "";

  const now = new Date().toISOString();
  const session: GameSession = createInitialGameSession({
    gameCode,
    title: title || `ゲーム ${gameCode}`,
    players: players || { A: "human", B: "ai-b", C: "ai-b", D: "ai-b", E: "ai-b" },
    isTestGame,
    environment: appEnvironment,
    randomSeed,
    createdAt: now,
    updatedAt: now,
  });
  const initialStates = createInitialCompanyStates();
  await redis.set(gameKey(gameCode), JSON.stringify(session));
  for (const [id, state] of Object.entries(initialStates)) {
    await redis.set(companyStateKey(gameCode, id), JSON.stringify(state));
  }
  await redis.lpush(gamesListKey(), gameCode);
  return NextResponse.json({ gameCode, session });
}

export async function GET() {
  const codes = await redis.lrange(gamesListKey(), 0, 19);
  const sessions = await Promise.all(codes.map(async (code) => {
    const data = await redis.get(gameKey(code));
    const parsed = parseStored<GameSession>(data);
    return parsed ? normalizeGameSession(parsed) : null;
  }));
  return NextResponse.json(sessions.filter(Boolean));
}
