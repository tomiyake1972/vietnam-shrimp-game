"use client";

// ShrimpX V2 — AI Analysis Pack の出力ボタン
//
// 【どこで生成するか】ブラウザで生成する。理由：
//   1. 出力対象の Simulation Run は既にこのブラウザ（localStorage）にある
//   2. サーバーを経由しないため、トークン・接続情報の類が Pack へ混ざる経路が構造的に無い
//   3. 32Q ぶんの ZIP（実測 約1.2MB）を Vercel function の応答へ載せずに済む
//   4. exceljs / jszip は既にこのプロジェクトの依存関係にあり、どちらもブラウザで動く
//
// 【fake progress を出さない】進捗表示は実際の処理段階に対応させる。
//
// 【別の run を誤って出力しない】表示中の Simulation Run の ID・シナリオ・seed・
// 完了ターン数を必ず画面に出してから出力する。

import { useCallback, useState } from "react";
import { buildAiAnalysisPack, PackBuildStage } from "../../../lib/v2/companyLab/simulation/aiPack/pack";
import { StoredSimulationRun } from "../../../lib/v2/companyLab/simulation/persistence/types";
import { loadSimulationRun } from "../lib/simulationRunStore";

const STAGE_LABELS: Readonly<Record<PackBuildStage, string>> = {
  preparing: "Preparing data…",
  buildingJson: "Building JSON…",
  buildingExcel: "Building Excel…",
  creatingZip: "Creating ZIP…",
  ready: "Ready",
};

interface Props {
  /** 出力対象。null なら出力できない。 */
  readonly simulationRunId: string | null;
  readonly scenarioId: string | null;
  readonly seed: string | null;
  readonly completedTurns: number | null;
  /** 既に読み込み済みの run があれば渡す（無ければ ID から読み直す）。 */
  readonly stored?: StoredSimulationRun | null;
  readonly compact?: boolean;
}

interface DownloadTarget {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
}

function toDownload(name: string, data: BlobPart, type: string): DownloadTarget {
  const blob = new Blob([data], { type });
  return { name, url: URL.createObjectURL(blob), bytes: blob.size };
}

export function ExportPackButton({ simulationRunId, scenarioId, seed, completedTurns, stored, compact = false }: Props) {
  const [stage, setStage] = useState<PackBuildStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<readonly DownloadTarget[]>([]);

  const exportPack = useCallback(async () => {
    if (!simulationRunId || stage !== null) return;
    setError(null);
    setDownloads([]);
    setStage("preparing");
    try {
      // 【run の取り違え防止】表示中の ID で読み直し、その1本だけを出力する。
      const target = stored && stored.run.simulationRunId === simulationRunId ? stored : await loadSimulationRun(simulationRunId);
      if (!target) throw new Error(`Simulation Run「${simulationRunId}」を読み込めませんでした。`);
      if (target.run.simulationRunId !== simulationRunId) {
        throw new Error("読み込んだ Simulation Run の ID が一致しません（出力を中止しました）。");
      }

      const pack = await buildAiAnalysisPack({
        stored: target,
        exportedAt: new Date().toISOString(),
        sourceBranch: process.env.NEXT_PUBLIC_SOURCE_BRANCH || "UNKNOWN",
        sourceCommit: process.env.NEXT_PUBLIC_SOURCE_COMMIT || "UNKNOWN",
        onStage: setStage,
      });

      const zipDownload = toDownload(pack.fileName, new Uint8Array(pack.zip), "application/zip");
      setDownloads([
        zipDownload,
        toDownload("01_Run_Summary.md", pack.blobParts.runSummaryMarkdown, "text/markdown"),
        toDownload("02_AI_Context.json", pack.blobParts.aiContextJson, "application/json"),
        toDownload("03_Analysis.xlsx", pack.blobParts.analysisWorkbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        toDownload("04_Event_Change_Log.csv", pack.blobParts.changeLogCsv, "text/csv"),
        toDownload("05_Data_Dictionary.md", pack.blobParts.dataDictionaryMarkdown, "text/markdown"),
      ]);

      // 主導線は ZIP 1個。押した流れで自動的に落とす。
      const anchor = document.createElement("a");
      anchor.href = zipDownload.url;
      anchor.download = zipDownload.name;
      anchor.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStage(null);
    }
  }, [simulationRunId, stage, stored]);

  const disabled = !simulationRunId || stage !== null || (completedTurns ?? 0) === 0;

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "rounded-lg border border-slate-700 bg-slate-900/60 p-3"}>
      {!compact ? <h2 className="mb-1.5 text-sm font-semibold">AI Analysis Pack</h2> : null}

      {!compact ? (
        <dl className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" data-testid="export-target">
          <div>
            <dt className="text-slate-400">Simulation Run ID</dt>
            <dd className="font-mono">{simulationRunId ?? "－"}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Scenario</dt>
            <dd className="font-mono">{scenarioId ?? "－"}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Seed</dt>
            <dd className="font-mono">{seed ?? "－"}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Completed Turns</dt>
            <dd className="font-mono">{completedTurns ?? "－"}</dd>
          </div>
        </dl>
      ) : null}

      <button
        type="button"
        onClick={exportPack}
        disabled={disabled}
        data-testid="export-pack"
        className="rounded bg-indigo-700 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-600 disabled:opacity-40"
      >
        AI Analysis Pack を出力
      </button>

      <span className="ml-2 text-[11px]" role="status" aria-live="polite" data-testid="export-status">
        {stage !== null ? (
          <span className="text-sky-300">{STAGE_LABELS[stage]}</span>
        ) : error !== null ? (
          <span className="text-rose-400" data-testid="export-error">
            {error}
          </span>
        ) : downloads.length > 0 ? (
          <span className="text-emerald-400" data-testid="export-ready">
            Ready — ZIP を出力しました（{(downloads[0].bytes / 1024).toFixed(0)} KB）
          </span>
        ) : (completedTurns ?? 0) === 0 ? (
          <span className="text-slate-500">32Q を実行すると出力できます</span>
        ) : null}
      </span>

      {downloads.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" data-testid="export-downloads">
          {downloads.map((d) => (
            <li key={d.name}>
              <a href={d.url} download={d.name} className="text-sky-300 underline-offset-2 hover:underline">
                {d.name}
              </a>
              <span className="ml-1 text-slate-500">({(d.bytes / 1024).toFixed(0)} KB)</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
