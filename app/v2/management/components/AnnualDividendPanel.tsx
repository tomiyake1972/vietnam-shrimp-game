"use client";

// ShrimpX V2 — 年間純利益ベース配当の実績パネル（Management Console）
//
// 【表示するのは実績だけ】Engineが年度末（Q4）の決算後に確定させた
// CompanyDividendQuarterResult.annualSettlement をそのまま転記する。
// ここで配当額・配当性向を再計算しない（現在のStandard AI parameterから
// 「当時の率」を逆算して表示する構造をやめる、が今回の方針）。
//
// 【Q4事前判断と実支払を混同しない】Standard AIがQ4の意思決定時点で決めるのは
// 「配当を検討してよいか」と「適用する配当性向」だけである。実際の支払額は
// Q4決算が終わってから年間純利益に対して精算される。本パネルが出すのは後者
// （実支払）であり、見出しでもそれを明示する。

import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import { toYearQuarter } from "../../../lib/v2/core/period";

function usdM(value: number): string {
  return `${(value / 1e6).toFixed(2)}M`;
}

function ratioPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sourceLabel(source: string): string {
  if (source === "MANUAL_OVERRIDE") return "管理者の手動指定";
  if (source === "STANDARD_AI") return "Standard AIの実効値";
  return source || "（不明）";
}

function shortfallLabel(reason: string | null): string {
  switch (reason) {
    case "CASH_LIMIT":
      return "現金の上限に達した";
    case "DISTRIBUTABLE_EARNINGS_LIMIT":
      return "分配可能利益の上限に達した";
    case "POLICY_GATE":
      return "配当ポリシーの条件を満たさなかった";
    case "SETTLEMENT_UNAVAILABLE":
      return "年間利益を確定できなかった";
    default:
      return "－";
  }
}

export function AnnualDividendPanel({ session }: { readonly session: SimulationSession | null }) {
  if (!session) {
    return <p className="text-xs text-slate-400">Runを選ぶと年度末の配当精算が表示されます。</p>;
  }

  // 年度末精算が記録されている四半期（＝Q4）だけを、新しい年度が上に来る順で並べる。
  const rows = session.state.history
    .flatMap((record) =>
      (record.dividendResults ?? []).map((dividend) => ({
        turn: record.turn,
        period: record.period,
        companyId: dividend.companyId,
        settlement: dividend.annualSettlement,
        unavailableReason: dividend.annualSettlementUnavailableReason,
      }))
    )
    .filter((row) => row.settlement !== undefined || row.unavailableReason !== undefined)
    .sort((a, b) => (b.turn === a.turn ? a.companyId.localeCompare(b.companyId) : b.turn - a.turn));

  if (rows.length === 0) {
    const anyQ4 = session.state.history.some((r) => toYearQuarter(r.period).quarter === 4);
    return (
      <p className="text-xs text-slate-400" data-testid="annual-dividend-empty">
        {anyQ4
          ? "年度末（Q4）に到達していますが、年間配当の精算は記録されていません（配当ポリシーの条件を満たさなかった年度です）。"
          : "まだ年度末（Q4）に到達していないため、年間配当の精算はありません。"}
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="annual-dividend-panel">
      <p className="text-[11px] leading-snug text-slate-400">
        配当は年度末（Q4）の決算が確定した<strong>後</strong>に、その年度Q1〜Q4の当期純利益の合計へ配当性向を掛けて精算します。
        同年度に既に支払った配当（Player入力分を含む実支払額）は差し引かれます。ここに出るのは<strong>実際に支払った実績</strong>であり、
        Q4時点の事前判断ではありません。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[11px]">
          <thead>
            <tr className="border-b border-slate-700 text-left text-slate-400">
              <th className="py-1 pr-2">対象年度</th>
              <th className="py-1 pr-2">会社</th>
              <th className="py-1 pr-2 text-right">年間純利益</th>
              <th className="py-1 pr-2 text-right">適用配当性向</th>
              <th className="py-1 pr-2">設定元</th>
              <th className="py-1 pr-2 text-right">年間配当目標</th>
              <th className="py-1 pr-2 text-right">同年度支払済み</th>
              <th className="py-1 pr-2 text-right">今回実支払</th>
              <th className="py-1 pr-2 text-right">未達額</th>
              <th className="py-1 pr-2">未達理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const s = row.settlement;
              const key = `${row.turn}-${row.companyId}`;
              if (!s) {
                // 年間利益を確定できず精算しなかったケース。推測で0を埋めない。
                return (
                  <tr key={key} className="border-b border-slate-800" data-testid={`annual-dividend-row-${key}`}>
                    <td className="py-1 pr-2">{row.period}</td>
                    <td className="py-1 pr-2 font-semibold">{row.companyId}</td>
                    <td className="py-1 pr-2 text-right text-slate-500" colSpan={7}>
                      精算なし — {row.unavailableReason}
                    </td>
                    <td className="py-1 pr-2">{shortfallLabel("SETTLEMENT_UNAVAILABLE")}</td>
                  </tr>
                );
              }
              return (
                <tr key={key} className="border-b border-slate-800" data-testid={`annual-dividend-row-${key}`}>
                  <td className="py-1 pr-2 tabular-nums">{s.dividendTargetYear}</td>
                  <td className="py-1 pr-2 font-semibold">{row.companyId}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{usdM(s.annualNetIncomeUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{ratioPercent(s.appliedPayoutRatio)}</td>
                  <td className="py-1 pr-2">{sourceLabel(s.payoutRatioSource)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{usdM(s.annualDividendTargetUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{usdM(s.paidDividendEarlierInYearUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums font-semibold">{usdM(s.appliedDividendUsd)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{usdM(s.annualDividendShortfallUsd)}</td>
                  <td className="py-1 pr-2">{s.annualDividendShortfallUsd > 0 ? shortfallLabel(s.shortfallReason) : "－"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
