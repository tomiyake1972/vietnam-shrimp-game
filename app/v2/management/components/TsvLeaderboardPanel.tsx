"use client";

// ShrimpX V2 — Total Shareholder Value 公式Leaderboard（TSV正式化指示§10-§12・§20）
//
// 【第一目標】ShrimpXの第一目標はTotal Shareholder Value（総株主価値）の最大化。
// TSVは最終Turnでのみ計算するスコアではなく、各Turn終了時点の現在価値として
// 毎Turn再計算・公開する（指示§10/§12/§13）。
//
// 【公開範囲(§11)】全社に公開するのはRank・Company・TSV・Dividend Value・
// Current Company Valueの3指標まで。Cash・Debt・Normalized Cash Flowは
// 自社のみの詳細内訳（ownCompanyId）としてのみ表示し、他社ぶんはこの
// コンポーネントのどこからも取得できない（computeAllCompaniesEvaluationSnapshot
// はCurrentCompanyValueBreakdown全体を返すが、他社行のレンダリングでは
// currentCompanyValueUsdだけを読み、breakdown内部のcash/debt/normalizedCFは
// 自社行にしか使わない設計にする）。
//
// 【新しい計算をしない】ここでは一切の再計算を行わない。
// evaluation/evaluationSemantics.ts（純粋関数）の結果をそのまま並べるだけ。

import { CompanyFixture } from "../../../lib/v2/companyLab/types";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { computeAllCompaniesEvaluationSnapshot, rankCompaniesByTotalShareholderValue } from "../../../lib/v2/companyLab/evaluation/evaluationSemantics";

function formatUsd(value: number | null): string {
  if (value === null) return "－";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
}

export function TsvLeaderboardPanel({
  session,
  fixtures,
  ownCompanyId,
}: {
  readonly session: SimulationSession;
  readonly fixtures: readonly CompanyFixture[];
  /** 指定した会社だけ、Current Company Valueの詳細内訳（EV/正常化CF/Cash/Debt）を追加表示する。 */
  readonly ownCompanyId?: string;
}) {
  const turn = session.state.scenarioState.currentTurn;
  const companyIds = fixtures.map((f) => f.companyId);
  const nameById = new Map(fixtures.map((f) => [f.companyId, f.displayName]));
  const snapshots = computeAllCompaniesEvaluationSnapshot(session.state.history, companyIds, turn);
  const ranked = rankCompaniesByTotalShareholderValue(snapshots);
  const ownSnapshot = ownCompanyId ? snapshots.find((s) => s.companyId === ownCompanyId) ?? null : null;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="tsv-leaderboard">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">総株主価値（Total Shareholder Value）ランキング — Turn {turn}時点</h2>
        <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200">全社公開</span>
      </div>
      <p className="mb-1 text-[11px] font-semibold text-emerald-300">ゲームの第一目標：総株主価値（TSV）を最大化すること</p>
      <p className="mb-2 text-[11px] text-slate-400">
        総株主価値は、これまでの配当の現在価値と、現在の会社価値の合計です。配当は支払時点から現在Turnまで年率15%で評価し、
        会社の事業価値は直近3四半期平均のCash創出力を年換算し、10年間・年率10%でDCFして算出（Terminal Valueなし）。そこへ現金を加算し、借入金を控除します。
        「今この瞬間にゲームが終了した場合」の値であり、Turn32まで到達した場合の想定値ではありません。
      </p>
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
                className={`border-b border-slate-800/60 ${s.companyId === ownCompanyId ? "bg-slate-800/50" : ""}`}
                data-testid={`tsv-leaderboard-row-${s.companyId}`}
              >
                <td className="py-1 pr-2 tabular-nums">{i + 1}</td>
                <td className="py-1 pr-2">{nameById.get(s.companyId) ?? s.companyId}</td>
                <td className="py-1 pr-2 text-right font-semibold tabular-nums">{formatUsd(s.totalShareholderValueUsd)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(s.currentDividendValueUsd)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatUsd(s.currentCompanyValue.currentCompanyValueUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ownSnapshot ? (
        <div className="mt-3 rounded border border-slate-700 bg-slate-900/40 p-2.5" data-testid="tsv-own-company-breakdown">
          <h3 className="mb-1.5 text-xs font-semibold">
            自社内訳（{nameById.get(ownSnapshot.companyId) ?? ownSnapshot.companyId}）— 他社には公開されません
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <dt className="text-slate-400">直近3Turn平均CF（四半期）</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.normalizedQuarterlyCashFlowUsd)}</dd>
            <dt className="text-slate-400">年換算Cash Flow</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.annualizedCashFlowUsd)}</dd>
            <dt className="text-slate-400">Enterprise Value（10年・10%DCF）</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.enterpriseValueUsd)}</dd>
            <dt className="text-slate-400">Cash</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.cashUsd)}</dd>
            <dt className="text-slate-400">Debt</dt>
            <dd className="text-right tabular-nums">{formatUsd(ownSnapshot.currentCompanyValue.debtUsd)}</dd>
            <dt className="text-slate-400">Current Company Value</dt>
            <dd className="text-right tabular-nums font-semibold">{formatUsd(ownSnapshot.currentCompanyValue.currentCompanyValueUsd)}</dd>
          </dl>
        </div>
      ) : null}
    </section>
  );
}
