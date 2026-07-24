// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ作成画面（指示§8.1）
//
// 会社選択肢はUIへ重複ハードコードせず、_lib/companyOptions.ts（既存buildCompanyFixtures
// 由来）から生成する。シナリオ選択肢も既存のALL_SCENARIO_DEFINITIONSをそのまま使う
// （既存の仮UI app/v2/company-lab/page.tsx と同じデータ源）。
//
// 【指示§6】playerCompanyIdはこの画面で明示的に選択必須（<select required>、デフォルトの
// サイレントfallbackは行わない）。実際の拒否判定はhandleCreateLab側（8C-3A実装）が行う。

import { requireStagingSession } from "../../../../lib/companyLabUiSession";
import { ALL_SCENARIO_DEFINITIONS } from "../../../../lib/v2/scenario";
import { listCompanyOptionsForUi } from "../_lib/companyOptions";
import { createLabAction } from "./actions";
import PlayLabBanner from "../components/PlayLabBanner";

const MAX_TURNS = 40;
const DEFAULT_SEED = "company-lab-ui-seed-001";

interface NewLabPageProps {
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function NewCompanyLabPage({ searchParams }: NewLabPageProps) {
  await requireStagingSession();
  const { error } = await searchParams;

  const scenarios = ALL_SCENARIO_DEFINITIONS;
  const companies = listCompanyOptionsForUi();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-8 space-y-6">
        <h1 className="text-lg font-semibold">新しいCompany Labを作成</h1>

        {error && <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-4 py-3 text-sm text-red-200">{decodeURIComponent(error)}</div>}

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
            <select id="scenarioId" name="scenarioId" defaultValue={scenarios[0]?.scenarioId} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
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
            <input id="seed" name="seed" defaultValue={DEFAULT_SEED} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
          </div>

          <div>
            <label htmlFor="turns" className="block text-xs text-gray-400 mb-1">
              ターン数（上限{MAX_TURNS}）
            </label>
            <input
              id="turns"
              type="number"
              name="turns"
              defaultValue={MAX_TURNS}
              min={1}
              max={MAX_TURNS}
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
      </div>
    </div>
  );
}
