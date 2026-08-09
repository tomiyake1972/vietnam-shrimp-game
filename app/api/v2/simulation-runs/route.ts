import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody, withSimulationRunApiContext } from "./_lib/context";
import { handleListSimulationRuns, handleSaveSimulationRun } from "./_lib/handlers";

// POST /api/v2/simulation-runs — Simulation Run の保存（32Q実行結果を丸ごと1回）。
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJsonBody(req);
  return withSimulationRunApiContext(req, (repository) => handleSaveSimulationRun(repository, body));
}

// GET /api/v2/simulation-runs — 保存済み Simulation Run の一覧（要約のみ）。
export async function GET(req: NextRequest): Promise<NextResponse> {
  return withSimulationRunApiContext(req, (repository) => handleListSimulationRuns(repository));
}
