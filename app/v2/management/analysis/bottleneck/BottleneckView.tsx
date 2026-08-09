"use client";

// ShrimpX V2 — Bottleneck（独立URL化。AI Trace と並べて開けるようにする）

import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { BottleneckTab } from "../tabs/BottleneckTab";
import { useAnalysisRun } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/bottleneck";

export function BottleneckView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const dataset = stored?.dataset ?? null;

  return (
    <AnalysisPageShell
      title="律速（ヒートマップ・遷移）"
      description="分類は確定記録にある3つの不足量の大小比較だけで決まります（生成AIによる分類はしていません）。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
    >
      {dataset ? <BottleneckTab dataset={dataset} /> : null}
    </AnalysisPageShell>
  );
}
