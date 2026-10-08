// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run Repository
//
// 会社ラボ本体の persistence/repository.ts と同じ設計方針を踏襲する。
//   - Repository 契約を1つ定義し、インメモリ実装と Redis 実装が同じ意味論を持つ
//   - 両実装を同じ契約テストで検証する
//   - キー生成・キーガードは redis/ 側へ委譲する
//
// 【O1・前提の是正】かつてここには「Simulation Run は追記されない完成物なので
// 楽観ロックは要らない」と書かれていたが、Independent Player Flow の導入で前提が
// 変わっている。いまは GM の Turn 保存と、別端末の PLAYER 提出が、同じ Run の
// resumePayload を並行に read-modify-write する。実測で、GM の保存が PLAYER の
// 提出を storage 実体から消す DATA LOSS を確認した。
// そのため本契約は「保存は正本 revision を基準にした CAS である」を正本にする:
//   - 書き手は読んだ正本の revision を expectedBaseRevision として申告する
//   - commit 時に公開中の revision と一致しなければ SimulationRunStaleRevisionError
//   - 同じ base を読んだ2つの書き手のうち、commit に成功するのは必ず一方だけ
//   - 未公開パートは attempt ごとの writeToken で分離し、敗者が勝者のパートを壊さない
// インメモリ実装と Redis 実装は、この意味論を完全に同じにする。

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

/**
 * 【O1】保存しようとした基準 revision が、既に公開中の revision と食い違っている。
 * 古い正本を元に作った保存を、新しい正本の上へ被せてはいけない。
 */
export class SimulationRunStaleRevisionError extends Error {
  constructor(
    readonly simulationRunId: string,
    readonly expectedBaseRevision: number,
    readonly currentPublishedRevision: number
  ) {
    super(
      `保存の基準が古くなっています（simulationRunId=${simulationRunId}, 読んだrevision=${expectedBaseRevision}, 現在公開中のrevision=${currentPublishedRevision}）。` +
        "最新を読み直してから保存し直してください。"
    );
    this.name = "SimulationRunStaleRevisionError";
  }
}

/**
 * 【O1】1回の保存attempt（パート保存〜manifest commit）を識別する情報。
 *
 * expectedBaseRevision:
 *   「私は正本のこの revision を読み、それを元にこの保存内容を作った」という申告。
 *   公開中の revision が別の値になっていれば commit は拒否される。
 *   revision を持たない旧Runは 0 として扱う（migrationしない）。
 * writeToken:
 *   このattemptの未公開パートを、他のwriterのパートと混ぜないための一意な識別子。
 *   commitに成功したattemptのパートだけが正本として公開される。
 */
export interface SimulationRunWriteAttempt {
  readonly expectedBaseRevision: number;
  readonly writeToken: string;
}

/**
 * 【O1】保存attemptごとに一意な writeToken を作る。
 *
 * 【revision番号を token にしてはいけない】同じ正本を読んだ2つのwriterは同じ
 * 「基準+1」を選ぶため、revisionから作った token は衝突する。衝突すると未公開パートの
 * 置き場を奪い合い、part collisionを防ぐという目的そのものが達成できない。
 * 時刻と乱数を混ぜて、writer・プロセス・retryをまたいで衝突しないようにする。
 * キー文字列へ入るため、使う文字は英数字とハイフンだけに限る
 * （simulationRunRedisKeys.ts の assertValidSimulationRunWriteToken と同じ制約）。
 */
export function createSimulationRunWriteToken(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
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
  saveRun(stored: StoredSimulationRun, attempt?: SimulationRunWriteAttempt): Promise<void>;
  /**
   * 【Turn14以降Save/Resume停止BLOCKER修正】dataset/resumePayload/packCaptureの
   * いずれか1パートだけを、指定revisionのキーへ保存する。まだmanifestは更新しない
   * （＝この時点ではまだ「読み込み可能な完全な状態」として公開されない。
   * commitRunManifestが呼ばれて初めて公開される。指示§21/§22）。
   */
  saveRunPart(simulationRunId: string, attempt: SimulationRunWriteAttempt, part: SimulationRunPart, value: unknown): Promise<void>;
  /**
   * 【Turn14以降Save/Resume停止BLOCKER修正】manifestを更新し、指定revisionを
   * 「読み込み可能な完全な状態」として公開する。呼び出し側は、この呼び出しより前に
   * 該当revisionのdataset（必須）・resume（hasResumePayloadがtrueなら必須）・
   * pack（hasPackCaptureがtrueなら必須）をすべてsaveRunPartで保存し終えている
   * こと（そうでない場合、後続のloadRunがパート欠落エラーを出す）。
   */
  commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary, attempt: SimulationRunWriteAttempt): Promise<void>;

  /**
   * 【O1】現在公開中の revision を返す（保存物が無ければ 0）。
   * 書き手が expectedBaseRevision を決めるための唯一の正当な入口。
   * 旧Run（persistenceRevision 未設定）も 0 を返す。
   */
  currentPublishedRevision(simulationRunId: string): Promise<number>;
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
  /**
   * 未公開パート。simulationRunId → writeToken → part → value。
   * 【O1】キーを revision ではなく writeToken にしてある。revision で分けていた頃は、
   * 同じ正本を読んだ2つのwriterが同じ新revision番号を選び、同じ置き場を奪い合っていた。
   */
  const pendingParts = new Map<string, Map<string, Partial<Record<SimulationRunPart, unknown>>>>();

  function publishedRevisionOf(simulationRunId: string): number {
    return runs.get(simulationRunId)?.persistenceRevision ?? 0;
  }

  async function currentPublishedRevision(simulationRunId: string): Promise<number> {
    return publishedRevisionOf(simulationRunId);
  }

  async function saveRun(stored: StoredSimulationRun, attempt?: SimulationRunWriteAttempt): Promise<void> {
    assertStorableSimulationRun(stored);
    const runId = stored.run.simulationRunId;
    /**
     * 【便宜メソッドのattempt省略時】現在公開中のrevisionをその場で読み、それを基準にする。
     * 単一の呼び出し元が完全なStoredSimulationRunを持っている場合（テスト・旧形式保存）
     * のための経路であり、並行writerがいる V2 PLAYER 保存経路はこの省略形を使わない
     * （必ず呼び出し側が読んだrevisionをexpectedBaseRevisionとして渡す）。
     */
    const effective: SimulationRunWriteAttempt = attempt ?? {
      expectedBaseRevision: publishedRevisionOf(runId),
      writeToken: createSimulationRunWriteToken("inline"),
    };
    const revision = stored.persistenceRevision ?? effective.expectedBaseRevision + 1;
    await saveRunPart(runId, effective, "dataset", stored.dataset);
    if (stored.resumePayload !== undefined) await saveRunPart(runId, effective, "resume", stored.resumePayload);
    if (stored.packCapture !== undefined) await saveRunPart(runId, effective, "pack", stored.packCapture);
    await commitRunManifest(
      {
        schemaVersion: stored.schemaVersion,
        run: stored.run,
        persistenceRevision: revision,
        savedAt: stored.savedAt,
        hasResumePayload: stored.resumePayload !== undefined,
        hasPackCapture: stored.packCapture !== undefined,
      },
      toSimulationRunSummary(stored),
      effective
    );
  }

  async function saveRunPart(simulationRunId: string, attempt: SimulationRunWriteAttempt, part: SimulationRunPart, value: unknown): Promise<void> {
    const byToken = pendingParts.get(simulationRunId) ?? new Map<string, Partial<Record<SimulationRunPart, unknown>>>();
    const parts = byToken.get(attempt.writeToken) ?? {};
    parts[part] = value;
    byToken.set(attempt.writeToken, parts);
    pendingParts.set(simulationRunId, byToken);
  }

  async function commitRunManifest(manifest: StoredSimulationRunManifest, summary: SimulationRunSummary, attempt: SimulationRunWriteAttempt): Promise<void> {
    const runId = manifest.run.simulationRunId;
    // 【CAS】公開中のrevisionが、このwriterが読んだrevisionと違えば正本化しない。
    const published = publishedRevisionOf(runId);
    if (published !== attempt.expectedBaseRevision) {
      throw new SimulationRunStaleRevisionError(runId, attempt.expectedBaseRevision, published);
    }
    // 【このattemptのパートだけを昇格させる】他writerのパートは混ざらない。
    const parts = pendingParts.get(runId)?.get(attempt.writeToken) ?? {};
    /**
     * 【部分保存を正本化しない】Redis実装のLuaが EXISTS で同じ検査をしている。
     * 両実装で意味論を揃えるため、インメモリ側でも欠落を明示的に弾く
     * （揃っていないまま公開すると、loadRunが resumePayload 無しの状態を返し、
     * Runが「続きからプレイできない」形で正本化されてしまう）。
     */
    if (parts.dataset === undefined) {
      throw new SimulationRunRepositoryError(`Simulation Run の保存パートが揃っていません（simulationRunId=${runId}, part=dataset）。`);
    }
    if (manifest.hasResumePayload && parts.resume === undefined) {
      throw new SimulationRunRepositoryError(`Simulation Run の保存パートが揃っていません（simulationRunId=${runId}, part=resume）。`);
    }
    if (manifest.hasPackCapture && parts.pack === undefined) {
      throw new SimulationRunRepositoryError(`Simulation Run の保存パートが揃っていません（simulationRunId=${runId}, part=pack）。`);
    }
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
    runs.set(runId, stored);
    // 昇格済みのattemptは片付ける（敗者のパートは孤児として残るが、公開されることはない）。
    pendingParts.get(runId)?.delete(attempt.writeToken);
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
    pendingParts.delete(simulationRunId);
  }

  return { saveRun, saveRunPart, commitRunManifest, loadRun, listRuns, deleteRun, currentPublishedRevision };
}
