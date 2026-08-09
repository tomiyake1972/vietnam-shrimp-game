"use client";

// ShrimpX V2 — 32Q Analysis 画面（Phase 2）
//
// 【Phase 2 での最重要の変更】
// **この画面は Simulation を実行しない。**
// Phase 1 では Analysis 側でもう一度32Qを回していたため、Console と Analysis が
// 別々の結果を見ていた（Phase 1 の残課題B）。Phase 2 では
// `?run=<simulationRunId>` または active run から保存済みの Simulation Run を
// 読み込むだけで、engine を一切呼ばない。
//
// 【未実装のタブに中身があるように見せない】
// Phase 2 で中身があるのは Overview / Market / Bottleneck / AI Trace の4つ。
// 残りは空の器であることを正直に表示する。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../lib/v2/companyLab/simulation/types";
import { StoredSimulationRun, SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { listSimulationRuns, loadSimulationRun, resolveRequestedRunId, setActiveSimulationRunId } from "../lib/simulationRunStore";
import { RunSelector } from "../components/RunSelector";
import { OverviewTab } from "./tabs/OverviewTab";
import { MarketTab } from "./tabs/MarketTab";
import { BottleneckTab } from "./tabs/BottleneckTab";
import { AiTraceTab } from "./tabs/AiTraceTab";

/** Phase 2 で中身があるタブ。 */
const IMPLEMENTED_TABS = ["Overview", "Market", "Bottleneck", "AI Trace"] as const;

/** 器だけ用意してあるタブ（中身は今後のPhase）。 */
const SHELL_TABS = ["Product", "Operations", "Sales", "Profitability", "Investment", "Finance", "Strategy", "Scenario"] as const;

const TABS = [...IMPLEMENTED_TABS, ...SHELL_TABS] as const;
type Tab = (typeof TABS)[number];

export function AnalysisShell() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [stored, setStored] = useState<StoredSimulationRun | null>(null);
  const [runs, setRuns] = useState<readonly SimulationRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFoundId, setNotFoundId] = useState<string | null>(null);

  const loadById = useCallback(async (simulationRunId: string) => {
    const found = await loadSimulationRun(simulationRunId);
    if (found) {
      setStored(found);
      setNotFoundId(null);
    } else {
      setStored(null);
      setNotFoundId(simulationRunId);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await listSimulationRuns();
      if (cancelled) return;
      setRuns(list);
      const requested = resolveRequestedRunId(typeof window === "undefined" ? null : window.location.search) ?? list[0]?.simulationRunId ?? null;
      if (requested) await loadById(requested);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadById]);

  const selectRun = useCallback(
    async (simulationRunId: string) => {
      setActiveSimulationRunId(simulationRunId);
      // URL にも反映して、2つのタブで別々の実行を並べても互いを壊さないようにする。
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("run", simulationRunId);
        window.history.replaceState(null, "", url.toString());
      }
      await loadById(simulationRunId);
    },
    [loadById]
  );

  const dataset = stored?.dataset ?? null;
  const totalTurns = useMemo(() => Math.max(MANAGEMENT_CONSOLE_STANDARD_TURNS, dataset?.turns.length ?? 0), [dataset]);

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-bold">32Q Analysis</h1>
        <Link
          href={stored ? `/v2/management?run=${encodeURIComponent(stored.run.simulationRunId)}` : "/v2/management"}
          className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          ← 経営管制室へ戻る
        </Link>
        <RunSelector runs={runs} selectedRunId={stored?.run.simulationRunId ?? null} onSelect={selectRun} />
        <span className="text-xs text-slate-400" data-testid="analysis-run-status">
          {loading
            ? "読み込み中…"
            : stored
              ? `${stored.dataset.turns.length} / ${stored.run.requestedTurns} Turns ・ ${stored.run.simulationRunId}`
              : "保存済みの Simulation Run がありません"}
        </span>
      </header>

      {!loading && !stored ? (
        <p className="mb-3 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200" data-testid="analysis-empty">
          {notFoundId
            ? `Simulation Run「${notFoundId}」が見つかりませんでした。`
            : "まだ保存された Simulation Run がありません。"}{" "}
          経営管制室で 32 Turns を実行すると、その結果がここで参照できます（この画面では Simulation を実行しません）。
        </p>
      ) : null}

      <nav className="mb-3 flex flex-wrap gap-1.5" aria-label="Analysis tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={t === tab}
            data-testid={`analysis-tab-${t.replace(/\s+/g, "-").toLowerCase()}`}
            className={`rounded px-2.5 py-1 text-xs font-semibold ${
              t === tab ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {dataset === null ? null : tab === "Overview" ? (
        <OverviewTab dataset={dataset} totalTurns={totalTurns} />
      ) : tab === "Market" ? (
        <MarketTab dataset={dataset} totalTurns={totalTurns} />
      ) : tab === "Bottleneck" ? (
        <BottleneckTab dataset={dataset} />
      ) : tab === "AI Trace" ? (
        <AiTraceTab dataset={dataset} />
      ) : (
        <p className="rounded border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400" data-testid="analysis-shell-tab">
          <strong className="text-slate-200">{tab}</strong> は今後のPhaseで実装します。Phase 2 で実装済みなのは Overview / Market /
          Bottleneck / AI Trace の4つです（中身のない器に、それらしい数字を置いていません）。
        </p>
      )}
    </div>
  );
}
