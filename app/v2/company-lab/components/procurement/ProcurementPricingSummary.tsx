// ShrimpX V2 — Procurement Planning: Procurement Pricing Summary（表示専用）
//
// procurementPricingViewModel.ts が返した値をそのまま並べるだけ。UI独自の
// 価格計算は一切行わない。国内・輸入は前四半期の公開市場情報が無い場合
// （turn1等）は「－」で表示し、値を捏造しない。

import { formatUsdPerHosoEqKg } from "../../../../lib/v2/industryLab/ui/formatters";
import { AquaculturePricingViewModel, DomesticPricingViewModel, ImportPricingRow } from "../../procurementPricingViewModel";
import { AREA_TONES, INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface ProcurementPricingSummaryProps {
  readonly domestic: DomesticPricingViewModel | null;
  readonly importRows: readonly ImportPricingRow[];
  readonly aquaculture: AquaculturePricingViewModel;
}

function price(v: number | undefined): string {
  return v === undefined ? NO_VALUE_TEXT : formatUsdPerHosoEqKg(v);
}

export default function ProcurementPricingSummary({ domestic, importRows, aquaculture }: ProcurementPricingSummaryProps) {
  const tone = AREA_TONES.info;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="procurement-pricing-summary">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Procurement Pricing Summary</span>
      </div>

      {/* 国内 */}
      <div className="mb-3">
        <h4 className="mb-1 text-xs font-semibold text-gray-300">国内（Domestic）</h4>
        {domestic ? (
          <table className="min-w-full text-xs text-gray-300" data-testid="pricing-domestic-table">
            <tbody>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">Reference Price</td>
                <td className="pr-3 py-1 text-right tabular-nums" data-testid="pricing-domestic-reference">
                  {price(domestic.referencePriceUsdPerHosoEqKg)}
                </td>
              </tr>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">Price Adjustment</td>
                <td className="pr-3 py-1 text-right tabular-nums">
                  {domestic.priceAdjustmentUsdPerHosoEqKg >= 0 ? "+" : ""}
                  {price(domestic.priceAdjustmentUsdPerHosoEqKg)}
                </td>
              </tr>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400 font-semibold">Implied Offer Price</td>
                <td className="pr-3 py-1 text-right tabular-nums font-semibold text-gray-100" data-testid="pricing-domestic-implied">
                  {price(domestic.impliedOfferPriceUsdPerHosoEqKg)}
                </td>
              </tr>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">Valid Bid Range</td>
                <td className={`pr-3 py-1 text-right tabular-nums ${domestic.isWithinValidBidRange ? "" : "text-amber-300"}`}>
                  {price(domestic.validBidRange.minUsdPerHosoEqKg)} 〜 {price(domestic.validBidRange.maxUsdPerHosoEqKg)}
                  {!domestic.isWithinValidBidRange && " （範囲外）"}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-gray-500">参考国内原料価格が未確定です（turn1等）。{NO_VALUE_TEXT}</p>
        )}
      </div>

      {/* 輸入 */}
      <div className="mb-3">
        <h4 className="mb-1 text-xs font-semibold text-gray-300">輸入（Import）</h4>
        {importRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300" data-testid="pricing-import-table">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">原産国</th>
                  <th className="pr-3 py-1 text-right">Origin Price</th>
                  <th className="pr-3 py-1 text-right font-semibold">Landed Cost</th>
                </tr>
              </thead>
              <tbody>
                {importRows.map((row) => (
                  <tr key={row.originCountry} className={INFO_TABLE_ROW_CLASS} data-testid={`pricing-import-row-${row.originCountry}`}>
                    <td className="pr-3 py-1">{row.originCountry}</td>
                    <td className="pr-3 py-1 text-right tabular-nums">{formatUsdPerHosoEqKg(row.breakdown.originPrice)}</td>
                    <td className="pr-3 py-1 text-right tabular-nums font-semibold text-gray-100">{formatUsdPerHosoEqKg(row.breakdown.landedPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="mt-1">
              <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">着地価格の内訳（duty / freight / insurance / country adjustment）</summary>
              <div className="mt-1 overflow-x-auto">
                <table className="min-w-full text-[11px] text-gray-400" data-testid="pricing-import-breakdown-table">
                  <thead>
                    <tr className={INFO_TABLE_HEAD_CLASS}>
                      <th className="pr-3 py-1">原産国</th>
                      <th className="pr-3 py-1 text-right">Duty</th>
                      <th className="pr-3 py-1 text-right">Freight</th>
                      <th className="pr-3 py-1 text-right">Insurance/Handling</th>
                      <th className="pr-3 py-1 text-right">Country Adjustment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.map((row) => (
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
          </div>
        ) : (
          <p className="text-xs text-gray-500">前四半期の産地国別価格が未確定です（turn1等）。{NO_VALUE_TEXT}</p>
        )}
      </div>

      {/* 養殖 */}
      <div>
        <h4 className="mb-1 text-xs font-semibold text-gray-300">自社養殖（Aquaculture）</h4>
        <table className="min-w-full text-xs text-gray-300">
          <tbody>
            <tr>
              <td className="pr-3 py-1 text-gray-400">Unit Cost</td>
              <td className="pr-3 py-1 text-right tabular-nums" data-testid="pricing-aquaculture-unit-cost">
                {formatUsdPerHosoEqKg(aquaculture.unitCostUsdPerHosoEqKg)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
