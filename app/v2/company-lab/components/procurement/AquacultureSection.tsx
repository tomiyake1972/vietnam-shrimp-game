// ShrimpX V2 — Procurement Planning: Aquaculture（入力＋自動計算を同一section内で）
//
// 入力欄は draft.aquacultureStockingPlans が現在持つ3フィールド
// （Planned Stocking Quantity / Aquaculture Intensity / Bio Security Level）だけを扱う。
// これ以外のフィールド（収穫期選択等）は現行のdraftスキーマに存在しないため、
// この画面で新設しない。
//
// Expected Production（rawMaterials/aquaculture.ts の calculateExpectedProduction を
// そのまま呼んだ結果）は必ず「Expected」と表示し、「Confirmed」とは呼ばない
// （疾病圧力は収穫時まで未確定のため）。

import { HosoEqTons, unwrapUnit } from "../../../../lib/v2/core/units";
import { formatHosoEqTons, formatUsdPerHosoEqKg } from "../../../../lib/v2/industryLab/ui/formatters";
import { AquacultureStockingDraft, CompanyDecisionDraft, updateAquacultureStockingDraft } from "../../decisionDraft";
import { NumberCell, RatioCell } from "../InputCells";
import { AREA_TONES, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface AquacultureSectionProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly aquacultureCapacityTons: HosoEqTons;
  /** rawMaterials/aquaculture.ts の calculateExpectedProduction の結果。行が無ければundefined。 */
  readonly expectedProductionTons: number | undefined;
  readonly unitCostUsdPerHosoEqKg: number;
}

export default function AquacultureSection({
  draft,
  onChange,
  disabled,
  aquacultureCapacityTons,
  expectedProductionTons,
  unitCostUsdPerHosoEqKg,
}: AquacultureSectionProps) {
  if (draft.aquacultureStockingPlans.length === 0) return null;
  const tone = AREA_TONES.input;
  const entry = draft.aquacultureStockingPlans[0];
  const capacityTons = unwrapUnit(aquacultureCapacityTons);

  const update = (patch: Partial<AquacultureStockingDraft>) => onChange(updateAquacultureStockingDraft(draft, patch));

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="aquaculture-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Aquaculture（養殖）</span>
        <span className="text-[11px] text-gray-400 ml-auto">自社養殖能力上限 {formatHosoEqTons(capacityTons)}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-300">
        <label className="flex flex-col gap-1">
          Planned Stocking Quantity 池入れ予定量(t)
          <NumberCell
            value={entry.plannedStockingQuantity}
            disabled={disabled}
            warn={entry.plannedStockingQuantity > capacityTons}
            testId="aquaculture-stocking-quantity-input"
            onChange={(n) => update({ plannedStockingQuantity: n })}
          />
        </label>
        <label className="flex flex-col gap-1">
          Aquaculture Intensity 養殖強度(0〜1)
          <RatioCell value={entry.aquacultureIntensity} disabled={disabled} onChange={(n) => update({ aquacultureIntensity: n })} />
        </label>
        <label className="flex flex-col gap-1">
          Bio Security Level バイオセキュリティ(0〜1)
          <RatioCell value={entry.bioSecurityLevel} disabled={disabled} onChange={(n) => update({ bioSecurityLevel: n })} />
        </label>
      </div>

      <div className="rounded border border-gray-700/60 bg-gray-900/40 p-2.5">
        <h4 className="mb-1 text-xs font-semibold text-gray-300">参考情報（Expected — 疾病圧力適用前）</h4>
        <table className="min-w-full text-xs text-gray-300">
          <tbody>
            <tr className={INFO_TABLE_ROW_CLASS}>
              <td className="pr-3 py-1 text-amber-300">Expected Production / Harvest（確定ではない）</td>
              <td className="pr-3 py-1 text-right tabular-nums font-semibold text-amber-100" data-testid="aquaculture-expected-production">
                {expectedProductionTons !== undefined ? formatHosoEqTons(expectedProductionTons) : NO_VALUE_TEXT}
              </td>
            </tr>
            <tr>
              <td className="pr-3 py-1 text-gray-400">Unit Cost</td>
              <td className="pr-3 py-1 text-right tabular-nums" data-testid="aquaculture-unit-cost">
                {formatUsdPerHosoEqKg(unitCostUsdPerHosoEqKg)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Expected Production / Harvestは池入れ予定量・養殖強度から求めた疾病圧力適用前の期待生産量です。実際の収穫量は収穫時点の疾病圧力・バイオセキュリティ水準によって変動するため、Confirmedではありません。
      </p>
    </div>
  );
}
