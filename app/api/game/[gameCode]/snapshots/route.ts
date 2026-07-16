import { NextRequest, NextResponse } from "next/server";
import { redis, parseStored } from "../../../../lib/redis";
import { GameSession } from "../../../../lib/gameTypes";
import { gameKey } from "../../../../lib/redisKeys";
import { normalizeGameSession, isValidTestGameSession } from "../../../../lib/gameSession";
import { createGameSnapshot, listGameSnapshots } from "../../../../lib/gameSnapshot";
import { assertStagingAdmin } from "../../../../lib/stagingAdmin";

// スナップショット一覧の取得は読み取りのみのため管理トークンを要求しない
// （ラベル・作成日時・年/四半期/フェーズのみを返し、破壊的操作ではないため）。
// ただし対象がテストゲームでない場合は空配列を返す（本番ゲームにスナップショットは存在しない）。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const { gameCode } = await params;
  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  if (!isValidTestGameSession(session)) {
    return NextResponse.json({ snapshots: [] });
  }

  const snapshots = await listGameSnapshots(gameCode);
  return NextResponse.json({ snapshots });
}

// スナップショットの作成は状態を変更する（Redisへの書き込み）ため管理トークンが必要。
export async function POST(req: NextRequest, { params }: { params: Promise<{ gameCode: string }> }) {
  const auth = assertStagingAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { gameCode } = await params;
  const body = await req.json().catch(() => ({}));
  const { label } = body as { label?: string };

  const sessionData = await redis.get(gameKey(gameCode));
  const stored = parseStored<GameSession>(sessionData);
  if (!stored) return NextResponse.json({ error: "Game not found" }, { status: 404 });
  const session = normalizeGameSession(stored);

  if (!isValidTestGameSession(session)) {
    return NextResponse.json({ error: "この操作はテストゲームでのみ利用できます。" }, { status: 403 });
  }

  const snapshot = await createGameSnapshot(gameCode, session, label ?? "");
  return NextResponse.json({
    id: snapshot.id,
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    year: snapshot.session.currentYear,
    quarter: snapshot.session.currentQuarter,
    phase: snapshot.session.currentPhase,
  });
}
