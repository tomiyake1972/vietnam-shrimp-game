"use client";

// ShrimpX V2 — 32Q Management Console（Phase 1）
//
// 【engine を省略しない】1 Turn / 4 Turns / 32 Turns はいずれも
// simulation/engine.ts の advanceSimulationTurn を「その回数だけ」呼ぶ。
// fast-run 専用の簡易計算は存在しない。
//
// 【progress は実測】"Running Turn 7 / 32" は実際に処理中のターン番号である。
// 進捗バーの水増しはしない。
//
// 【STOP は本物】次のターンの処理へ入る前に停止する。完了済みターンはそのまま残り、
// 処理中のターンが中途半端に保存されることはない。
//
// 【UI と計算の分離】1ターン処理するたびに setState して描画を1回だけ更新し、
// requestAnimationFrame を挟んでブラウザへ制御を戻す。全体再読み込みはしない。

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { advanceSimulationTurn, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { buildCompanySeries } from "../../../lib/v2/companyLab/simulation/series";
import { createEmptyStrategyDocument, CompanyStrategyDocument } from "../../../lib/v2/companyLab/strategyProfile/types";
import { TrendChart } from "./TrendChart";
import { CompanyInspector } from "./CompanyInspector";
import { MarketSummary } from "./MarketSummary";

const SCENARIO_ID = "baseline";
const DEFAULT_SEED = "management-console-32q";

/** metadata 用のタイムスタンプ。ゲーム判断には一切渡さない。 */
function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(seed: string, startedAt: string): string {
  return `run-${seed}-${startedAt}`;
}

type RunPhase = "idle" | "running" | "stopping";

export function ManagementConsole() {
  const [seed] = useState(DEFAULT_SEED);
  const [session, setSession] = useState<SimulationSession>(() =>
    createSimulationSession({
      simulationRunId: newRunId(DEFAULT_SEED, "init"),
      scenarioId: SCENARIO_ID,
      seed: DEFAULT_SEED,
      requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
      startedAt: "init",
    })
  );
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [runningTurn, setRunningTurn] = useState<number | null>(null);
  const [targetTurns, setTargetTurns] = useState<number>(MANAGEMENT_CONSOLE_STANDARD_TURNS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("BAL");
  const stopRequested = useRef(false);

  const [strategyDocs] = useState<Readonly<Record<string, CompanyStrategyDocument>>>(() => {
    const s = createSimulationSession({
      simulationRunId: "schema",
      scenarioId: SCENARIO_ID,
      seed: DEFAULT_SEED,
      requestedTurns: 1,
      startedAt: "init",
    });
    return Object.fromEntries(s.fixtures.map((f) => [f.companyId, createEmptyStrategyDocument(f.companyId)]));
  });

  const series = useMemo(
    () => buildCompanySeries(session.state.history, session.fixtures),
    [session.state.history, session.fixtures]
  );

  const completedTurns = session.state.history.length;

  /** 指定ターン数だけ進める。1回のターン処理ごとに描画を更新する。 */
  const run = useCallback(
    async (turns: number) => {
      if (phase !== "idle") return;
      setErrorMessage(null);
      setTargetTurns(turns);
      setPhase("running");
      stopRequested.current = false;

      let current = session;
      // 押した時点から数えて turns ターン進める。
      const goal = current.state.history.length + turns;

      for (let i = 0; i < turns; i++) {
        // 【本物のSTOP】次のターンへ入る前に確認する。処理中の中断はしない。
        if (stopRequested.current) {
          setSession({ ...current, run: { ...current.run, stopReason: "stopped_by_user", completedAt: nowIso() } });
          setPhase("idle");
          setRunningTurn(null);
          return;
        }
        if (current.state.isComplete) break;

        const turnNumber = current.state.scenarioState.currentTurn;
        setRunningTurn(turnNumber);
        // ブラウザへ制御を戻し、進捗表示を実際に描画させる。
        await new Promise((r) => requestAnimationFrame(() => r(null)));

        const outcome = advanceSimulationTurn(current, nowIso());
        current = outcome.session;
        setSession(current);

        if (!outcome.advanced) {
          if (outcome.error) setErrorMessage(`Simulation stopped at Turn ${turnNumber}: ${outcome.error.message}`);
          break;
        }
      }
      void goal;
      setPhase("idle");
      setRunningTurn(null);
    },
    [phase, session]
  );

  const reset = useCallback(() => {
    if (phase !== "idle") return;
    const startedAt = nowIso();
    setSession(
      createSimulationSession({
        simulationRunId: newRunId(seed, startedAt),
        scenarioId: SCENARIO_ID,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt,
      })
    );
    setErrorMessage(null);
    setRunningTurn(null);
  }, [phase, seed]);

  const busy = phase !== "idle";
  const isComplete = completedTurns >= MANAGEMENT_CONSOLE_STANDARD_TURNS || session.state.isComplete;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---------------- TOP BAR ---------------- */}
      <header className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-4 py-2.5 backdropblur">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <h1 className="text-base font-bold tracking-tight">ShrimpX 経営管制室</h1>
            <p className="text-[11px] text-slate-400">Game Owner / test environment 専用</p>
          </div>

          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <div>
              <dt className="text-slate-400">Scenario</dt>
              <dd className="font-mono font-semibold">{session.run.scenarioId}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Turn</dt>
              <dd className="font-mono font-semibold" data-testid="turn-counter">
                {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Simulation Run ID</dt>
              <dd className="max-w-[220px] truncate font-mono text-[11px]">{session.run.simulationRunId}</dd>
            </div>
          </dl>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => run(1)} disabled={busy || isComplete} data-testid="run-1"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              1 Turn
            </button>
            <button type="button" onClick={() => run(4)} disabled={busy || isComplete} data-testid="run-4"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              4 Turns
            </button>
            <button type="button" onClick={() => run(MANAGEMENT_CONSOLE_STANDARD_TURNS)} disabled={busy || isComplete} data-testid="run-32"
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40">
              32 Turns
            </button>
            <button type="button" onClick={() => { stopRequested.current = true; setPhase("stopping"); }} disabled={phase !== "running"} data-testid="stop"
              className="rounded bg-rose-700 px-3 py-1.5 text-sm font-semibold hover:bg-rose-600 disabled:opacity-40">
              STOP
            </button>
            <button type="button" onClick={reset} disabled={busy}
              className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-40">
              Reset
            </button>
            <Link href="/v2/management/analysis" data-testid="analysis-link"
              className="rounded border border-sky-600 px-3 py-1.5 text-sm font-semibold text-sky-300 hover:bg-slate-800">
              Analysis
            </Link>
          </div>
        </div>

        {/* progress: 実際に処理中のターン番号を出す（水増ししない） */}
        <div className="mt-1.5 min-h-[20px] text-xs" role="status" aria-live="polite" data-testid="progress">
          {phase === "running" && runningTurn !== null ? (
            <span className="text-sky-300">
              Running Turn {runningTurn} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}（Completed {completedTurns} / {targetTurns} 要求分）
            </span>
          ) : phase === "stopping" ? (
            <span className="text-amber-300">停止要求を受け付けました。処理中のターンの完了を待っています…</span>
          ) : errorMessage ? (
            <span className="text-rose-400" data-testid="error-message">{errorMessage}</span>
          ) : session.run.stopReason === "stopped_by_user" ? (
            <span className="text-amber-300">Stopped by user — Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns</span>
          ) : isComplete && completedTurns > 0 ? (
            <span className="font-semibold text-emerald-400" data-testid="complete-message">
              Simulation Complete — {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns
            </span>
          ) : (
            <span className="text-slate-500">待機中</span>
          )}
        </div>
      </header>

      {/* ---------------- BODY ---------------- */}
      <div className="flex flex-col gap-3 p-3 lg:flex-row">
        {/* LEFT: Game Overview 約65% */}
        <main className="flex flex-col gap-3 lg:w-[65%]">
          <TrendChart
            title="Revenue Trend（5社 / 32Q）"
            series={series}
            pick={(p) => p.revenue}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightCompanyId={selectedCompanyId}
            unitLabel="USD (百万)"
          />
          <TrendChart
            title="Operating Profit Trend（5社 / 32Q）"
            series={series}
            pick={(p) => p.operatingProfit}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightCompanyId={selectedCompanyId}
            unitLabel="USD (百万)"
          />

          <MarketSummary state={session.state} />

          <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
            <h2 className="mb-2 text-sm font-semibold">5社サマリー（最新ターン）</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                    <th className="py-1 pr-2">会社</th>
                    <th className="py-1 pr-2 text-right">Revenue</th>
                    <th className="py-1 pr-2 text-right">Op. Profit</th>
                    <th className="py-1 pr-2 text-right">Net Income</th>
                    <th className="py-1 pr-2 text-right">Cash</th>
                    <th className="py-1 text-right">Debt</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => {
                    const last = s.points[s.points.length - 1];
                    const m = (v: number | null | undefined) => (v === null || v === undefined ? "－" : `${(v / 1_000_000).toFixed(1)}M`);
                    return (
                      <tr
                        key={s.companyId}
                        onClick={() => setSelectedCompanyId(s.companyId)}
                        className={`cursor-pointer border-b border-slate-800 hover:bg-slate-800/60 ${
                          s.companyId === selectedCompanyId ? "bg-slate-800/80" : ""
                        }`}
                      >
                        <td className="py-1 pr-2">
                          <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: s.color }} aria-hidden />
                          {s.companyId}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums">{m(last?.revenue)}</td>
                        <td className={`py-1 pr-2 text-right tabular-nums ${(last?.operatingProfit ?? 0) < 0 ? "text-rose-400" : ""}`}>
                          {m(last?.operatingProfit)}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums">{m(last?.netIncome)}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{m(last?.cash)}</td>
                        <td className="py-1 text-right tabular-nums">{m(last?.debt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {completedTurns === 0 ? (
              <p className="mt-2 text-xs text-slate-400">ターンを進めると実績が表示されます。</p>
            ) : null}
          </section>
        </main>

        {/* RIGHT: Company Inspector 約35% */}
        <aside className="lg:w-[35%]">
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-2.5">
            <h2 className="mb-2 text-sm font-semibold">Company Inspector</h2>
            <CompanyInspector
              state={session.state}
              fixtures={session.fixtures}
              selectedCompanyId={selectedCompanyId}
              onSelect={setSelectedCompanyId}
              strategyDocs={strategyDocs}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
