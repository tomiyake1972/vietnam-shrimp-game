"use client";

// ShrimpX V2 — Overview（独立URL化）
// Phase 2 でタブとして作った Overview を、そのまま独立した画面にした。

import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { OverviewTab } from "../tabs/OverviewTab";
import { useAnalysisRun } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/overview";

export function OverviewView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const dataset = stored?.dataset ?? null;
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  return (
    <AnalysisPageShell
      title="Overview（5社 × 全指標）"
      description="指標を切り替えて5社を比較します。値はすべて確定済み実績から取り出したもので、表示のための再計算はしていません。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
    >
      {dataset ? <OverviewTab dataset={dataset} totalTurns={totalTurns} /> : null}
    </AnalysisPageShell>
  );
}
