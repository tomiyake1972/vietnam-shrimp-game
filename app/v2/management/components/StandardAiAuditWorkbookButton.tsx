"use client";

// ShrimpX V2 — Standard AI 32Q Audit Workbook の出力ボタン（実装指示§32）
//
// 【既存のexport導線と別物（実装指示§31）】
//   - Company Databook          … PLAYER 1社の運転資料
//   - AI Analysis Pack (ZIP)    … Run全体の分析パック（既存・無変更）
//   - Standard AI Audit Workbook … 本ボタン。5社×32TurnのStandard AI判断ログと
//                                  業績推移だけを1冊のExcelにしたAI分析用の監査資料
// この3つは画面上でも別のボタン・別のファイル名として区別する。
//
// 【Management/Admin専用（実装指示§36）】5社横断の監査資料であるため、
// Player Workspace からは import しない（Management Console と GM Final Results のみ）。
//
// 【どこで生成するか】ExportPackButton と同じくブラウザで生成する。対象Runは既に
// この画面（localStorage / server store）にあり、サーバー経由にすると資格情報が
// 混ざる経路が生まれるため。exceljs は既存の依存関係でブラウザでも動く。
//
// 【live history を渡す理由】保存済みRunの resumePayload.state.history は容量のため
// 直近数ターンへ間引かれている（persistence/resume.ts）。Console は live session を
// 持っているため、その確定履歴をそのまま渡すことで全Turnの詳細シートと
// Turn別の株主価値（TSV）が埋まる。渡せない場合も export は失敗せず、
// 欠損理由が 00_README へ記録される。

import { useCallback, useState } from "react";
import { buildStandardAiAuditExport } from "../../../lib/v2/companyLab/simulation/auditWorkbook";
import { CompanyQuarterRecord } from "../../../lib/v2/companyLab/types";
import { loadSimulationRun } from "../lib/simulationRunStore";

interface Props {
  readonly simulationRunId: string | null;
  readonly completedTurns: number | null;
  /** 【任意】live session の確定履歴。渡せる画面では必ず渡す（全Turn詳細が埋まる）。 */
  readonly liveHistory?: readonly CompanyQuarterRecord[];
  readonly compact?: boolean;
}

interface DownloadTarget {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
}

export function StandardAiAuditWorkbookButton({ simulationRunId, completedTurns, liveHistory, compact = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadTarget | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const exportWorkbook = useCallback(async () => {
    if (!simulationRunId || busy) return;
    setError(null);
    setDownload(null);
    setNote(null);
    setBusy(true);
    try {
      // 【run の取り違え防止】表示中の ID で読み直し、その1本だけを出力する
      // （ExportPackButton と同じ方針。stale な props を無条件で信頼しない）。
      const stored = await loadSimulationRun(simulationRunId);
      if (!stored) throw new Error(`Simulation Run「${simulationRunId}」を読み込めませんでした。`);
      if (stored.run.simulationRunId !== simulationRunId) {
        throw new Error("読み込んだ Simulation Run の ID が一致しません（出力を中止しました）。");
      }

      const built = await buildStandardAiAuditExport({
        stored,
        generatedAt: new Date().toISOString(),
        liveHistory,
      });
      const blob = new Blob([new Uint8Array(built.workbook)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const target: DownloadTarget = { name: built.fileName, url: URL.createObjectURL(blob), bytes: blob.size };
      setDownload(target);
      setNote(
        built.data.meta.missingDataNotes.length > 0
          ? `一部データが未取得です（${built.data.meta.missingDataNotes.length}件）。理由は 00_README に記録しています。`
          : null
      );

      const anchor = document.createElement("a");
      anchor.href = target.url;
      anchor.download = target.name;
      anchor.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [simulationRunId, busy, liveHistory]);

  const turns = completedTurns ?? 0;
  const disabled = !simulationRunId || busy || turns === 0;
  const label = turns > 0 && turns < 32 ? "Standard AI分析Excel（途中経過）をダウンロード" : "Standard AI分析Excelをダウンロード";

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "rounded-lg border border-slate-700 bg-slate-900/60 p-3"}>
      {!compact ? <h2 className="mb-1.5 text-sm font-semibold">Standard AI Audit Workbook</h2> : null}
      {!compact ? (
        <p className="mb-2 text-[11px] text-slate-400" data-testid="standard-ai-audit-description">
          5社×32TurnのStandard AI判断ログと業績推移をAI分析向け形式で出力します。
        </p>
      ) : null}

      <button
        type="button"
        onClick={exportWorkbook}
        disabled={disabled}
        data-testid="export-standard-ai-audit"
        className="rounded bg-teal-700 px-3 py-1.5 text-sm font-semibold hover:bg-teal-600 disabled:opacity-40"
      >
        {label}
      </button>

      <span className="ml-2 text-[11px]" role="status" aria-live="polite" data-testid="standard-ai-audit-status">
        {busy ? (
          <span className="text-sky-300">Excel を生成しています…</span>
        ) : error !== null ? (
          <span className="text-rose-400" data-testid="standard-ai-audit-error">
            {error}
          </span>
        ) : download !== null ? (
          <span className="text-emerald-400" data-testid="standard-ai-audit-ready">
            Ready — {download.name}（{(download.bytes / 1024).toFixed(0)} KB）
          </span>
        ) : turns === 0 ? (
          <span className="text-slate-500">ターンを実行すると出力できます</span>
        ) : null}
      </span>

      {note !== null ? (
        <p className="mt-1 text-[11px] text-amber-300" data-testid="standard-ai-audit-note">
          {note}
        </p>
      ) : null}

      {download !== null ? (
        <p className="mt-1 text-[11px]">
          <a href={download.url} download={download.name} className="text-sky-300 underline-offset-2 hover:underline">
            {download.name}
          </a>
        </p>
      ) : null}
    </div>
  );
}
