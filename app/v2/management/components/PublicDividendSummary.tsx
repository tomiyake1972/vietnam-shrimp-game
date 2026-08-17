"use client";

// ShrimpX V2 — DIV-2: 配当（株主還元）の他社公開表示
//
// 【実装指示§18】配当は他社にも公開される情報（Current Turn Dividend・
// Cumulative Dividend・Weighted Dividend Value）。ただし同じ画面から
// Cash・借入枠・CAPEX計画等の非公開情報を一切追加開示してはならない
// （それらは自社のFinance/Decisionタブ・CompanyInspector等、既存の
// 「自社のみ」導線だけに留める）。
//
// 【新しい計算をしない】ここでは一切の再計算を行わない。既に
// companyLab/runner.tsが確定・永続化したCompanyQuarterRecord.dividendResults
// （finance/dividend.ts）から、companyId別に配当関連フィールドだけを
// 読み出して並べるだけである。

import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { extractCompanyDividendResult } from "../../company-lab/play/_lib/financialViewSelectors";

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function PublicDividendSummary({ session, fixtures }: { readonly session: SimulationSession; readonly fixtures: readonly CompanyFixture[] }) {
  const turn = session.state.scenarioState.currentTurn;
  const lastRecord = session.state.history[session.state.history.length - 1] ?? null;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="public-dividend-summary">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">株主還元（配当）— 他社公開情報</h2>
        <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200">全社公開</span>
      </div>
      <p className="mb-2 text-[11px] text-slate-400">
        各社の配当実績は他社にも公開されます。Cash・借入枠・設備投資計画などはこの画面には含まれません（自社のみ閲覧可能）。
      </p>
      {lastRecord === null ? (
        <p className="text-xs text-slate-400">まだ確定した実績がありません。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="py-1 pr-2 text-left">会社</th>
                <th className="py-1 pr-2 text-right">当期配当（Turn {turn}）</th>
                <th className="py-1 pr-2 text-right">累積配当</th>
                <th className="py-1 pr-2 text-right">累積加重配当価値</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map((f) => {
                const dividend = extractCompanyDividendResult(lastRecord, f.companyId);
                return (
                  <tr key={f.companyId} className="border-b border-slate-800/60" data-testid={`public-dividend-row-${f.companyId}`}>
                    <td className="py-1 pr-2">{f.displayName}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(dividend?.appliedDividendUsd ?? 0)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(dividend?.cumulativeDividendUsd ?? 0)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(dividend?.cumulativeWeightedDividendValueUsd ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
