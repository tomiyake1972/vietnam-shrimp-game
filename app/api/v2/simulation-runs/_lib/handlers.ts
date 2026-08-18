// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run API ハンドラー
//
// Repository を注入して受け取る純粋なハンドラー（テストではインメモリ実装を渡す）。
// 例外を投げず、必ず {status, body} を返す。

import { SimulationRunPart, SimulationRunRepository, SimulationRunSchemaError } from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun, StoredSimulationRunManifest, manifestToSimulationRunSummary } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { SimulationRunApiResult } from "./context";

function badRequest(message: string): SimulationRunApiResult {
  return { status: 400, body: { error: { code: "BAD_REQUEST", message } } };
}

function gameFinishedConflict(simulationRunId: string, gameEndedAt: string): SimulationRunApiResult {
  return {
    status: 409,
    body: {
      error: {
        code: "GAME_FINISHED",
        message: `この Simulation Run（${simulationRunId}）は既に Game Master によって終了しています（gameEndedAt=${gameEndedAt}）。終了後の Turn 進行・意思決定変更は保存できません。`,
      },
    },
  };
}

/**
 * 【Game End / Final Results・END-1・指示§5】UIで隠すだけでなく、server-side
 * mutationもFINISHED時は拒否する。既にcommit済みのmanifestがgameEndedAtを
 * 持っていれば、以後のこのRunへの保存（part保存・manifest commitの両方）を
 * 一律で拒否する（Reopenは今回不要・例外を作らない）。
 * ゲーム終了そのものを確定させる保存（＝この時点でまだcommit済みmanifestに
 * gameEndedAtが無い）は、この関数が呼ばれる前段階なので通過する。
 */
async function checkNotAlreadyFinished(repository: SimulationRunRepository, simulationRunId: string): Promise<SimulationRunApiResult | null> {
  const existing = await repository.loadRun(simulationRunId);
  const existingGameEndedAt = existing?.run.gameEndedAt ?? null;
  if (existingGameEndedAt) return gameFinishedConflict(simulationRunId, existingGameEndedAt);
  return null;
}

const VALID_PARTS: readonly SimulationRunPart[] = ["dataset", "resume", "pack"];

/**
 * 【Turn14以降Save/Resume停止BLOCKER修正】dataset/resumePayload/packCaptureの
 * いずれか1パートを保存する。1回のHTTP requestが小さく収まるよう、クライアントは
 * これを複数回（part単位）に分けて呼ぶ（simulationRunStore.ts の saveToServer 参照）。
 * まだmanifestは更新しない＝この時点ではまだ「読み込み可能な完全な状態」として
 * 公開されない。
 */
export async function handleSaveSimulationRunPart(repository: SimulationRunRepository, body: unknown): Promise<SimulationRunApiResult> {
  if (typeof body !== "object" || body === null) {
    return badRequest("リクエストボディが JSON オブジェクトではありません。");
  }
  const candidate = body as { simulationRunId?: unknown; revision?: unknown; part?: unknown; value?: unknown };
  if (typeof candidate.simulationRunId !== "string" || candidate.simulationRunId.length === 0) {
    return badRequest("simulationRunId が空です。");
  }
  if (typeof candidate.revision !== "number" || !Number.isFinite(candidate.revision)) {
    return badRequest("revision が数値ではありません。");
  }
  if (typeof candidate.part !== "string" || !VALID_PARTS.includes(candidate.part as SimulationRunPart)) {
    return badRequest(`part は ${VALID_PARTS.join(" / ")} のいずれかである必要があります。`);
  }
  if (candidate.value === undefined) {
    return badRequest("value がありません。");
  }
  const lockConflict = await checkNotAlreadyFinished(repository, candidate.simulationRunId);
  if (lockConflict) return lockConflict;
  try {
    await repository.saveRunPart(candidate.simulationRunId, candidate.revision, candidate.part as SimulationRunPart, candidate.value);
  } catch (e) {
    if (e instanceof SimulationRunSchemaError) return badRequest(e.message);
    throw e;
  }
  return { status: 200, body: { simulationRunId: candidate.simulationRunId, revision: candidate.revision, part: candidate.part } };
}

/**
 * 【Turn14以降Save/Resume停止BLOCKER修正】manifestをcommitする（＝該当revisionを
 * 「読み込み可能な完全な状態」として公開する）。呼び出し側は、この呼び出しより前に
 * 該当revisionの全パートをhandleSaveSimulationRunPart経由で保存し終えていること。
 *
 * 【後方互換】旧クライアント（dataset/resumePayload/packCaptureを直接bodyへ埋め込む
 * 形）からの呼び出しも引き続き受け付ける（小さいpayloadであれば単発で成立するため）。
 * その場合はrepository.saveRunへフォールバックする。
 */
export async function handleSaveSimulationRun(repository: SimulationRunRepository, body: unknown): Promise<SimulationRunApiResult> {
  if (typeof body !== "object" || body === null) {
    return badRequest("リクエストボディが JSON オブジェクトではありません。");
  }
  const candidate = body as Partial<StoredSimulationRun> & Partial<StoredSimulationRunManifest> & { readonly manifestOnly?: boolean };

  if (candidate.manifestOnly) {
    if (!candidate.run || typeof candidate.savedAt !== "string" || typeof candidate.persistenceRevision !== "number") {
      return badRequest("run / savedAt / persistenceRevision のいずれかがありません。");
    }
    const manifest: StoredSimulationRunManifest = {
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: candidate.run,
      persistenceRevision: candidate.persistenceRevision,
      savedAt: candidate.savedAt,
      hasResumePayload: candidate.hasResumePayload === true,
      hasPackCapture: candidate.hasPackCapture === true,
    };
    const lockConflict = await checkNotAlreadyFinished(repository, manifest.run.simulationRunId);
    if (lockConflict) return lockConflict;
    try {
      await repository.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest));
    } catch (e) {
      if (e instanceof SimulationRunSchemaError) return badRequest(e.message);
      throw e;
    }
    return { status: 200, body: { simulationRunId: manifest.run.simulationRunId, savedAt: manifest.savedAt, persistenceRevision: manifest.persistenceRevision } };
  }

  // 旧形式（dataset等を直接bodyへ埋め込む単発保存）。
  if (!candidate.run || !candidate.dataset || typeof candidate.savedAt !== "string") {
    return badRequest("run / dataset / savedAt のいずれかがありません。");
  }
  const stored: StoredSimulationRun = {
    // schemaVersion はサーバー側で必ず現行版へ確定させる（クライアントの申告を信用しない）。
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: candidate.run,
    dataset: candidate.dataset,
    // 【Turn14以降Save/Resume停止BLOCKER修正で判明した実バグの修正】
    // 旧実装はここで resumePayload と persistenceRevision をクライアントから
    // 受け取っていながら保存対象へ含めておらず、server保存物が常に
    // resumePayload無し（＝VIEW_ONLY）・常にpersistenceRevision無し
    // （＝freshness比較で常にrevision=0扱い、browser側に常に敗ける）という
    // 実バグになっていた。
    resumePayload: candidate.resumePayload,
    packCapture: candidate.packCapture,
    savedAt: candidate.savedAt,
    persistenceRevision: candidate.persistenceRevision,
  };
  const lockConflict = await checkNotAlreadyFinished(repository, stored.run.simulationRunId);
  if (lockConflict) return lockConflict;
  try {
    await repository.saveRun(stored);
  } catch (e) {
    if (e instanceof SimulationRunSchemaError) return badRequest(e.message);
    throw e;
  }
  return { status: 200, body: { simulationRunId: stored.run.simulationRunId, savedAt: stored.savedAt, persistenceRevision: stored.persistenceRevision } };
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
