// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 設定・操作パネル
//
// シナリオ・モード・シード・プレイヤー操作会社の選択と、初期化・1四半期進める・
// 複数ターン一括実行・リセットの操作ボタンをまとめる。industry-lab（Phase3）の
// ScenarioControls.tsxと同じ見た目の規約（bg-gray-800のカード、bg-gray-700の
// 入力欄）を踏襲する。計算ロジックは持たない。

import { ScenarioMode } from "../../../lib/v2/scenario/types";

export interface ScenarioOption {
  readonly scenarioId: string;
  readonly title: string;
  readonly durationTurns: number;
}

export interface CompanyOption {
  readonly companyId: string;
  readonly displayName: string;
}

interface ScenarioControlsProps {
  readonly scenarioOptions: readonly ScenarioOption[];
  readonly companyOptions: readonly CompanyOption[];
  readonly draftScenarioId: string;
  readonly draftMode: ScenarioMode;
  readonly draftSeed: string;
  readonly draftPlayerCompanyId: string;
  readonly onChangeScenarioId: (id: string) => void;
  readonly onChangeMode: (mode: ScenarioMode) => void;
  readonly onChangeSeed: (seed: string) => void;
  readonly onChangePlayerCompanyId: (companyId: string) => void;
  readonly onInit: () => void;
  readonly onStepOnce: () => void;
  readonly onBulkRun: (turns: number) => void;
  readonly onReset: () => void;
  readonly canEditSetup: boolean;
  readonly canStepOnce: boolean;
  readonly canBulkRun: boolean;
  readonly hasRun: boolean;
  readonly progressLabel: string;
}

export default function ScenarioControls(props: ScenarioControlsProps) {
  const {
    scenarioOptions,
    companyOptions,
    draftScenarioId,
    draftMode,
    draftSeed,
    draftPlayerCompanyId,
    onChangeScenarioId,
    onChangeMode,
    onChangeSeed,
    onChangePlayerCompanyId,
    onInit,
    onStepOnce,
    onBulkRun,
    onReset,
    canEditSetup,
    canStepOnce,
    canBulkRun,
    hasRun,
    progressLabel,
  } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h2 className="text-base font-semibold text-gray-100">設定</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          シナリオ
          <select
            value={draftScenarioId}
            onChange={(e) => onChangeScenarioId(e.target.value)}
            disabled={!canEditSetup}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
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
            disabled={!canEditSetup}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
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
            disabled={!canEditSetup}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
            placeholder="例: company-lab-seed-001"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-400">
          プレイヤー操作会社
          <select
            value={draftPlayerCompanyId}
            onChange={(e) => onChangePlayerCompanyId(e.target.value)}
            disabled={!canEditSetup}
            className="bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
          >
            {companyOptions.map((opt) => (
              <option key={opt.companyId} value={opt.companyId}>
                {opt.companyId}（{opt.displayName}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500">
        プレイヤー操作会社以外の4社は常に暫定自動方針（generateAutoPolicyDecision）で動く。
        「8/32ターン一括実行」は仕様どおり、プレイヤー操作会社を含む全5社を暫定自動方針で動かす
        （プレイヤーの個別編集は「1四半期進める」でのみ反映される）。
      </p>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={onInit}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-sm font-semibold text-white"
        >
          初期化
        </button>
        <button
          onClick={onStepOnce}
          disabled={!canStepOnce}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-gray-100"
        >
          1四半期進める（自社編集を反映）
        </button>
        <button
          onClick={() => onBulkRun(8)}
          disabled={!canBulkRun}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-gray-100"
        >
          8ターン一括実行（全社自動方針）
        </button>
        <button
          onClick={() => onBulkRun(32)}
          disabled={!canBulkRun}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-gray-100"
        >
          32ターン一括実行（全社自動方針）
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
