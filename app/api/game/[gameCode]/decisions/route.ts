import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { CompanyDecision, GameSession, SubmittedBy } from "../../../../lib/gameTypes";
import { CompanyId } from "../../../../lib/gameData";
import { decisionsKey, formatPeriod, gameKey } from "../../../../lib/redisKeys";
import { normalizeGameSession } from "../../../../lib/gameSession";
import { normalizeDecision } from "../../../../lib/decision";
import { isProduction } from "../../../../lib/env";

const VALID_COMPANY_IDS: string[] = ["A", "B", "C", "D", "E"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const body = await req.json();
  const { companyId, phases, isGmTestSubmission } = body;
  const gameData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(gameData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  // submittedByはクライアントの申告をそのまま信用しない。"gm-test"は、非本番環境・
  // 対象ゲームがテストゲーム・対象会社IDがA〜Eである、をすべてサーバー側で再確認できた
  // 場合のみ付与する。本番環境ではリクエストを細工しても"gm-test"にはならない。
  const isValidCompanyId = VALID_COMPANY_IDS.includes(companyId);
  const requestedGmTest = Boolean(isGmTestSubmission);
  const submittedBy: SubmittedBy =
    !isProduction && session.isTestGame && requestedGmTest && isValidCompanyId ? "gm-test" : "player";

  const period = formatPeriod(session.currentYear, session.currentQuarter);
  const key = decisionsKey(gameCode, period, companyId);
  const previousRaw = await redis.get(key);
  const previousStored = parseStored<CompanyDecision>(previousRaw);
  const previous = previousStored ? normalizeDecision(previousStored) : null;

  const now = new Date().toISOString();
  const decision: CompanyDecision = {
    companyId,
    gameCode,
    year: session.currentYear,
    quarter: session.currentQuarter,
    submittedAt: now,
    phases,
    submissionCount: (previous?.submissionCount ?? 0) + 1,
    firstSubmittedAt: previous?.firstSubmittedAt || now,
    lastSubmittedAt: now,
    submittedBy,
  };
  await redis.set(key, JSON.stringify(decision));

  const updatedSession: GameSession = { ...session, updatedAt: now };
  await redis.set(gameKey(gameCode), JSON.stringify(updatedSession));
  return NextResponse.json({ success: true });
}
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const gameData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(gameData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);
  const decisions: Partial<Record<CompanyId, CompanyDecision>> = {};
  const period = formatPeriod(session.currentYear, session.currentQuarter);
  for (const id of ["A","B","C","D","E"] as CompanyId[]) {
    const data = await redis.get(decisionsKey(gameCode, period, id));
    const parsed = parseStored<CompanyDecision>(data);
    if (parsed) decisions[id] = normalizeDecision(parsed);
  }
  return NextResponse.json(decisions);
}
