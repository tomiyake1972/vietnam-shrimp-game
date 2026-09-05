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
import { SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { listSimulationRuns } from "../lib/simulationRunStore";
import { persistResumableRun } from "../lib/persistRun";
import { upsertLiveSession } from "../lib/liveSessionRegistry";
import { newRunId } from "../lib/runId";
import { StrategicPosture } from "../../../lib/v2/companyLab/vision/types";
// 【MANAGEMENT-CONSOLE-SALES-MODEL-1】販売市場モデルの唯一のSSoTは
// lib/v2/sales/salesModels.ts（immutable registry）であり、その日本語ラベル・
// 既定値・「既定のままなら送らない」変換は Company Lab のラボ作成フォームが
// 既に使っている表示モジュール／純粋関数をそのまま再利用する。
// Management Console用に別のラベル表・別の既定値を新設しない。
import { SALES_MODEL_IDS } from "../../../lib/v2/sales/salesModels";
import {
  DEFAULT_SALES_MODEL_ID,
  SALES_MODEL_DESCRIPTIONS,
  SALES_MODEL_DISPLAY_LABELS,
} from "../../company-lab/play/_lib/salesModelDisplay";
import { resolveSalesModelIdForSubmission } from "../../company-lab/play/_lib/newLabFormModel";
import {
  CompanyLabVisionOverrides,
  CompanyVisionOverrideEntry,
  VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER,
  VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER,
  defaultCompanyVisionAtTurn,
  isVisionTargetScaleInValidRange,
} from "../../../lib/v2/companyLab/vision/overrides";

const STRATEGIC_POSTURE_OPTIONS: readonly StrategicPosture[] = ["AGGRESSIVE_EARLY_CAPACITY", "DEMAND_CONFIRMED", "VALUE_FIRST"];

function defaultVisionTargetsByCompany(): Record<string, number> {
  return Object.fromEntries(
    COMPANY_LAB_COMPANY_IDS.map((id) => [id, defaultCompanyVisionAtTurn(id, 1)?.targetScaleTonsPerQuarterAtQ32 ?? VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER])
  );
}

function defaultVisionPosturesByCompany(): Record<string, StrategicPosture> {
  return Object.fromEntries(COMPANY_LAB_COMPANY_IDS.map((id) => [id, defaultCompanyVisionAtTurn(id, 1)?.strategicPosture ?? "DEMAND_CONFIRMED"]));
}

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
  // 【MANAGEMENT-CONSOLE-SALES-MODEL-1】既定は従来市場モデル（legacy）。
  // Run開始時に固定され、開始後は変更できない（この値を書き換えるUIは
  // Management Console・PLAYER Workspaceのどちらにも作らない）。
  const [salesModelId, setSalesModelId] = useState<string>(DEFAULT_SALES_MODEL_ID);
  const [controlModes, setControlModes] = useState<Readonly<Record<string, CompanyControlMode>>>(
    () => Object.fromEntries(COMPANY_LAB_COMPANY_IDS.map((id) => [id, "STANDARD_AI" as CompanyControlMode]))
  );
  const [starting, setStarting] = useState(false);
  const [savedRuns, setSavedRuns] = useState<readonly SimulationRunSummary[] | null>(null);
  const [defaultVisionTargets] = useState<Record<string, number>>(() => defaultVisionTargetsByCompany());
  const [defaultVisionPostures] = useState<Record<string, StrategicPosture>>(() => defaultVisionPosturesByCompany());
  const [visionTargets, setVisionTargets] = useState<Record<string, number>>(() => defaultVisionTargetsByCompany());
  const [visionPostures, setVisionPostures] = useState<Record<string, StrategicPosture>>(() => defaultVisionPosturesByCompany());

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

  const handleChangeVisionTarget = useCallback((companyId: string, value: number) => {
    setVisionTargets((prev) => ({ ...prev, [companyId]: value }));
  }, []);

  const handleChangeVisionPosture = useCallback((companyId: string, posture: StrategicPosture) => {
    setVisionPostures((prev) => ({ ...prev, [companyId]: posture }));
  }, []);

  const handleResetVisionDefaults = useCallback(() => {
    setVisionTargets(defaultVisionTargetsByCompany());
    setVisionPostures(defaultVisionPosturesByCompany());
  }, []);

  const hasInvalidVisionTarget = COMPANY_LAB_COMPANY_IDS.some((id) => !isVisionTargetScaleInValidRange(visionTargets[id] ?? 0));

  const handleStart = useCallback(async () => {
    if (!selectedScenario || starting || hasInvalidVisionTarget) return;
    setStarting(true);
    const startedAt = nowIso();
    const simulationRunId = newRunId(`${scenarioAlias}-${seed}`, startedAt);
    // 【指示§9「Default Vision + Run-specific override」】defaultから変更した会社
    // だけをoverrideに含める。誰も編集しなければvisionOverridesはundefinedのままで、
    // 既存の全Run・全テストの挙動を変えない。
    const visionOverrides: Record<string, readonly CompanyVisionOverrideEntry[]> = {};
    for (const companyId of COMPANY_LAB_COMPANY_IDS) {
      const target = visionTargets[companyId];
      const posture = visionPostures[companyId];
      const targetChanged = target !== defaultVisionTargets[companyId];
      const postureChanged = posture !== defaultVisionPostures[companyId];
      if (targetChanged || postureChanged) {
        visionOverrides[companyId] = [
          { effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: target, strategicPosture: posture, source: "MANUAL_OVERRIDE" },
        ];
      }
    }
    const session = createSimulationSession({
      simulationRunId,
      scenarioId: scenarioAlias,
      seed,
      requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
      startedAt,
      runName: runName.trim() || undefined,
      companyControlModes: controlModes,
      visionOverrides: Object.keys(visionOverrides).length > 0 ? (visionOverrides as CompanyLabVisionOverrides) : undefined,
      // 既定（従来市場モデル）のままなら undefined ＝ createSimulationSession が
      // configへキー自体を書き込まない（既存Runとビット単位で同一のconfig）。
      salesModelId: resolveSalesModelIdForSubmission(salesModelId),
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
    // 【AI Management Meeting・Turn1利用可否】以前はここでdataset単体だけを保存し、
    // resumePayloadはPLAYER意思決定確定・Turn進行まで存在しなかったため、Turn1開始
    // 直後はAI経営会議が使えなかった（resumePayloadが無いSimulation Runとして404）。
    // persistResumableRun（Console・PLAYER Workspaceの両方が既に使っている唯一の
    // 保存関数）をRun作成時にも呼ぶことで、「resumePayloadの組み立て方は1箇所にだけ
    // 書く」という既存方針のまま、Run作成直後からresumePayloadが存在するようにする。
    // confirmedPlayerDecisionsは何も確定していないため{}（意思決定の扱いは変更しない）。
    await persistResumableRun(session, controlModes, {});
    router.push(`/v2/management?run=${encodeURIComponent(simulationRunId)}`);
  }, [
    selectedScenario,
    scenarioAlias,
    seed,
    runName,
    controlModes,
    salesModelId,
    starting,
    router,
    visionTargets,
    visionPostures,
    defaultVisionTargets,
    defaultVisionPostures,
    hasInvalidVisionTarget,
  ]);

  return (
    <div className="min-h-screen bg-slate-950 p-3 text-slate-100 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">ShrimpX 経営管制室 — ゲーム条件設定</h1>
            <p className="mt-1 text-xs text-slate-400">
              Scenario・Seed・会社ごとの経営モードを選んで、新しいSimulation Runを開始します。既存のRunはここでは変更・削除されません。
            </p>
          </div>
          {/* 【管理者ログイン固定導線】PC/iPad/別ブラウザ等、端末を変えた際に
              staging管理認証セッションが切れていることがあり、その状態のまま
              ゲームを開始すると後でManagement Console側の保存操作（Turn進行・
              Game End等）が認証不足で止まる。新しい認証機構・新しいlogin page・
              新しいtoken方式は作らず、Management Console等と共通の既存
              staging管理ログインroute（/v2/company-lab/play/login）をそのまま
              再利用する。既に認証済みでもこのroute自身がreturnToへ自動的に
              戻すため、Setup画面側で認証状態を判定するロジックは持たない。
              別タブで開き、Setup画面の入力中の設定を失わせない。 */}
          <Link
            href={`/v2/company-lab/play/login?returnTo=${encodeURIComponent("/v2/management/setup")}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="setup-admin-login-link"
            className="shrink-0 rounded border border-slate-600 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-400 hover:bg-slate-800"
          >
            🔐 管理者ログイン
          </Link>
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

        {/* --- Vision / AI Strategy Calibration --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-vision-calibration-section">
          <h2 className="mb-2 text-sm font-semibold">4. Vision / AI Strategy Calibration（Q32目標規模・戦略姿勢）</h2>
          <p className="mb-2 text-[11px] leading-snug text-slate-500">
            各社が8年後（Q32）に目指す規模の「志」です。単位は <span className="font-mono">t / quarter（t/四半期）</span>
            。ここで変更してもStandard AIが必ずこの数量を作るわけではありません（達成義務ではなく、投資判断の物差しです）。このRunだけに適用され、他のRunや既定値は変わりません。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-left text-slate-400">
                  <th className="py-1 pr-2">Company</th>
                  <th className="py-1 pr-2">Q32 Target Scale（t/quarter）</th>
                  <th className="py-1 pr-2">Default</th>
                  <th className="py-1 pr-2">Strategic Posture</th>
                </tr>
              </thead>
              <tbody>
                {COMPANY_LAB_COMPANY_IDS.map((companyId) => {
                  const value = visionTargets[companyId] ?? 0;
                  const valid = isVisionTargetScaleInValidRange(value);
                  const isDefault = value === defaultVisionTargets[companyId];
                  return (
                    <tr key={companyId} className="border-b border-slate-800">
                      <td className="py-1 pr-2 font-semibold">{companyId}</td>
                      <td className="py-1 pr-2">
                        <input
                          type="number"
                          value={value}
                          step={1000}
                          min={VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER}
                          max={VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER}
                          onChange={(e) => handleChangeVisionTarget(companyId, Math.round(Number(e.target.value)))}
                          data-testid={`setup-vision-target-${companyId}`}
                          className={`w-28 rounded border bg-slate-900 px-1.5 py-1 text-[11px] ${valid ? "border-slate-600" : "border-red-600"}`}
                        />
                        {!valid ? (
                          <p className="mt-0.5 text-[10px] text-red-400" data-testid={`setup-vision-target-warning-${companyId}`}>
                            {VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER.toLocaleString()}〜{VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER.toLocaleString()}
                            t/期の範囲で入力してください。
                          </p>
                        ) : null}
                      </td>
                      <td className={`py-1 pr-2 tabular-nums ${isDefault ? "text-slate-500" : "text-amber-400"}`}>
                        {defaultVisionTargets[companyId]?.toLocaleString() ?? "－"}
                      </td>
                      <td className="py-1 pr-2">
                        <select
                          value={visionPostures[companyId] ?? "DEMAND_CONFIRMED"}
                          onChange={(e) => handleChangeVisionPosture(companyId, e.target.value as StrategicPosture)}
                          data-testid={`setup-vision-posture-${companyId}`}
                          className="rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px]"
                        >
                          {STRATEGIC_POSTURE_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={handleResetVisionDefaults}
            data-testid="setup-vision-reset-defaults"
            className="mt-2 rounded border border-slate-600 px-2.5 py-1.5 text-[11px] hover:bg-slate-800"
          >
            Reset Defaults
          </button>
        </section>

        {/* --- Sales market model --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-sales-model-section">
          <h2 className="mb-2 text-sm font-semibold">5. 販売市場モデル</h2>
          <select
            value={salesModelId}
            onChange={(e) => setSalesModelId(e.target.value)}
            data-testid="setup-sales-model-select"
            className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs"
          >
            {SALES_MODEL_IDS.map((id) => (
              <option key={id} value={id}>
                {SALES_MODEL_DISPLAY_LABELS[id]}
              </option>
            ))}
          </select>
          <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-slate-500">
            {SALES_MODEL_IDS.map((id) => (
              <li key={id}>
                {SALES_MODEL_DISPLAY_LABELS[id]}: 「{SALES_MODEL_DESCRIPTIONS[id]}」
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            このRunで使う販売市場モデルは開始時に固定され、途中では変更できません（PLAYER会社・Standard AI会社の5社すべてが同じ市場モデルで成約を争います）。
          </p>
        </section>

        {/* --- Run name --- */}
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="setup-run-name-section">
          <h2 className="mb-2 text-sm font-semibold">6. Run名・メモ（任意）</h2>
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
          disabled={starting || hasInvalidVisionTarget}
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
