// ShrimpX V2 — Independent Player Flow: Player Submit（server authoritative）
//
// 【Engineを複製しない】ここでは意思決定の計算・確定処理を一切行わない。
// resumePayload.confirmedPlayerDecisions[companyId]へ書き込み、GM Consoleの
// runInternal（既存のTurn進行ロジック）が読む場所と完全に同じ場所・同じ形へ
// 書くだけ。書き込み経路も既存のhandleSaveSimulationRunPart/handleSaveSimulationRun
// （FINISHED lockを含む）をそのまま呼ぶ（重複Game End lock禁止）。

import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../../api/v2/simulation-runs/_lib/handlers";
import { SimulationRunRepository } from "../companyLab/simulation/persistence/repository";
import { StoredSimulationRun } from "../companyLab/simulation/persistence/types";
import { CompanyDecisionInput } from "../companyLab/types";
import { CompanyId } from "../sales/types";
import { PlayerRepository } from "./repository";
import { PlayerSubmitError } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 【O1】保存競合時の再試行上限。無制限retryは禁止（指示§7）。
 * 競合は「別のPLAYERが同じTurnへ提出した」「GMがTurn保存を終えた」のどちらかで、
 * どちらも人の操作に伴う頻度なので、数回で収束しなければ諦めて明示エラーにする。
 */
const MAX_SAVE_ATTEMPTS = 4;

/** 保存attemptごとに一意なwriteToken（未公開パートを他writerと混ぜないための識別子）。 */
function newWriteToken(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `sub-${Date.now().toString(36)}-${random}`;
}

/** STALE_PERSISTENCE_REVISION（409）かどうか。 */
function isStaleRevisionResult(result: { readonly status: number; readonly body: unknown }): boolean {
  if (result.status !== 409) return false;
  const body = result.body as { error?: { code?: unknown } } | null;
  return body?.error?.code === "STALE_PERSISTENCE_REVISION";
}

export interface SubmitPlayerDecisionParams {
  readonly runId: string;
  readonly companyId: CompanyId;
  /** クライアントが「これはTurn Nに対する提出です」と主張するTurn番号。stale Turn拒否のために必須。 */
  readonly claimedTurn: number;
  readonly decision: CompanyDecisionInput;
}

export interface SubmitPlayerDecisionResult {
  readonly runId: string;
  readonly companyId: CompanyId;
  readonly turn: number;
  readonly persistenceRevision: number;
}

/**
 * Player Submitのserver authoritative検証・永続化。最低限:
 *  - Runが存在する
 *  - Runが FINISHED でない
 *  - 会社が現在companyControlModesでPLAYERとして扱われている
 *  - claimedTurnが実際に確定待ちのTurn（=resumePayload.state.scenarioState.currentTurn）と一致する（stale Turn拒否）
 *  - 同じTurnに対する二重提出を拒否する（Submit後は同Turn編集不可）
 * を守ってから、既存のconfirmedPlayerDecisionsへ書き込む。
 */
export async function submitPlayerDecision(
  simulationRunRepository: SimulationRunRepository,
  playerRepository: PlayerRepository,
  params: SubmitPlayerDecisionParams
): Promise<SubmitPlayerDecisionResult> {
  const { runId, companyId, claimedTurn, decision } = params;

  /**
   * 【O1 §9・保存不変条件】保存キー（companyId）と decision 本体の companyId が
   * 食い違ったまま保存できてしまっていた。HTTP routeではCookieの会社で上書きされるため
   * 外部からのなりすましではないが、「key と中身が別会社」という状態を storage へ
   * 残せること自体が保存契約として弱い。service層で弾く。
   */
  const decisionCompanyId = (decision as { readonly companyId?: unknown }).companyId;
  if (decisionCompanyId !== undefined && decisionCompanyId !== companyId) {
    throw new PlayerSubmitError(
      `意思決定の会社（${String(decisionCompanyId)}）と提出先の会社（${companyId}）が一致しません。`,
      "INVALID_DECISION"
    );
  }

  /**
   * 【O1・CAS保存】読んだ正本のrevisionを expectedBaseRevision として申告し、
   * commit時に公開中revisionが変わっていれば拒否させる。
   * 競合したら「同じpayloadのrevisionだけ上げて再送」はせず、必ず最新を読み直して
   * 検証からやり直す（指示§7）。
   */
  let lastConflict: { readonly currentPublishedRevision: number } | null = null;
  for (let attemptIndex = 0; attemptIndex < MAX_SAVE_ATTEMPTS; attemptIndex += 1) {
    const stored = await simulationRunRepository.loadRun(runId);
    if (!stored) throw new PlayerSubmitError(`Simulation Run が見つかりません（runId=${runId}）。`, "RUN_NOT_FOUND");

    const validated = validateSubmittable(stored, companyId, claimedTurn);
    const expectedBaseRevision = stored.persistenceRevision ?? 0;
    const nextRevision = expectedBaseRevision + 1;
    const writeToken = newWriteToken();
    const savedAt = nowIso();

    /**
     * 【最新へmergeし直す】candidateは「いま読んだ最新の confirmedPlayerDecisions」
     * ＋自社decision。再試行のたびに作り直すため、競合相手（別PLAYER会社）の提出を
     * 巻き戻すことがない。
     */
    const updatedResumePayload = {
      ...validated.resumePayload,
      confirmedPlayerDecisions: { ...validated.existingDecisions, [companyId]: decision },
    };

    const attempt = { expectedBaseRevision, writeToken };

    // 既存のGM保存経路とまったく同じ関数（part保存→manifest commit、FINISHED lock込み）を呼ぶ。
    const datasetResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "dataset", value: stored.dataset, ...attempt });
    if (datasetResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（dataset）。", "INVALID_DECISION");

    const resumeResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "resume", value: updatedResumePayload, ...attempt });
    if (resumeResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（resume）。", "INVALID_DECISION");

    if (stored.packCapture) {
      const packResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "pack", value: stored.packCapture, ...attempt });
      if (packResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（pack）。", "INVALID_DECISION");
    }

    const manifestResult = await handleSaveSimulationRun(simulationRunRepository, {
      manifestOnly: true,
      run: stored.run,
      savedAt,
      persistenceRevision: nextRevision,
      hasResumePayload: true,
      hasPackCapture: Boolean(stored.packCapture),
      ...attempt,
    });

    if (isStaleRevisionResult(manifestResult)) {
      /**
       * 【競合】公開状態は一切変わっていない。最新を読み直して検証からやり直す。
       * このとき次の周回の validateSubmittable が
       *   - Turnが進んでいれば STALE_TURN
       *   - 自社が既に提出済みなら DUPLICATE_SUBMIT
       * を投げるため、競合の種類に応じた既存のエラーへ自然に収束する。
       */
      const body = manifestResult.body as { error?: { currentPublishedRevision?: number } };
      lastConflict = { currentPublishedRevision: body?.error?.currentPublishedRevision ?? -1 };
      continue;
    }
    if (manifestResult.status !== 200) throw new PlayerSubmitError("提出の確定（manifest）に失敗しました。", "INVALID_DECISION");

    /**
     * 【順序】decisionの保存が確定してからseat記録を書く（指示§12）。
     * CASに失敗した周回ではここへ到達しないため、
     * 「seatだけ提出済みで decision は無い」という不整合を作らない。
     */
    await playerRepository.recordSubmission(runId, companyId, validated.currentTurn, savedAt);

    return { runId, companyId, turn: validated.currentTurn, persistenceRevision: nextRevision };
  }

  throw new PlayerSubmitError(
    `他の保存と競合したため、意思決定を確定できませんでした（再試行${MAX_SAVE_ATTEMPTS}回。` +
      `最後に確認した保存revision=${lastConflict?.currentPublishedRevision ?? "不明"}）。画面を再読み込みしてから、もう一度提出してください。`,
    "SAVE_CONFLICT"
  );
}

/**
 * 提出可能かどうかの検証（毎回の再試行で最新stateに対して呼び直す）。
 * 検証内容は従来と同一で、順序も変えていない。
 */
function validateSubmittable(
  stored: StoredSimulationRun,
  companyId: SubmitPlayerDecisionParams["companyId"],
  claimedTurn: number
): {
  readonly resumePayload: NonNullable<StoredSimulationRun["resumePayload"]>;
  readonly existingDecisions: Readonly<Record<string, CompanyDecisionInput>>;
  readonly currentTurn: number;
} {
  if (stored.run.gameEndedAt) {
    throw new PlayerSubmitError("このゲームは既に終了しています。意思決定は変更できません。", "RUN_FINISHED");
  }
  if (!stored.resumePayload) {
    throw new PlayerSubmitError("この Simulation Run は続きからプレイできる保存形式ではありません。", "INVALID_DECISION");
  }

  const controlModes = stored.resumePayload.companyControlModes ?? {};
  if ((controlModes[companyId] ?? "STANDARD_AI") !== "PLAYER") {
    throw new PlayerSubmitError("この会社は現在 PLAYER 操作の対象ではありません（GMがStandard AIへ戻した可能性があります）。", "NOT_PLAYER_CONTROLLED");
  }

  const currentTurn = stored.resumePayload.state.scenarioState.currentTurn;
  if (claimedTurn !== currentTurn) {
    throw new PlayerSubmitError(
      `このTurn（${claimedTurn}）は既に進行済みか、まだ到達していません（現在の確定待ちTurnは${currentTurn}です）。画面を再読み込みしてください。`,
      "STALE_TURN"
    );
  }

  const existingDecisions = stored.resumePayload.confirmedPlayerDecisions ?? {};
  if (existingDecisions[companyId] !== undefined) {
    throw new PlayerSubmitError(
      `Turn ${currentTurn} の意思決定は既に提出済みです。GMがTurnを進めるまで再提出はできません。`,
      "DUPLICATE_SUBMIT"
    );
  }

  return { resumePayload: stored.resumePayload, existingDecisions, currentTurn };
}
