// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run API ハンドラー
//
// Repository を注入して受け取る純粋なハンドラー（テストではインメモリ実装を渡す）。
// 例外を投げず、必ず {status, body} を返す。

import {
  SimulationRunPart,
  SimulationRunRepository,
  SimulationRunSchemaError,
  SimulationRunStaleRevisionError,
  SimulationRunWriteAttempt,
  createSimulationRunWriteToken,
} from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import {
  SIMULATION_RUN_DELTA_BASE_MISMATCH,
  SimulationRunPartMergeError,
  maxTurnOfSimulationRunPart,
  mergeSimulationRunPart,
  parseSimulationRunPartSource,
} from "../../../../lib/v2/companyLab/simulation/persistence/partWire";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun, StoredSimulationRunManifest, manifestToSimulationRunSummary } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { CompanyControlMode } from "../../../../lib/v2/companyLab/simulation/types";
import { SimulationRunApiResult } from "./context";

/**
 * 【Independent Player Flow・指示「UI disabledだけでなくserver processing側でも守る」】
 * GMが参加linkを発行した（＝Independent Player Flowへ組み入れた）PLAYER会社について、
 * 該当Turnの提出が揃っていなければmanifest commit（＝Turn進行の確定）を拒否する。
 *
 * 【GM代理操作との整合】GMが参加linkを一度も発行していない会社（従来どおりGMが
 * 「この会社を操作」で代理入力するだけの会社）はこのgateの対象外とする
 * （既存のClient側missingPlayerCompanies判定にそのまま委ねる。GM自身のブラウザ
 * セッションでの代理操作は元々GM本人が信頼主体であり、今回新設する
 * server-side gateは「独立した別セッションのPlayerが本当に提出したか」を
 * GMが検証できない、という新しい非対称性を埋めるためのものであるため）。
 */
export interface PlayerSeatSubmissionGate {
  checkTurnAdvanceAllowed(
    runId: string,
    completedTurn: number,
    companyControlModes: Readonly<Record<string, CompanyControlMode>> | undefined
  ): Promise<{ readonly allowed: boolean; readonly missingCompanyIds: readonly string[] }>;
}

function badRequest(message: string): SimulationRunApiResult {
  return { status: 400, body: { error: { code: "BAD_REQUEST", message } } };
}

/**
 * 【O1】保存の基準revisionが古い。クライアントは最新を読み直し、
 * 自分の変更を最新へ安全に再適用できる場合だけ作り直して再保存する
 * （同じpayloadのrevisionだけ上げて再送してはいけない）。
 */
/**
 * 【FOT-1】差分追記・再利用の土台（基準 revision のパート）が噛み合わない。
 *
 * STALE_PERSISTENCE_REVISION とは意味が違う（あちらは「他のwriterが先に公開した」）。
 * こちらは「送り方を軽くしようとしたが土台が無い／ずれている」であり、
 * クライアントは同じ内容を**完全な値**で送り直せば解決する。混同させないため
 * 別コードにする。
 */
function deltaBaseMismatch(part: SimulationRunPart, fromRevision: number, message: string): SimulationRunApiResult {
  return {
    status: 409,
    body: {
      error: {
        code: SIMULATION_RUN_DELTA_BASE_MISMATCH,
        message: `${message} 完全な値で保存し直してください。`,
        part,
        fromRevision,
      },
    },
  };
}

function staleRevisionConflict(e: SimulationRunStaleRevisionError): SimulationRunApiResult {
  return {
    status: 409,
    body: {
      error: {
        code: "STALE_PERSISTENCE_REVISION",
        message: e.message,
        expectedBaseRevision: e.expectedBaseRevision,
        currentPublishedRevision: e.currentPublishedRevision,
      },
    },
  };
}

/**
 * 【O1】保存attempt（expectedBaseRevision / writeToken）をリクエストから取り出す。
 * どちらも省略不可にはしない（旧クライアント互換のため）。省略された場合は
 * legacy pathとして扱い、その場で公開中revisionを基準に採る。
 * ただしlegacy pathはPLAYER提出の競合を閉じられないため、V2のPLAYER保存経路
 * （simulationRunStore.ts / submitPlayerDecision）は必ず両方を送る。
 */
function parseWriteAttempt(candidate: { readonly expectedBaseRevision?: unknown; readonly writeToken?: unknown }): SimulationRunWriteAttempt | "invalid" | null {
  const hasBase = candidate.expectedBaseRevision !== undefined;
  const hasToken = candidate.writeToken !== undefined;
  if (!hasBase && !hasToken) return null;
  if (typeof candidate.expectedBaseRevision !== "number" || !Number.isFinite(candidate.expectedBaseRevision) || candidate.expectedBaseRevision < 0) return "invalid";
  if (typeof candidate.writeToken !== "string" || candidate.writeToken.length === 0) return "invalid";
  return { expectedBaseRevision: candidate.expectedBaseRevision, writeToken: candidate.writeToken };
}

/** legacy path（attempt未指定）のための、その場読み取り基準。 */
async function inlineAttempt(repository: SimulationRunRepository, simulationRunId: string): Promise<SimulationRunWriteAttempt> {
  const base = await repository.currentPublishedRevision(simulationRunId);
  return { expectedBaseRevision: base, writeToken: createSimulationRunWriteToken("legacy") };
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
  // 【BW-1】見るのは run.gameEndedAt だけ。これは manifest に入っているので、
  // dataset / resumePayload / packCapture は読まない（保存1回ごとに巨大な
  // パートを読み直していた分の転送量を落とす）。
  const existing = await repository.loadRun(simulationRunId, { include: { dataset: false, resume: false, pack: false } });
  const existingGameEndedAt = existing?.run.gameEndedAt ?? null;
  if (existingGameEndedAt) return gameFinishedConflict(simulationRunId, existingGameEndedAt);
  return null;
}

function playerSubmissionRequiredConflict(missingCompanyIds: readonly string[]): SimulationRunApiResult {
  return {
    status: 409,
    body: {
      error: {
        code: "PLAYER_SUBMISSION_REQUIRED",
        message: `PLAYER会社の意思決定が未提出のため、Turnを進められません（未提出: ${missingCompanyIds.join(", ")}）。`,
        missingCompanyIds,
      },
    },
  };
}

/**
 * 【指示「UI disabledだけでなくserver processing側でも守る」】completedTurnsが
 * 既存保存値より増える（＝Turnが新しく確定・commitされる）瞬間だけ検査する。
 * 経営モード変更・Vision override保存等、completedTurnsが変わらない保存では
 * 一切ブロックしない（この保存自体はTurn進行ではないため）。
 */
async function checkPlayerSeatsSubmittedForAdvance(
  repository: SimulationRunRepository,
  playerSeatGate: PlayerSeatSubmissionGate,
  candidateRun: { readonly simulationRunId: string; readonly completedTurns: number; readonly companyControlModes?: Readonly<Record<string, CompanyControlMode>> }
): Promise<SimulationRunApiResult | null> {
  // 【BW-1】見るのは run.completedTurns だけ（manifest に入っている）。
  const existing = await repository.loadRun(candidateRun.simulationRunId, { include: { dataset: false, resume: false, pack: false } });
  const existingCompletedTurns = existing?.run.completedTurns ?? 0;
  if (candidateRun.completedTurns <= existingCompletedTurns) return null;
  const gate = await playerSeatGate.checkTurnAdvanceAllowed(candidateRun.simulationRunId, candidateRun.completedTurns, candidateRun.companyControlModes);
  if (gate.allowed) return null;
  return playerSubmissionRequiredConflict(gate.missingCompanyIds);
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
  const candidate = body as {
    simulationRunId?: unknown;
    revision?: unknown;
    part?: unknown;
    value?: unknown;
    expectedBaseRevision?: unknown;
    writeToken?: unknown;
    /** 【FOT-1】このパートは前の revision から変わっていない（value は送らない）。 */
    reuseFromRevision?: unknown;
    /** 【FOT-1】この revision のパートへ value（差分）を turn キーで追記する。 */
    appendFromRevision?: unknown;
    /** 【FOT-1】追記後に期待する最大 turn（土台ずれの検知用）。 */
    expectedMaxTurn?: unknown;
  };
  if (typeof candidate.simulationRunId !== "string" || candidate.simulationRunId.length === 0) {
    return badRequest("simulationRunId が空です。");
  }
  if (typeof candidate.revision !== "number" || !Number.isFinite(candidate.revision)) {
    return badRequest("revision が数値ではありません。");
  }
  if (typeof candidate.part !== "string" || !VALID_PARTS.includes(candidate.part as SimulationRunPart)) {
    return badRequest(`part は ${VALID_PARTS.join(" / ")} のいずれかである必要があります。`);
  }
  const part = candidate.part as SimulationRunPart;
  /**
   * 【FOT-1・送信量削減】value（完全な値）のほかに reuse（変わっていない）と
   * append（増えた行だけ）を受け付ける。どれで来たかはここで1回だけ判定する。
   */
  const source = parseSimulationRunPartSource(part, candidate);
  if ("error" in source) {
    return badRequest(source.error);
  }
  const parsedAttempt = parseWriteAttempt(candidate);
  if (parsedAttempt === "invalid") {
    return badRequest("expectedBaseRevision（0以上の数値）と writeToken（空でない文字列）は同時に指定してください。");
  }
  const lockConflict = await checkNotAlreadyFinished(repository, candidate.simulationRunId);
  if (lockConflict) return lockConflict;
  try {
    /**
     * 【O1】未公開パートはattempt固有の置き場へ書く。attempt未指定のlegacy pathでは
     * その場で公開中revisionを読んで基準にする（旧クライアント互換）。
     */
    const attempt = parsedAttempt ?? (await inlineAttempt(repository, candidate.simulationRunId));
    const runId = candidate.simulationRunId;

    if (source.kind === "value") {
      await repository.saveRunPart(runId, attempt, part, source.value);
    } else if (source.kind === "reuse") {
      /**
       * 変わっていないパートは Redis 内でコピーする（ブラウザからは数十バイトしか出ない）。
       * コピー元が無ければ差分の土台が崩れているため、正本化せずクライアントへ
       * 「完全な値で送り直せ」と返す。
       */
      const copied = await repository.stagePartFromPublished(runId, attempt, part, source.fromRevision);
      if (!copied) {
        return deltaBaseMismatch(part, source.fromRevision, `再利用元（revision=${source.fromRevision}）の ${part} が見つかりません。`);
      }
    } else {
      const published = await repository.readPublishedPart(runId, part, source.fromRevision);
      if (published === undefined) {
        return deltaBaseMismatch(part, source.fromRevision, `差分追記の土台（revision=${source.fromRevision}）の ${part} が見つかりません。`);
      }
      const merged = mergeSimulationRunPart(part, published, source.delta);
      /**
       * 【差分が噛み合っていないまま正本化しない】マージ結果の最大turnが
       * クライアントの申告と違えば、土台がずれている（＝取りこぼしがある）。
       * ここで止めなければ、あとで ExportPackButton の findStaleness に
       * 引っかかって AI Analysis Pack が出せない Run になる。
       */
      const mergedMaxTurn = maxTurnOfSimulationRunPart(part, merged);
      if (mergedMaxTurn !== source.expectedMaxTurn) {
        return deltaBaseMismatch(
          part,
          source.fromRevision,
          `差分追記の結果が期待と一致しません（期待する最大turn=${source.expectedMaxTurn}, 実際=${mergedMaxTurn}）。`
        );
      }
      await repository.saveRunPart(runId, attempt, part, merged);
    }
  } catch (e) {
    if (e instanceof SimulationRunPartMergeError) {
      return deltaBaseMismatch(part, -1, e.message);
    }
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
export async function handleSaveSimulationRun(
  repository: SimulationRunRepository,
  body: unknown,
  playerSeatGate?: PlayerSeatSubmissionGate
): Promise<SimulationRunApiResult> {
  if (typeof body !== "object" || body === null) {
    return badRequest("リクエストボディが JSON オブジェクトではありません。");
  }
  const candidate = body as Partial<StoredSimulationRun> &
    Partial<StoredSimulationRunManifest> & {
      readonly manifestOnly?: boolean;
      readonly expectedBaseRevision?: unknown;
      readonly writeToken?: unknown;
    };

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
    if (playerSeatGate) {
      const advanceConflict = await checkPlayerSeatsSubmittedForAdvance(repository, playerSeatGate, manifest.run);
      if (advanceConflict) return advanceConflict;
    }
    const parsedAttempt = parseWriteAttempt(candidate);
    if (parsedAttempt === "invalid") {
      return badRequest("expectedBaseRevision（0以上の数値）と writeToken（空でない文字列）は同時に指定してください。");
    }
    try {
      const attempt = parsedAttempt ?? (await inlineAttempt(repository, manifest.run.simulationRunId));
      await repository.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);
    } catch (e) {
      if (e instanceof SimulationRunStaleRevisionError) return staleRevisionConflict(e);
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
  if (playerSeatGate) {
    const advanceConflict = await checkPlayerSeatsSubmittedForAdvance(repository, playerSeatGate, stored.run);
    if (advanceConflict) return advanceConflict;
  }
  const parsedAttempt = parseWriteAttempt(candidate as { expectedBaseRevision?: unknown; writeToken?: unknown });
  if (parsedAttempt === "invalid") {
    return badRequest("expectedBaseRevision（0以上の数値）と writeToken（空でない文字列）は同時に指定してください。");
  }
  try {
    await repository.saveRun(stored, parsedAttempt ?? undefined);
  } catch (e) {
    if (e instanceof SimulationRunStaleRevisionError) return staleRevisionConflict(e);
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
