"use client";

// ShrimpX V2 — 32Q Analysis 画面（Phase 1）
//
// Phase 1 は Overview のみ実装する。将来のタブを置ける構造だけ用意し、
// **未実装のタブに中身があるように見せない**（空の器を正直に空と表示する）。

import { useMemo, useState } from "react";
import Link from "next/link";
import { advanceSimulationTurn, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { buildCompanySeries } from "../../../lib/v2/companyLab/simulation/series";

/** 将来のタブ。Phase 1 で中身があるのは Overview だけ。 */
const TABS = [
  "Overview",
  "Market",
  "Product",
  "Operations",
  "Sales",
  "Profitability",
  "Investment",
  "Finance",
  "Bottleneck",
  "Strategy",
  "Scenario",
  "AI Trace",
] as const;
type Tab = (typeof TABS)[number];

const METRICS = [
  { key: "revenue", label: "Revenue" },
  { key: "operatingProfit", label: "Operating Profit" },
  { key: "netIncome", label: "Net Income" },
  { key: "cash", label: "Cash" },
  { key: "debt", label: "Debt" },
] as const;

export function AnalysisShell() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [session, setSession] = useState<SimulationSession | null>(null);
  const [running, setRunning] = useState(false);
  const [metric, setMetric] = useState<(typeof METRICS)[number]["key"]>("revenue");

  const series = useMemo(
    () => (session ? buildCompanySeries(session.state.history, session.fixtures) : []),
    [session]
  );

  /** Analysis 画面単体でも 32Q を回せるようにする（同じ engine を使う）。 */
  const run32 = async () => {
    if (running) return;
    setRunning(true);
    let s = createSimulationSession({
      simulationRunId: `analysis-${Date.now()}`,
      scenarioId: "baseline",
      seed: "management-console-32q",
      requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
      startedAt: new Date().toISOString(),
    });
    for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
      if (s.state.isComplete) break;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const o = advanceSimulationTurn(s, new Date().toISOString());
      s = o.session;
      setSession(s);
      if (!o.advanced) break;
    }
    setRunning(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-bold">32Q Analysis</h1>
        <Link href="/v2/management" className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800">
          ← 経営管制室へ戻る
        </Link>
        <button
          type="button"
          onClick={run32}
          disabled={running}
          data-testid="analysis-run-32"
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40"
        >
          {running ? "実行中…" : "32 Turns 実行"}
        </button>
        <span className="text-xs text-slate-400">
          {session ? `${session.state.history.length} / ${MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns` : "未実行"}
        </span>
      </header>

      <nav className="mb-3 flex flex-wrap gap-1.5" aria-label="Analysis tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={t === tab}
            className={`rounded px-2.5 py-1 text-xs font-semibold ${
              t === tab ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab !== "Overview" ? (
        <p className="rounded border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400">
          <strong className="text-slate-200">{tab}</strong> は Phase 2 以降で実装します。Phase 1 では Overview のみが実装済みです。
        </p>
      ) : (
        <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Overview — 5社 × 32Q</h2>
            <div className="ml-auto flex gap-1">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMetric(m.key)}
                  aria-pressed={metric === m.key}
                  className={`rounded px-2 py-1 text-xs ${
                    metric === m.key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {series.length === 0 ? (
            <p className="text-sm text-slate-400">「32 Turns 実行」を押すとデータが表示されます。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-xs" data-testid="analysis-overview-table">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="py-1 pr-2 text-left">会社</th>
                    {series[0].points.map((p) => (
                      <th key={p.turn} className="px-1 py-1 text-right">Q{p.turn}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.companyId} className="border-b border-slate-800">
                      <td className="py-1 pr-2">
                        <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: s.color }} aria-hidden />
                        {s.companyId}
                      </td>
                      {s.points.map((p) => {
                        const v = p[metric];
                        return (
                          <td key={p.turn} className={`px-1 py-1 text-right tabular-nums ${v !== null && v < 0 ? "text-rose-400" : ""}`}>
                            {v === null ? "－" : (v / 1_000_000).toFixed(1)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-slate-500">単位: USD 百万</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
