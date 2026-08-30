// ShrimpX V2 — Company Lab 管理者画面「分析データをエクスポート」機能 Turn/会社選択・ダウンロード画面
//
// 【設計方針】このページ自体が表示する「確定済みTurn一覧」は、既存の読み取り専用
// Export API（/api/v2/exports/company-labs/{labId}）を自己fetchして取得する
// （companyLabAdminExportSource.ts経由。Redis・Repositoryへは一切アクセスしない）。
// STAGING_EXPORT_TOKENの読み取り・Authorizationヘッダーの組み立ては
// companyLabAdminExportSource.ts内でのみ行われ、このページ（ブラウザへ送られる
// HTML）には一切含まれない。
//
// 【操作性】iPadのSafariでもタップだけで完結するよう、Turn/会社選択はJS不要の
// 素のHTML <form method="get"> とし、ダウンロードは素の <a href> リンク
// （ブラウザ標準のファイル保存動作に任せる）にしている。

import Link from "next/link";
import { isProduction } from "../../../../../lib/env";
import { requireStagingSession } from "../../../../../lib/companyLabUiSession";
import { fetchLabIndex } from "../../../../../lib/v2/companyLab/adminExport/companyLabAdminExportSource";
import { resolveRequestOriginFromHeaders } from "../../../../../lib/v2/companyLab/adminExport/requestOrigin";
import { listCompanyOptionsForUi } from "../../_lib/companyOptions";
import PlayLabBanner from "../../components/PlayLabBanner";
import { decodeLabIdRouteParam } from "../../_lib/labIdRouteParam";

interface ExportLabPageProps {
  readonly params: Promise<{ readonly labId: string }>;
  readonly searchParams: Promise<{ readonly turn?: string; readonly companyId?: string }>;
}

export default async function CompanyLabExportLabPage({ params, searchParams }: ExportLabPageProps) {
  await requireStagingSession();

  if (isProduction) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center px-4">
        <div className="bg-gray-800 rounded-2xl p-6 text-sm text-gray-300">この機能は本番環境では利用できません。</div>
      </div>
    );
  }

  // 【COMPANYLAB-DETAIL-LOAD-404-1】詳細画面と同じく、動的セグメントは
  // percent-encoded のまま渡るため保存済み labId へ復元する。
  const { labId: rawLabId } = await params;
  const labId = decodeLabIdRouteParam(rawLabId);
  const { turn: turnQuery, companyId: companyIdQuery } = await searchParams;
  const origin = await resolveRequestOriginFromHeaders();
  const indexResult = await fetchLabIndex(origin, labId);
  const companyOptions = listCompanyOptionsForUi();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 pb-16">
      <PlayLabBanner />
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">分析データをエクスポート — {labId}</h1>
          <Link href="/v2/company-lab/play/export" className="text-xs text-teal-400 underline">
            ラボ選択へ戻る
          </Link>
        </div>

        {!indexResult.ok ? (
          <div className="bg-red-950/50 border border-red-700/60 rounded-lg px-4 py-3 text-sm text-red-200">{indexResult.userMessage}</div>
        ) : (
          <>
            <div className="bg-gray-800 rounded-2xl p-4 text-xs text-gray-400 space-y-1">
              <p>engineVersion: {indexResult.data.engineVersion}</p>
              <p>プレイヤー会社: {indexResult.data.playerCompanyId}</p>
              <p>確定済みTurn: {indexResult.data.availableTurns.length > 0 ? indexResult.data.availableTurns.join(", ") : "(まだありません)"}</p>
            </div>

            {indexResult.data.availableTurns.length === 0 ? (
              <div className="bg-gray-800 rounded-2xl p-6 text-center text-gray-400 text-sm">まだ確定済みのTurnがありません。</div>
            ) : (
              <>
                <form method="get" className="bg-gray-800 rounded-2xl p-4 space-y-4">
                  <div>
                    <label htmlFor="turn" className="block text-xs text-gray-400 mb-1">
                      Turn
                    </label>
                    <select
                      id="turn"
                      name="turn"
                      defaultValue={turnQuery ?? String(indexResult.data.latestProcessedTurn ?? indexResult.data.availableTurns[indexResult.data.availableTurns.length - 1])}
                      className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
                    >
                      {indexResult.data.availableTurns.map((t) => (
                        <option key={t} value={t}>
                          Turn {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="companyId" className="block text-xs text-gray-400 mb-1">
                      会社
                    </label>
                    <select
                      id="companyId"
                      name="companyId"
                      defaultValue={companyIdQuery ?? indexResult.data.playerCompanyId}
                      className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
                    >
                      {companyOptions.map((c) => (
                        <option key={c.companyId} value={c.companyId}>
                          {c.companyId}（{c.displayName}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className="w-full bg-teal-600 hover:bg-teal-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
                    選択
                  </button>
                </form>

                {turnQuery && companyIdQuery && (
                  <DownloadLinksCard labId={labId} turn={turnQuery} companyId={companyIdQuery} />
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DownloadLinksCard({ labId, turn, companyId }: { readonly labId: string; readonly turn: string; readonly companyId: string }) {
  const base = `/api/v2/admin/export-download/${encodeURIComponent(labId)}/${encodeURIComponent(turn)}?companyId=${encodeURIComponent(companyId)}`;
  const links: readonly { readonly mode: string; readonly label: string; readonly description: string }[] = [
    { mode: "bundle", label: "一括ダウンロード（ZIP）", description: "index・会社別・全社・市場の全JSON＋Excel経営データブックをまとめて取得" },
    { mode: "company", label: "会社別データ（JSON）", description: `${companyId}社のTurn${turn}確定データのみ` },
    { mode: "all", label: "全社データ（JSON）", description: `Turn${turn}の全社確定データ` },
    { mode: "market", label: "市場データ（JSON）", description: `Turn${turn}の市場結果（公開情報）` },
  ];
  return (
    <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
      <p className="text-xs text-gray-400">
        Turn {turn}・{companyId}社のダウンロード:
      </p>
      <div className="grid grid-cols-1 gap-2">
        {links.map((l) => (
          <a
            key={l.mode}
            href={`${base}&mode=${l.mode}`}
            className="bg-teal-700/80 hover:bg-teal-600 rounded-lg px-4 py-3 text-sm font-semibold text-white flex flex-col"
          >
            {l.label}
            <span className="text-xs font-normal text-teal-100/80">{l.description}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
