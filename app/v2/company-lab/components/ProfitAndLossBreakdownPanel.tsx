// ShrimpX V2 — 前期PL（費用内訳）パネル
//
// 【計算しない】表示するのは profitAndLossBreakdownViewModel が
// エンジンの確定値から組み立てた行だけで、このファイルは整形しかしない。
// エンジンが値を持っていない費目は金額の代わりに「未実装」と出す（0で埋めない）。

import CollapsibleSection from "./CollapsibleSection";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS } from "./panelStyles";
import type { ProfitAndLossBreakdown } from "../profitAndLossBreakdownViewModel";

const NOT_IMPLEMENTED = "未実装";

function usd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? "" : `${(value * 100).toFixed(1)}%`;
}

export default function ProfitAndLossBreakdownPanel({
  breakdown,
  periodLabel,
}: {
  readonly breakdown: ProfitAndLossBreakdown;
  readonly periodLabel: string;
}) {
  return (
    <CollapsibleSection
      title={`業績の内訳（損益計算書 — ${periodLabel}）`}
      description="エンジンが確定させた値だけを表示しています。画面側での推計は行っていません。"
      tone="info"
      defaultOpen={false}
      testId="pl-breakdown-section"
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300" data-testid="pl-breakdown-table">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1 text-left">項目</th>
              <th className="pr-3 py-1 text-right">金額</th>
              <th className="pr-3 py-1 text-right">売上比</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.rows.map((row) => (
              <tr key={row.key} className={INFO_TABLE_ROW_CLASS} data-testid={`pl-row-${row.key}`}>
                <td className={`py-1 pr-3 ${row.indent ? "pl-4 text-gray-400" : ""} ${row.emphasis ? "font-semibold text-gray-100" : ""}`}>
                  {row.label}
                  {row.note ? <span className="ml-1 text-[10px] text-gray-500">{row.note}</span> : null}
                </td>
                <td
                  className={`py-1 pr-3 text-right tabular-nums ${row.emphasis ? "font-semibold text-gray-100" : ""} ${
                    row.amountUsd === null ? "text-amber-300" : ""
                  }`}
                  data-testid={`pl-amount-${row.key}`}
                >
                  {row.amountUsd === null ? NOT_IMPLEMENTED : usd(row.amountUsd)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-gray-400">{percent(row.marginRatio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <h5 className="mb-1 text-[11px] font-semibold text-gray-300">kgあたり指標</h5>
        <table className="min-w-full text-xs text-gray-300" data-testid="pl-per-kg-table">
          <tbody>
            {breakdown.perKilogram.map((metric) => (
              <tr key={metric.key} className={INFO_TABLE_ROW_CLASS}>
                <td className="py-1 pr-3">{metric.label}</td>
                <td className="py-1 pr-3 text-right tabular-nums" data-testid={`pl-per-kg-${metric.key}`}>
                  {metric.valueUsdPerKg === null ? "算定不可" : `$${metric.valueUsdPerKg.toFixed(2)}/kg`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {breakdown.unavailableItems.length > 0 ? (
        <p className="mt-2 text-[11px] text-amber-300/90" data-testid="pl-unavailable-items">
          エンジンが確定値として持っていないため表示できない項目: {breakdown.unavailableItems.join(" / ")}
        </p>
      ) : null}
    </CollapsibleSection>
  );
}
