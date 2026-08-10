// ShrimpX V2 — 32Q Management Console Phase 9: Simulation Run の保存（共通ヘルパー）
//
// 【Console と PLAYER Workspace の両方から同じ関数を通す】
// 「保存すべきタイミング」は指示§15の通り複数箇所（Turn完了後・PLAYER意思決定確定後・
// 経営モード変更後・新規Run開始時）にまたがるが、"何を保存するか"（resumePayloadの組み立て方）
// は1箇所にだけ書く。ここで重複させると、片方だけ更新されて保存内容がずれる事故につながる。

import { CompanyControlMode, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { buildResumePayload } from "../../../lib/v2/companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { saveSimulationRun, setActiveSimulationRunId, SaveSimulationRunResult } from "./simulationRunStore";

/** metadata 用のタイムスタンプ。ゲーム判断には一切渡さない。 */
function nowIso(): string {
  return new Date().toISOString();
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
  const resumePayload = buildResumePayload(session, companyControlModes, confirmedPlayerDecisions);
  const result = await saveSimulationRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset,
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: nowIso(),
  });
  setActiveSimulationRunId(session.run.simulationRunId);
  return result;
}
