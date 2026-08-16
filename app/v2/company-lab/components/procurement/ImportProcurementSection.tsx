// ShrimpX V2 — Procurement Planning: Import Procurement（入力＋自動計算を同一section内で）
//
// 入力欄（Ordered Quantity / Lead Time）は decisionDraft.ts の updateImportOrderDraft を
// 呼ぶだけ（計算ロジックなし）。着地価格内訳・到着予定四半期は
// procurementPricingViewModel.ts / plannedProcurementViewModel.ts が返した値を
// そのまま表示するだけ。
//
// 【Ordered Quantity ≠ Confirmed Import Allocation】
// 発注量は原産国別供給上限に対する水位法配分（rawMaterials/imports.ts の
// createImportLots）で満額通らない可能性があり、この画面では確定配分量を
// 一切計算・表示しない。

import { PeriodV2 } from "../../../../lib/v2/core/period";
import { CompanyDecisionDraft, ImportOrderDraftRow, updateImportOrderDraft } from "../../decisionDraft";
import { formatUsdPerHosoEqKg } from "../../../../lib/v2/industryLab/ui/formatters";
import { ImportPricingRow } from "../../procurementPricingViewModel";
import { resolveImportArrivalBucket } from "../../plannedProcurementViewModel";
import { TIMELINE_BUCKET_LABELS } from "../../rawMaterialTimelineViewModel";
import { NumberCell } from "../InputCells";
import { AREA_TONES, INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INPUT_CONTROL_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface ImportProcurementSectionProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly pricingRows: readonly ImportPricingRow[];
  readonly period: PeriodV2;
  readonly standardLeadTimeTurns: number;
}

function price(v: number | undefined): string {
  return v === undefined ? NO_VALUE_TEXT : formatUsdPerHosoEqKg(v);
}

function ImportOrderRow({
  row,
  disabled,
  pricing,
  arrivalQuarterLabel,
  onChange,
}: {
  readonly row: ImportOrderDraftRow;
  readonly disabled: boolean;
  readonly pricing: ImportPricingRow | undefined;
  readonly arrivalQuarterLabel: string;
  readonly onChange: (patch: Partial<ImportOrderDraftRow>) => void;
}) {
  return (
    <tr className={INFO_TABLE_ROW_CLASS} data-testid={`import-order-row-${row.originCountry}`}>
      <td className="pr-3 py-1">{row.originCountry}</td>
      <td className="pr-3 py-1 text-right tabular-nums">{price(pricing?.breakdown.originPrice)}</td>
      <td className="pr-3 py-1">
        <NumberCell
          value={row.orderedQuantity}
          disabled={disabled}
          testId={`import-ordered-quantity-input-${row.originCountry}`}
          onChange={(n) => onChange({ orderedQuantity: n })}
        />
      </td>
      <td className="pr-3 py-1">
        <input
          type="number"
          min={1}
          step={1}
          value={row.leadTimeTurns ?? ""}
          disabled={disabled}
          placeholder="標準"
          data-testid={`import-lead-time-input-${row.originCountry}`}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({ leadTimeTurns: raw === "" ? undefined : Math.max(1, Math.round(Number(raw) || 1)) });
          }}
          className={`w-20 ${INPUT_CONTROL_CLASS}`}
        />
      </td>
      <td className="pr-3 py-1 text-right" data-testid={`import-arrival-quarter-${row.originCountry}`}>
        {arrivalQuarterLabel}
      </td>
      <td className="pr-3 py-1 text-right tabular-nums font-semibold text-gray-100" data-testid={`import-landed-cost-${row.originCountry}`}>
        {price(pricing?.breakdown.landedPrice)}
      </td>
    </tr>
  );
}

export default function ImportProcurementSection({ draft, onChange, disabled, pricingRows, period, standardLeadTimeTurns }: ImportProcurementSectionProps) {
  const tone = AREA_TONES.input;
  const pricingByCountry = new Map(pricingRows.map((r) => [r.originCountry, r]));

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="import-section">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Import Procurement（輸入・原産国別）</span>
      </div>

      {pricingRows.length === 0 && (
        <p className="mb-2 text-xs text-gray-500">前四半期の産地国別価格が未確定です（turn1等）。Origin Price / Indicative Landed Costは{NO_VALUE_TEXT}表示になります。</p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">Origin</th>
              <th className="pr-3 py-1 text-right">Origin Price</th>
              <th className="pr-3 py-1">Ordered Quantity(t)</th>
              <th className="pr-3 py-1">Lead Time(ターン)</th>
              <th className="pr-3 py-1 text-right">Expected Arrival Quarter</th>
              <th className="pr-3 py-1 text-right font-semibold">Indicative Landed Cost</th>
            </tr>
          </thead>
          <tbody>
            {draft.importOrders.map((row) => {
              const bucket = resolveImportArrivalBucket(period, row.leadTimeTurns, standardLeadTimeTurns);
              return (
                <ImportOrderRow
                  key={row.originCountry}
                  row={row}
                  disabled={disabled}
                  pricing={pricingByCountry.get(row.originCountry)}
                  arrivalQuarterLabel={TIMELINE_BUCKET_LABELS[bucket]}
                  onChange={(patch) => onChange(updateImportOrderDraft(draft, row.originCountry, patch))}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {pricingRows.length > 0 && (
        <details className="mt-2">
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">着地価格の内訳（duty / freight / insurance / country adjustment）</summary>
          <div className="mt-1 overflow-x-auto">
            <table className="min-w-full text-[11px] text-gray-400" data-testid="import-landed-cost-breakdown-table">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">Origin</th>
                  <th className="pr-3 py-1 text-right">Duty</th>
                  <th className="pr-3 py-1 text-right">Freight</th>
                  <th className="pr-3 py-1 text-right">Insurance/Handling</th>
                  <th className="pr-3 py-1 text-right">Country Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {pricingRows.map((row) => (
                  <tr key={row.originCountry} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{row.originCountry}</td>
                    <td className="pr-3 py-1 text-right tabular-nums">{formatUsdPerHosoEqKg(row.breakdown.dutyAndTaxUsdPerHosoEqKg)}</td>
                    <td className="pr-3 py-1 text-right tabular-nums">{formatUsdPerHosoEqKg(row.breakdown.freightUsdPerHosoEqKg)}</td>
                    <td className="pr-3 py-1 text-right tabular-nums">{formatUsdPerHosoEqKg(row.breakdown.insuranceAndHandlingUsdPerHosoEqKg)}</td>
                    <td className="pr-3 py-1 text-right tabular-nums">
                      {row.breakdown.originCountryAdjustmentUsdPerHosoEqKg >= 0 ? "+" : ""}
                      {formatUsdPerHosoEqKg(row.breakdown.originCountryAdjustmentUsdPerHosoEqKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="mt-2 text-[11px] text-gray-500">
        Ordered Quantity（発注量） ≠ Confirmed Import Allocation（原産国別供給上限に対する水位法配分後の確定輸入量）。他社との競合発注・原産国側の供給上限次第で、発注量どおりに満額到着するとは限りません。
      </p>
    </div>
  );
}
