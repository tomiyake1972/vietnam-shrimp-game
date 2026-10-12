"use client";

// ShrimpX V2 — Independent Player Flow: Overview / Market / Inventory パネル
//
// 【この層がやること】サーバー（PlayerDecisionContext）が既に組み立てた
// ビューモデルを並べて表示するだけ。計算・集計・推測は一切行わない。
//
// 【この層がやらないこと】
//  - 他社の非公開値を表示しない（そもそもビューモデルに含まれていない）。
//  - 値が無いときに 0 で埋めない。null は「未取得」と出す。
//  - GM 向け MarketSummary（dataset.marketMetrics の trueWorld）を読まない。
//    受講者の市場情報は PublicMarketInfo 由来の遅行公開値だけである。

import LastTurnReviewPanel from "../../company-lab/components/LastTurnReviewPanel";
import type { LastTurnReview } from "../../company-lab/lastTurnReviewViewModel";
import type { PlayerInventoryView, PlayerMarketView } from "../../../lib/v2/player/workspaceViews";
import {
  CROWDING_BAND_LABEL,
  SHARE_BAND_LABEL,
  type CrowdingBand,
  type PublicCompetitorSnapshot,
  type ShareBand,
  type ShareBandTrend,
} from "../../../lib/v2/companyLab/publicCompetitorSnapshot";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

function tons(value: number | null): string {
  return value === null ? "未取得" : `${Math.round(value).toLocaleString()} t`;
}

function percent(value: number | null): string {
  return value === null ? "未取得" : `${(value * 100).toFixed(1)}%`;
}

function millionsUsd(value: number | null): string {
  return value === null ? "未取得" : `$${(value / 1e6).toFixed(2)}M`;
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

export function PlayerOverviewPanel({ review }: { readonly review: LastTurnReview | null }) {
  if (review === null) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="play-overview-empty">
        <h2 className="mb-1 text-sm font-semibold">まだ確定した四半期がありません</h2>
        <p className="text-xs text-slate-400">
          Turn 1 の意思決定を提出し、GMが四半期を進めると、ここに「出した指示とその結果」が出ます。
        </p>
      </section>
    );
  }
  return (
    <div data-testid="play-overview">
      <LastTurnReviewPanel review={review} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------

export function PlayerMarketPanel({ view }: { readonly view: PlayerMarketView }) {
  const markets = [...new Set(view.cells.map((c) => c.market))];
  const cellByKey = new Map(view.cells.map((c) => [`${c.market}|${c.product}`, c]));
  const hasGameStartPrice = view.cells.some((c) => c.basePriceSource === "GAME_START_MARKET_INFORMATION");

  return (
    <div className="space-y-3" data-testid="play-market">
      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">市場の公開情報</h2>
          <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-sky-200" data-testid="play-market-source-badge">
            {view.observedDemandSourceQuarter === null
              ? "開始時の市場情報"
              : `Turn ${view.observedDemandSourceQuarter} の実績（遅行${view.observationLagQuarters ?? "?"}四半期）`}
          </span>
        </div>
        {markets.length === 0 ? (
          <p className="text-xs text-slate-400">公開されている需要情報がまだありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs" data-testid="play-market-table">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400">
                  <th className="py-1 pr-2 text-left">市場</th>
                  {PRODUCTS.map((p) => (
                    <th key={`d-${p}`} className="px-1 py-1 text-right">
                      {p.toUpperCase()} 需要(t)
                    </th>
                  ))}
                  {PRODUCTS.map((p) => (
                    <th key={`p-${p}`} className="px-1 py-1 text-right">
                      {p.toUpperCase()} 基準価格
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m} className="border-b border-slate-800" data-testid={`play-market-row-${m}`}>
                    <td className="py-1 pr-2 font-semibold">{m}</td>
                    {PRODUCTS.map((p) => {
                      const cell = cellByKey.get(`${m}|${p}`);
                      return (
                        <td key={`d-${p}`} className="px-1 py-1 text-right tabular-nums">
                          {cell?.observedDemandTons === null || cell?.observedDemandTons === undefined
                            ? "－"
                            : Math.round(cell.observedDemandTons).toLocaleString()}
                        </td>
                      );
                    })}
                    {PRODUCTS.map((p) => {
                      const cell = cellByKey.get(`${m}|${p}`);
                      return (
                        <td key={`p-${p}`} className="px-1 py-1 text-right tabular-nums">
                          {cell?.basePriceUsdPerKg === null || cell?.basePriceUsdPerKg === undefined ? "－" : cell.basePriceUsdPerKg.toFixed(3)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500" data-testid="play-market-source-note">
          {view.sourceNote}
        </p>
        {hasGameStartPrice ? (
          <p className="mt-1 text-[11px] leading-snug text-slate-500" data-testid="play-market-game-start-note">
            基準価格はゲーム開始時点の市場情報です（まだ前四半期の市場実績がないため）。
          </p>
        ) : null}
        <p className="mt-1 text-[11px] text-slate-500">
          ベトナム国内原料の前期価格: {view.vietnamDomesticPriorPrice.toFixed(3)} USD/kg
        </p>
      </section>

      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <h2 className="mb-1.5 text-sm font-semibold">TSV ランキング（株主価値）</h2>
        <table className="w-full text-xs" data-testid="play-tsv-table">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400">
              <th className="py-1 pr-2 text-left">順位</th>
              <th className="py-1 pr-2 text-left">会社</th>
              <th className="px-1 py-1 text-right">TSV</th>
            </tr>
          </thead>
          <tbody>
            {view.tsvRanking.map((row, index) => (
              <tr
                key={row.companyId}
                className={`border-b border-slate-800 ${row.isOwnCompany ? "bg-slate-800/50" : ""}`}
                data-testid={`play-tsv-row-${row.companyId}`}
              >
                <td className="py-1 pr-2 tabular-nums">{index + 1}</td>
                <td className="py-1 pr-2">
                  {row.displayName}
                  {row.isOwnCompany ? <span className="ml-1 text-[10px] text-sky-300">（自社）</span> : null}
                </td>
                <td className="px-1 py-1 text-right tabular-nums">{millionsUsd(row.totalShareholderValueUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          TSV は暫定的な参考指標です。各社の現金・利益・原価などの内部数値は公開されません。
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------

export function PlayerInventoryPanel({ view }: { readonly view: PlayerInventoryView | null }) {
  if (view === null) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="play-inventory-empty">
        <h2 className="mb-1 text-sm font-semibold">在庫</h2>
        <p className="text-xs text-slate-400">まだ確定した実績がありません。</p>
      </section>
    );
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="play-inventory">
      <h2 className="mb-2 text-sm font-semibold">在庫（直近確定Turn）</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded border border-slate-700 bg-slate-900/40 p-2.5" data-testid="play-inventory-stock-group">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">在庫</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">完成品在庫</dt>
            <dd className="text-right tabular-nums" data-testid="play-inventory-finished-goods">
              {tons(view.finishedGoodsInventoryTons)}
            </dd>
            <dt className="text-slate-400">原料在庫</dt>
            <dd className="text-right tabular-nums" data-testid="play-inventory-raw-material">
              {tons(view.rawMaterialInventoryTons)}
            </dd>
          </dl>
        </div>
        <div className="rounded border border-slate-700 bg-slate-900/40 p-2.5" data-testid="play-inventory-backlog-group">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">受注残</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">未履行残高（backlog）</dt>
            <dd className="text-right tabular-nums" data-testid="play-inventory-backlog">
              {tons(view.backlogTons)}
            </dd>
            <dt className="text-slate-400">納期超過</dt>
            <dd
              className={`text-right tabular-nums ${view.overdueIsSignificant ? "font-semibold text-amber-300" : ""}`}
              data-testid="play-inventory-overdue"
            >
              {tons(view.overdueTons)}
            </dd>
          </dl>
        </div>
        <div className="rounded border border-slate-700 bg-slate-900/40 p-2.5 sm:col-span-2">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">稼働率</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">設備稼働率</dt>
            <dd className="text-right tabular-nums">{percent(view.equipmentUtilizationRate)}</dd>
            <dt className="text-slate-400">労働稼働率</dt>
            <dd className="text-right tabular-nums">{percent(view.laborUtilizationRate)}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// 競合の動き（前四半期の公開情報）
// ---------------------------------------------------------------------

const SHARE_BAND_CHIP: Readonly<Record<ShareBand, string>> = {
  leader: "bg-sky-800 text-sky-100",
  large: "bg-sky-900/70 text-sky-200",
  medium: "bg-slate-700 text-slate-200",
  small: "bg-slate-800 text-slate-400",
  none: "bg-transparent text-slate-600",
};

const SHARE_BAND_DOTS: Readonly<Record<ShareBand, string>> = {
  leader: "●●●●",
  large: "●●●",
  medium: "●●",
  small: "●",
  none: "－",
};

const TREND_MARK: Readonly<Record<ShareBandTrend, string>> = { up: "↑", down: "↓", flat: "→" };

const CROWDING_CHIP: Readonly<Record<CrowdingBand, string>> = {
  loose: "bg-emerald-900/60 text-emerald-200",
  normal: "bg-slate-800 text-slate-300",
  tight: "bg-amber-900/70 text-amber-200",
};

export function PlayerCompetitorPanel({ snapshot }: { readonly snapshot: PublicCompetitorSnapshot }) {
  const markets = [...new Set(snapshot.cells.map((c) => c.market))];
  const cellByKey = new Map(snapshot.cells.map((c) => [`${c.market}|${c.product}`, c]));

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="play-competitor">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">競合の動き</h2>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300" data-testid="play-competitor-source">
          {snapshot.source === "GAME_START_BACKLOG" ? "ゲーム開始時点の勢力図（初期受注残）" : `Turn ${snapshot.sourceTurn} の結果`}
        </span>
      </div>

      {markets.length === 0 ? (
        <p className="text-xs text-slate-400">公開されている競合情報がまだありません。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[11px]" data-testid="play-competitor-grid">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="py-1 pr-2 text-left">市場</th>
                {PRODUCTS.map((p) => (
                  <th key={p} className="px-1 py-1 text-left">
                    {p.toUpperCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => (
                <tr key={market} className="border-b border-slate-800 align-top">
                  <td className="py-1.5 pr-2 font-semibold">{market}</td>
                  {PRODUCTS.map((product) => {
                    const cell = cellByKey.get(`${market}|${product}`);
                    if (!cell) {
                      return (
                        <td key={product} className="px-1 py-1.5 text-slate-600">
                          －
                        </td>
                      );
                    }
                    return (
                      <td key={product} className="px-1 py-1.5" data-testid={`play-competitor-cell-${market}-${product}`}>
                        <div className="mb-1">
                          {cell.crowding === null ? (
                            <span className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-500">混雑度 取得不能</span>
                          ) : (
                            <span className={`rounded px-1 py-0.5 text-[10px] ${CROWDING_CHIP[cell.crowding]}`}>
                              {CROWDING_BAND_LABEL[cell.crowding]}
                            </span>
                          )}
                        </div>
                        <ul className="space-y-0.5">
                          {cell.shares.map((share) => (
                            <li key={share.companyId} className="flex items-center gap-1">
                              <span className={`w-10 shrink-0 ${share.exactShare !== undefined ? "font-semibold text-sky-300" : "text-slate-400"}`}>
                                {share.companyId}
                              </span>
                              <span className={`rounded px-1 ${SHARE_BAND_CHIP[share.band]}`} title={SHARE_BAND_LABEL[share.band]}>
                                {SHARE_BAND_DOTS[share.band]}
                              </span>
                              <span className="w-3 text-slate-500">{share.trend === null ? "" : TREND_MARK[share.trend]}</span>
                              {share.exactShare !== undefined ? (
                                <span className="font-semibold tabular-nums text-sky-300">{(share.exactShare * 100).toFixed(1)}%</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mb-1 mt-3 text-xs font-semibold text-slate-300">各社の営業人員</h3>
      <table className="w-full max-w-md text-[11px]" data-testid="play-competitor-salesforce">
        <thead>
          <tr className="border-b border-slate-700 text-slate-400">
            <th className="py-1 pr-2 text-left">会社</th>
            <th className="px-1 py-1 text-right">営業人員（概数）</th>
            <th className="px-1 py-1 text-right">前四半期比</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.salesForce.map((entry) => (
            <tr key={entry.companyId} className="border-b border-slate-800">
              <td className="py-1 pr-2">{entry.companyId}</td>
              <td className="px-1 py-1 text-right tabular-nums">約{entry.approximateHeadcount}人</td>
              <td className="px-1 py-1 text-right tabular-nums">
                {entry.approximateChange === null
                  ? "－"
                  : entry.approximateChange === 0
                    ? "±0"
                    : `${entry.approximateChange > 0 ? "＋" : "−"}${Math.abs(entry.approximateChange)}人`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-[11px] leading-snug text-slate-500">
        ここに出るのは前四半期の結果だけです。他社が今期どう動くかは分かりません。
        シェアは5社の中での割合で、帯（{SHARE_BAND_DOTS.leader} 首位級40%以上／{SHARE_BAND_DOTS.large} 大25%以上／
        {SHARE_BAND_DOTS.medium} 中10%以上／{SHARE_BAND_DOTS.small} 小）に丸めてあります。自社の行だけ正確な割合を併記しています。
        営業人員は10人単位の概数で、市場別の配置は公開されません。
        混雑度は5社の提示が需要に対してどれだけ集中していたかで、「混雑」のマスは価格が下押しされます。
      </p>
    </section>
  );
}
