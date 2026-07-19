// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 市場レベル結果表示パネル
//
// 当四半期のMarketQuarterResult（全社共通・公開情報）を表示するだけの純粋な
// 表示コンポーネント。個社の非公開計画は一切扱わない。

import { COUNTRY_IDS } from "../../../lib/v2/market/types";
import { MarketQuarterResult } from "../../../lib/v2/market/types";
import { CompanyReasonEntry } from "../../../lib/v2/companyLab";
import { formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";

interface MarketPanelProps {
  readonly marketResult: MarketQuarterResult;
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
}

export default function MarketPanel(props: MarketPanelProps) {
  const { marketResult, globalReasonCodes } = props;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-3">
      <h3 className="text-base font-semibold text-gray-100">市場情報（全社共通・公開）</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-[11px] text-gray-500">ベトナム国内原料価格</div>
          <div className="text-gray-100">{formatUsdPerHosoEqKg(marketResult.vietnamDomestic.price)}</div>
        </div>
        {COUNTRY_IDS.map((c) => (
          <div key={c} className="bg-gray-900/50 rounded-lg px-3 py-2">
            <div className="text-[11px] text-gray-500">HOSO FOB（{c}）</div>
            <div className="text-gray-100">{formatUsdPerHosoEqKg(marketResult.hosoPrices[c].price)}</div>
          </div>
        ))}
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-[11px] text-gray-500">PDプレミアム</div>
          <div className="text-gray-100">{formatUsdPerHosoEqKg(marketResult.pdPremium.basePremium)}</div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-[11px] text-gray-500">VAPプレミアム</div>
          <div className="text-gray-100">{formatUsdPerHosoEqKg(marketResult.vapPremium.basePremium)}</div>
        </div>
      </div>

      {globalReasonCodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {globalReasonCodes.map((r, idx) => (
            <span key={`${r.code}-${idx}`} className="text-[11px] bg-indigo-950/60 border border-indigo-700/50 text-indigo-200 rounded-full px-2 py-0.5">
              {r.message}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
