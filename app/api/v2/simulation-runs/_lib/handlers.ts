// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run API ハンドラー
//
// Repository を注入して受け取る純粋なハンドラー（テストではインメモリ実装を渡す）。
// 例外を投げず、必ず {status, body} を返す。

import { SimulationRunRepository, SimulationRunSchemaError } from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { SimulationRunApiResult } from "./context";

function badRequest(message: string): SimulationRunApiResult {
  return { status: 400, body: { error: { code: "BAD_REQUEST", message } } };
}

export async function handleSaveSimulationRun(repository: SimulationRunRepository, body: unknown): Promise<SimulationRunApiResult> {
  if (typeof body !== "object" || body === null) {
    return badRequest("リクエストボディが JSON オブジェクトではありません。");
  }
  const candidate = body as Partial<StoredSimulationRun>;
  if (!candidate.run || !candidate.dataset || typeof candidate.savedAt !== "string") {
    return badRequest("run / dataset / savedAt のいずれかがありません。");
  }
  const stored: StoredSimulationRun = {
    // schemaVersion はサーバー側で必ず現行版へ確定させる（クライアントの申告を信用しない）。
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: candidate.run,
    dataset: candidate.dataset,
    savedAt: candidate.savedAt,
  };
  try {
    await repository.saveRun(stored);
  } catch (e) {
    if (e instanceof SimulationRunSchemaError) return badRequest(e.message);
    throw e;
  }
  return { status: 200, body: { simulationRunId: stored.run.simulationRunId, savedAt: stored.savedAt } };
}

export async function handleLoadSimulationRun(repository: SimulationRunRepository, simulationRunId: string): Promise<SimulationRunApiResult> {
  const stored = await repository.loadRun(simulationRunId);
  if (!stored) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: `Simulation Run が見つかりません（simulationRunId=${simulationRunId}）。` } } };
  }
  return { status: 200, body: stored };
}

export async function handleListSimulationRuns(repository: SimulationRunRepository): Promise<SimulationRunApiResult> {
  const runs = await repository.listRuns();
  return { status: 200, body: { runs } };
}

export async function handleDeleteSimulationRun(repository: SimulationRunRepository, simulationRunId: string): Promise<SimulationRunApiResult> {
  await repository.deleteRun(simulationRunId);
  return { status: 200, body: { simulationRunId, deleted: true } };
}
