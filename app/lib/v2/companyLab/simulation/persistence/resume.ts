// ShrimpX V2 — 32Q Management Console Phase 9: Simulation Run の Save / Resume
//
// SimulationSession ⇄ SimulationResumePayload の相互変換だけを持つ。
// 計算ロジックは一切無い（純粋なデータの組み立て・分解だけ）。

import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../../types";
import { CompanyControlMode, SimulationRun, SimulationSession } from "../types";
import { SimulationAnalyticsDataset } from "../analytics/types";
import { SimulationResumePayload } from "./types";

/**
 * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】resumePayload.state.history に
 * 残す直近ターン数。
 *
 * 監査の結果（history consumer audit）、次ターンのsimulation継続に生きたパスで
 * 履歴を読む箇所は marketDemandObservation.ts の固定lag=2（history[length-2]）
 * だけで、それ以外の継続系コード（engine.ts / runner.ts 等）は最後の1件しか
 * 読まない。history全件を読むのは Analysis/export/UI閲覧用（buildDatasetFromSession等）
 * であり、これらは resumePayload ではなく別途保存される dataset/packCapture
 * （常にライブの完全なsession.state.historyから作られ、trimmedなresumePayload.state.history
 * の影響を受けない）を読む。
 *
 * 4を採用: 生きたパスで必要な2に対して、将来Phase Iで検討され得る2Q/4Qトレンド
 * 判断のための余地を残す（instruction §8「32Q全部をresume snapshotへ残す設計に
 * 戻さない」を守りつつ、必要最小限より少し余裕を持たせる）。
 */
export const ROLLING_RESUME_HISTORY_WINDOW = 4;

/** resumePayload保存用に、historyを直近ROLLING_RESUME_HISTORY_WINDOW件だけへ間引く。 */
function trimStateForResume(state: CompanyLabState): CompanyLabState {
  if (state.history.length <= ROLLING_RESUME_HISTORY_WINDOW) return state;
  return { ...state, history: state.history.slice(-ROLLING_RESUME_HISTORY_WINDOW) };
}

/**
 * aiTurnTraces（history同様、次ターン継続には使われない・純粋な分析用の蓄積値。
 * dataset.ts:aiTurnTraces参照は buildDatasetFromSession 経由でのみ）も同じ
 * window分だけへ間引く。turn範囲がhistoryとずれるとaiTraceの再計算が不整合になる
 * ため、historyと同じ件数（同じ直近ターン集合）を残す。
 */
function trimAiTurnTracesForResume(traces: SimulationSession["aiTurnTraces"], windowTurns: readonly number[]): SimulationSession["aiTurnTraces"] {
  if (windowTurns.length === 0) return traces;
  const minTurn = windowTurns[0];
  return traces.filter((t) => t.turn >= minTurn);
}

/**
 * SimulationSessionから、保存すべきresumePayloadを組み立てる。
 * companyControlModes・confirmedPlayerDecisionsはSimulationSession自体には
 * 持たせていない（Management Console側のReact stateが唯一の情報源）ため、
 * 呼び出し側から渡す。
 */
export function buildResumePayload(
  session: SimulationSession,
  companyControlModes: Readonly<Record<string, CompanyControlMode>>,
  confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>
): SimulationResumePayload {
  const trimmedState = trimStateForResume(session.state);
  const windowTurns = trimmedState.history.map((r) => r.turn);
  return {
    state: trimmedState,
    fixtures: session.fixtures,
    companyControlModes,
    confirmedPlayerDecisions,
    aiTurnTraces: trimAiTurnTracesForResume(session.aiTurnTraces, windowTurns),
    observedDemand: session.observedDemand,
    salesHeadcountByTurn: session.salesHeadcountByTurn,
    capacityByTurn: session.capacityByTurn,
    latestQuarterPreProcessingSnapshot: session.latestQuarterPreProcessingSnapshot,
  };
}

/**
 * 保存済みのSimulationRunメタデータ＋resumePayloadから、続きから進められる
 * SimulationSessionを再構築する。
 *
 * 【捏造しない】packCompanyTurns/packWorldTurnsはpackCaptureから復元する
 * （呼び出し側がstored.packCaptureを渡す。無ければ空のまま＝AI Analysis Packの
 * 該当セクションはNOT_RECORDEDとして扱われる。既存の後方互換方針と同じ）。
 */
export function restoreSessionFromResumePayload(
  run: SimulationRun,
  resumePayload: SimulationResumePayload,
  packCapture?: { readonly companyTurns: SimulationSession["packCompanyTurns"]; readonly worldTurns: SimulationSession["packWorldTurns"] },
  /**
   * 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】resume元のStoredSimulationRunが
   * 持っていた dataset（resumePayload.state.historyがrolling windowへ間引かれる前、
   * ライブの完全なsession.state.historyから作られていたため、reload以前のturnぶんの
   * Analysis事実をすべて含む）。渡すと、以後 buildDatasetFromSession が呼ばれるたびに
   * これとマージされ、Analysis/AI Pack/Databookが読むdatasetからreload以前のturnが
   * 欠落しない（session.priorAnalyticsDatasetとして保持する。dataset.ts参照）。
   */
  priorAnalyticsDataset?: SimulationAnalyticsDataset
): SimulationSession {
  const config: CompanyLabConfig = {
    scenarioId: run.scenarioId,
    mode: "canonical",
    seed: run.seed,
    turns: run.requestedTurns,
  };
  return {
    run,
    state: resumePayload.state,
    fixtures: resumePayload.fixtures,
    config,
    aiTurnTraces: resumePayload.aiTurnTraces,
    observedDemand: resumePayload.observedDemand,
    salesHeadcountByTurn: resumePayload.salesHeadcountByTurn,
    capacityByTurn: resumePayload.capacityByTurn,
    packCompanyTurns: packCapture?.companyTurns ?? [],
    packWorldTurns: packCapture?.worldTurns ?? [],
    latestQuarterPreProcessingSnapshot: resumePayload.latestQuarterPreProcessingSnapshot,
    priorAnalyticsDataset,
  };
}
