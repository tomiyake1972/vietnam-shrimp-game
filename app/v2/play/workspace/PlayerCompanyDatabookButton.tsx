"use client";

// ShrimpX V2 — Independent Player Flow: 受講者自身の会社Databook ダウンロードボタン
//
// 【GM側（management/player/CompanyDatabookButton.tsx）との違い】
// GM画面はブラウザのメモリに SimulationSession を持っているため、
// entry をクライアントで組み立ててサーバーへ送る。受講者の画面は
// PlayerDecisionContext（絞り込み済みDTO）しか持たないため、組み立ても
// サーバー側（/api/v2/play/company-databook）で行う。対象会社は Cookie の
// Player session から決まるので、このボタンは companyId を送らない。
//
// 表示・文言・testid は GM側と揃える（同じものが同じ名前で見つかるようにする）。

import { useCallback, useState } from "react";

interface Props {
  readonly companyId: string;
}

export function PlayerCompanyDatabookButton({ companyId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyFileName, setReadyFileName] = useState<string | null>(null);

  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReadyFileName(null);
    try {
      const response = await fetch("/api/v2/play/company-databook", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Databookの生成に失敗しました（HTTP ${response.status}）`);
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const matched = /filename="([^"]+)"/.exec(disposition);
      const fileName = matched?.[1] ?? `ShrimpX_${companyId}_Databook.xlsx`;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setReadyFileName(fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={loading}
        data-testid="company-databook-download"
        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40 text-white"
      >
        {loading ? "生成中…" : `会社Databookをダウンロード（${companyId}）`}
      </button>
      <span className="text-[11px]" role="status" aria-live="polite" data-testid="company-databook-status">
        {error ? (
          <span className="text-rose-400" data-testid="company-databook-error">
            {error}
          </span>
        ) : readyFileName ? (
          <span className="text-emerald-400" data-testid="company-databook-ready">
            Ready — {readyFileName}
          </span>
        ) : null}
      </span>
    </div>
  );
}
