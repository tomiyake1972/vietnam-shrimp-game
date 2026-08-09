"use client";

// ShrimpX V2 — 32Q Management Console（Phase 2）
//
// 【engine を省略しない】1 Turn / 4 Turns / 32 Turns はいずれも
// simulation/engine.ts の advanceSimulationTurn を「その回数だけ」呼ぶ。
// fast-run 専用の簡易計算は存在しない。
//
// 【progress は実測】"Running Turn 7 / 32" は実際に処理中のターン番号である。
//
// 【STOP は本物】次のターンの処理へ入る前に停止する。完了済みターンはそのまま残る。
//
// 【Phase 2 で解消した2点】
//   A. リロードで結果が消える  → 実行の区切りごとに Simulation Run として保存し、
//      次回の読み込み時に active run を復元する。
//   B. Console と Analysis が別々のデータを見ている → 両画面とも
//      simulationRunId で同じ Simulation Run を読む（Analysis は再実行しない）。
//
// 【表示は必ず dataset を通す】実行直後もリロード後も、描画に使うのは
// buildDatasetFromSession / 保存された dataset の**同じ形**である。
// 「実行中は state から、復元後は dataset から」という二重経路を作らない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { advanceSimulationTurn, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS, SimulationRun, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { SimulationAnalyticsDataset } from "../../../lib/v2/companyLab/simulation/analytics/types";
import { toCompanySeries } from "../../../lib/v2/companyLab/simulation/analytics/views";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { createEmptyStrategyDocument, CompanyStrategyDocument } from "../../../lib/v2/companyLab/strategyProfile/types";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import {
  getActiveSimulationRunId,
  listSimulationRuns,
  loadSimulationRun,
  saveSimulationRun,
  setActiveSimulationRunId,
} from "../lib/simulationRunStore";
import { SeriesChart } from "./SeriesChart";
import { CompanyInspector } from "./CompanyInspector";
import { MarketSummary } from "./MarketSummary";
import { RunSelector } from "./RunSelector";

const SCENARIO_ID = "baseline";
const DEFAULT_SEED = "management-console-32q";

/** metadata 用のタイムスタンプ。ゲーム判断には一切渡さない。 */
function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(seed: string, startedAt: string): string {
  // Redisキーへ使うため、コロン以外の記号が入らないよう ISO 文字列を整形する。
  return `run-${seed}-${startedAt.replace(/[^0-9A-Za-z]/g, "")}`;
}

type RunPhase = "idle" | "running" | "stopping";

/** 表示に必要な最小限。実行中は session から、復元時は保存済み run から埋まる。 */
interface ConsoleView {
  readonly run: SimulationRun;
  readonly dataset: SimulationAnalyticsDataset;
  /** 続きを進められるのは、このブラウザで実際に走らせているセッションだけ。 */
  readonly session: SimulationSession | null;
}

function viewFromSession(session: SimulationSession): ConsoleView {
  return { run: session.run, dataset: buildDatasetFromSession(session), session };
}

export function ManagementConsole() {
  const [seed] = useState(DEFAULT_SEED);
  const [view, setView] = useState<ConsoleView | null>(null);
  const [fixtures, setFixtures] = useState<readonly CompanyFixture[]>([]);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [runningTurn, setRunningTurn] = useState<number | null>(null);
  const [targetTurns, setTargetTurns] = useState<number>(MANAGEMENT_CONSOLE_STANDARD_TURNS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("BAL");
  const [savedRuns, setSavedRuns] = useState<readonly SimulationRunSummary[]>([]);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const stopRequested = useRef(false);

  const [strategyDocs] = useState<Readonly<Record<string, CompanyStrategyDocument>>>(() => {
    const s = createSimulationSession({ simulationRunId: "schema", scenarioId: SCENARIO_ID, seed: DEFAULT_SEED, requestedTurns: 1, startedAt: "init" });
    return Object.fromEntries(s.fixtures.map((f) => [f.companyId, createEmptyStrategyDocument(f.companyId)]));
  });

  /** 空セッションを作る（fixtures はここでしか手に入らないので必ず保持する）。 */
  const createFresh = useCallback(
    (startedAt: string): SimulationSession =>
      createSimulationSession({
        simulationRunId: newRunId(seed, startedAt),
        scenarioId: SCENARIO_ID,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt,
      }),
    [seed]
  );

  // --- 起動時：保存済み Simulation Run を復元する（Aの解消） ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blank = createFresh("init");
      if (!cancelled) setFixtures(blank.fixtures);

      const runs = await listSimulationRuns();
      if (cancelled) return;
      setSavedRuns(runs);

      const activeId = getActiveSimulationRunId() ?? runs[0]?.simulationRunId ?? null;
      if (activeId) {
        const stored = await loadSimulationRun(activeId);
        if (!cancelled && stored) {
          setView({ run: stored.run, dataset: stored.dataset, session: null });
          setRestoring(false);
          return;
        }
      }
      if (!cancelled) {
        setView(viewFromSession(blank));
        setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createFresh]);

  /** 実行の区切りで保存する。保存先（サーバー／ブラウザ）は必ず画面へ出す。 */
  const persist = useCallback(async (session: SimulationSession) => {
    const dataset = buildDatasetFromSession(session);
    const result = await saveSimulationRun({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run,
      dataset,
      savedAt: nowIso(),
    });
    setActiveSimulationRunId(session.run.simulationRunId);
    setSavedRuns(await listSimulationRuns());
    setStorageNote(
      result.savedTo.length === 0
        ? `保存できませんでした（${[result.browserError, result.serverError].filter(Boolean).join(" / ")}）`
        : result.savedTo.length === 2
          ? "保存先: サーバー（Redis）＋このブラウザ"
          : result.savedTo[0] === "browser"
            ? `保存先: このブラウザのみ（${result.serverError}）`
            : `保存先: サーバーのみ（${result.browserError}）`
    );
  }, []);

  /** 指定ターン数だけ進める。1回のターン処理ごとに描画を更新する。 */
  const run = useCallback(
    async (turns: number) => {
      if (phase !== "idle" || restoring) return;
      setErrorMessage(null);
      setTargetTurns(turns);
      setPhase("running");
      stopRequested.current = false;

      // 保存済み実行を表示しているだけの状態からは、新しい実行として開始する
      // （保存物には途中状態を含めていないため、続きから進めるふりをしない）。
      // まだ1ターンも進んでいないセッションでも、ここで実時刻の run id を採り直す
      // （起動時に作る空セッションの id を使い回すと、実行どうしを区別できなくなる）。
      const live = view?.session ?? null;
      let current = live !== null && live.state.history.length > 0 ? live : createFresh(nowIso());
      setView(viewFromSession(current));

      for (let i = 0; i < turns; i++) {
        // 【本物のSTOP】次のターンへ入る前に確認する。処理中の中断はしない。
        if (stopRequested.current) {
          current = { ...current, run: { ...current.run, stopReason: "stopped_by_user", completedAt: nowIso() } };
          setView(viewFromSession(current));
          setPhase("idle");
          setRunningTurn(null);
          await persist(current);
          return;
        }
        if (current.state.isComplete) break;

        const turnNumber = current.state.scenarioState.currentTurn;
        setRunningTurn(turnNumber);
        // ブラウザへ制御を戻し、進捗表示を実際に描画させる。
        await new Promise((r) => requestAnimationFrame(() => r(null)));

        const outcome = advanceSimulationTurn(current, nowIso());
        current = outcome.session;
        setView(viewFromSession(current));

        if (!outcome.advanced) {
          if (outcome.error) setErrorMessage(`Simulation stopped at Turn ${turnNumber}: ${outcome.error.message}`);
          break;
        }
      }
      setPhase("idle");
      setRunningTurn(null);
      // 完走・シナリオ終端・失敗のいずれでも保存する（失敗の記録も残す）。
      await persist(current);
    },
    [phase, restoring, view, createFresh, persist]
  );

  const reset = useCallback(() => {
    if (phase !== "idle") return;
    setView(viewFromSession(createFresh(nowIso())));
    setErrorMessage(null);
    setRunningTurn(null);
    setStorageNote(null);
  }, [phase, createFresh]);

  const selectRun = useCallback(async (simulationRunId: string) => {
    const stored = await loadSimulationRun(simulationRunId);
    if (!stored) return;
    setActiveSimulationRunId(simulationRunId);
    setView({ run: stored.run, dataset: stored.dataset, session: null });
    setErrorMessage(null);
  }, []);

  const dataset = view?.dataset ?? null;
  const revenueSeries = useMemo(
    () => (dataset ? toCompanySeries(dataset, "revenue").map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points })) : []),
    [dataset]
  );
  const profitSeries = useMemo(
    () => (dataset ? toCompanySeries(dataset, "operatingProfit").map((s) => ({ key: s.companyId, label: s.companyId, color: s.color, points: s.points })) : []),
    [dataset]
  );

  const completedTurns = dataset?.turns.length ?? 0;
  const busy = phase !== "idle";
  const isComplete = completedTurns >= MANAGEMENT_CONSOLE_STANDARD_TURNS;
  const isRestoredOnly = view !== null && view.session === null && completedTurns > 0;

  const money = (v: number | null | undefined) => (v === null || v === undefined ? "－" : `${(v / 1_000_000).toFixed(1)}M`);
  const latestValue = (companyId: string, metric: string): number | null => {
    if (!dataset) return null;
    const turn = dataset.turns[dataset.turns.length - 1];
    return dataset.companyMetrics.find((f) => f.companyId === companyId && f.turn === turn && f.metric === metric)?.value ?? null;
  };

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
              <dd className="font-mono font-semibold">{view?.run.scenarioId ?? "－"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Turn</dt>
              <dd className="font-mono font-semibold" data-testid="turn-counter">
                {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Simulation Run ID</dt>
              <dd className="max-w-[220px] truncate font-mono text-[11px]" data-testid="run-id">
                {view?.run.simulationRunId ?? "－"}
              </dd>
            </div>
          </dl>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => run(1)} disabled={busy || restoring} data-testid="run-1"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              1 Turn
            </button>
            <button type="button" onClick={() => run(4)} disabled={busy || restoring} data-testid="run-4"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600 disabled:opacity-40">
              4 Turns
            </button>
            <button type="button" onClick={() => run(MANAGEMENT_CONSOLE_STANDARD_TURNS)} disabled={busy || restoring} data-testid="run-32"
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
            <Link
              href={view?.run.simulationRunId ? `/v2/management/analysis?run=${encodeURIComponent(view.run.simulationRunId)}` : "/v2/management/analysis"}
              data-testid="analysis-link"
              className="rounded border border-sky-600 px-3 py-1.5 text-sm font-semibold text-sky-300 hover:bg-slate-800"
            >
              Analysis
            </Link>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* progress: 実際に処理中のターン番号を出す（水増ししない） */}
          <div className="min-h-[20px] text-xs" role="status" aria-live="polite" data-testid="progress">
            {restoring ? (
              <span className="text-slate-500">保存済みの実行を確認しています…</span>
            ) : phase === "running" && runningTurn !== null ? (
              <span className="text-sky-300">
                Running Turn {runningTurn} / {MANAGEMENT_CONSOLE_STANDARD_TURNS}（Completed {completedTurns} / {targetTurns} 要求分）
              </span>
            ) : phase === "stopping" ? (
              <span className="text-amber-300">停止要求を受け付けました。処理中のターンの完了を待っています…</span>
            ) : errorMessage ? (
              <span className="text-rose-400" data-testid="error-message">{errorMessage}</span>
            ) : view?.run.stopReason === "stopped_by_user" ? (
              <span className="text-amber-300">Stopped by user — Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns</span>
            ) : isComplete && completedTurns > 0 ? (
              <span className="font-semibold text-emerald-400" data-testid="complete-message">
                Simulation Complete — {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns
              </span>
            ) : completedTurns > 0 ? (
              <span className="text-slate-400">Completed {completedTurns} / {MANAGEMENT_CONSOLE_STANDARD_TURNS} Turns</span>
            ) : (
              <span className="text-slate-500">待機中</span>
            )}
          </div>

          <RunSelector runs={savedRuns} selectedRunId={view?.run.simulationRunId ?? null} onSelect={selectRun} disabled={busy} />

          {storageNote ? (
            <span className="text-[11px] text-slate-400" data-testid="storage-note">{storageNote}</span>
          ) : null}
        </div>

        {isRestoredOnly ? (
          <p className="mt-1 text-[11px] text-amber-300/90" data-testid="restored-note">
            保存済みの Simulation Run を表示しています。保存物には途中状態を含めていないため、
            この実行の「続き」からは進められません（実行ボタンを押すと新しい実行を開始します）。
          </p>
        ) : null}
      </header>

      {/* ---------------- BODY ---------------- */}
      <div className="flex flex-col gap-3 p-3 lg:flex-row">
        {/* LEFT: Game Overview 約65% */}
        <main className="flex flex-col gap-3 lg:w-[65%]">
          <SeriesChart
            title="Revenue Trend（5社 / 32Q）"
            series={revenueSeries}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightKey={selectedCompanyId}
            unitLabel="USD"
            emptyMessage="まだデータがありません。ターンを進めてください。"
          />
          <SeriesChart
            title="Operating Profit Trend（5社 / 32Q）"
            series={profitSeries}
            totalTurns={MANAGEMENT_CONSOLE_STANDARD_TURNS}
            highlightKey={selectedCompanyId}
            unitLabel="USD"
            emptyMessage="まだデータがありません。ターンを進めてください。"
          />

          {dataset ? <MarketSummary dataset={dataset} /> : null}

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
                  {(dataset?.companies ?? []).map((c) => {
                    const op = latestValue(c.companyId, "operatingProfit");
                    return (
                      <tr
                        key={c.companyId}
                        onClick={() => setSelectedCompanyId(c.companyId)}
                        className={`cursor-pointer border-b border-slate-800 hover:bg-slate-800/60 ${c.companyId === selectedCompanyId ? "bg-slate-800/80" : ""}`}
                      >
                        <td className="py-1 pr-2">
                          <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: c.color }} aria-hidden />
                          {c.companyId}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "revenue"))}</td>
                        <td className={`py-1 pr-2 text-right tabular-nums ${(op ?? 0) < 0 ? "text-rose-400" : ""}`}>{money(op)}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "netIncome"))}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{money(latestValue(c.companyId, "cash"))}</td>
                        <td className="py-1 text-right tabular-nums">{money(latestValue(c.companyId, "debt"))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {completedTurns === 0 ? <p className="mt-2 text-xs text-slate-400">ターンを進めると実績が表示されます。</p> : null}
          </section>
        </main>

        {/* RIGHT: Company Inspector 約35% */}
        <aside className="lg:w-[35%]">
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-2.5">
            <h2 className="mb-2 text-sm font-semibold">Company Inspector</h2>
            {dataset ? (
              <CompanyInspector
                dataset={dataset}
                fixtures={fixtures}
                selectedCompanyId={selectedCompanyId}
                onSelect={setSelectedCompanyId}
                strategyDocs={strategyDocs}
              />
            ) : (
              <p className="text-sm text-slate-400">読み込み中…</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
