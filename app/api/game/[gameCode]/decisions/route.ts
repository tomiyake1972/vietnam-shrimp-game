import { NextRequest, NextResponse } from "next/server";
import { redis } from "../../../../lib/redis";
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const body = await req.json();
  const { companyId, phases } = body;
  const gameData = await redis.get(`game:${gameCode}`);
  if (!gameData) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = JSON.parse(gameData as string);
  const key = `game:${gameCode}:decisions:${session.currentYear}Q${session.currentQuarter}:${companyId}`;
  const decision = { companyId, gameCode, year: session.currentYear, quarter: session.currentQuarter, submittedAt: new Date().toISOString(), phases };
  await redis.set(key, JSON.stringify(decision));
  return NextResponse.json({ success: true });
}
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const gameData = await redis.get(`game:${gameCode}`);
  if (!gameData) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = JSON.parse(gameData as string);
  const decisions: Record<string, any> = {};
  for (const id of ["A","B","C","D","E"]) {
    const key = `game:${gameCode}:decisions:${session.currentYear}Q${session.currentQuarter}:${id}`;
    const data = await redis.get(key);
    if (data) decisions[id] = JSON.parse(data as string);
  }
  return NextResponse.json(decisions);
}
