// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run Repository
//
// 会社ラボ本体の persistence/repository.ts と同じ設計方針を踏襲する。
//   - Repository 契約を1つ定義し、インメモリ実装と Redis 実装が同じ意味論を持つ
//   - 両実装を同じ契約テストで検証する
//   - キー生成・キーガードは redis/ 側へ委譲する
//
// 会社ラボ本体と違い、Simulation Run は**追記されない完成物**である
// （32Q を回し終えた結果を丸ごと1回保存する）。四半期ごとの原子コミット・
// 楽観ロック・処理ロックは必要ないため、意図的に持たない。

import { StoredSimulationRun, StoredSimulationRunManifest, SimulationRunSummary, isReadableSimulationRunSchema, toSimulationRunSummary } from "./types";

/** saveRunPart が受け付けるパート種別。 */
export type SimulationRunPart = "dataset" | "resume" | "pack";

export class SimulationRunNotFoundError extends Error {
  constructor(readonly simulationRunId: string) {
    super(`Simulation Run が見つかりません（simulationRunId=${simulationRunId}）。`);
    this.name = "SimulationRunNotFoundError";
  }
}

export class SimulationRunRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRunRepositoryError";
  }
}

export class SimulationRunSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRunSchemaError";
  }
}

/** 保存上限（古いものから消す）。無制限に貯めて Redis を圧迫しないための歯止め。 */
export const SIMULATION_RUN_RETENTION_LIMIT = 20;

export interface SimulationRunRepository {
  /**
   * 保存（同じ simulationRunId は上書きする＝同じ実行を保存し直せる）。
   * 【Turn14以降Save/Resume停止BLOCKER修正】呼び出し側が完全な StoredSimulationRun を
   * 一度に持っている場合の便宜メソッド（テスト・小さいpayload向け）。内部的には
   * saveRunPart×最大3回 → commitRunManifest の順で呼ぶのと同じ意味を持つ。
   * HTTP経由でクライアントから保存する場合は、1回のrequest bodyが巨大になるのを
   * 避けるため、API層はこのsaveRunではなく saveRunPart / commitRunManifest を
   * 個別のHTTP requestとして順に呼ぶ（simulation-runs/_lib/handlers.ts参照）。
   */
  saveRun(stored: StoredSimulationRun): Promise<void>;
  /**
   * 【Turn14以降Save/Resume停止BLOCKER修正】dataset/resumePayload/packCaptureの
   * いずれか1パートだけを、指定revisionのキーへ保存する。まだmanifestは更新しない
   * （＝この時点ではまだ「読み込み可能な完全な状態」として公開されない。
   * commitRunManifestが呼ばれて初めて公開される。指示§21/§22）。
   */
  saveRunPart(simulationRunId: string, revision: number, part: SimulationRunPart, value: unknown): Promise<void>;
  /**
   * 【Turn14以降Save/Resume停止BLOCKER修正】manifestを更新し、指定revisionを
   * 「読み込み可能な完全な状態」として公開する。呼び出し側は、この呼び出しより前に
   * 該当revisionのdataset（必須）・resume（hasResumePayloadがtrueなら必須）・
   * pack（hasPackCaptureがtrueなら必須）をすべてsaveRunPartで保存し終えている
   * こと（そうでない場合、後続のloadRunがパート欠落エラーを出す）。
   */
  commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary): Promise<void>;
  /** 読み込み。存在しなければ null。 */
  loadRun(simulationRunId: string): Promise<StoredSimulationRun | null>;
  /** 一覧（保存が新しい順）。dataset 本体は読まない。 */
  listRuns(limit?: number): Promise<readonly SimulationRunSummary[]>;
  /** 削除（存在しなくてもエラーにしない）。 */
  deleteRun(simulationRunId: string): Promise<void>;
}

/** 保存前の妥当性検証（呼び出し契約違反の早期検出。ストレージ層とは独立）。 */
export function assertStorableSimulationRun(stored: StoredSimulationRun): void {
  if (!isReadableSimulationRunSchema(stored.schemaVersion)) {
    throw new SimulationRunSchemaError(`保存できないスキーマ版です: ${JSON.stringify(stored.schemaVersion)}`);
  }
  if (typeof stored.run?.simulationRunId !== "string" || stored.run.simulationRunId.length === 0) {
    throw new SimulationRunRepositoryError("simulationRunId は空でない文字列である必要があります。");
  }
  if (stored.dataset === undefined || stored.dataset === null) {
    throw new SimulationRunRepositoryError("dataset が空です。実行結果のない Simulation Run は保存しません。");
  }
}

/** 読み込んだ値の検証。**現行より新しい版だけを拒否する。** */
export function parseStoredSimulationRun(raw: unknown, simulationRunId: string): StoredSimulationRun {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof parsed !== "object" || parsed === null) {
    throw new SimulationRunSchemaError(`保存されていた Simulation Run が壊れています（simulationRunId=${simulationRunId}）。`);
  }
  const candidate = parsed as Partial<StoredSimulationRun>;
  if (!isReadableSimulationRunSchema(candidate.schemaVersion)) {
    throw new SimulationRunSchemaError(
      `保存されていた Simulation Run のスキーマ版（${JSON.stringify(candidate.schemaVersion)}）を読み込めません（simulationRunId=${simulationRunId}）。`
    );
  }
  if (!candidate.run || !candidate.dataset) {
    throw new SimulationRunSchemaError(`保存されていた Simulation Run に run または dataset がありません（simulationRunId=${simulationRunId}）。`);
  }
  return candidate as StoredSimulationRun;
}

/** 保存が新しい順に並べ、上限で切る（両実装で同じ順序・同じ件数になるようにする）。 */
export function sortAndLimitSummaries(summaries: readonly SimulationRunSummary[], limit: number): readonly SimulationRunSummary[] {
  return [...summaries]
    .sort((a, b) => (a.savedAt === b.savedAt ? a.simulationRunId.localeCompare(b.simulationRunId) : a.savedAt < b.savedAt ? 1 : -1))
    .slice(0, limit);
}

// ---------------------------------------------------------------------
// インメモリ実装（テスト・契約検証用）
// ---------------------------------------------------------------------

export function createInMemorySimulationRunRepository(): SimulationRunRepository {
  const runs = new Map<string, StoredSimulationRun>();
  // simulationRunId → revision → part → value（commitRunManifestで公開されるまで見えない）。
  const pendingParts = new Map<string, Map<number, Partial<Record<SimulationRunPart, unknown>>>>();

  async function saveRun(stored: StoredSimulationRun): Promise<void> {
    assertStorableSimulationRun(stored);
    const revision = stored.persistenceRevision ?? 1;
    await saveRunPart(stored.run.simulationRunId, revision, "dataset", stored.dataset);
    if (stored.resumePayload !== undefined) await saveRunPart(stored.run.simulationRunId, revision, "resume", stored.resumePayload);
    if (stored.packCapture !== undefined) await saveRunPart(stored.run.simulationRunId, revision, "pack", stored.packCapture);
    await commitRunManifest(
      {
        schemaVersion: stored.schemaVersion,
        run: stored.run,
        persistenceRevision: revision,
        savedAt: stored.savedAt,
        hasResumePayload: stored.resumePayload !== undefined,
        hasPackCapture: stored.packCapture !== undefined,
      },
      toSimulationRunSummary(stored)
    );
  }

  async function saveRunPart(simulationRunId: string, revision: number, part: SimulationRunPart, value: unknown): Promise<void> {
    const byRevision = pendingParts.get(simulationRunId) ?? new Map<number, Partial<Record<SimulationRunPart, unknown>>>();
    const parts = byRevision.get(revision) ?? {};
    parts[part] = value;
    byRevision.set(revision, parts);
    pendingParts.set(simulationRunId, byRevision);
  }

  async function commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary): Promise<void> {
    const parts = pendingParts.get(manifest.run.simulationRunId)?.get(manifest.persistenceRevision) ?? {};
    const stored: StoredSimulationRun = {
      schemaVersion: manifest.schemaVersion,
      run: manifest.run,
      dataset: parts.dataset as StoredSimulationRun["dataset"],
      resumePayload: manifest.hasResumePayload ? (parts.resume as StoredSimulationRun["resumePayload"]) : undefined,
      packCapture: manifest.hasPackCapture ? (parts.pack as StoredSimulationRun["packCapture"]) : undefined,
      savedAt: manifest.savedAt,
      persistenceRevision: manifest.persistenceRevision,
    };
    assertStorableSimulationRun(stored);
    runs.set(stored.run.simulationRunId, stored);
    void summary; // インメモリ実装は toSimulationRunSummary(stored) を都度計算するため要約を別保持しない
    // 保存上限を超えたら、保存が古いものから消す（Redis 実装と同じ意味論）。
    const ordered = sortAndLimitSummaries([...runs.values()].map(toSimulationRunSummary), Number.MAX_SAFE_INTEGER);
    for (const evicted of ordered.slice(SIMULATION_RUN_RETENTION_LIMIT)) {
      runs.delete(evicted.simulationRunId);
    }
  }

  async function loadRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
    return runs.get(simulationRunId) ?? null;
  }

  async function listRuns(limit = SIMULATION_RUN_RETENTION_LIMIT): Promise<readonly SimulationRunSummary[]> {
    return sortAndLimitSummaries([...runs.values()].map(toSimulationRunSummary), limit);
  }

  async function deleteRun(simulationRunId: string): Promise<void> {
    runs.delete(simulationRunId);
  }

  return { saveRun, saveRunPart, commitRunManifest, loadRun, listRuns, deleteRun };
}
