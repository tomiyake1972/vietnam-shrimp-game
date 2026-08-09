import { NextRequest, NextResponse } from "next/server";
import { withSimulationRunApiContext } from "../_lib/context";
import { handleDeleteSimulationRun, handleLoadSimulationRun } from "../_lib/handlers";

interface RouteContext {
  readonly params: Promise<{ readonly simulationRunId: string }>;
}

// GET /api/v2/simulation-runs/{simulationRunId} — 保存済み Simulation Run の読み込み。
export async function GET(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { simulationRunId } = await context.params;
  return withSimulationRunApiContext(req, (repository) => handleLoadSimulationRun(repository, simulationRunId));
}

// DELETE /api/v2/simulation-runs/{simulationRunId} — 保存済み Simulation Run の削除。
export async function DELETE(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { simulationRunId } = await context.params;
  return withSimulationRunApiContext(req, (repository) => handleDeleteSimulationRun(repository, simulationRunId));
}
