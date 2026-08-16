// ShrimpX V2 — Procurement Planning: Auto Calculated Impact（表示専用）
//
// plannedProcurementViewModel.ts / procurementPricingViewModel.ts が返した値を
// そのまま並べるだけ。新しい集計式・単価計算式は一切作らない。
//
// 【Planned Procurement Total（今回のdraft入力の合計）と、手持ち在庫の加重平均単価は
//  別物】前者は今回入力した希望量・発注量・池入れ計画（未提出・未確定）の合計、
// 後者は既に手元にあるロット（status="available"）の実際の簿価加重平均であり、
// この2つを混ぜて1つの数値にしない。

import { formatHosoEqTons, formatRatioAsPercent, formatUsdPerHosoEqKg } from "../../../../lib/v2/industryLab/ui/formatters";
import { PlannedProcurementSummary, PlannedProcurementSource } from "../../plannedProcurementViewModel";
import { RawMaterialCostSummary } from "../../procurementPricingViewModel";
import { AREA_TONES, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface ProcurementAutoCalcPanelProps {
  readonly plannedSummary: PlannedProcurementSummary;
  readonly costSummary: RawMaterialCostSummary;
}

const SOURCE_LABEL: Readonly<Record<PlannedProcurementSource, string>> = {
  domestic: "国内（Domestic）",
  import: "輸入（Import）",
  aquaculture: "養殖（Aquaculture）",
};

export default function ProcurementAutoCalcPanel({ plannedSummary, costSummary }: ProcurementAutoCalcPanelProps) {
  const tone = AREA_TONES.info;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="procurement-auto-calc-panel">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Auto Calculated Impact（今回のdraft入力の自動集計）</span>
      </div>

      <div className="mb-3 rounded border border-sky-800/50 bg-sky-950/20 px-2.5 py-2">
        <div className="text-[11px] text-sky-300">Planned Procurement Total（国内＋輸入＋養殖・未提出・未確定）</div>
        <div className="mt-0.5 text-lg font-bold tabular-nums text-sky-100" data-testid="auto-calc-planned-total">
          {formatHosoEqTons(plannedSummary.totalTons)}
        </div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {plannedSummary.bySource.map((entry) => (
          <div key={entry.source} className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2" data-testid={`auto-calc-source-mix-${entry.source}`}>
            <div className="text-[11px] text-gray-400">{SOURCE_LABEL[entry.source]}</div>
            <div className="mt-0.5 text-sm tabular-nums text-gray-100">
              {formatHosoEqTons(entry.quantityTons)}（{formatRatioAsPercent(entry.shareOfTotal)}）
            </div>
          </div>
        ))}
      </div>

      <div className="rounded border border-gray-700/60 bg-gray-900/40 p-2.5">
        <h4 className="mb-1 text-xs font-semibold text-gray-300">手持ち在庫の加重平均原料単価（Weighted Average Raw Material Cost — 実際の簿価）</h4>
        <table className="min-w-full text-xs text-gray-300">
          <tbody>
            {costSummary.bySource.map((entry) => (
              <tr key={entry.source} className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">{SOURCE_LABEL[entry.source]}</td>
                <td className="pr-3 py-1 text-right tabular-nums">{formatHosoEqTons(entry.quantityTons)}</td>
                <td className="pr-3 py-1 text-right tabular-nums">
                  {entry.weightedAverageUnitCostUsdPerHosoEqKg !== undefined ? formatUsdPerHosoEqKg(entry.weightedAverageUnitCostUsdPerHosoEqKg) : NO_VALUE_TEXT}
                </td>
              </tr>
            ))}
            <tr className="border-t border-gray-600 font-semibold">
              <td className="pr-3 py-1 text-gray-300">全体</td>
              <td className="pr-3 py-1 text-right tabular-nums">{formatHosoEqTons(costSummary.totalQuantityTons)}</td>
              <td className="pr-3 py-1 text-right tabular-nums" data-testid="auto-calc-overall-weighted-cost">
                {costSummary.overallWeightedAverageUnitCostUsdPerHosoEqKg !== undefined
                  ? formatUsdPerHosoEqKg(costSummary.overallWeightedAverageUnitCostUsdPerHosoEqKg)
                  : NO_VALUE_TEXT}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
