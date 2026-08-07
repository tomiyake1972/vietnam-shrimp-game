// ShrimpX V2 — Company Lab プレイヤー画面 ラボ作成フォーム（Client Component）
//
// 【ターン数整合性修正】ターン数の初期値・上限は選択中シナリオのdurationTurns
// （_lib/newLabFormModel.tsのturnBoundsForScenarioが唯一の導出点）。シナリオを
// 変更すると、ターン数入力値と上限が新しいシナリオのdurationTurnsへ追随する。
// 32・40等の数値はこのファイルへ一切ハードコードしない。
//
// このクライアント側の初期値・上限はあくまで利便性のためであり、強制は
// サーバー側の二層（validation.tsのdurationTurns検証＋initializeCompanyLabの検証）が
// 独立に行う（指示「クライアント側の表示だけに依存しないこと」）。
//
// フォーム全体をClient Component化したのは「シナリオ変更→ターン数追随」という
// クライアント側インタラクションが必要になったため。送信先は従来どおり
// Server Action（createLabAction。セッション検証・Origin確認・入力検証はサーバー側）。

"use client";

import { useState } from "react";
import { createLabAction } from "./actions";
import { NewLabScenarioOption, turnBoundsForScenario } from "../_lib/newLabFormModel";
import { CompanyOptionForUi } from "../_lib/companyOptions";

export interface NewLabFormProps {
  readonly scenarios: readonly NewLabScenarioOption[];
  readonly companies: readonly CompanyOptionForUi[];
  readonly defaultSeed: string;
}

export default function NewLabForm({ scenarios, companies, defaultSeed }: NewLabFormProps) {
  const initialScenarioId = scenarios[0]?.scenarioId ?? "";
  const initialBounds = turnBoundsForScenario(scenarios, initialScenarioId);

  const [selectedScenarioId, setSelectedScenarioId] = useState(initialScenarioId);
  // 入力途中の空欄等を壊さないよう文字列で保持する（サーバー側validation.tsが最終検証を行う）。
  const [turns, setTurns] = useState(initialBounds !== null ? String(initialBounds.defaultTurns) : "");

  const bounds = turnBoundsForScenario(scenarios, selectedScenarioId);

  function handleScenarioChange(nextScenarioId: string): void {
    setSelectedScenarioId(nextScenarioId);
    // 【指示3】シナリオ変更時は、新しく選択したシナリオのdurationTurnsへターン数を更新する。
    const nextBounds = turnBoundsForScenario(scenarios, nextScenarioId);
    if (nextBounds !== null) {
      setTurns(String(nextBounds.defaultTurns));
    }
  }

  return (
    <form action={createLabAction} className="space-y-4 bg-gray-800 rounded-2xl p-5">
      <div>
        <label htmlFor="labId" className="block text-xs text-gray-400 mb-1">
          ラボID（任意。省略時は自動採番）
        </label>
        <input id="labId" name="labId" className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" placeholder="例: my-first-lab" />
      </div>

      <div>
        <label htmlFor="scenarioId" className="block text-xs text-gray-400 mb-1">
          シナリオ
        </label>
        <select
          id="scenarioId"
          name="scenarioId"
          value={selectedScenarioId}
          onChange={(e) => handleScenarioChange(e.target.value)}
          className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
        >
          {scenarios.map((s) => (
            <option key={s.scenarioId} value={s.scenarioId}>
              {s.title}（{s.durationTurns}ターン）
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="mode" className="block text-xs text-gray-400 mb-1">
          モード
        </label>
        <select id="mode" name="mode" defaultValue="canonical" className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
          <option value="canonical">canonical（基準シナリオ）</option>
          <option value="variation">variation（変動シナリオ）</option>
        </select>
      </div>

      <div>
        <label htmlFor="seed" className="block text-xs text-gray-400 mb-1">
          シード
        </label>
        <input id="seed" name="seed" defaultValue={defaultSeed} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
      </div>

      <div>
        <label htmlFor="turns" className="block text-xs text-gray-400 mb-1">
          ターン数（1〜{bounds?.maxTurns ?? "?"}。選択中シナリオの期間に連動）
        </label>
        <input
          id="turns"
          type="number"
          name="turns"
          value={turns}
          onChange={(e) => setTurns(e.target.value)}
          min={1}
          max={bounds?.maxTurns}
          className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
        />
      </div>

      <div>
        <label htmlFor="playerCompanyId" className="block text-xs text-gray-400 mb-1">
          プレイヤー操作会社（必須）
        </label>
        <select
          id="playerCompanyId"
          name="playerCompanyId"
          required
          defaultValue={companies[0]?.companyId}
          className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
        >
          {companies.map((c) => (
            <option key={c.companyId} value={c.companyId}>
              {c.companyId}（{c.displayName}）
            </option>
          ))}
        </select>
        <p className="text-[11px] text-gray-500 mt-1">作成後は変更できません。</p>
      </div>

      <button type="submit" className="bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
        作成する
      </button>
    </form>
  );
}
