// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ作成画面（指示§8.1）
//
// 会社選択肢はUIへ重複ハードコードせず、_lib/companyOptions.ts（既存buildCompanyFixtures
// 由来）から生成する。シナリオ選択肢も既存のALL_SCENARIO_DEFINITIONSを唯一のデータ源とする
// （_lib/newLabFormModel.ts経由。既存の仮UI app/v2/company-lab/page.tsx と同じデータ源）。
//
// 【ターン数整合性修正】ターン数の初期値・上限は選択中シナリオのdurationTurnsが唯一の正
// （baselineでは32）。シナリオ変更時の追随というクライアント側インタラクションが必要な
// ため、フォーム本体はClient Component（NewLabForm.tsx）へ分離した。本Server Componentは
// セッション検証と、シリアライズ可能なprops（選択肢・エラーメッセージ）の組み立てだけを行う。
//
// 【指示§6】playerCompanyIdはこの画面で明示的に選択必須（<select required>、デフォルトの
// サイレントfallbackは行わない）。実際の拒否判定はhandleCreateLab側（8C-3A実装）が行う。

import { requireStagingSession } from "../../../../lib/companyLabUiSession";
import { listScenarioOptionsForNewLab } from "../_lib/newLabFormModel";
import { listCompanyOptionsForUi } from "../_lib/companyOptions";
import NewLabForm from "./NewLabForm";
import PlayLabBanner from "../components/PlayLabBanner";

const DEFAULT_SEED = "company-lab-ui-seed-001";

interface NewLabPageProps {
  readonly searchParams: Promise<{ readonly error?: string }>;
}

export default async function NewCompanyLabPage({ searchParams }: NewLabPageProps) {
  await requireStagingSession();
  const { error } = await searchParams;

  const scenarios = listScenarioOptionsForNewLab();
  const companies = listCompanyOptionsForUi();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-8 space-y-6">
        <h1 className="text-lg font-semibold">新しいCompany Labを作成</h1>

        {error && <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-4 py-3 text-sm text-red-200">{decodeURIComponent(error)}</div>}

        <NewLabForm scenarios={scenarios} companies={companies} defaultSeed={DEFAULT_SEED} />
      </div>
    </div>
  );
}
