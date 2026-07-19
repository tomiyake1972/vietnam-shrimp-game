// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） シナリオ操作パネル

import { ScenarioMode } from "../../../lib/v2/scenario/types";

export interface ScenarioOption {
  readonly scenarioId: string;
  readonly title: string;
  readonly durationTurns: number;
}

interface ScenarioControlsProps {
  readonly scenarioOptions: readonly ScenarioOption[];
  readonly draftScenarioId: string;
  readonly draftMode: ScenarioMode;
  readonly draftSeed: string;
  readonly draftTurns: number;
  readonly maxTurnsForDraftScenario: number;
  readonly onChangeScenarioId: (id: string) => void;
  readonly onChangeMode: (mode: ScenarioMode) => void;
  readonly onChangeSeed: (seed: string) => void;
  readonly onChangeTurns: (turns: number) => void;
  readonly onStart: () => void;
  readonly onStepOnce: () => void;
  readonly onRunToEnd: () => void;
  readonly onReset: () => void;
  readonly canStepOnce: boolean;
  readonly canRunToEnd: boolean;
  readonly hasRun: boolean;
  readonly progressLabel: string;
}

const MIN_TURNS_INPUT = 20;
const MAX_TURNS_INPUT = 40;

export default function ScenarioControls(props: ScenarioControlsProps) {
  const {
    scenarioOptions,
    draftScenarioId,
    draftMode,
    draftSeed,
    draftTurns,
    maxTurnsForDraftScenario,
    onChangeScenarioId,
    onChangeMode,
    onChangeSeed,
    onChangeTurns,
    onStart,
    onStepOnce,
    onRunToEnd,
    onReset,
    canStepOnce,
    canRunToEnd,
    hasRun,
    progressLabel,
  } = props;

  const effectiveMax = Math.min(MAX_TURNS_INPUT, maxTurnsForDraftScenario);

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h2 className="text-base font-semibold text-gray-100">シナリオ設定</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          シナリオ
          <select
            value={draftScenarioId}
            onChange={(e) => onChangeScenarioId(e.target.value)}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
          >
            {scenarioOptions.map((opt) => (
              <option key={opt.scenarioId} value={opt.scenarioId}>
                {opt.title}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-400">
          モード
          <select
            value={draftMode}
            onChange={(e) => onChangeMode(e.target.value as ScenarioMode)}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
          >
            <option value="canonical">Canonical（外生イベント固定）</option>
            <option value="variation">Variation（シードで揺らす）</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-400">
          乱数シード
          <input
            type="text"
            value={draftSeed}
            onChange={(e) => onChangeSeed(e.target.value)}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
            placeholder="例: lab-seed-001"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-400">
          実行ターン数（{MIN_TURNS_INPUT}〜{effectiveMax}）
          <input
            type="number"
            min={MIN_TURNS_INPUT}
            max={effectiveMax}
            value={draftTurns}
            onChange={(e) => onChangeTurns(Number(e.target.value))}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={onStart}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-semibold text-white"
        >
          シミュレーション開始
        </button>
        <button
          onClick={onStepOnce}
          disabled={!canStepOnce}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-gray-100"
        >
          1四半期進める
        </button>
        <button
          onClick={onRunToEnd}
          disabled={!canRunToEnd}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-gray-100"
        >
          最後まで一括実行
        </button>
        <button
          onClick={onReset}
          className="px-4 py-2 bg-red-900/60 hover:bg-red-900 rounded-lg text-sm font-semibold text-red-200"
        >
          リセット
        </button>
        {hasRun && <span className="text-xs text-gray-400 ml-2">進行状況: {progressLabel}</span>}
      </div>
    </div>
  );
}
