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
import { InputFieldLabel, ReferenceBadge } from "../FieldAnnotations";
import { AREA_TONES, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface AquacultureSectionProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly aquacultureCapacityTons: HosoEqTons;
  /** rawMaterials/aquaculture.ts の calculateExpectedProduction の結果。行が無ければundefined。 */
  readonly expectedProductionTons: number | undefined;
  readonly unitCostUsdPerHosoEqKg: number;
  /**
   * 【テストプレイ指摘⑨・2026-11】養殖強度による歩留まりの上限割合
   * （rawMaterials/parameters.ts の intensityYieldBonusMax）。
   * 「池入れ 4,000t がなぜ収穫 5,200t になるのか」が画面で分からなかったため、
   * 式をそのまま書くために受け取る。計算はここで行わない（表示専用）。
   */
  readonly intensityYieldBonusMax?: number;
}

export default function AquacultureSection({
  draft,
  onChange,
  disabled,
  aquacultureCapacityTons,
  expectedProductionTons,
  unitCostUsdPerHosoEqKg,
  intensityYieldBonusMax,
}: AquacultureSectionProps) {
  if (draft.aquacultureStockingPlans.length === 0) return null;
  const tone = AREA_TONES.input;
  const entry = draft.aquacultureStockingPlans[0];
  const capacityTons = unwrapUnit(aquacultureCapacityTons);
  /**
   * 【テストプレイ指摘①・2026-10-29】養殖能力を超えた池入れは、入力時には何も言われず、
   * GMがTurnを進めた瞬間に engine 側（rawMaterials/aquaculture.ts の
   * assertValidStockingPlan）で停止する。これまで入力欄にあった合図は枠の色だけで、
   * 超えていることが読み取れなかった。
   *
   * 【止めない理由】実際に停止するかどうかは、この時点では判定できない。
   * companyLab/runner.ts は池入れ計画に資金制約（constraint.scaleRatio）を掛けてから
   * 検証へ渡すため、能力を超える入力でも縮小後に収まれば通る（実測: 5,000t入力・
   * 能力4,000tのRunは通り、50,000t入力は縮小後34,854.16tで停止した）。
   * そのため「超えている事実」だけを示し、入力の可否は変えない。
   */
  const overCapacity = Number.isFinite(entry.plannedStockingQuantity) && entry.plannedStockingQuantity > capacityTons;

  const update = (patch: Partial<AquacultureStockingDraft>) => onChange(updateAquacultureStockingDraft(draft, patch));

  return (
    <div className={`rounded-lg p-3 ${tone.section}`} data-testid="aquaculture-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        <span className={`text-sm font-semibold ${tone.heading}`}>Aquaculture（養殖）</span>
        <span className="text-[11px] text-gray-400 ml-auto">自社養殖能力上限 {formatHosoEqTons(capacityTons)}</span>
      </div>

      {/* 【UI-TRIAL-1 §4】項目名・単位・対象を明記する（下の灰色の枠は読むだけの情報）。 */}
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-300" data-testid="aquaculture-inputs">
        <div className="flex flex-col gap-1">
          <InputFieldLabel name="池入れ予定量 Planned Stocking Quantity" unit="t" target="自社養殖" htmlFor="aquaculture-stocking-quantity-input" />
          <NumberCell
            value={entry.plannedStockingQuantity}
            disabled={disabled}
            warn={overCapacity}
            testId="aquaculture-stocking-quantity-input"
            ariaLabel="自社養殖の池入れ予定量（t）"
            onChange={(n) => update({ plannedStockingQuantity: n })}
          />
          {overCapacity ? (
            <p className="max-w-[18rem] text-[11px] leading-snug text-amber-300" role="alert" data-testid="aquaculture-over-capacity-warning">
              自社養殖能力 {formatHosoEqTons(capacityTons)} を超えています。このままだとTurnを進めたときに処理が止まることがあります。
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <InputFieldLabel name="養殖強度 Aquaculture Intensity" unit="0〜1" target="自社養殖" />
          <RatioCell
            value={entry.aquacultureIntensity}
            disabled={disabled}
            testId="aquaculture-intensity-input"
            ariaLabel="自社養殖の養殖強度（0〜1）"
            onChange={(n) => update({ aquacultureIntensity: n })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <InputFieldLabel name="バイオセキュリティ Bio Security Level" unit="0〜1" target="自社養殖" />
          <RatioCell
            value={entry.bioSecurityLevel}
            disabled={disabled}
            testId="aquaculture-biosecurity-input"
            ariaLabel="自社養殖のバイオセキュリティ水準（0〜1）"
            onChange={(n) => update({ bioSecurityLevel: n })}
          />
        </div>
      </div>

      <div className="rounded border border-gray-700/60 bg-gray-900/40 p-2.5">
        <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-300">
          参考情報（Expected — 疾病圧力適用前）
          <ReferenceBadge kind="reference" testId="aquaculture-expected-reference-badge" />
        </h4>
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
      {/* 【テストプレイ指摘⑨・2026-11】換算の式を実値で書く。
          値はすでに画面上にある入力値とパラメータだけで、新しい計算はしない。 */}
      {intensityYieldBonusMax !== undefined ? (
        <p className="mt-2 text-[11px] leading-snug text-gray-400" data-testid="aquaculture-expected-formula">
          期待生産量の求め方: 池入れ予定量 {formatHosoEqTons(entry.plannedStockingQuantity)} × （1 ＋{" "}
          {intensityYieldBonusMax.toFixed(2)} × 養殖強度 {entry.aquacultureIntensity.toFixed(2)}） ={" "}
          {expectedProductionTons !== undefined ? formatHosoEqTons(expectedProductionTons) : NO_VALUE_TEXT}。
          養殖強度を上げると歩留まりが最大 {(intensityYieldBonusMax * 100).toFixed(0)}% まで増えますが、
          同時に疾病に弱くなり、収穫時の生残率が下がります（上の期待生産量にはその影響がまだ入っていません）。
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-500">
        Expected Production / Harvestは池入れ予定量・養殖強度から求めた疾病圧力適用前の期待生産量です。実際の収穫量は収穫時点の疾病圧力・バイオセキュリティ水準によって変動するため、Confirmedではありません。
      </p>
    </div>
  );
}
