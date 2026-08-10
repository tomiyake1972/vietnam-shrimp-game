// ShrimpX V2 — 32Q Management Console Phase 9: Simulation Run の Save / Resume
//
// SimulationSession ⇄ SimulationResumePayload の相互変換だけを持つ。
// 計算ロジックは一切無い（純粋なデータの組み立て・分解だけ）。

import { CompanyDecisionInput, CompanyLabConfig } from "../../types";
import { CompanyControlMode, SimulationRun, SimulationSession } from "../types";
import { SimulationResumePayload } from "./types";

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
  return {
    state: session.state,
    fixtures: session.fixtures,
    companyControlModes,
    confirmedPlayerDecisions,
    aiTurnTraces: session.aiTurnTraces,
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
  packCapture?: { readonly companyTurns: SimulationSession["packCompanyTurns"]; readonly worldTurns: SimulationSession["packWorldTurns"] }
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
  };
}
