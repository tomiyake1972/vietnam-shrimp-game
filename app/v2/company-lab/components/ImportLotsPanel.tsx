// ShrimpX V2 — Phase 8G §5 輸入原料の状況（輸送中・到着済み）パネル
//
// 【このコンポーネントが存在する理由】
//   輸入発注（DecisionEditor「輸入（原産国別）」セクション）は発注量・リード
//   タイムの入力欄しか無く、発注済み・輸送中の輸入ロットが「いつ・いくらで・
//   どれだけ」到着するのか、当期時点でプレイヤーが確認できる場所が無かった
//   （Phase 8G §5で発見された表示不足。営業配分修正の不具合ではない）。
//
// 【計算ロジックを一切持たない】
//   このコンポーネントはownState.rawMaterialLots（エンジンが既に確定させた
//   RawMaterialLot配列）をフィルタ・並び替え・整形するだけであり、輸入原価
//   （landed cost）・到着時期（availableFromPeriod）のいずれも、既存の
//   rawMaterials/imports.ts（calculateLandedPrice・resolveArrivalPeriod）が
//   ロット生成時に確定させた値をそのまま表示する。新しい費用係数・リードタイム
//   をここで計算・推測することは一切ない。
//
// 【禁止事項】
//   - 輸入原価・到着時期をここで再計算しない（lot.unitCost・
//     lot.availableFromPeriodをそのまま表示する）。
//   - GM専用の精密値（他社ロット・内部の原価内訳breakdown等）を含めない。
//     このコンポーネントは自社ownState.rawMaterialLots（既に自社分だけに
//     絞り込み済み）だけを受け取る前提とする。

import { RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import { PeriodV2 } from "../../../lib/v2/core/period";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { COUNTRY_NAMES } from "../../industry-lab/components/chartColors";
import { formatHosoEqTons, formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface ImportLotsPanelProps {
  /** 自社ぶんのロット全件（他社分は含まない前提。呼び出し側でownState.rawMaterialLotsをそのまま渡す）。 */
  readonly rawMaterialLots: readonly RawMaterialLot[];
  /** 当期（"到着済み"かどうかの表示ラベル分岐にのみ使う。判定そのものは既存のlot.statusをそのまま使う）。 */
  readonly currentPeriod: PeriodV2;
}

const STATUS_LABEL: Record<"available" | "inTransitImport", string> = {
  available: "到着済み・利用可能",
  inTransitImport: "輸送中",
};

const STATUS_STYLE: Record<"available" | "inTransitImport", string> = {
  available: "bg-emerald-950/60 border border-emerald-700/50 text-emerald-200",
  inTransitImport: "bg-amber-950/60 border border-amber-700/50 text-amber-200",
};

export default function ImportLotsPanel(props: ImportLotsPanelProps) {
  const { rawMaterialLots, currentPeriod } = props;

  // 輸入原料（source="import"）のうち、輸送中・到着済みで残数量が残っているものだけを対象にする
  // （消費済み・期限切れのロットは既存のRawMaterialLotStatusでremainingQuantity=0となり、
  // 表示する意味が無いため対象外。フィルタ条件のみで、金額・数量は一切加工しない）。
  const importLots = rawMaterialLots
    .filter((l): l is RawMaterialLot & { status: "available" | "inTransitImport" } =>
      l.source === "import" && (l.status === "available" || l.status === "inTransitImport") && unwrapUnit(l.remainingQuantity) > 0
    )
    .slice()
    .sort((a, b) => {
      const periodCompare = String(a.availableFromPeriod).localeCompare(String(b.availableFromPeriod));
      if (periodCompare !== 0) return periodCompare;
      return a.originCountry.localeCompare(b.originCountry);
    });

  if (importLots.length === 0) {
    return <p className="text-xs text-gray-400">{NO_VALUE_TEXT} 現在、輸送中・到着済みの輸入原料はありません。</p>;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className={INFO_TABLE_HEAD_CLASS}>
              <th className="pr-3 py-1">原産国</th>
              <th className="pr-3 py-1">数量</th>
              <th className="pr-3 py-1">輸入原価（到着原価）</th>
              <th className="pr-3 py-1">状態</th>
              <th className="pr-3 py-1">到着時期</th>
            </tr>
          </thead>
          <tbody>
            {importLots.map((lot) => (
              <tr key={lot.lotId} className={INFO_TABLE_ROW_CLASS}>
                <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">
                  {COUNTRY_NAMES[lot.originCountry]}（{lot.originCountry}）
                </td>
                <td className="pr-3 py-1.5 whitespace-nowrap">{formatHosoEqTons(lot.remainingQuantity)}</td>
                <td className="pr-3 py-1.5 whitespace-nowrap">{formatUsdPerHosoEqKg(lot.unitCost)}</td>
                <td className="pr-3 py-1.5 whitespace-nowrap">
                  <span className={`text-[10px] rounded-full px-2 py-0.5 ${STATUS_STYLE[lot.status]}`}>{STATUS_LABEL[lot.status]}</span>
                </td>
                <td className="pr-3 py-1.5 whitespace-nowrap">
                  {String(lot.availableFromPeriod)}
                  {String(lot.availableFromPeriod) === String(currentPeriod) && lot.status === "inTransitImport" && (
                    <span className="ml-1 text-[10px] text-gray-500">（今期到着予定）</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-500 leading-relaxed">
        「輸入原価（到着原価）」は、原産国のFOB価格に運賃・関税・保険等の既存の輸入コスト係数を加えた、
        発注確定時点の1トンあたり取得原価です（発注後に価格が変動しても、このロットの原価は変わりません）。
        「到着時期」は、輸送中の原料が使用可能になる四半期です。
      </p>
    </div>
  );
}
