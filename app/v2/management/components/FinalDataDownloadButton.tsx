"use client";

// ShrimpX V2 — Game End / Final Results（END-4）
//
// 【新しいexport frameworkを作らない(指示§15)】既存のAI Analysis Pack
// （ExportPackButton・Turn1〜End Turnの主要KPI履歴を5社ぶんカバー済み）・
// 会社Databook（CompanyDatabookButton）はそのまま維持し、そちらへ丸ごと委ねる。
// ここで新しく作るのは、それらではまだカバーされていない
// 「Final Evaluation Snapshot・TSV推移・配当推移」だけをまとめた、
// 1個の軽量JSON blob download（ExportPackButtonと同じtoDownload()パターン）。
//
// 【保存済みFinal Snapshotを優先する(指示§4)】ここではFinal Evaluation
// Snapshotを再計算しない。run.finalEvaluationSnapshot（Game End時に保存された
// 公式値）をそのまま出力する。

import { useCallback, useState } from "react";
import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { SimulationRun, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { buildDividendSeries, buildTsvSeries } from "../../../lib/v2/companyLab/simulation/analytics/finalResultsSeries";

interface Props {
  readonly run: SimulationRun;
  readonly fixtures: readonly CompanyFixture[];
  /** Turn別のTSV・配当推移を出すには確定history（session.state.history）が要る。無ければSnapshotのみ出力する。 */
  readonly session: SimulationSession | null;
}

function toDownload(name: string, data: BlobPart, type: string): { readonly name: string; readonly url: string; readonly bytes: number } {
  const blob = new Blob([data], { type });
  return { name, url: URL.createObjectURL(blob), bytes: blob.size };
}

export function FinalDataDownloadButton({ run, fixtures, session }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);

  const download = useCallback(() => {
    setError(null);
    setReady(null);
    if (!run.gameEndedAt || !run.gameEndTurn) {
      setError("このRunはまだゲーム終了していません。");
      return;
    }
    if (!run.finalEvaluationSnapshot) {
      setError("このRunには保存済みFinal Evaluation Snapshotがありません（Game End機能導入以前の旧形式Runの可能性があります）。");
      return;
    }
    const payload = {
      simulationRunId: run.simulationRunId,
      scenarioId: run.scenarioId,
      gameEndTurn: run.gameEndTurn,
      finishedAt: run.gameEndedAt,
      finalEvaluationSnapshot: run.finalEvaluationSnapshot,
      totalShareholderValueHistory: session ? buildTsvSeries(session.state.history, fixtures, run.gameEndTurn) : null,
      dividendHistory: session ? buildDividendSeries(session.state.history, fixtures, run.gameEndTurn) : null,
      note: session
        ? null
        : "このタブはこのRunの確定履歴（history）を保持していないため、Turn別のTSV・配当推移は含めていません（Final Evaluation Snapshotのみ）。",
    };
    const dl = toDownload(`ShrimpX_Final_Results_${run.simulationRunId}.json`, JSON.stringify(payload, null, 2), "application/json");
    const anchor = document.createElement("a");
    anchor.href = dl.url;
    anchor.download = dl.name;
    anchor.click();
    setReady(dl.name);
  }, [run, fixtures, session]);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="final-data-download-panel">
      <h2 className="mb-1.5 text-sm font-semibold">Final Data Download</h2>
      <p className="mb-2 text-[11px] text-slate-400">
        Final Evaluation Snapshot・TSV推移・配当推移をJSONで出力します。Turn1〜Game End Turnの主要KPI履歴（5社ぶん）は下のAI Analysis
        Pack、自社ぶんの詳細Databookは会社Databookをご利用ください。
      </p>
      <button
        type="button"
        onClick={download}
        disabled={!run.gameEndedAt}
        data-testid="final-data-download"
        className="rounded bg-indigo-700 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-600 disabled:opacity-40"
      >
        Final Snapshot / TSV・配当推移 を出力（JSON）
      </button>
      {error ? (
        <p className="mt-2 text-[11px] text-rose-400" data-testid="final-data-download-error">
          {error}
        </p>
      ) : ready ? (
        <p className="mt-2 text-[11px] text-emerald-400" data-testid="final-data-download-ready">
          Ready — {ready} を出力しました
        </p>
      ) : null}
    </div>
  );
}
