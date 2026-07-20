// ShrimpX V2 — 会社経営統合テスト環境 品質ダッシュボード（Phase 7B） 3. 5社比較（GM専用）
//
// dashboardViewModel.buildCompanyComparisonRowsが集計した値を並べるだけ。
// 実プレイヤーは他社の結果を見られないため、既存のComparisonPanel（全社比較）と
// 同様にGM専用として呼び出し側でゲートする。

"use client";

import { useState } from "react";
import { CompanyComparisonRow, MarketFilter, ProductFilter, PRODUCTS } from "../dashboardViewModel";
import { formatHosoEqTons, formatRatioAsPercent, formatScore } from "../../../lib/v2/industryLab/ui/formatters";
import { DEMAND_MARKET_IDS } from "../../../lib/v2/market/types";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";

interface QualityCompanyComparisonProps {
  readonly buildRows: (productFilter: ProductFilter, marketFilter: MarketFilter) => readonly CompanyComparisonRow[];
}

const PRODUCT_LABELS: Record<string, string> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

export default function QualityCompanyComparison(props: QualityCompanyComparisonProps) {
  const { buildRows } = props;
  const [productFilter, setProductFilter] = useState<ProductFilter>("all");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");

  const rows = buildRows(productFilter, marketFilter);

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-gray-100">5社比較（品質・信頼・納期）</h3>
        <span className="text-[11px] bg-amber-900/60 border border-amber-600/50 text-amber-200 rounded-full px-2 py-0.5">
          GM専用 — 実際のプレイヤーは他社の結果を見られません
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-gray-400">
          商品:
          <select value={productFilter} onChange={(e) => setProductFilter(e.target.value as ProductFilter)} className="bg-gray-700 rounded px-2 py-1 text-gray-100">
            <option value="all">全商品平均</option>
            {PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {PRODUCT_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          市場:
          <select value={marketFilter} onChange={(e) => setMarketFilter(e.target.value as MarketFilter)} className="bg-gray-700 rounded px-2 py-1 text-gray-100">
            <option value="all">全市場平均</option>
            {DEMAND_MARKET_IDS.map((m) => (
              <option key={m} value={m}>
                {DEMAND_MARKET_NAMES[m]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-gray-300">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="pr-3 py-1">会社</th>
              <th className="pr-3 py-1">生産量</th>
              <th className="pr-3 py-1">品質スコア</th>
              <th className="pr-3 py-1">操業リスク</th>
              <th className="pr-3 py-1">廃棄量</th>
              <th className="pr-3 py-1">納期遵守率</th>
              <th className="pr-3 py-1">顧客信頼</th>
              <th className="pr-3 py-1">納期信頼性</th>
              <th className="pr-3 py-1">重大品質事故</th>
              <th className="pr-3 py-1">成約量</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.companyId} className="border-t border-gray-700/60">
                <td className="pr-3 py-1 font-semibold text-gray-100">
                  {r.companyId}（{r.displayName}）
                </td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.saleableProductionQuantity)}</td>
                <td className="pr-3 py-1">{r.qualityScore !== undefined ? formatScore(r.qualityScore) : "—"}</td>
                <td className="pr-3 py-1">{r.operationalRisk !== undefined ? formatRatioAsPercent(r.operationalRisk) : "—"}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.discardQuantity)}</td>
                <td className="pr-3 py-1">{r.onTimeDeliveryRate !== undefined ? formatScore(r.onTimeDeliveryRate) : "対象なし"}</td>
                <td className="pr-3 py-1">{r.customerTrustScore !== undefined ? formatScore(r.customerTrustScore) : "—"}</td>
                <td className="pr-3 py-1">{r.deliveryReliabilityScore !== undefined ? formatScore(r.deliveryReliabilityScore) : "—"}</td>
                <td className="pr-3 py-1">{r.majorIncidentCount > 0 ? <span className="text-red-300 font-semibold">{r.majorIncidentCount}件</span> : "なし"}</td>
                <td className="pr-3 py-1">{formatHosoEqTons(r.newContractedQuantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
