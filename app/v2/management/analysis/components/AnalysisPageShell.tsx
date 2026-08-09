"use client";

// ShrimpX V2 — 各分析画面の共通の枠
//
// 【横方向の巨大タブバーで画面を埋めない】上部に置くのは
// 「Analysis Home へ戻る」「経営管制室へ戻る」と、現在の Simulation Run の表示だけ。
// 分析どうしの移動は Analysis Home（索引）を経由する。
//
// 【run selector は画面状態ではなくリンク】run を切り替えると URL の `?run=` が
// 変わるだけで、active run（他のタブが見ている run）は書き換わらない。

import Link from "next/link";
import { StoredSimulationRun, SimulationRunSummary } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { analysisHref } from "../lib/useAnalysisRun";

const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  completed: "完走",
  stopped_by_user: "途中停止",
  error: "失敗",
  scenario_end: "シナリオ終端",
  running: "実行中",
};

interface Props {
  readonly title: string;
  readonly description?: string;
  readonly stored: StoredSimulationRun | null;
  readonly runs: readonly SimulationRunSummary[];
  readonly loading: boolean;
  readonly notFoundRunId: string | null;
  /** 現在のパス（run 切替リンクの生成に使う）。 */
  readonly path: string;
  /** run 切替リンクへ引き継ぐ query（market / company 等）。 */
  readonly extraQuery?: Readonly<Record<string, string>>;
  readonly children: React.ReactNode;
}

export function AnalysisPageShell({ title, description, stored, runs, loading, notFoundRunId, path, extraQuery, children }: Props) {
  const runId = stored?.run.simulationRunId ?? null;

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={analysisHref("/v2/management/analysis", runId)} className="rounded border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-800">
          ← Analysis Home
        </Link>
        <Link href={runId ? `/v2/management?run=${encodeURIComponent(runId)}` : "/v2/management"} className="rounded border border-slate-600 px-2.5 py-1 text-xs hover:bg-slate-800">
          経営管制室
        </Link>
        <h1 className="text-base font-bold" data-testid="analysis-page-title">
          {title}
        </h1>
        <span className="text-xs text-slate-400" data-testid="analysis-run-status">
          {loading
            ? "読み込み中…"
            : stored
              ? `${stored.run.scenarioId} ・ seed ${stored.run.seed} ・ ${stored.dataset.turns.length} / ${stored.run.requestedTurns} Turns（${STOP_REASON_LABELS[stored.run.stopReason] ?? stored.run.stopReason}） ・ ${stored.run.simulationRunId}`
              : "保存済みの Simulation Run がありません"}
        </span>
      </header>

      {description ? <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{description}</p> : null}

      {runs.length > 1 ? (
        <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="Simulation Run の切り替え">
          <span className="text-slate-400">Run:</span>
          {runs.map((r, index) => {
            const selected = r.simulationRunId === runId;
            return (
              <Link
                key={r.simulationRunId}
                href={analysisHref(path, r.simulationRunId, extraQuery)}
                aria-current={selected ? "page" : undefined}
                data-testid={`run-link-${r.simulationRunId}`}
                className={`rounded px-2 py-1 font-mono ${selected ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              >
                {index === 0 ? "Current" : `Prev ${index}`}（{r.completedTurns}/{r.requestedTurns}Q）
              </Link>
            );
          })}
        </nav>
      ) : null}

      {!loading && !stored ? (
        <p className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200" data-testid="analysis-empty">
          {notFoundRunId ? `Simulation Run「${notFoundRunId}」が見つかりませんでした。` : "まだ保存された Simulation Run がありません。"} 経営管制室で 32 Turns
          を実行すると、その結果がここで参照できます（この画面では Simulation を実行しません）。
        </p>
      ) : (
        children
      )}
    </div>
  );
}
