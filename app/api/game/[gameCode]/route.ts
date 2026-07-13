import { NextRequest, NextResponse } from "next/server";
import { redis } from "../../../lib/redis";
export async function GET(_: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const data = await redis.get(`game:${gameCode}`);
  if (!data) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = JSON.parse(data as string);
  const companyStates: Record<string, any> = {};
  for (const id of ["A","B","C","D","E"]) {
    const state = await redis.get(`game:${gameCode}:company:${id}`);
    if (state) companyStates[id] = JSON.parse(state as string);
  }
  return NextResponse.json({ session, companyStates });
}
