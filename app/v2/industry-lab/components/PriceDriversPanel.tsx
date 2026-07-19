// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 価格変動理由パネル
//
// 市場モジュールが返す理由コード（MarketPriceDriver）と数値内訳
// （前期比・需給圧力・コスト圧力・加工能力稼働率）を表示する（実装指示 §7）。
// 理由コードのラベルは静的な日本語マップ（labels.ts）のみを使い、生成AIは
// 使わない。

import { COUNTRY_IDS } from "../../../lib/v2/market/types";
import { IndustryQuarterRecord, marketPriceDriverLabel, formatSignedPercent, formatRatioAsPercent } from "../../../lib/v2/industryLab";
import { COUNTRY_NAMES } from "./chartColors";

interface PriceDriversPanelProps {
  readonly quarter: IndustryQuarterRecord | undefined;
}

export default function PriceDriversPanel({ quarter }: PriceDriversPanelProps) {
  if (!quarter) {
    return (
      <div className="bg-gray-800 rounded-2xl p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-gray-200 mb-2">価格変動理由</h3>
        <p className="text-sm text-gray-500">シミュレーションを開始してください。</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-200">価格変動理由（国際HOSO価格）</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm text-left border-collapse min-w-[640px]">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="py-1.5 pr-3">国</th>
              <th className="py-1.5 pr-3">前期比</th>
              <th className="py-1.5 pr-3">国別需給圧力</th>
              <th className="py-1.5 pr-3">世界需給圧力</th>
              <th className="py-1.5 pr-3">稼働率</th>
              <th className="py-1.5 pr-3">主な理由コード</th>
            </tr>
          </thead>
          <tbody>
            {COUNTRY_IDS.map((c) => {
              const p = quarter.marketResult.hosoPrices[c];
              return (
                <tr key={c} className="border-b border-gray-700/50">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{COUNTRY_NAMES[c]}</td>
                  <td className="py-1.5 pr-3">{formatSignedPercent(p.changeRatio)}</td>
                  <td className="py-1.5 pr-3">{p.localPressure.toFixed(3)}</td>
                  <td className="py-1.5 pr-3">{p.worldPressure.toFixed(3)}</td>
                  <td className="py-1.5 pr-3">{formatRatioAsPercent(p.utilizationRatio)}</td>
                  <td className="py-1.5 pr-3">
                    {p.drivers.length === 0 ? "—" : p.drivers.map((d) => marketPriceDriverLabel(d)).join("、")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-gray-900/50 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">ベトナム国内原料市場</div>
          <div className="text-sm text-gray-200">
            需給不均衡: {formatSignedPercent(quarter.marketResult.vietnamDomestic.imbalance)}　最低買付ルール:{" "}
            {quarter.marketResult.vietnamDomestic.minimumOfftakeApplied ? "発動" : "未発動"}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            理由コード:{" "}
            {quarter.marketResult.vietnamDomestic.drivers.length === 0
              ? "—"
              : quarter.marketResult.vietnamDomestic.drivers.map((d) => marketPriceDriverLabel(d)).join("、")}
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">PD/VAP加工能力稼働率</div>
          <div className="text-sm text-gray-200">
            PD: {formatRatioAsPercent(quarter.marketResult.pdPremium.globalUtilization)}　VAP:{" "}
            {formatRatioAsPercent(quarter.marketResult.vapPremium.globalUtilization)}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            理由コード:{" "}
            {[...quarter.marketResult.pdPremium.drivers, ...quarter.marketResult.vapPremium.drivers]
              .map((d) => marketPriceDriverLabel(d))
              .join("、") || "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
