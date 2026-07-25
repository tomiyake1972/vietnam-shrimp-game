// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） ラボ一覧・作成導線（指示§8.1）
//
// 既存のCompany Lab一覧（handleListLabs、Phase 8C-3A）をそのまま再利用する
// （一覧取得ロジックを重複実装しない）。要約DTO（CompanyLabSummaryDto）のみを扱い、
// 巨大な内部snapshotは一切取得しない。

import Link from "next/link";
import { requireStagingSession } from "../../../lib/companyLabUiSession";
import { resolveCompanyLabUiDependencies, isCompanyLabUiRunningInMemoryForE2e } from "./_lib/uiDependencies";
import { handleListLabs } from "../../../api/v2/company-labs/_lib/handlers";
import type { CompanyLabSummaryDto } from "../../../api/v2/company-labs/_lib/responseDto";
import { listCompanyOptionsForUi } from "./_lib/companyOptions";
import PlayLabBanner from "./components/PlayLabBanner";
import { logoutAction } from "./actions";

export default async function CompanyLabListPage() {
  await requireStagingSession();

  const deps = await resolveCompanyLabUiDependencies();
  const result = await handleListLabs(deps);
  const labs: readonly CompanyLabSummaryDto[] = result.status === 200 ? (result.body as { labs: CompanyLabSummaryDto[] }).labs : [];
  const nameById = new Map(listCompanyOptionsForUi().map((c) => [c.companyId, c.displayName]));
  const sorted = [...labs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        {isCompanyLabUiRunningInMemoryForE2e() && (
          <div className="bg-amber-950/50 border border-amber-700/60 rounded-lg px-4 py-2 text-xs text-amber-200">
            COMPANY_LAB_UI_E2E_IN_MEMORY=1 で動作中です。この一覧・状態はサーバープロセス内のメモリ上のみに保存され、実Redisへは保存されません（ブラウザE2E検証専用のフォールバック）。
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Company Lab（テストプレイ）</h1>
          <div className="flex items-center gap-3">
            <Link href="/v2/company-lab/play/export" className="bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
              分析データをエクスポート
            </Link>
            <Link href="/v2/company-lab/play/new" className="bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
              新しいラボを作成
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="text-xs text-gray-400 underline">
                ログアウト
              </button>
            </form>
          </div>
        </div>

        {sorted.length === 0 ? (
          <div className="bg-gray-800 rounded-2xl p-8 text-center text-gray-400 text-sm">
            まだラボがありません。「新しいラボを作成」から開始してください。
          </div>
        ) : (
          <div className="bg-gray-800 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-700/60 text-xs text-gray-400">
                <tr>
                  <th className="text-left px-4 py-2">ラボID</th>
                  <th className="text-left px-4 py-2">プレイヤー会社</th>
                  <th className="text-left px-4 py-2">turn</th>
                  <th className="text-left px-4 py-2">状態</th>
                  <th className="text-left px-4 py-2">更新日時</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((lab) => (
                  <tr key={lab.labId} className="border-t border-gray-700/60">
                    <td className="px-4 py-2 font-mono text-xs">{lab.labId}</td>
                    <td className="px-4 py-2">
                      {lab.playerCompanyId}（{nameById.get(lab.playerCompanyId) ?? lab.playerCompanyId}）
                    </td>
                    <td className="px-4 py-2">
                      {lab.currentTurn} / {lab.totalTurns}
                    </td>
                    <td className="px-4 py-2">
                      {lab.isComplete ? (
                        <span className="bg-gray-600 text-gray-100 rounded-full px-2 py-0.5 text-xs">完了</span>
                      ) : (
                        <span className="bg-teal-700 text-teal-100 rounded-full px-2 py-0.5 text-xs">進行中</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400">{new Date(lab.updatedAt).toLocaleString("ja-JP")}</td>
                    <td className="px-4 py-2 text-right">
                      <Link href={`/v2/company-lab/play/${encodeURIComponent(lab.labId)}`} className="text-teal-400 underline text-xs">
                        再開
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
