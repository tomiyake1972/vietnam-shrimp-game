// ShrimpX V2 — 会社経営統合テスト環境 市場レベル結果表示パネル
// （Phase 6.2で新規作成。Phase 8C-3Dで一覧表化・前四半期比表示を追加）
//
// 当四半期のMarketQuarterResult（全社共通・公開情報）を表示するだけの純粋な
// 表示コンポーネント。個社の非公開計画は一切扱わない。価格の抽出・前期比の
// 算出は marketPriceViewModel.ts（表示用データ層）に集約しており、そこがさらに
// 既存エンジン関数（market/destinationPricing.ts）を呼ぶだけの構造にしている。
// このファイル自身は数値を一切計算しない（表示とフォーマットのみ）。
//
// 【改善要望への対応】
//   ① 各消費国（仕向市場 CN/US/EU/JP/OTHER）の商品別価格を、バラバラのボックスではなく
//      1つの表にまとめる。従来ボックスで出していた産地国（EC/IN/ID/VN）のFOB価格も
//      別表として一覧化し、PD・VAPまで含めて表示する（従来はHOSOのみだった）。
//   ② すべての価格に前四半期比を添える。前四半期のデータが取れない項目は
//      0で埋めず「-」と表示する。

import { COUNTRY_NAMES, DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";
import { MarketQuarterResult } from "../../../lib/v2/market/types";
import { CompanyReasonEntry } from "../../../lib/v2/companyLab";
import { ConsumerMarketQuarterRecord, MarketPhase } from "../../../lib/v2/market/consumerInventory";
import {
  formatHosoEqTons,
  formatIndex,
  formatRatioAsPercent,
  formatSignedPercent,
  formatSupplyDemandBalance,
  formatUsdPerHosoEqKg,
} from "../../../lib/v2/industryLab/ui/formatters";
import {
  MARKET_PANEL_PRODUCTS,
  MarketIndicatorRow,
  PRODUCT_LABELS,
  PriceWithQoq,
  buildDestinationMarketPriceRows,
  buildDestinationPriceExplanation,
  buildMarketIndicatorRows,
  buildOriginCountryPriceRows,
} from "../marketPriceViewModel";

interface MarketPanelProps {
  readonly marketResult: MarketQuarterResult;
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
  /**
   * 前四半期の確定市場結果。前四半期比の算出に使う。存在しない（初回四半期・取得失敗）
   * 場合はnull/undefinedのままで良く、その場合は前期比を「-」と表示する（捏造しない）。
   */
  readonly previousMarketResult?: MarketQuarterResult | null;
  /** 前四半期の期表示（"2015Q1"等）。見出しの注記に出すだけで、計算には使わない。 */
  readonly previousPeriodLabel?: string | null;
  /**
   * 【Phase 8F-1】当期の消費国別・在庫循環（消費／在庫／購買）確定結果。全社共通・公開情報。
   * Phase 8F-1導入前の古い保存データにはこの項目が無いため、undefinedの場合は
   * この節自体を表示しない（0で埋めない・捏造しない）。
   */
  readonly consumerMarketRecords?: readonly ConsumerMarketQuarterRecord[];
}

interface StockStatusDisplay {
  readonly label: string;
  readonly style: string;
}

/**
 * 【プレイヤー向け「在庫状況」4段階表示】
 * 既存のmarketPhase判定（tight/restocking/balanced/destocking。
 * market/consumerInventory.tsのclassifyMarketPhaseが、在庫月数・目標在庫月数・
 * 購買圧力指数から算出済み）を、そのまま日本語ラベルへ1:1で変換しただけであり、
 * 新しい閾値や需給判定ロジックをこの表示層に追加したものではない
 * （表示専用のラベル付け替え。計算結果には一切影響しない）。
 *
 * 対応関係と、既存ロジックとの整合性:
 *   tight       → 逼迫     … 既に「在庫月数が目標在庫月数×しきい値比率を下回る」という
 *                            最も厳格な条件で判定済みの状態。そのまま「逼迫」とする。
 *   restocking  → やや不足 … 購買圧力指数がプラスのしきい値を超えている状態
 *                            （消費に対して多めに買いたい＝在庫を積み増したい）。
 *   balanced    → 安心圏   … 購買圧力指数がしきい値の範囲内（プラスにもマイナスにも
 *                            大きく振れていない）状態。
 *   destocking  → 在庫過多 … 購買圧力指数がマイナスのしきい値を下回っている状態
 *                            （消費に対して買い控えたい＝在庫が余っている）。
 * 4値はclassifyMarketPhaseの分岐と完全に1対1で対応するため、変換の矛盾は生じない。
 */
const STOCK_STATUS_BY_PHASE: Record<MarketPhase, StockStatusDisplay> = {
  tight: { label: "逼迫", style: "bg-rose-950/60 border border-rose-700/50 text-rose-200" },
  restocking: { label: "やや不足", style: "bg-amber-950/60 border border-amber-700/50 text-amber-200" },
  balanced: { label: "安心圏", style: "bg-emerald-950/60 border border-emerald-700/50 text-emerald-200" },
  destocking: { label: "在庫過多", style: "bg-sky-950/60 border border-sky-700/50 text-sky-200" },
};

/** 在庫月数（ヶ月）の表示。既存formattersに月数専用の関数が無いため、この表示用途に限定してここで整形する。 */
function formatCoverageMonths(months: number): string {
  return `${months.toFixed(1)}ヶ月`;
}

/** 前期比が僅少（±0.05%未満）なら「横ばい」扱いにして、符号のちらつきを見せない。 */
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

function ProductHeaderCells() {
  return (
    <>
      {MARKET_PANEL_PRODUCTS.map((p) => (
        <th key={p} className="pr-3 py-1 font-medium">
          {PRODUCT_LABELS[p]}
        </th>
      ))}
    </>
  );
}

/**
 * 「現在の在庫水準」「市場の安心在庫水準」「在庫状況」を1つのセルにまとめて表示する。
 * 既存のPriceCell（価格＋前期比の2行スタック）と同じ「主要な値＋補足の小さな行」の
 * 構成をそのまま踏襲し、新しい表現パターンを増やさない。
 */
function StockStatusCell(props: { readonly record: ConsumerMarketQuarterRecord }) {
  const { record } = props;
  const status = STOCK_STATUS_BY_PHASE[record.marketPhase];
  return (
    <td className="pr-3 py-1.5 whitespace-nowrap align-top">
      <div className="text-gray-100">現在 {formatCoverageMonths(record.inventoryCoverageMonths)}</div>
      <div
        className="text-[10px] text-gray-500"
        title="市場の安心在庫水準は、輸入業者や流通業者が供給途絶や需要変動に不安を感じずに取引できる在庫水準の目安です。"
      >
        安心水準 {formatCoverageMonths(record.targetCoverageMonths)}
      </div>
      <div className="mt-1">
        <span className={`text-[10px] rounded-full px-2 py-0.5 ${status.style}`}>在庫状況：{status.label}</span>
      </div>
    </td>
  );
}

function IndicatorValueCell(props: { readonly row: MarketIndicatorRow; readonly which: "value" | "priorValue" }) {
  const { row, which } = props;
  const raw = which === "value" ? row.value : row.priorValue;
  if (raw === null) return <td className="pr-3 py-1.5 text-gray-500">-</td>;
  return (
    <td className="pr-3 py-1.5 text-gray-100 whitespace-nowrap">
      {row.kind === "price" ? formatUsdPerHosoEqKg(raw) : formatSupplyDemandBalance(raw)}
    </td>
  );
}

function IndicatorChangeCell(props: { readonly row: MarketIndicatorRow }) {
  const { row } = props;
  if (row.kind === "price") {
    return <td className={`pr-3 py-1.5 whitespace-nowrap ${changeStyle(row.changeRatio)}`}>{changeLabel(row.changeRatio)}</td>;
  }
  // 比率項目（世界需給バランス）は「比の比」ではなく前期差（pt）で見る。
  if (row.difference === null) return <td className="pr-3 py-1.5 text-gray-500">-</td>;
  const flat = Math.abs(row.difference) < FLAT_THRESHOLD;
  const style = flat ? "text-gray-400" : row.difference > 0 ? "text-teal-300" : "text-rose-300";
  return (
    <td className={`pr-3 py-1.5 whitespace-nowrap ${style}`}>
      {flat ? "横ばい" : `${row.difference > 0 ? "▲" : "▼"}${formatRatioAsPercent(Math.abs(row.difference))}pt`}
    </td>
  );
}

export default function MarketPanel(props: MarketPanelProps) {
  const { marketResult, globalReasonCodes, previousMarketResult = null, previousPeriodLabel = null, consumerMarketRecords } = props;

  const destinationRows = buildDestinationMarketPriceRows(marketResult, previousMarketResult);
  const originRows = buildOriginCountryPriceRows(marketResult, previousMarketResult);
  const indicatorRows = buildMarketIndicatorRows(marketResult, previousMarketResult);
  const explanation = buildDestinationPriceExplanation(marketResult);
  const hasPreviousQuarter = previousMarketResult !== null;

  return (
    <div className="bg-gray-800 rounded-2xl p-4 sm:p-5 space-y-5" data-testid="market-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-gray-100">市場情報（全社共通・公開）</h3>
        <span className="text-[11px] text-gray-400">
          当期 {String(marketResult.period)}
          {hasPreviousQuarter ? `　／　前四半期 ${previousPeriodLabel ?? "（期表示なし）"}` : "　／　前四半期の確定データなし"}
        </span>
      </div>

      {/* ① 各消費国（仕向市場）の商品別価格一覧 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 className="text-sm font-semibold text-gray-200">消費国（仕向市場）別・商品別 参照価格</h4>
          <span className="text-[11px] text-gray-500">単位：USD／HOSO換算kg</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1 font-medium">消費国（仕向市場）</th>
                <ProductHeaderCells />
              </tr>
            </thead>
            <tbody>
              {destinationRows.map((r) => (
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
        <p className="text-[10px] text-gray-500 leading-relaxed">
          消費国ごとの差は、ベトナム基準価格を「HOSO基礎価値 {formatUsdPerHosoEqKg(explanation.hosoBasePrice)}／PD加工プレミアム{" "}
          {formatUsdPerHosoEqKg(explanation.pdProcessingPremium)}／VAP追加プレミアム {formatUsdPerHosoEqKg(explanation.vapIncrementalPremium)}」に分解し、
          市場ごとの評価係数を各部分にかけて算出しています（PD加工プレミアムはPD・VAPの両方に、VAP追加プレミアムはVAPにのみ含まれます）。
        </p>
      </div>

      {/* 産地国別（従来のHOSO FOBボックス群の一覧化。PD・VAPまで拡張） */}
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
                <ProductHeaderCells />
              </tr>
            </thead>
            <tbody>
              {originRows.map((r) => (
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

      {/* 基礎指標（国内原料価格・世界基準プレミアム・世界需給バランス） */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-200">基礎指標</h4>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1 font-medium">項目</th>
                <th className="pr-3 py-1 font-medium">当期</th>
                <th className="pr-3 py-1 font-medium">前四半期</th>
                <th className="pr-3 py-1 font-medium">前期比</th>
              </tr>
            </thead>
            <tbody>
              {indicatorRows.map((row) => (
                <tr key={row.key} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">{row.label}</td>
                  <IndicatorValueCell row={row} which="value" />
                  <IndicatorValueCell row={row} which="priorValue" />
                  <IndicatorChangeCell row={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 【Phase 8F-1】消費国別・在庫循環（消費／在庫／購買）。古い保存データにはconsumerMarketRecordsが
          無いため、その場合はこの節自体を表示しない（0で埋めない・捏造しない）。 */}
      {consumerMarketRecords && consumerMarketRecords.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h4 className="text-sm font-semibold text-gray-200">消費国別・在庫循環（消費・在庫・購買）</h4>
            <span className="text-[11px] text-gray-500">単位：トン（HOSO換算）／在庫状況欄の月数はヶ月</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="pr-3 py-1 font-medium">消費国（仕向市場）</th>
                  <th className="pr-3 py-1 font-medium">期首在庫量</th>
                  <th className="pr-3 py-1 font-medium">実消費</th>
                  <th className="pr-3 py-1 font-medium">希望購買</th>
                  <th className="pr-3 py-1 font-medium">実購買</th>
                  <th className="pr-3 py-1 font-medium">期末在庫量</th>
                  <th className="pr-3 py-1 font-medium">在庫状況</th>
                  <th className="pr-3 py-1 font-medium">購買圧力指数</th>
                </tr>
              </thead>
              <tbody>
                {consumerMarketRecords.map((r) => (
                  <tr key={r.market} className="border-t border-gray-700/60">
                    <td className="pr-3 py-1.5 font-semibold text-gray-100 whitespace-nowrap">
                      {DEMAND_MARKET_NAMES[r.market]}（{r.market}）
                    </td>
                    <td className="pr-3 py-1.5 whitespace-nowrap">{formatHosoEqTons(r.openingInventoryTons)}</td>
                    <td className="pr-3 py-1.5 whitespace-nowrap">{formatHosoEqTons(r.realizedConsumptionTons)}</td>
                    <td className="pr-3 py-1.5 whitespace-nowrap">{formatHosoEqTons(r.desiredPurchaseTons)}</td>
                    <td className="pr-3 py-1.5 whitespace-nowrap">{formatHosoEqTons(r.actualPurchaseTons)}</td>
                    <td className="pr-3 py-1.5 whitespace-nowrap align-top">
                      <div>{formatHosoEqTons(r.endingInventoryTons)}</div>
                      <div className="text-[10px] text-gray-500">安心水準に必要な在庫量 {formatHosoEqTons(r.targetInventoryTons)}</div>
                    </td>
                    <StockStatusCell record={r} />
                    <td className="pr-3 py-1.5 whitespace-nowrap">{formatIndex(r.purchasePressureIndex)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">
            「希望購買」は在庫・消費から見て市場が購入したい量、「実購買」は世界全体の需給調整後に実際に確保できた量です
            （実購買が希望購買を下回る場合、供給不足が起きています）。「市場の安心在庫水準」は、輸入業者や流通業者が
            供給途絶や需要変動に不安を感じずに取引できる在庫水準の目安です。「在庫状況」は、現在の在庫水準と
            この安心水準との関係を4段階（逼迫／やや不足／安心圏／在庫過多）で示したものです。「購買圧力指数」は
            正の値ほど積み増し（購買増）圧力、負の値ほど取り崩し圧力が強いことを示し、翌四半期の消費国別価格に
            反映されます。
          </p>
        </div>
      )}

      {globalReasonCodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {globalReasonCodes.map((r, idx) => (
            <span
              key={`${r.code}-${idx}`}
              className="text-[11px] bg-indigo-950/60 border border-indigo-700/50 text-indigo-200 rounded-full px-2 py-0.5"
            >
              {r.message}
            </span>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-500 leading-relaxed">
        前期比の「▲／▼」は価格の上昇・下落の向きだけを示します（良し悪しの判定ではありません。例：国内原料価格の上昇はコスト増）。
        {hasPreviousQuarter
          ? "前期比は前四半期の確定市場結果と比較して算出しています。"
          : "前四半期の確定市場結果がまだ無いため、確定履歴に保存されている前期HOSO価格が使える項目だけ前期比を表示し、その他は0で埋めず「-」と表示しています。"}
      </p>
    </div>
  );
}
