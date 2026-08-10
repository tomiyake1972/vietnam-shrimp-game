"use client";

// ShrimpX V2 — 32Q Management Console Phase 9: PLAYER Company Databook ボタン
//
// 【AI Analysis Packとは別物】AI Analysis Packは「このRun全体（5社ぶん）」の
// 研究用の出力である。こちらは「今操作しているこの1社だけ」の、通常プレイと
// 同じ意思決定用Databook（PL/BS/CF・契約・在庫・工場・借入等）であり、
// 他社の非公開情報は一切含まない（buildCompanyExportPayloadの既存フィルタリングに従う）。
//
// 【計算しない】このコンポーネントはDTO組み立て（buildCompanyDatabookQuarterEntry）と
// サーバーへのPOSTだけを行う。Excel生成本体はサーバー側route（node:child_process等
// Node専用APIに依存するためブラウザでは実行できない）が、通常プレイと同じ
// buildCompanyExportPayload / buildCompanyExportExcelWorkbook で行う。

import { useCallback, useState } from "react";
import { buildCompanyDatabookQuarterEntry, DatabookNotAvailableError } from "../lib/companyDatabookPayload";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";

interface Props {
  readonly session: SimulationSession;
  readonly companyId: string;
}

export function CompanyDatabookButton({ session, companyId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyFileName, setReadyFileName] = useState<string | null>(null);

  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReadyFileName(null);
    try {
      const entry = buildCompanyDatabookQuarterEntry(session, companyId);
      const response = await fetch("/api/v2/management/company-databook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulationRunId: session.run.simulationRunId,
          companyId,
          entry,
          fixtures: session.fixtures,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error((body as { error?: string } | null)?.error ?? `Databookの生成に失敗しました（HTTP ${response.status}）`);
      }
      const blob = await response.blob();
      const fileName = `ShrimpX_${companyId}_Turn${entry.turn}_Databook.xlsx`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setReadyFileName(fileName);
    } catch (e) {
      setError(e instanceof DatabookNotAvailableError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session, companyId]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={loading}
        data-testid="company-databook-download"
        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-40"
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
