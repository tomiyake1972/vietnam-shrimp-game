// ShrimpX V2 — 「AIが見ている市場情報」パネル
// (test/sai6-manual-observation-2026-08-01: 三宅さんの3回目の手動観察テストで
//  「市場レベルの価格・需要・需要トレンド（伸びている市場／縮んでいる市場が分かれば
//  よい）が画面のどこにも出ていない。基本的にStandard AIが判断に使っている情報を
//  すべて出してほしい」という指摘を受けた)
//
// 【本パネルが表示する値の出どころ（捏造禁止の徹底）】
// Standard AIの意思決定関数（standardAi/policy.tsのgenerateStandardAiDecision）が
// 実際に受け取る入力は fixture・ownState・publicInfo（PublicMarketInfo）・period・turn
// の5つだけ（同ファイル冒頭コメント参照）。本パネルはこのうち publicInfo を
// そのまま表示するだけで、新しい市場データ・新しい計算式は一切導入しない。
//   - 価格（消費国別・産地国別・基礎指標）: publicInfo.lastMarketResult を
//     marketPriceViewModel.ts の既存関数（buildDestinationMarketPriceRows等。
//     「直近の四半期結果」パネルのMarketPanelと同じ関数）にそのまま渡す。
//   - turn1（lastMarketResultがundefined）: AI自身も参照できる市場実績が
//     まだ無いという事実をそのまま伝える。0や推定値で埋めない。
//   - 需要トレンド（伸びている／縮んでいる市場）: publicInfo.productLifecycleOutlook
//     （config.sai5.productLifecycle有効時のみ設定される公開情報）を
//     aiMarketInfoSummary.ts で定性ラベルへ変換する。市場全体の需要量そのもの
//     （絶対トン数）はAIの入力に含まれていないため、ここでは構成比の伸縮という
//     「相対的な」トレンドのみを示す（絶対量を推定して表示しない）。
//   - 供給圧力（供給過剰／供給不足）: publicInfo.productSupplyPressureOutlook
//     （config.sai5有効時のみ）をそのまま定性ラベルへ変換する。
//   - SAI-5系の項目が両方ともundefined（機能OFF）の場合は、その旨を明示し、
//     空欄や中立値で埋めない。

import {
  MARKET_PANEL_PRODUCTS,
  PRODUCT_LABELS,
  PriceWithQoq,
  buildDestinationMarketPriceRows,
  buildMarketIndicatorRows,
  buildOriginCountryPriceRows,
} from "../marketPriceViewModel";
import { COUNTRY_NAMES, DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";
import { PublicMarketInfo } from "../../../lib/v2/companyLab/types";
import { MarketQuarterResult } from "../../../lib/v2/market/types";
import { formatRatioAsPercent, formatSignedPercent, formatSupplyDemandBalance, formatUsdPerHosoEqKg } from "../../../lib/v2/industryLab/ui/formatters";
import {
  LIFECYCLE_TREND_THRESHOLD,
  LifecycleTrendLabel,
  SupplyPressureLabel,
  buildLifecycleTrendRows,
  buildSupplyPressureRows,
} from "../../../lib/v2/companyLab/aiMarketInfoSummary";

export interface AiMarketInfoPanelProps {
  readonly publicInfo: PublicMarketInfo;
  /** publicInfo.lastMarketResultの、さらに1期前の確定市場結果（前期比の分母）。無ければnull。 */
  readonly previousMarketResult: MarketQuarterResult | null;
  readonly previousPeriodLabel: string | null;
}

/** 前期比が僅少（±0.05%未満）なら「横ばい」扱いにする（MarketPanel.tsxのFLAT_THRESHOLDと同じ考え方）。 */
const FLAT_THRESHOLD = 0.0005;

function changeLabel(changeRatio: number | null): string {
  if (changeRatio === null) return "-";
  if (Math.abs(changeRatio) < FLAT_THRESHOLD) return "横ばい";
  const arrow = changeRatio > 0 ? "▲" : "▼";
  return `${arrow}${formatSignedPercent(changeRatio).replace("+", "")}`;
}

function changeStyle(changeRatio: number | null): string {
  if (changeRatio === null) return "text-gray-500";
  if (Math.abs(changeRatio) < FLAT_THRESHOLD) return "text-gray-400";
  return changeRatio > 0 ? "text-teal-300" : "text-rose-300";
}

function PriceCell(props: { readonly cell: PriceWithQoq }) {
  const { cell } = props;
  return (
    <td className="pr-3 py-1.5 whitespace-nowrap align-top">
      <div className="text-gray-100">{formatUsdPerHosoEqKg(cell.price)}</div>
      <div className={`text-[10px] ${changeStyle(cell.changeRatio)}`}>前期比 {changeLabel(cell.changeRatio)}</div>
    </td>
  );
}

const LIFECYCLE_TREND_DISPLAY: Record<LifecycleTrendLabel, { label: string; style: string }> = {
  growing: { label: "伸びている", style: "text-teal-300" },
  shrinking: { label: "縮んでいる", style: "text-rose-300" },
  flat: { label: "横ばい", style: "text-gray-400" },
};

const SUPPLY_PRESSURE_DISPLAY: Record<SupplyPressureLabel, { label: string; style: string }> = {
  oversupply: { label: "供給過剰気味", style: "text-amber-300" },
  undersupply: { label: "供給不足気味", style: "text-sky-300" },
  balanced: { label: "概ね均衡", style: "text-gray-400" },
};

const PRODUCT_JA_LABEL: Record<string, string> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

/** 構成比の四半期トレンド（-1〜1程度のpt差）を「+0.5pt」のように表示する。 */
function formatTrendPt(trendValue: number): string {
  const pt = trendValue * 100;
  const sign = pt > 0 ? "+" : "";
  return `${sign}${pt.toFixed(2)}pt`;
}

export default function AiMarketInfoPanel({ publicInfo, previousMarketResult, previousPeriodLabel }: AiMarketInfoPanelProps) {
  const { lastMarketResult } = publicInfo;

  return (
    <div className="space-y-5 text-sm" data-testid="ai-market-info-panel">
      <p className="text-xs text-gray-400">
        Standard AIが次の意思決定を作るときに実際に参照している公開市場情報を、そのまま表示しています
        （standardAi/policy.tsのgenerateStandardAiDecisionへ渡される publicInfo と同一のデータです。新しい数値の推定・計算は行っていません）。
      </p>

      {!lastMarketResult ? (
        <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-700/50 rounded-lg px-3 py-2">
          turn 1: AIも参照できる市場実績がまだありません（初回四半期のため、前四半期の確定結果自体が存在しません。
          この状態はAI自身にとっても同じ制約であり、画面側で推定値を作ることはしていません）。
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="text-sm font-semibold text-gray-200">消費国（仕向市場）別・商品別 参照価格（AIが参照する前四半期の確定結果）</h4>
              <span className="text-[11px] text-gray-500">単位：USD／HOSO換算kg</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-gray-300">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-3 py-1 font-medium">消費国（仕向市場）</th>
                    {MARKET_PANEL_PRODUCTS.map((p) => (
                      <th key={p} className="pr-3 py-1 font-medium">
                        {PRODUCT_LABELS[p]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buildDestinationMarketPriceRows(lastMarketResult, previousMarketResult).map((r) => (
                    <tr key={r.market} className="border-t border-gray-700/60">
                      <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">
                        {DEMAND_MARKET_NAMES[r.market]}（{r.market}）
                      </td>
                      <PriceCell cell={r.hoso} />
                      <PriceCell cell={r.pd} />
                      <PriceCell cell={r.vap} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="text-sm font-semibold text-gray-200">産地国別・商品別 FOB価格</h4>
              <span className="text-[11px] text-gray-500">単位：USD／HOSO換算kg（消費国とは別の軸＝どこで獲れたエビか）</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-gray-300">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-3 py-1 font-medium">産地国</th>
                    {MARKET_PANEL_PRODUCTS.map((p) => (
                      <th key={p} className="pr-3 py-1 font-medium">
                        {PRODUCT_LABELS[p]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buildOriginCountryPriceRows(lastMarketResult, previousMarketResult).map((r) => (
                    <tr key={r.country} className="border-t border-gray-700/60">
                      <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">
                        {COUNTRY_NAMES[r.country]}（{r.country}）
                      </td>
                      <PriceCell cell={r.hoso} />
                      <PriceCell cell={r.pd} />
                      <PriceCell cell={r.vap} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-200">基礎指標（世界需給・国内原料価格等）</h4>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-gray-300">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-3 py-1 font-medium">項目</th>
                    <th className="pr-3 py-1 font-medium">当期</th>
                    <th className="pr-3 py-1 font-medium">前期比</th>
                  </tr>
                </thead>
                <tbody>
                  {buildMarketIndicatorRows(lastMarketResult, previousMarketResult).map((row) => (
                    <tr key={row.key} className="border-t border-gray-700/60">
                      <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">{row.label}</td>
                      <td className="pr-3 py-1.5 text-gray-100 whitespace-nowrap">
                        {row.kind === "price" ? formatUsdPerHosoEqKg(row.value) : formatSupplyDemandBalance(row.value)}
                      </td>
                      <td className="pr-3 py-1.5 whitespace-nowrap">
                        {row.kind === "price"
                          ? changeLabel(row.changeRatio)
                          : row.difference === null
                            ? "-"
                            : Math.abs(row.difference) < FLAT_THRESHOLD
                              ? "横ばい"
                              : `${row.difference > 0 ? "▲" : "▼"}${formatRatioAsPercent(Math.abs(row.difference))}pt`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-500">
              当期 {String(lastMarketResult.period)}
              {previousMarketResult ? `　／　前四半期 ${previousPeriodLabel ?? "（期表示なし）"}` : "　／　前四半期の確定データなし"}
            </p>
          </div>
        </>
      )}

      <div className="space-y-2 border-t border-gray-700/60 pt-3">
        <h4 className="text-sm font-semibold text-gray-200">市場×商品別 需要構成トレンド（伸びている／縮んでいる市場）</h4>
        {!publicInfo.productLifecycleOutlook ? (
          <p className="text-[11px] text-gray-500">
            このラボでは商品ライフサイクル機能（config.sai5.productLifecycle）が無効のため、この情報はAI自身も参照していません
            （空欄・中立値で埋めていません）。
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              各市場内でのHOSO／PD／VAPの需要構成比（シェア）が、前四半期にどれだけ変化したか（四半期あたりのポイント差）を
              大まかに「伸びている／縮んでいる／横ばい」の3段階に分類したものです。市場全体の需要量そのもの（絶対トン数）の
              トレンドではなく、あくまで商品間のシェアの変化という相対的な情報です（AIが実際に参照している唯一の需要トレンド情報）。
              閾値は四半期あたり±{formatRatioAsPercent(LIFECYCLE_TREND_THRESHOLD)}pt
              （定常的な緩やかな浸透と、S字カーブの加速期を大まかに分けるための目安であり、精密な閾値ではありません）。
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-gray-300">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-3 py-1 font-medium">消費国（仕向市場）</th>
                    <th className="pr-3 py-1 font-medium">商品</th>
                    <th className="pr-3 py-1 font-medium">四半期トレンド</th>
                    <th className="pr-3 py-1 font-medium">判定</th>
                  </tr>
                </thead>
                <tbody>
                  {buildLifecycleTrendRows(publicInfo.productLifecycleOutlook).map((r) => {
                    const disp = LIFECYCLE_TREND_DISPLAY[r.label];
                    return (
                      <tr key={`${r.market}-${r.product}`} className="border-t border-gray-700/60">
                        <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">
                          {DEMAND_MARKET_NAMES[r.market]}（{r.market}）
                        </td>
                        <td className="pr-3 py-1.5 whitespace-nowrap">{PRODUCT_JA_LABEL[r.product] ?? r.product}</td>
                        <td className="pr-3 py-1.5 whitespace-nowrap">{formatTrendPt(r.trendValue)}</td>
                        <td className={`pr-3 py-1.5 whitespace-nowrap font-medium ${disp.style}`}>{disp.label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="space-y-2 border-t border-gray-700/60 pt-3">
        <h4 className="text-sm font-semibold text-gray-200">商品別 供給圧力（供給過剰／供給不足の持続傾向）</h4>
        {!publicInfo.productSupplyPressureOutlook ? (
          <p className="text-[11px] text-gray-500">
            このラボでは供給圧力の公開統計（config.sai5、5社提示量÷対象需要のEWMA）が無効のため、この情報はAI自身も参照していません
            （空欄・中立値で埋めていません）。
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500">
              1.0が需給均衡、1.0より大きいほど供給過剰が持続していることを示す業界全体の統計です（個社の非公開計画は含みません）。
              ±10%（0.9〜1.1）を「概ね均衡」の目安の帯としています（精密な閾値ではなく、通常の四半期変動と持続的な偏りを大まかに
              分けるための目安です）。
            </p>
            <div className="flex flex-wrap gap-3">
              {buildSupplyPressureRows(publicInfo.productSupplyPressureOutlook).map((r) => {
                const disp = SUPPLY_PRESSURE_DISPLAY[r.label];
                return (
                  <div key={r.product} className="bg-gray-900/60 border border-gray-700/60 rounded-lg px-3 py-2">
                    <div className="text-[11px] text-gray-400">{PRODUCT_JA_LABEL[r.product] ?? r.product}</div>
                    <div className="text-gray-100 font-medium">{r.value.toFixed(2)}倍</div>
                    <div className={`text-[11px] font-medium ${disp.style}`}>{disp.label}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
