// ShrimpX V2 — Independent Player Flow: Player Submit（server authoritative）
//
// 【Engineを複製しない】ここでは意思決定の計算・確定処理を一切行わない。
// resumePayload.confirmedPlayerDecisions[companyId]へ書き込み、GM Consoleの
// runInternal（既存のTurn進行ロジック）が読む場所と完全に同じ場所・同じ形へ
// 書くだけ。書き込み経路も既存のhandleSaveSimulationRunPart/handleSaveSimulationRun
// （FINISHED lockを含む）をそのまま呼ぶ（重複Game End lock禁止）。

import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../../api/v2/simulation-runs/_lib/handlers";
import { SimulationRunRepository } from "../companyLab/simulation/persistence/repository";
import { CompanyDecisionInput } from "../companyLab/types";
import { CompanyId } from "../sales/types";
import { PlayerRepository } from "./repository";
import { PlayerSubmitError } from "./types";

function nowIso(): string {
  return new Date().toISOString();
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
  const stored = await simulationRunRepository.loadRun(runId);
  if (!stored) throw new PlayerSubmitError(`Simulation Run が見つかりません（runId=${runId}）。`, "RUN_NOT_FOUND");
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

  const nextRevision = (stored.persistenceRevision ?? 0) + 1;
  const savedAt = nowIso();
  const updatedResumePayload = { ...stored.resumePayload, confirmedPlayerDecisions: { ...existingDecisions, [companyId]: decision } };

  // 既存のGM保存経路とまったく同じ関数（part保存→manifest commit、FINISHED lock込み）を呼ぶ。
  const datasetResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "dataset", value: stored.dataset });
  if (datasetResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（dataset）。", "INVALID_DECISION");

  const resumeResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "resume", value: updatedResumePayload });
  if (resumeResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（resume）。", "INVALID_DECISION");

  if (stored.packCapture) {
    const packResult = await handleSaveSimulationRunPart(simulationRunRepository, { simulationRunId: runId, revision: nextRevision, part: "pack", value: stored.packCapture });
    if (packResult.status !== 200) throw new PlayerSubmitError("提出の保存に失敗しました（pack）。", "INVALID_DECISION");
  }

  const manifestResult = await handleSaveSimulationRun(simulationRunRepository, {
    manifestOnly: true,
    run: stored.run,
    savedAt,
    persistenceRevision: nextRevision,
    hasResumePayload: true,
    hasPackCapture: Boolean(stored.packCapture),
  });
  if (manifestResult.status !== 200) throw new PlayerSubmitError("提出の確定（manifest）に失敗しました。", "INVALID_DECISION");

  // Seat側の提出記録（GM Console表示・Advance Turn gating用の副次的な監査情報）。
  // 上のresumePayload書き込みが正本であり、ここが失敗しても意思決定自体は失われない
  // （GM Console側のgatingがこの副次情報を使う点は既知の残余リスクとして報告する）。
  await playerRepository.recordSubmission(runId, companyId, currentTurn, savedAt);

  return { runId, companyId, turn: currentTurn, persistenceRevision: nextRevision };
}
