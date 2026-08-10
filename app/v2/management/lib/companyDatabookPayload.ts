// ShrimpX V2 — 32Q Management Console Phase 9: PLAYER Company Databook
//
// 【別の計算を作らない】ここはデータの組み立てだけを持つ。実際のExcel生成・
// TRUE/OBSERVABLEのフィルタリングは、通常プレイと同じ
// buildCompanyExportPayload（app/api/v2/exports/_lib/exportDto.ts）・
// buildCompanyExportExcelWorkbook（companyLabAdminExcelBuilder.ts、execFileSync等
// Node専用APIに依存するためサーバー側でのみ呼べる）をそのまま使う。
// このファイルはブラウザ側で SimulationSession から
// CompanyLabQuarterHistoryEntry を組み立てる変換だけを担う（純関数、副作用無し）。

import { CompanyLabQuarterHistoryEntry } from "../../../lib/v2/companyLab/persistence/types";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../../../lib/v2/companyLab/persistence/types";
import { createCompanyLabRuntimeSnapshot } from "../../../lib/v2/companyLab/persistence/snapshot";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";

export class DatabookNotAvailableError extends Error {}

/**
 * SimulationSessionの直近確定ターンから、その1社ぶんの
 * CompanyLabQuarterHistoryEntry を組み立てる（通常プレイのExport APIが
 * 読む形と同じ）。まだ1ターンも確定していないRunでは作れない（Q1からの
 * 捏造をしない）。
 *
 * 【期首欄について】preProcessingStateSnapshotは
 * session.latestQuarterPreProcessingSnapshot（直近ターンの処理直前の状態。
 * engine.tsのadvanceSimulationTurnが処理のたびに更新する）をそのまま使う。
 * 直近確定ターン以外（過去のターン）のDatabookはサポートしない
 * （過去ターンの処理直前状態はSimulationSessionに保持していないため）。
 */
export function buildCompanyDatabookQuarterEntry(session: SimulationSession, companyId: string): CompanyLabQuarterHistoryEntry {
  const record = session.state.history[session.state.history.length - 1];
  if (!record) {
    throw new DatabookNotAvailableError("まだ確定したTurnがありません。Turnを進めてからダウンロードしてください。");
  }
  if (!session.latestQuarterPreProcessingSnapshot) {
    throw new DatabookNotAvailableError("このRunの期首状態が記録されていません（Save/Resumeの都合上、古い保存物では作れません）。");
  }
  const playerSubmission = record.decisions.find((d) => d.companyId === companyId);
  if (!playerSubmission) {
    throw new DatabookNotAvailableError(`会社「${companyId}」の当ターン意思決定記録が見つかりません。`);
  }
  const otherCompaniesDecisions: readonly CompanyDecisionInput[] = record.decisions.filter((d) => d.companyId !== companyId);

  return {
    turnId: `${session.run.simulationRunId}-turn-${record.turn}`,
    turn: record.turn,
    period: record.period,
    engineVersion: session.run.gameParameterVersion,
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    preProcessingStateSnapshot: session.latestQuarterPreProcessingSnapshot,
    postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(session.state),
    playerSubmission,
    otherCompaniesDecisions,
    record,
    processedAt: session.run.completedAt ?? session.run.startedAt,
  };
}
