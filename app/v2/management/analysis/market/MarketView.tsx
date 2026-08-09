"use client";

// ShrimpX V2 — Market（需要 TRUE/OBSERVABLE ＋ GLOBAL PRODUCER DATA、独立URL化）

import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../../lib/v2/companyLab/simulation/types";
import { AnalysisPageShell } from "../components/AnalysisPageShell";
import { MarketTab } from "../tabs/MarketTab";
import { useAnalysisRun } from "../lib/useAnalysisRun";

const PATH = "/v2/management/analysis/market";

export function MarketView() {
  const { stored, runs, loading, notFoundRunId } = useAnalysisRun();
  const dataset = stored?.dataset ?? null;
  const totalTurns = Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0);

  return (
    <AnalysisPageShell
      title="市場需要と産地国データ"
      description="需要は TRUE WORLD（実際に成立した対象需要）と OBSERVABLE（プレイヤー・Standard AI が見る2四半期遅行の公開値）を別系列として扱います。"
      stored={stored}
      runs={runs}
      loading={loading}
      notFoundRunId={notFoundRunId}
      path={PATH}
    >
      {dataset ? <MarketTab dataset={dataset} totalTurns={totalTurns} /> : null}
    </AnalysisPageShell>
  );
}
