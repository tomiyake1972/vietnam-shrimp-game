"use client";

// ShrimpX V2 — Game Setup / Scenario Selection（Phase 8）
//
// 【Scenario一覧はコードから読む】listScenarioAliases()（scenario/definitions の
// 登録簿）をそのまま読む。未実装のScenarioをダミーで追加しない。将来Scenarioを
// 追加すれば、この画面の選択肢にも自動で現れる（指示§C/§E）。
//
// 【ここでRunを作らない】「この条件でゲーム開始」を押したときだけ、新しい
// Simulation Runを生成する。画面を開いた・条件を選んだだけでは何も作らない
// （指示§H）。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listScenarioAliases } from "../../../lib/v2/industryLab/cli/scenarioAliases";
import { COMPANY_LAB_COMPANY_IDS } from "../../../lib/v2/companyLab";
import { createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { CompanyControlMode, MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../../../lib/v2/companyLab/simulation/types";
import { buildDatasetFromSession } from "../../../lib/v2/companyLab/simulation/analytics/dataset";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { listSimulationRuns, saveSimulationRun, setActiveSimulationRunId } from "../lib/simulationRunStore";
import { upsertLiveSession } from "../lib/liveSessionRegistry";
import { newRunId } from "../lib/runId";

const SCENARIOS = listScenarioAliases();
const DEFAULT_SEED = "management-console-32q";

function nowIso(): string {
  return new Date().toISOString();
}

/** ランダムなseed候補を作る（UIの便宜のためだけの提案値。ここに決定論を依存させない）。 */
function suggestSeed(): string {
  return `seed-${Math.random().toString(36).slice(2, 10)}`;
}

function formatStopReason(stopReason: SimulationRunSummary["stopReason"]): string {
  const labels: Readonly<Record<string, string>> = {
    completed: "完了",
    stopped_by_user: "停止中",
    error: "エラー",
    scenario_end: "シナリオ終端",
    waiting_for_player: "PLAYER待ち",
    running: "実行中",
  };
  return labels[stopReason] ?? stopReason;
}

export function SetupScreen() {
  const router = useRouter();
  const [scenarioAlias, setScenarioAlias] = useState(SCENARIOS[0]?.alias ?? "baseline");
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [runName, setRunName] = useState("");
  const [controlModes, setControlModes] = useState<Readonly<Record<string, CompanyControlMode>>>(
    () => Object.fromEntries(COMPANY_LAB_COMPANY_IDS.map((id) => [id, "STANDARD_AI" as CompanyControlMode]))
  );
  const [starting, setStarting] = useState(false);
  const [savedRuns, setSavedRuns] = useState<readonly SimulationRunSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const runs = await listSimulationRuns();
      if (!cancelled) setSavedRuns(runs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedScenario = SCENARIOS.find((s) => s.alias === scenarioAlias) ?? SCENARIOS[0];

  const handleChangeControlMode = useCallback((companyId: string, mode: CompanyControlMode) => {
    setControlModes((prev) => ({ ...prev, [companyId]: mode }));
  }, []);

  const handleStart = useCallback(async () => {
    if (!selectedScenario || starting) return;
    setStarting(true);
    const startedAt = nowIso();
    const simulationRunId = newRunId(`${scenarioAlias}-${seed}`, startedAt);
    const session = createSimulationSession({
      simulationRunId,
      scenarioId: scenarioAlias,
      seed,
      requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
      startedAt,
      runName: runName.trim() || undefined,
      companyControlModes: controlModes,
    });

    // 【指示§I】既存Runは削除・上書きしない。新しいRunを1本追加するだけ。
    upsertLiveSession(simulationRunId, {
      session,
      companyControlModes: controlModes,
      confirmedPlayerDecisions: {},
      confirmedPlayerDrafts: {},
      pendingDrafts: {},
      selectedCompanyId: COMPANY_LAB_COMPANY_IDS[0],
    });
    await saveSimulationRun({
      schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
      run: session.run,
      dataset: buildDatasetFromSession(session),
      packCapture: { companyTurns: [], worldTurns: [] },
      savedAt: nowIso(),
    });
    setActiveSimulationRunId(simulationRunId);
    router.push(`/v2/management?run=${encodeURIComponent(simulationRunId)}`);
  }, [selectedScenario, scenarioAlias, seed, runName, controlModes, starting, router]);

  return (
    <div className="min-h-screen bg-slate-950 p-3 text-slate-100 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4">
          <h1 className="text-lg font-bold tracking-tight">ShrimpX 経営管制室 — ゲーム条件設定</h1>
          <p className="mt-1 text-xs text-slate-400">
            Scenario・Seed・会社ごとの経営モードを選んで、新しいSimulation Runを開始します。既存のRunはここでは変更・削除されません。
          </p>
        </header>

        {/* --- Scenario --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-scenario-section">
          <h2 className="mb-2 text-sm font-semibold">1. Scenario</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SCENARIOS.map((s) => {
              const isBaseline = s.alias === "baseline";
              const selected = s.alias === scenarioAlias;
              return (
                <button
                  key={s.alias}
                  type="button"
                  onClick={() => setScenarioAlias(s.alias)}
                  data-testid={`setup-scenario-card-${s.alias}`}
                  aria-pressed={selected}
                  className={`rounded-md border px-3 py-2.5 text-left ${
                    selected ? "border-sky-500 bg-sky-950/40" : "border-slate-700 bg-slate-900/40 hover:border-slate-600"
                  }`}
                >
                  <p className="text-sm font-semibold text-slate-100">
                    {s.definition.title}
                    {isBaseline ? <span className="ml-1.5 rounded bg-sky-700 px-1.5 py-0.5 text-[10px] font-semibold">標準Scenario</span> : null}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{s.definition.publicBackground}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    version {s.definition.version} / {s.definition.durationTurns}ターン
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* --- Seed --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-seed-section">
          <h2 className="mb-2 text-sm font-semibold">2. Seed</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              data-testid="setup-seed-input"
              spellCheck={false}
              className="w-[260px] rounded border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setSeed(suggestSeed())}
              data-testid="setup-seed-generate"
              className="rounded border border-slate-600 px-2.5 py-1.5 text-xs hover:bg-slate-800"
            >
              自動生成
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            同じScenario＋同じSeedを使うと、同じ条件を再現できます（Standard AIの判断・市場の動きが決定論的に一致します）。
          </p>
        </section>

        {/* --- Control Mode --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-control-mode-section">
          <h2 className="mb-2 text-sm font-semibold">3. 会社ごとの経営モード</h2>
          <ul className="flex flex-col gap-1.5">
            {COMPANY_LAB_COMPANY_IDS.map((companyId) => (
              <li key={companyId} className="flex items-center justify-between rounded border border-slate-700 bg-slate-900/40 px-2 py-1.5">
                <span className="text-xs font-semibold">{companyId}</span>
                <select
                  value={controlModes[companyId] ?? "STANDARD_AI"}
                  onChange={(e) => handleChangeControlMode(companyId, e.target.value as CompanyControlMode)}
                  data-testid={`setup-control-mode-${companyId}`}
                  className="rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px]"
                >
                  <option value="STANDARD_AI">Standard AI</option>
                  <option value="PLAYER">自分で操作</option>
                </select>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">開始後もManagement Console上の経営モード切替でいつでも変更できます。</p>
        </section>

        {/* --- Run name --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-run-name-section">
          <h2 className="mb-2 text-sm font-semibold">4. Run名・メモ（任意）</h2>
          <input
            type="text"
            value={runName}
            onChange={(e) => setRunName(e.target.value)}
            placeholder="例: BALをPLAYERにしたテストプレイ"
            data-testid="setup-run-name-input"
            className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs"
          />
        </section>

        {/* --- Start --- */}
        <button
          type="button"
          onClick={handleStart}
          disabled={starting}
          data-testid="setup-start-button"
          className="w-full rounded bg-emerald-700 px-4 py-3 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40"
        >
          この条件でゲーム開始
        </button>

        {/* --- Run History --- */}
        <section className="mt-6 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-run-history-section">
          <h2 className="mb-2 text-sm font-semibold">Run History（保存済みのRun一覧）</h2>
          {savedRuns === null ? (
            <p className="text-xs text-slate-400">読み込み中…</p>
          ) : savedRuns.length === 0 ? (
            <p className="text-xs text-slate-400">まだ保存済みのRunがありません。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-1 pr-2">Run</th>
                    <th className="py-1 pr-2">Scenario</th>
                    <th className="py-1 pr-2">Seed</th>
                    <th className="py-1 pr-2 text-right">Turns</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">PLAYER</th>
                    <th className="py-1">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {savedRuns.map((r) => (
                    <tr key={r.simulationRunId} className="border-b border-slate-800 hover:bg-slate-800/60">
                      <td className="py-1 pr-2">
                        <Link
                          href={`/v2/management?run=${encodeURIComponent(r.simulationRunId)}`}
                          data-testid={`setup-run-history-open-${r.simulationRunId}`}
                          className="font-mono text-sky-300 underline-offset-2 hover:underline"
                        >
                          {r.runName?.trim() ? r.runName : r.simulationRunId}
                        </Link>
                      </td>
                      <td className="py-1 pr-2">{r.scenarioId}</td>
                      <td className="py-1 pr-2 font-mono">{r.seed}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {r.completedTurns} / {r.requestedTurns}
                      </td>
                      <td className="py-1 pr-2">{formatStopReason(r.stopReason)}</td>
                      <td className="py-1 pr-2">{(r.playerCompanyIds ?? []).length > 0 ? r.playerCompanyIds!.join(", ") : "－"}</td>
                      <td className="py-1 text-slate-400">{r.startedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          ⓘ 新しいゲームを開始しても、既存のRunは削除されません。上のRun Historyからいつでも過去のRunへ戻れます。
        </p>
      </div>
    </div>
  );
}
