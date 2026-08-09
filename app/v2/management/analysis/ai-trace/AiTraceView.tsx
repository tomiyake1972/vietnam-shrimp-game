"use client";

// ShrimpX V2 — AI Trace（独立URL化。Bottleneck と並べて開けるようにする）

import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { AiTraceTab } from "../tabs/AiTraceTab";
import { useAnalysisRun } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/ai-trace";

export function AiTraceView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const dataset = stored?.dataset ?? null;

  return (
    <AnalysisPageShell
      title="Standard AI Trace（6段階）"
      description="Standard AI が意思決定の過程で実際に計算した値と、AI 自身が付けた理由コードだけを表示します（説明文の自動生成はしていません）。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
    >
      {dataset ? <AiTraceTab dataset={dataset} /> : null}
    </AnalysisPageShell>
  );
}
