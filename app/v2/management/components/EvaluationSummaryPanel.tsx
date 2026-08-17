"use client";

// ShrimpX V2 — EVAL-1: 任意Turn評価サマリー（Game Master向け・読み取り専用）
//
// 【実装指示§14/§32】End Gameの正式なUI（「今のTurnで終了する」ボタン・確認
// ダイアログ・状態遷移）は、既存Run/Labライフサイクル（SimulationRun.stopReason・
// resumePayload等の版管理されたスキーマ）へ手を入れる必要があり、リスクが
// 大きいためこのPhaseでは実装しない（サービス層＝evaluationSemantics.tsの
// 基盤のみ用意し、UIは読み取り専用の「今この時点で終了したら、この評価に
// なる」プレビュー表示に留める）。
//
// 【新しい計算をしない】ここでは一切の再計算を行わない。既に確定・永続化された
// CompanyQuarterRecord履歴を computeCompanyEvaluationSnapshot（純粋関数）へ
// 渡して読むだけ。Current/Total Shareholder Valueは常に暫定プレースホルダー
// （実装指示§15/§16/§17）であり、この画面でもランキングとしては一切扱わない。

import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { computeCompanyEvaluationSnapshot } from "../../../lib/v2/companyLab/evaluation/evaluationSemantics";

function formatUsd(value: number | null): string {
  if (value === null) return "－";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "－";
  return `${(value * 100).toFixed(1)}%`;
}

export function EvaluationSummaryPanel({
  session,
  fixture,
}: {
  readonly session: SimulationSession;
  readonly fixture: CompanyFixture;
}) {
  const turn = session.state.scenarioState.currentTurn;
  const snapshot = computeCompanyEvaluationSnapshot(session.state.history, fixture.companyId, turn);

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="evaluation-summary-panel">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">評価サマリー（{fixture.displayName} — Turn {turn}時点）</h2>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">現Turnで終了した場合のプレビュー</span>
      </div>
      <p className="mb-2 text-[11px] text-slate-400">
        「今このTurnでRunを終了した場合」の評価スナップショット（読み取り専用プレビュー）。実際にRunを終了する機能はまだありません。
        Turn16で終了しても・最後まで走らせても、同じ計算方法で評価します。
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <dt className="text-slate-400">累積営業利益</dt>
        <dd className="text-right tabular-nums" data-testid="eval-cumulative-operating-profit">{formatUsd(snapshot.kpis.cumulativeOperatingProfitUsd)}</dd>
        <dt className="text-slate-400">累積売上高</dt>
        <dd className="text-right tabular-nums" data-testid="eval-cumulative-revenue">{formatUsd(snapshot.kpis.cumulativeRevenueUsd)}</dd>
        <dt className="text-slate-400">平均営業利益率</dt>
        <dd className="text-right tabular-nums">{formatPercent(snapshot.kpis.averageOperatingMarginRatio)}</dd>
        <dt className="text-slate-400">現金（直近確定）</dt>
        <dd className="text-right tabular-nums">{formatUsd(snapshot.kpis.endingCashUsd)}</dd>
        <dt className="text-slate-400">借入残高（直近確定）</dt>
        <dd className="text-right tabular-nums">{formatUsd(snapshot.kpis.endingDebtUsd)}</dd>
        <dt className="text-slate-400">財務不健全Turn数</dt>
        <dd className="text-right tabular-nums">{snapshot.kpis.distressTurnCount}</dd>
        <dt className="text-slate-400">累積配当</dt>
        <dd className="text-right tabular-nums" data-testid="eval-cumulative-dividend">{formatUsd(snapshot.kpis.cumulativeDividendUsd)}</dd>
        <dt className="text-slate-400">累積加重配当価値</dt>
        <dd className="text-right tabular-nums">{formatUsd(snapshot.weightedCumulativeDividendValueUsd)}</dd>
      </dl>
      <div className="mt-2 rounded border border-slate-700 bg-slate-900/40 p-2 text-[11px] text-slate-400">
        <p>Current Shareholder Value: TBD / Experimental（正式な算定式は未確定。バージョン: {snapshot.shareholderValueModelVersion}）</p>
        <p>Total Shareholder Value: not finalized（加重配当価値 + Current Shareholder Valueの正式合算は未実装）</p>
      </div>
    </section>
  );
}
