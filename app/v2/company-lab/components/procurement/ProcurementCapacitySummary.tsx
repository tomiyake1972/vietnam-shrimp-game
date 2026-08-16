// ShrimpX V2 — Procurement Planning: Procurement Capacity Summary（表示専用）
//
// procurementCapacityViewModel.ts が返した値をそのまま並べるだけ。
// Desired Quantity ≠ Effective Purchase Intent ≠ Actual Purchase Quantity
// であることを明示する（Actual Purchase Quantityは今回表示しない）。

import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { ProcurementCapacityBindingConstraint, ProcurementCapacityViewModel } from "../../procurementCapacityViewModel";
import { AREA_TONES, NO_VALUE_TEXT } from "../panelStyles";

interface ProcurementCapacitySummaryProps {
  readonly capacity: ProcurementCapacityViewModel;
  /** 基準供給量（shareOfSupplyCapの算出元）が公開市場情報から得られたか。falseなら
   *  Effective Purchase Intent / Binding Constraint は参考値扱いであることを明示する。 */
  readonly referenceSupplyKnown: boolean;
}

const BINDING_LABEL: Readonly<Record<ProcurementCapacityBindingConstraint, string>> = {
  desiredQuantity: "希望量そのもの（能力・上限に余裕あり）",
  procurementCapacity: "調達処理能力（人員を増やすと伸びる）",
  approvedPurchaseCap: "承認済み買付枠",
  shareOfSupplyCap: "市場シェア上限",
};

export default function ProcurementCapacitySummary({ capacity, referenceSupplyKnown }: ProcurementCapacitySummaryProps) {
  const tone = AREA_TONES.info;
  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="procurement-capacity-summary">
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Procurement Capacity Summary</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
          <div className="text-[11px] text-gray-400">Desired Quantity（希望量）</div>
          <div className="mt-0.5 text-sm tabular-nums text-gray-100" data-testid="capacity-desired">
            {formatHosoEqTons(capacity.desiredQuantityTons)}
          </div>
        </div>
        <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
          <div className="text-[11px] text-gray-400">Procurement Headcount</div>
          <div className="mt-0.5 text-sm tabular-nums text-gray-100">{capacity.procurementHeadcount}人</div>
        </div>
        <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2">
          <div className="text-[11px] text-gray-400">Procurement Capacity（調達人員から導出）</div>
          <div className="mt-0.5 text-sm tabular-nums text-gray-100" data-testid="capacity-capacity">
            {formatHosoEqTons(capacity.procurementCapacityTons)}
          </div>
        </div>
        <div className="rounded border border-sky-800/50 bg-sky-950/20 px-2.5 py-2">
          <div className="text-[11px] text-sky-300">Effective Purchase Intent（確定買付量ではない）</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-sky-100" data-testid="capacity-effective-intent">
            {referenceSupplyKnown ? formatHosoEqTons(capacity.effectivePurchaseIntentTons) : NO_VALUE_TEXT}
          </div>
        </div>
        <div className="rounded border border-gray-700/60 bg-gray-900/40 px-2.5 py-2 sm:col-span-2">
          <div className="text-[11px] text-gray-400">Binding Constraint（何が効いているか）</div>
          <div className="mt-0.5 text-xs text-gray-200" data-testid="capacity-binding-constraint">
            {referenceSupplyKnown ? BINDING_LABEL[capacity.bindingConstraint] : `${NO_VALUE_TEXT}（前四半期の市場基準供給量が未確定のため参考値なし）`}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Desired Quantity（希望量） ≠ Effective Purchase Intent（自社視点の意向上限。過大申告で価格を吊り上げないための上限） ≠ Actual
        Purchase Quantity（他社との競争・銀行審査・市場供給を経て四半期処理で決まる実際の成立量）です。実際の成立量はこの画面では表示しません。
      </p>
    </div>
  );
}
