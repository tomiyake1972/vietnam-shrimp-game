import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../../lib/redis";
import { CompanyDecision, CompanyState, GameSession, TurnResult } from "../../../../../lib/gameTypes";
import { CompanyId } from "../../../../../lib/gameData";
import { companyStateKey, decisionsKey, gameKey, gamesListKey, resultsKey } from "../../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession, generateRandomSeed } from "../../../../../lib/gameSession";
import { createInitialCompanyStates, createInitialGameSession } from "../../../../../lib/initialGameState";
import { relevantPeriods } from "../../../../../lib/gameSnapshot";
import { normalizeDecision } from "../../../../../lib/decision";
import { normalizeTurnResult } from "../../../../../lib/turnResult";
import { assertStagingAdmin } from "../../../../../lib/stagingAdmin";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];
const MAX_GAME_CODE_ATTEMPTS = 10;

function generateGameCodeCandidate(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateUniqueGameCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_GAME_CODE_ATTEMPTS; attempt++) {
    const candidate = generateGameCodeCandidate();
    const existingCount = await redis.exists(gameKey(candidate));
    if (existingCount === 0) return candidate;
  }
  throw new Error(`ゲームコードの生成に${MAX_GAME_CODE_ATTEMPTS}回失敗しました（既存コードとの衝突が続いています）。`);
}

// テストゲームを複製する。mode="current"は現在の状態（会社状態・意思決定・結果履歴）を
// そのまま複製し、mode="initial"は担当設定とタイトルのみ維持して他は初期状態にする。
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode } = await params;
  const body = await req.json().catch(() => ({}));
  const { mode, seedMode } = body as { mode?: string; seedMode?: string };
  const cloneMode: "current" | "initial" = mode === "initial" ? "initial" : "current";
  const useSameSeed = seedMode === "same";

  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const sourceSession = normalizeGameSession(stored);

  if (!isValidTestGameSession(sourceSession)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  let newGameCode: string;
  try {
    newGameCode = await generateUniqueGameCode();
  } catch (e) {
    const message = e instanceof Error ? e.message : "ゲームコードの生成に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const now = new Date().toISOString();
  const newRandomSeed = useSameSeed ? sourceSession.randomSeed : generateRandomSeed();
  const newTitle = `${sourceSession.title}（コピー）`;

  let newSession: GameSession;
  let newCompanyStates: Record<CompanyId, CompanyState>;

  if (cloneMode === "initial") {
    newSession = createInitialGameSession({
      gameCode: newGameCode,
      title: newTitle,
      players: sourceSession.players,
      isTestGame: true,
      environment: sourceSession.environment,
      randomSeed: newRandomSeed,
      createdAt: now,
      updatedAt: now,
    });
    newCompanyStates = createInitialCompanyStates();
  } else {
    newSession = {
      ...sourceSession,
      gameCode: newGameCode,
      title: newTitle,
      randomSeed: newRandomSeed,
      createdAt: now,
      updatedAt: now,
      isTestGame: true,
    };
    newCompanyStates = {} as Record<CompanyId, CompanyState>;
    for (const id of COMPANY_IDS) {
      const raw = await redis.get(companyStateKey(gameCode, id));
      const state = parseStored<CompanyState>(raw);
      if (state) newCompanyStates[id] = state;
    }
  }

  await redis.set(gameKey(newGameCode), JSON.stringify(newSession));
  for (const [id, state] of Object.entries(newCompanyStates)) {
    await redis.set(companyStateKey(newGameCode, id), JSON.stringify(state));
  }

  if (cloneMode === "current") {
    for (const period of relevantPeriods(sourceSession)) {
      const resultRaw = await redis.get(resultsKey(gameCode, period));
      const resultParsed = parseStored<TurnResult>(resultRaw);
      if (resultParsed) {
        const result = normalizeTurnResult(resultParsed);
        const clonedResult: TurnResult = { ...result, gameCode: newGameCode };
        await redis.set(resultsKey(newGameCode, period), JSON.stringify(clonedResult));
      }
      for (const id of COMPANY_IDS) {
        const raw = await redis.get(decisionsKey(gameCode, period, id));
        const stored = parseStored<CompanyDecision>(raw);
        if (stored) {
          const decision = normalizeDecision(stored);
          const clonedDecision: CompanyDecision = { ...decision, gameCode: newGameCode };
          await redis.set(decisionsKey(newGameCode, period, id), JSON.stringify(clonedDecision));
        }
      }
    }
  }

  await redis.lpush(gamesListKey(), newGameCode);

  return NextResponse.json({ gameCode: newGameCode, session: newSession });
}
