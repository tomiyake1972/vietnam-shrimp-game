"use client";

// ShrimpX V2 — Game End / Final Results（END-2）
//
// 【新しい計算をしない】ここでは一切の再計算を行わない。呼び出し側が渡した
// CompanyEvaluationSnapshot（既存evaluation service・保存済みFinal Snapshotの
// いずれか）をそのまま並べるだけ。順位付けも既存rankCompaniesByTotalShareholderValue
// をそのまま使う。
//
// 【公開範囲(指示§8/§17)】ownCompanyIdを渡した場合（PLAYER向け）でも、他社について
// 公開するのはRank・Company・TSV・Dividend Value・Current Company Valueまで。
// Cash・Debt・Normalized Cash Flow・CAPEX計画・詳細BS等は自社行にしか出さない
// （TsvLeaderboardPanelと同じ公開範囲を踏襲）。
//
// 【AIは中心に置かない(指示§19/§20)】解説文・AI総評・confetti等の演出は持たない。
// 数字と比較を中心にする。

import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { CompanyEvaluationSnapshot, rankCompaniesByTotalShareholderValue } from "../../../lib/v2/companyLab/evaluation/evaluationSemantics";

function formatUsd(value: number | null): string {
  if (value === null) return "－";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
}

function formatUsdLarge(value: number | null): string {
  if (value === null) return "－";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

export function FinalResultsSummary({
  snapshot,
  fixtures,
  ownCompanyId,
  gameEndTurn,
  finishedAt,
  testIdPrefix = "final-results",
}: {
  readonly snapshot: readonly CompanyEvaluationSnapshot[];
  readonly fixtures: readonly CompanyFixture[];
  /** PLAYER向けに開くときだけ渡す。自社の順位見出し・自社内訳カードが追加で出る。 */
  readonly ownCompanyId?: string;
  readonly gameEndTurn: number;
  readonly finishedAt: string;
  readonly testIdPrefix?: string;
}) {
  const nameById = new Map(fixtures.map((f) => [f.companyId, f.displayName]));
  const ranked = rankCompaniesByTotalShareholderValue(snapshot);
  const ownIndex = ownCompanyId ? ranked.findIndex((s) => s.companyId === ownCompanyId) : -1;
  const ownSnapshot = ownIndex >= 0 ? ranked[ownIndex] : null;

  return (
    <section className="space-y-3" data-testid={testIdPrefix}>
      {ownSnapshot ? (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">最終順位</p>
          <p className="mt-1 text-3xl font-bold tabular-nums" data-testid={`${testIdPrefix}-own-rank`}>
            第{ownIndex + 1}位 <span className="text-base font-normal text-slate-400">/ {ranked.length}社</span>
          </p>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-emerald-300">Total Shareholder Value</p>
          <p className="mt-1 text-3xl font-bold tabular-nums" data-testid={`${testIdPrefix}-own-tsv`}>
            {formatUsdLarge(ownSnapshot.totalShareholderValueUsd)}
          </p>
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid={`${testIdPrefix}-ranking`}>
        <h2 className="mb-2 text-sm font-semibold">最終順位 — 5社比較（Total Shareholder Value）</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="py-1 pr-2 text-left">順位</th>
                <th className="py-1 pr-2 text-left">会社</th>
                <th className="py-1 pr-2 text-right">Total Shareholder Value</th>
                <th className="py-1 pr-2 text-right">Dividend Value</th>
                <th className="py-1 pr-2 text-right">Current Company Value</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((s, i) => (
                <tr
                  key={s.companyId}
                  className={`border-b border-slate-800/60 ${s.companyId === ownCompanyId ? "bg-emerald-900/30" : ""}`}
                  data-testid={`${testIdPrefix}-ranking-row-${s.companyId}`}
                >
                  <td className="py-1 pr-2 tabular-nums">{i + 1}</td>
                  <td className="py-1 pr-2">
                    {nameById.get(s.companyId) ?? s.companyId}
                    {s.companyId === ownCompanyId ? <span className="ml-1.5 text-[10px] text-emerald-300">（自社）</span> : null}
                  </td>
                  <td className="py-1 pr-2 text-right font-semibold tabular-nums">{formatUsd(s.totalShareholderValueUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(s.currentDividendValueUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(s.currentCompanyValue.currentCompanyValueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {ownSnapshot ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid={`${testIdPrefix}-own-detail`}>
          <h2 className="mb-2 text-sm font-semibold">自社の最終KPI（{nameById.get(ownSnapshot.companyId) ?? ownSnapshot.companyId}）</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
            <dt className="text-[11px] text-slate-400">Total Shareholder Value</dt>
            <dd className="text-right font-semibold tabular-nums">{formatUsd(ownSnapshot.totalShareholderValueUsd)}</dd>
            <dt className="text-[11px] text-slate-400">Dividend Value</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentDividendValueUsd)}</dd>
            <dt className="text-[11px] text-slate-400">Current Company Value</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.currentCompanyValueUsd)}</dd>
            <dt className="text-[11px] text-slate-400">Enterprise Value</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.enterpriseValueUsd)}</dd>
            <dt className="text-[11px] text-slate-400">Cash</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.cashUsd)}</dd>
            <dt className="text-[11px] text-slate-400">Debt</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.debtUsd)}</dd>
            <dt className="text-[11px] text-slate-400">累積配当（Cumulative Dividend）</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.kpis.cumulativeDividendUsd)}</dd>
            <dt className="text-[11px] text-slate-400">累積営業利益（Cumulative Operating Profit）</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.kpis.cumulativeOperatingProfitUsd)}</dd>
          </dl>
        </div>
      ) : null}

      <p className="text-[11px] text-slate-500" data-testid={`${testIdPrefix}-meta`}>
        Game End Turn {gameEndTurn} ／ Finished At {finishedAt}
      </p>
    </section>
  );
}
