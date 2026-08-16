// ShrimpX V2 — Procurement Planning: Pre-Financing Liquidity Constraint（表示専用）
//
// procurementCashViewModel.ts が返した値をそのまま並べるだけ。
// 「追加借入承認前（approved loan draw = 0）の保守ケース」であることを
// 常に明示し、Projected Ending Cash 相当の表示は一切行わない。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { ProcurementCashViewModel } from "../../procurementCashViewModel";
import { AREA_TONES, NO_VALUE_TEXT } from "../panelStyles";

interface PreFinancingLiquidityPanelProps {
  readonly cash: ProcurementCashViewModel | null;
  /** Procurement Capacity Summary（P4）で計算済みのEffective Purchase Intent。参考として並べて表示する。 */
  readonly effectivePurchaseIntentTons: number | null;
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export default function PreFinancingLiquidityPanel({ cash, effectivePurchaseIntentTons }: PreFinancingLiquidityPanelProps) {
  const tone = AREA_TONES.info;

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="pre-financing-liquidity-panel">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Pre-Financing Procurement Capacity（追加資金調達前）</span>
      </div>

      {cash ? (
        <>
          <div className="mb-2 rounded border border-amber-700/50 bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-200">
            この結果は「新規借入の承認をまだ考慮しない、現在確定している流動性だけを前提とした調達制約」です（承認額 $0
            の保守ケース）。追加借入・銀行審査・市場供給・他社との競争を経た最終的な買付確定量ではありません。
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
              <div className="text-[11px] text-gray-400">Desired Domestic Purchase</div>
              <div className="mt-0.5 text-sm tabular-nums text-gray-100">{formatHosoEqTons(cash.domesticDesiredQuantityTons)}</div>
            </div>
            <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
              <div className="text-[11px] text-gray-400">Effective Purchase Intent</div>
              <div className="mt-0.5 text-sm tabular-nums text-gray-100">
                {effectivePurchaseIntentTons !== null ? formatHosoEqTons(effectivePurchaseIntentTons) : NO_VALUE_TEXT}
              </div>
            </div>
            <div className="rounded border border-amber-800/50 bg-amber-950/20 px-2.5 py-2">
              <div className="text-[11px] text-amber-300">Pre-Financing Constrained Quantity</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-amber-100" data-testid="pre-financing-constrained-quantity">
                {formatHosoEqTons(cash.preFinancingConstrainedDomesticQuantityTons)}
              </div>
            </div>
            <div className="rounded border border-amber-800/50 bg-amber-950/20 px-2.5 py-2">
              <div className="text-[11px] text-amber-300">Potential Reduction（希望量 − 資金制約後数量）</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-amber-100" data-testid="pre-financing-potential-reduction">
                {formatHosoEqTons(Math.max(0, cash.domesticDesiredQuantityTons - cash.preFinancingConstrainedDomesticQuantityTons))}
              </div>
            </div>
            <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
              <div className="text-[11px] text-gray-400">Funding Gap</div>
              <div
                className={`mt-0.5 text-sm tabular-nums ${cash.domesticProcurementFundingGapUsd > 0 ? "text-rose-300" : "text-gray-100"}`}
                data-testid="pre-financing-funding-gap"
              >
                {formatUsd(cash.domesticProcurementFundingGapUsd)}
              </div>
            </div>
            <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
              <div className="text-[11px] text-gray-400">Scale Ratio</div>
              <div className="mt-0.5 text-sm tabular-nums text-gray-100" data-testid="pre-financing-scale-ratio">
                {(cash.preFinancingScaleRatio * 100).toFixed(0)}%
              </div>
            </div>
            <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
              <div className="text-[11px] text-gray-400">Planned Raw Procurement Cash-out</div>
              <div className="mt-0.5 text-sm tabular-nums text-gray-100">{formatUsd(cash.totalPlannedRawProcurementCostUsd)}</div>
            </div>
          </div>

          {cash.importOrdersBlocked && (
            <div className="mt-2 rounded border border-rose-700/60 bg-rose-950/40 px-2.5 py-1.5 text-xs text-rose-200" data-testid="pre-financing-import-blocked">
              Import Orders Blocked — 重大な延滞・支払不能状態のため、輸入発注が抑制されています。
            </div>
          )}
          <p className="mt-2 text-[11px] text-gray-500">{cash.reason}</p>
          <p className="mt-1 text-[11px] text-gray-500">
            資金制約を解消するには、下部の「資金調達（借入・返済）」セクションで追加の資金調達を検討してください。
          </p>
        </>
      ) : (
        <p className="text-xs text-gray-500">この画面では前四半期の公開市場情報が未確定のため、Pre-Financing情報を表示できません（turn1等）。</p>
      )}
    </div>
  );
}
