// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） C. 市場別信頼
//
// dashboardViewModel.buildMarketTrustRowsが既に抽出・前期比較した値を表示するだけ。
// 市場名はindustry-labの既存定義（DEMAND_MARKET_NAMES）をそのまま使い、UI内で
// 別定義を作らない。

import { MarketTrustRow, TrendDirection } from "../dashboardViewModel";
import { formatScore } from "../../../lib/v2/industryLab/ui/formatters";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";

interface QualityMarketTrustTableProps {
  readonly rows: readonly MarketTrustRow[];
}

const TREND_LABEL: Record<TrendDirection, string> = { improved: "改善", worsened: "悪化", flat: "横ばい", unknown: "—" };
const TREND_STYLE: Record<TrendDirection, string> = {
  improved: "text-teal-300",
  worsened: "text-red-300",
  flat: "text-gray-400",
  unknown: "text-gray-500",
};

function DeltaCell(props: { readonly score?: number; readonly delta?: number; readonly trend: TrendDirection }) {
  const { score, delta, trend } = props;
  return (
    <td className="pr-3 py-1">
      <div>{score !== undefined ? formatScore(score) : "—"}</div>
      <div className={`text-[10px] ${TREND_STYLE[trend]}`}>
        {TREND_LABEL[trend]}
        {delta !== undefined ? `（${delta > 0 ? "+" : ""}${delta.toFixed(1)}）` : ""}
      </div>
    </td>
  );
}

export default function QualityMarketTrustTable(props: QualityMarketTrustTableProps) {
  const { rows } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <h3 className="text-base font-semibold text-gray-100">市場別信頼</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="pr-3 py-1">市場</th>
              <th className="pr-3 py-1">顧客信頼（前期比）</th>
              <th className="pr-3 py-1">納期信頼性（前期比）</th>
              <th className="pr-3 py-1">当期の納期遵守率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.market} className="border-t border-gray-700/60">
                <td className="pr-3 py-1 font-semibold text-gray-100">{DEMAND_MARKET_NAMES[r.market]}（{r.market}）</td>
                <DeltaCell score={r.customerTrustScore} delta={r.customerTrustDelta} trend={r.customerTrustTrend} />
                <DeltaCell score={r.deliveryReliabilityScore} delta={r.deliveryReliabilityDelta} trend={r.deliveryReliabilityTrend} />
                <td className="pr-3 py-1">{r.onTimeDeliveryRateThisPeriod !== undefined ? formatScore(r.onTimeDeliveryRateThisPeriod) : "対象なし"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
