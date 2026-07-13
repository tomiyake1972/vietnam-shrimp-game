import { NextRequest, NextResponse } from "next/server";
import { redis } from "../../lib/redis";
import { GameSession } from "../../lib/gameTypes";
import { COMPANIES, CompanyId } from "../../lib/gameData";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, players } = body;
  const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const defaultOrders: Record<string, any[]> = {};
  Object.keys(COMPANIES).forEach((id) => { defaultOrders[id] = []; });
  const session: GameSession = {
    gameCode, title: title || `ゲーム ${gameCode}`, createdAt: new Date().toISOString(),
    currentYear: 2015, currentQuarter: 1, currentPhase: 0, status: "playing",
    players: players || { A: "human", B: "ai-b", C: "ai-b", D: "ai-b", E: "ai-b" },
    confirmedOrders: defaultOrders as any,
  };
  const initialStates: Record<string, any> = {
    A: { cash: 20, totalAssets: 270, equity: 100, debtEquityRatio: 1.3, creditScore: 98, farmingArea: 1800, processingCapacity: 8000 },
    B: { cash: 20, totalAssets: 155, equity: 45, debtEquityRatio: 2.4, creditScore: 75, farmingArea: 1200, processingCapacity: 5000 },
    C: { cash: 6, totalAssets: 114, equity: 40, debtEquityRatio: 1.75, creditScore: 65, farmingArea: 800, processingCapacity: 3500 },
    D: { cash: 15, totalAssets: 270, equity: 90, debtEquityRatio: 2.0, creditScore: 85, farmingArea: 2200, processingCapacity: 9000 },
    E: { cash: 5, totalAssets: 105, equity: 25, debtEquityRatio: 2.8, creditScore: 60, farmingArea: 700, processingCapacity: 3000 },
  };
  await redis.set(`game:${gameCode}`, JSON.stringify(session));
  for (const [id, state] of Object.entries(initialStates)) {
    await redis.set(`game:${gameCode}:company:${id}`, JSON.stringify(state));
  }
  await redis.lpush("games", gameCode);
  return NextResponse.json({ gameCode, session });
}

export async function GET() {
  const codes = await redis.lrange("games", 0, 19);
  const sessions = await Promise.all(codes.map(async (code) => {
    const data = await redis.get(`game:${code}`);
    return data ? JSON.parse(data as string) : null;
  }));
  return NextResponse.json(sessions.filter(Boolean));
}
