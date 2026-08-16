// ShrimpX V2 — Procurement Planning: Domestic Procurement（入力＋自動計算を同一section内で）
//
// 入力欄（Desired Quantity / Price Adjustment / Procurement Headcount）は
// decisionDraft.ts の updateDomesticPurchaseDraft を呼ぶだけ（計算ロジックなし）。
// 自動計算欄（Reference/Implied/Valid Bid Range・Capacity/Effective Purchase Intent/
// Binding Constraint）は procurementPricingViewModel.ts / procurementCapacityViewModel.ts
// が返した値をそのまま表示するだけ。
//
// 【Desired Quantity ≠ Effective Purchase Intent ≠ Actual Purchase Quantity】
// Actual Purchase Quantity（他社との競争配分後の実際の成立量）はこの画面では
// 一切計算・表示しない。

import { CompanyDecisionDraft, updateDomesticPurchaseDraft } from "../../decisionDraft";
import { formatHosoEqTons, formatUsdPerHosoEqKg } from "../../../../lib/v2/industryLab/ui/formatters";
import { DomesticPricingViewModel } from "../../procurementPricingViewModel";
import { ProcurementCapacityBindingConstraint, ProcurementCapacityViewModel } from "../../procurementCapacityViewModel";
import { NumberCell, PriceAdjustmentCell } from "../InputCells";
import { AREA_TONES, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface DomesticProcurementSectionProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly pricing: DomesticPricingViewModel | null;
  readonly capacity: ProcurementCapacityViewModel;
  readonly referenceSupplyKnown: boolean;
}

const BINDING_LABEL: Readonly<Record<ProcurementCapacityBindingConstraint, string>> = {
  desiredQuantity: "希望量そのもの（能力・上限に余裕あり）",
  procurementCapacity: "調達処理能力（人員を増やすと伸びる）",
  approvedPurchaseCap: "承認済み買付枠",
  shareOfSupplyCap: "市場シェア上限",
};

function price(v: number | undefined): string {
  return v === undefined ? NO_VALUE_TEXT : formatUsdPerHosoEqKg(v);
}

export default function DomesticProcurementSection({
  draft,
  onChange,
  disabled,
  pricing,
  capacity,
  referenceSupplyKnown,
}: DomesticProcurementSectionProps) {
  const tone = AREA_TONES.input;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="domestic-purchase-section">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Domestic Procurement（国内原料買付）</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-300">
        <label className="flex flex-col gap-1">
          Desired Quantity 買付希望量(t)
          <NumberCell
            value={draft.domesticPurchase.desiredQuantity}
            disabled={disabled}
            warn={draft.domesticPurchase.desiredQuantity > 20000}
            testId="domestic-desired-quantity-input"
            onChange={(n) => onChange(updateDomesticPurchaseDraft(draft, { desiredQuantity: n }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          Price Adjustment 価格調整($/kg)
          <PriceAdjustmentCell
            value={draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg}
            disabled={disabled}
            onChange={(n) => onChange(updateDomesticPurchaseDraft(draft, { priceAdjustmentUsdPerHosoEqKg: n }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          Procurement Headcount 調達人員
          <NumberCell
            value={draft.domesticPurchase.procurementHeadcount}
            disabled={disabled}
            testId="domestic-headcount-input"
            onChange={(n) => onChange(updateDomesticPurchaseDraft(draft, { procurementHeadcount: Math.round(n) }))}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded border border-gray-700/60 bg-gray-900/40 p-2.5">
          <h4 className="mb-1 text-xs font-semibold text-gray-300">価格（Pricing）</h4>
          {pricing ? (
            <table className="min-w-full text-xs text-gray-300">
              <tbody>
                <tr className={INFO_TABLE_ROW_CLASS}>
                  <td className="pr-3 py-1 text-gray-400">Reference Price</td>
                  <td className="pr-3 py-1 text-right tabular-nums" data-testid="pricing-domestic-reference">
                    {price(pricing.referencePriceUsdPerHosoEqKg)}
                  </td>
                </tr>
                <tr className={INFO_TABLE_ROW_CLASS}>
                  <td className="pr-3 py-1 text-gray-400 font-semibold">Implied Offer Price</td>
                  <td className="pr-3 py-1 text-right tabular-nums font-semibold text-gray-100" data-testid="pricing-domestic-implied">
                    {price(pricing.impliedOfferPriceUsdPerHosoEqKg)}
                  </td>
                </tr>
                <tr className={INFO_TABLE_ROW_CLASS}>
                  <td className="pr-3 py-1 text-gray-400">Valid Bid Range</td>
                  <td className={`pr-3 py-1 text-right tabular-nums ${pricing.isWithinValidBidRange ? "" : "text-amber-300"}`}>
                    {price(pricing.validBidRange.minUsdPerHosoEqKg)} 〜 {price(pricing.validBidRange.maxUsdPerHosoEqKg)}
                    {!pricing.isWithinValidBidRange && " （範囲外）"}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-gray-500">参考国内原料価格が未確定です（turn1等）。{NO_VALUE_TEXT}</p>
          )}
        </div>

        <div className="rounded border border-gray-700/60 bg-gray-900/40 p-2.5">
          <h4 className="mb-1 text-xs font-semibold text-gray-300">能力・意向（Capacity / Intent）</h4>
          <table className="min-w-full text-xs text-gray-300">
            <tbody>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">Procurement Capacity</td>
                <td className="pr-3 py-1 text-right tabular-nums" data-testid="capacity-capacity">
                  {formatHosoEqTons(capacity.procurementCapacityTons)}
                </td>
              </tr>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-gray-400">Desired Quantity</td>
                <td className="pr-3 py-1 text-right tabular-nums" data-testid="capacity-desired">
                  {formatHosoEqTons(capacity.desiredQuantityTons)}
                </td>
              </tr>
              <tr className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1 text-sky-300">Effective Purchase Intent（確定買付量ではない）</td>
                <td className="pr-3 py-1 text-right tabular-nums font-semibold text-sky-100" data-testid="capacity-effective-intent">
                  {referenceSupplyKnown ? formatHosoEqTons(capacity.effectivePurchaseIntentTons) : NO_VALUE_TEXT}
                </td>
              </tr>
              <tr>
                <td className="pr-3 py-1 text-gray-400">Binding Constraint</td>
                <td className="pr-3 py-1 text-right text-[11px] text-gray-200" data-testid="capacity-binding-constraint">
                  {referenceSupplyKnown ? BINDING_LABEL[capacity.bindingConstraint] : `${NO_VALUE_TEXT}（基準供給量未確定）`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Desired Quantity（希望量） ≠ Effective Purchase Intent（自社視点の意向上限） ≠ Actual Purchase Quantity（他社との競争・四半期処理で決まる実際の成立量。この画面では表示しません）。
      </p>
    </div>
  );
}
