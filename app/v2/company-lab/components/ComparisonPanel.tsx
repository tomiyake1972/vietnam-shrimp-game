// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 全社比較パネル（GM専用）
//
// 実プレイヤーは他社の非公開計画・結果を見られないという前提のもと、本パネルは
// GM（ゲームマスター）専用の比較表示であることを明示する。財務三表は未実装のため、
// 財務指標（利益・キャッシュ等）は一切表示しない（存在しない数値を捏造しない）。
// すべてCompanyQuarterSummaryのフィールドから導出できる値のみを表示する。

import { unwrapUnit } from "../../../lib/v2/core/units";
import { CompanyQuarterSummary } from "../../../lib/v2/companyLab";
import { formatHosoEqTons, formatRatioAsPercent } from "../../../lib/v2/industryLab/ui/formatters";

interface ComparisonPanelProps {
  readonly summaries: readonly CompanyQuarterSummary[];
  readonly nameById: ReadonlyMap<string, string>;
}

const EPSILON = 1e-6;

function fulfillmentRate(s: CompanyQuarterSummary): number {
  const fulfilled = unwrapUnit(s.fulfilledQuantity);
  const outstanding = unwrapUnit(s.outstandingQuantity);
  const denom = fulfilled + outstanding;
  return denom > EPSILON ? fulfilled / denom : 0;
}

function rawMaterialSecuredRatio(s: CompanyQuarterSummary): number {
  const secured = unwrapUnit(s.domesticPurchaseQuantity) + unwrapUnit(s.importArrivedQuantity) + unwrapUnit(s.aquacultureHarvestedQuantity);
  const shortfall = unwrapUnit(s.rawMaterialShortfall);
  const denom = secured + shortfall;
  return denom > EPSILON ? secured / denom : 0;
}

export default function ComparisonPanel(props: ComparisonPanelProps) {
  const { summaries, nameById } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-gray-100">全社比較</h3>
        <span className="text-[11px] bg-amber-900/60 border border-amber-600/50 text-amber-200 rounded-full px-2 py-0.5">
          GM専用 — 実際のプレイヤーは他社の非公開計画・結果を見られません
        </span>
      </div>
      <p className="text-xs text-gray-500">財務三表は未実装のため、財務指標（利益・キャッシュ等）はここに表示していません。</p>

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="pr-3 py-1">会社</th>
              <th className="pr-3 py-1">新規成約量</th>
              <th className="pr-3 py-1">履行率</th>
              <th className="pr-3 py-1">納期超過量</th>
              <th className="pr-3 py-1">原料確保率</th>
              <th className="pr-3 py-1">HOSO生産</th>
              <th className="pr-3 py-1">PD生産</th>
              <th className="pr-3 py-1">VAP生産</th>
              <th className="pr-3 py-1">未履行残高</th>
              <th className="pr-3 py-1">原料在庫</th>
              <th className="pr-3 py-1">完成品在庫</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.companyId} className="border-t border-gray-700/60">
                <td className="pr-3 py-1 font-semibold text-gray-100">
                  {s.companyId}（{nameById.get(s.companyId) ?? s.companyId}）
                </td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.newContractedQuantity)}</td>
                <td className="pr-3 py-1">{formatRatioAsPercent(fulfillmentRate(s))}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.overdueQuantity)}</td>
                <td className="pr-3 py-1">{formatRatioAsPercent(rawMaterialSecuredRatio(s))}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.hosoProduced)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.pdProduced)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.vapProduced)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.outstandingQuantity)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.rawMaterialInventory)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(s.finishedGoodsInventory)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
