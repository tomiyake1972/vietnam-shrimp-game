// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） B. 商品別品質
//
// dashboardViewModel.buildProductQualityRowsが既に集計した値を表示するだけ。
// 格落ち・再加工・廃棄を別列に分け、廃棄だけが数量損失であることを明示する。

import { ProductQualityRow } from "../dashboardViewModel";
import { formatHosoEqTons, formatRatioAsPercent, formatScore } from "../../../lib/v2/industryLab/ui/formatters";

interface QualityProductTableProps {
  readonly rows: readonly ProductQualityRow[];
}

const PRODUCT_LABELS: Record<string, string> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

export default function QualityProductTable(props: QualityProductTableProps) {
  const { rows } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <h3 className="text-base font-semibold text-gray-100">商品別品質</h3>
      <p className="text-[11px] text-gray-500">
        格落ち・再加工は完成品数量に含まれたまま（記録用の内訳）。廃棄だけが販売可能完成品数量を減らす真の数量損失です。
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="pr-3 py-1">商品</th>
              <th className="pr-3 py-1">品質スコア</th>
              <th className="pr-3 py-1">操業リスク</th>
              <th className="pr-3 py-1">生産量</th>
              <th className="pr-3 py-1">格落ち量</th>
              <th className="pr-3 py-1">再加工量</th>
              <th className="pr-3 py-1">廃棄量</th>
              <th className="pr-3 py-1">販売可能回収率</th>
              <th className="pr-3 py-1">重大品質事故</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product} className="border-t border-gray-700/60">
                <td className="pr-3 py-1 font-semibold text-gray-100">{PRODUCT_LABELS[r.product] ?? r.product}</td>
                <td className="pr-3 py-1">{r.qualityScore !== undefined ? formatScore(r.qualityScore) : "—"}</td>
                <td className="pr-3 py-1">{r.hasProduction && r.operationalRisk !== undefined ? formatRatioAsPercent(r.operationalRisk) : r.hasProduction ? "—" : "生産なし"}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.originalProductionQuantity)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.downgradeQuantity)}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.reworkQuantity)}</td>
                <td className={`pr-3 py-1 ${r.discardQuantity > 0 ? "text-red-300" : ""}`}>{formatHosoEqTons(r.discardQuantity)}</td>
                <td className="pr-3 py-1">{r.saleableRecoveryRatio !== undefined ? formatRatioAsPercent(r.saleableRecoveryRatio) : "生産なし"}</td>
                <td className="pr-3 py-1">
                  {!r.hasProduction ? "—" : r.hasMajorIncident ? <span className="text-red-300 font-semibold">あり（{r.majorIncidentCount}件）</span> : "なし"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
