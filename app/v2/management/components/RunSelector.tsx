"use client";

// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run セレクター
//
// 【A/B比較を壊さないための設計】
// 選択中の実行は「画面のstate」ではなく simulationRunId として外に出す。
// Console 側は選択を localStorage の active run へ、Analysis 側は URL の
// ?run= へ持たせられるため、2つのタブで別々の実行を並べても互いを壊さない。

import { SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";

const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  completed: "完走",
  stopped_by_user: "途中停止",
  error: "失敗",
  scenario_end: "シナリオ終端",
  running: "実行中",
};

/**
 * 【Phase 9・§17 Run History状態表示】
 *   COMPLETED  … シナリオを最後まで終えた（もう続きが無い）。
 *   RESUMABLE  … resumePayloadがあり、続きから進められる。
 *   VIEW_ONLY  … resumePayloadが無い旧形式のRun。閲覧はできるが続きから進められない。
 */
export function runResumeStatus(r: SimulationRunSummary): "COMPLETED" | "RESUMABLE" | "VIEW_ONLY" {
  if (r.stopReason === "completed" || r.stopReason === "scenario_end") return "COMPLETED";
  return r.hasResumePayload ? "RESUMABLE" : "VIEW_ONLY";
}

const STATUS_LABELS: Readonly<Record<ReturnType<typeof runResumeStatus>, string>> = {
  COMPLETED: "完了",
  RESUMABLE: "再開可",
  VIEW_ONLY: "閲覧専用",
};

export interface RunSelectorProps {
  readonly runs: readonly SimulationRunSummary[];
  readonly selectedRunId: string | null;
  readonly onSelect: (simulationRunId: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function RunSelector({ runs, selectedRunId, onSelect, label = "Simulation Run", disabled = false }: RunSelectorProps) {
  const selectedRun = selectedRunId ? (runs.find((r) => r.simulationRunId === selectedRunId) ?? null) : null;
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-slate-400">{label}</span>
      <select
        value={selectedRunId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled || runs.length === 0}
        data-testid="run-selector"
        className="max-w-[320px] rounded border border-slate-600 bg-slate-900 px-2 py-1 font-mono text-[11px] disabled:opacity-40"
      >
        {runs.length === 0 ? <option value="">保存済みの実行はありません</option> : null}
        {runs.map((r, index) => (
          <option key={r.simulationRunId} value={r.simulationRunId}>
            {index === 0 ? "Current" : `Previous ${index}`}: {r.completedTurns}/{r.requestedTurns}Q ・{" "}
            {STOP_REASON_LABELS[r.stopReason] ?? r.stopReason} ・[{STATUS_LABELS[runResumeStatus(r)]}]・{" "}
            {r.savedAt.slice(0, 19).replace("T", " ")}
          </option>
        ))}
      </select>
      {/* <option>内はスタイル・data-testidを個別に持てないため、選択中の実行の状態を
          Playwrightからも読める形でここに複製する（指示§17）。 */}
      {selectedRun ? (
        <span data-testid="run-selector-selected-status" data-status={runResumeStatus(selectedRun)} className="text-[11px] text-slate-400">
          {STATUS_LABELS[runResumeStatus(selectedRun)]}
        </span>
      ) : null}
    </label>
  );
}
