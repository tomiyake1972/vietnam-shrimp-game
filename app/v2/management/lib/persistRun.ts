// ShrimpX V2 — 32Q Management Console Phase 9: Simulation Run の保存（共通ヘルパー）
//
// 【Console と PLAYER Workspace の両方から同じ関数を通す】
// 「保存すべきタイミング」は指示§15の通り複数箇所（Turn完了後・PLAYER意思決定確定後・
// 経営モード変更後・新規Run開始時）にまたがるが、"何を保存するか"（resumePayloadの組み立て方）
// は1箇所にだけ書く。ここで重複させると、片方だけ更新されて保存内容がずれる事故につながる。
//
// 【O1・保存競合の扱い】保存はサーバーの公開中revisionを基準にしたCASになった。
// 他のwriter（別端末のIndependent Player等）が先に公開していた場合、保存は
// 409 STALE_PERSISTENCE_REVISION で拒否される。そのとき「同じ内容をrevisionだけ
// 上げて再送」してはいけない。相手の提出を消してしまうためである。
// ここでは最新を読み直し、**安全に再適用できると判定できる場合だけ**
// candidateを組み立て直して再試行する。

import { CompanyControlMode, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../../lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { loadSimulationRun, saveSimulationRun, setActiveSimulationRunId, SaveSimulationRunResult } from "./simulationRunStore";

/** metadata 用のタイムスタンプ。ゲーム判断には一切渡さない。 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 【O1】保存競合時の再試行上限。無制限retryは禁止（指示§7）。
 * 競合相手は人の操作（別端末のPlayer提出・別タブのGM操作）なので、
 * 数回で収束しなければ諦めて失敗として返し、呼び出し側がTurnを進めないようにする。
 */
const MAX_SAVE_ATTEMPTS = 4;

/**
 * 競合後、自分の保存を最新の正本へ安全に再適用できるかを判定し、
 * 再適用できるなら「最新と合成した confirmedPlayerDecisions」を返す。
 *
 * 【判定規則】
 *  - 最新の保存物の方がTurnが進んでいる（completedTurnsが大きい）場合は再適用しない。
 *    自分の持っているsessionは既に古く、それを書けば相手のTurn進行を巻き戻す。
 *  - Turnが同じなら、最新側に入っている他社の提出を保持したうえで、
 *    自分が持ち込む提出を重ねる（＝どちらの提出も消えない）。
 *  - 自分の方がTurnを進めている場合、最新側の提出は「前のTurnのもの」なので引き継がない
 *    （自分が渡す confirmedPlayerDecisions をそのまま使う）。
 */
async function rebuildConfirmedForRetry(
  session: SimulationSession,
  confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>
): Promise<{ readonly ok: true; readonly confirmed: Readonly<Record<string, CompanyDecisionInput>> } | { readonly ok: false; readonly reason: string }> {
  const latest = await loadSimulationRun(session.run.simulationRunId);
  if (!latest) return { ok: false, reason: "最新の保存物を読み直せませんでした。" };

  if (latest.run.completedTurns > session.run.completedTurns) {
    return {
      ok: false,
      reason:
        `サーバー上のTurn（${latest.run.completedTurns}）が、この画面が持っているTurn（${session.run.completedTurns}）より進んでいます。` +
        "画面を再読み込みしてから操作してください。",
    };
  }

  const latestTurn = latest.resumePayload?.state.scenarioState.currentTurn;
  const myTurn = session.state.scenarioState.currentTurn;
  if (latestTurn === myTurn) {
    // 同じTurnを見ている ⇒ 相手の提出を残したまま自分の提出を重ねる。
    return { ok: true, confirmed: { ...(latest.resumePayload?.confirmedPlayerDecisions ?? {}), ...confirmedPlayerDecisions } };
  }
  // 自分の方が先のTurn ⇒ 相手側の提出は前Turnのものなので引き継がない。
  return { ok: true, confirmed: confirmedPlayerDecisions };
}

/**
 * 続きからプレイできる状態（resumePayload）込みで Simulation Run を保存する。
 * Console（Turn完了後・経営モード変更後）・PLAYER Workspace（意思決定確定後）の
 * どちらから呼んでも同じ保存物になる。
 */
export async function persistResumableRun(
  session: SimulationSession,
  companyControlModes: Readonly<Record<string, CompanyControlMode>>,
  confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>
): Promise<SaveSimulationRunResult> {
  const dataset = buildDatasetFromSession(session);
  let confirmed = confirmedPlayerDecisions;
  let lastResult: SaveSimulationRunResult | null = null;

  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
    const resumePayload = buildResumePayload(session, companyControlModes, confirmed);
    const result = await saveSimulationRun({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run,
      dataset,
      packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
      resumePayload,
      savedAt: nowIso(),
    });
    lastResult = result;
    if (!result.conflict) {
      setActiveSimulationRunId(session.run.simulationRunId);
      return result;
    }

    // 【競合】最新を読み直し、安全に再適用できる場合だけ作り直す。
    const rebuilt = await rebuildConfirmedForRetry(session, confirmed);
    if (!rebuilt.ok) {
      return { ...result, serverError: `${result.serverError ?? "保存が競合しました"} / ${rebuilt.reason}`, serverSaveSucceeded: false, degraded: true };
    }
    confirmed = rebuilt.confirmed;
  }

  setActiveSimulationRunId(session.run.simulationRunId);
  return (
    lastResult ?? {
      savedTo: [],
      serverError: "保存に失敗しました。",
      browserError: null,
      degraded: true,
      serverSaveSucceeded: false,
      persistenceRevision: 0,
      conflict: true,
    }
  );
}
