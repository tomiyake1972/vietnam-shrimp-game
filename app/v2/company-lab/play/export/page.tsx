// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 ラボ選択画面
//
// 既存のラボ一覧（handleListLabs）をそのまま再利用する（既存の /v2/company-lab/play
// 一覧ページと同じ、要約DTOだけを扱う既存パターン）。ここでの一覧取得自体は
// 会社の財務等の非公開データを含まない軽量なサマリーであり、実際にエクスポート
// されるデータ（JSON/Excel）は次の画面（[labId]/page.tsx）以降ですべて
// 読み取り専用Export API経由でのみ取得する。

import Link from "next/link";
import { isProduction } from "../../../../lib/env";
import { requireStagingSession } from "../../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies } from "../_lib/uiDependencies";
import { handleListLabs } from "../../../../api/v2/company-labs/_lib/handlers";
import type { CompanyLabSummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import PlayLabBanner from "../components/PlayLabBanner";

export default async function CompanyLabExportListPage() {
  await requireStagingSession();

  if (isProduction) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center px-4">
        <div className="bg-gray-800 rounded-2xl p-6 text-sm text-gray-300">この機能は本番環境では利用できません。</div>
      </div>
    );
  }

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleListLabs(deps);
  const labs: readonly CompanyLabSummaryDto[] = result.status === 200 ? (result.body as { labs: CompanyLabSummaryDto[] }).labs : [];
  const sorted = [...labs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">分析データをエクスポート</h1>
          <Link href="/v2/company-lab/play" className="text-xs text-teal-400 underline">
            ラボ一覧へ戻る
          </Link>
        </div>
        <p className="text-xs text-gray-400">
          エクスポートするラボを選んでください。次の画面で、確定済みのTurnと会社を選び、JSON・Excelをダウンロードできます。
        </p>

        {sorted.length === 0 ? (
          <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">まだラボがありません。</div>
        ) : (
          <div className="bg-gray-800 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-700/60 text-xs text-gray-400">
                <tr>
                  <th className="text-left px-4 py-2">ラボID</th>
                  <th className="text-left px-4 py-2">プレイヤー会社</th>
                  <th className="text-left px-4 py-2">turn</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((lab) => (
                  <tr key={lab.labId} className="border-t border-gray-700/60">
                    <td className="px-4 py-2 font-mono text-xs">{lab.labId}</td>
                    <td className="px-4 py-2">{lab.playerCompanyId}</td>
                    <td className="px-4 py-2">
                      {lab.currentTurn} / {lab.totalTurns}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/v2/company-lab/play/export/${encodeURIComponent(lab.labId)}`}
                        className="bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg px-3 py-1.5 text-xs inline-block"
                      >
                        エクスポート
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
