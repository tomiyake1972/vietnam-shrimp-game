// ShrimpX V2 — Company Lab / Test15 期初情報パネル（財務状況・償却資産明細・市場情報）
//
// 【表示方針】情報量が多いため、3パネルとも既定で「閉じた」状態にする
// （意思決定フォームを画面下へ押し下げないため。開閉は既存のCollapsibleSectionに任せ、
// 独自の折りたたみ実装は書かない）。折りたたんだままでも判断の出発点が分かるよう、
// 見出し右端のsummaryRightへ最重要の1〜2値だけを出す。
//
// 【この層がやらないこと】値の計算をしない。openingInfoViewModel.tsが組み立てた
// 数値をそのまま整形して並べるだけ（undefinedは「－」と表示し、0で埋めない）。

import CollapsibleSection from "./CollapsibleSection";
import type {
  DepreciableAssetsBreakdown,
  OpeningBalanceSheet,
  OpeningBalanceSheetRow,
  OpeningMarketInfo,
  ScenarioNewsItem,
} from "../play/_lib/openingInfoViewModel";
import type { DomesticReferencePrice } from "../../../lib/v2/companyLab/domesticReferencePrice";
import type { ObservedMarketDemand } from "../../../lib/v2/companyLab/marketDemandObservation";

const DASH = "－";

function usd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return DASH;
  return `$${Math.round(v).toLocaleString()}`;
}
function ratio(v: number | undefined, digits = 2): string {
  if (v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}
function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}
function tons(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return DASH;
  return `${Math.round(v).toLocaleString()} t`;
}

function BsRows({ rows }: { readonly rows: readonly OpeningBalanceSheetRow[] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={r.emphasis ? "border-t border-gray-600/60 font-semibold" : ""}>
            <td className="py-0.5 pr-2 text-gray-300">{r.label}</td>
            <td className="py-0.5 text-right tabular-nums text-gray-100">{usd(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OpeningBalanceSheetPanel({ bs, turn }: { readonly bs: OpeningBalanceSheet; readonly turn: number }) {
  return (
    <CollapsibleSection
      title={`財務状況（turn ${turn} 開始時点のBS）`}
      description="四半期処理前の確定値です。PL・CFは当期の実績が確定してから「直近の四半期結果」に表示されます。"
      tone="info"
      defaultOpen={false}
      testId="opening-balance-sheet"
      summaryRight={
        <span className="text-xs text-gray-400">
          現金 {usd(bs.assets[0]?.value)} ／ 総資産 {usd(bs.totalAssets)} ／ D/E {ratio(bs.debtEquityRatio)}
        </span>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-400 mb-1">資産</h4>
          <BsRows rows={bs.assets} />
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-400 mb-1">負債</h4>
          <BsRows rows={bs.liabilities} />
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-400 mb-1">純資産</h4>
          <BsRows rows={bs.equity} />
          <table className="w-full text-xs mt-3">
            <tbody>
              <tr className="border-t border-gray-600/60">
                <td className="py-0.5 pr-2 text-gray-300">D/E（有利子負債 ÷ 純資産）</td>
                <td className="py-0.5 text-right tabular-nums text-gray-100">{ratio(bs.debtEquityRatio)}</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 text-gray-500">貸借差額（0であること）</td>
                <td className="py-0.5 text-right tabular-nums text-gray-500">{usd(bs.balanceDifference)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </CollapsibleSection>
  );
}

export function DepreciableAssetsPanel({ assets }: { readonly assets: DepreciableAssetsBreakdown }) {
  return (
    <CollapsibleSection
      title="償却資産明細"
      description="既存資産は建物・機械の2区分へ簡便配分した簡略モデルです（finance/parameters.ts）。個別の取得履歴は保持されていないため、区分より細かい内訳は表示しません。"
      tone="info"
      defaultOpen={false}
      testId="depreciable-assets"
      summaryRight={<span className="text-xs text-gray-400">簿価合計 {usd(assets.totalNetBookValue)}</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[720px]">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="text-left py-1 pr-2">区分</th>
              <th className="text-right py-1 pr-2">取得原価</th>
              <th className="text-right py-1 pr-2">償却累計</th>
              <th className="text-right py-1 pr-2">簿価</th>
              <th className="text-left py-1 pr-2">状態</th>
              <th className="text-right py-1 pr-2">完成予定</th>
              <th className="text-right py-1 pr-2">残存(四半期)</th>
            </tr>
          </thead>
          <tbody>
            {assets.rows.map((r) => (
              <tr key={r.category} className="border-b border-gray-800/60 align-top">
                <td className="py-1 pr-2 text-gray-200">
                  {r.category}
                  <div className="text-[10px] text-gray-500 mt-0.5">{r.note}</div>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">{usd(r.grossBookValue)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{usd(r.accumulatedDepreciation)}</td>
                <td className="py-1 pr-2 text-right tabular-nums font-semibold">{usd(r.netBookValue)}</td>
                <td className="py-1 pr-2">{r.status}</td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {r.expectedCompletionTurn === undefined ? DASH : `turn ${r.expectedCompletionTurn}`}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.remainingLifeQuarters ?? DASH}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="py-1 pr-2">明細 簿価合計</td>
              <td colSpan={2} />
              <td className="py-1 pr-2 text-right tabular-nums">{usd(assets.totalNetBookValue)}</td>
              <td colSpan={3} />
            </tr>
            <tr className="text-gray-500">
              <td className="py-1 pr-2">BS側（固定資産純額＋建設中勘定）</td>
              <td colSpan={2} />
              <td className="py-1 pr-2 text-right tabular-nums">{usd(assets.balanceSheetFixedAssetsNetPlusCip)}</td>
              <td colSpan={3} />
            </tr>
            <tr className="text-gray-500">
              <td className="py-1 pr-2">差額（0であること）</td>
              <td colSpan={2} />
              <td className="py-1 pr-2 text-right tabular-nums">{usd(assets.reconciliationDifference)}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </CollapsibleSection>
  );
}

export function OpeningMarketInfoPanel({
  info,
  referencePrice,
}: {
  readonly info: OpeningMarketInfo;
  readonly referencePrice: DomesticReferencePrice | null;
}) {
  const rm = info.rawMaterial;
  return (
    <CollapsibleSection
      title="市場情報（原料・販売市場の初期条件）"
      description="ゲームエンジンが持っている確定パラメータと前期実績です。将来の予測ではありません。"
      tone="info"
      defaultOpen={false}
      testId="opening-market-info"
      summaryRight={
        <span className="text-xs text-gray-400">
          国内原料 ${rm.vietnamDomesticPriorPrice.toFixed(2)}/kg ／ HOSO参考 ${info.referencePriceByProduct.hoso.toFixed(2)}/kg
        </span>
      }
    >
      <div className="space-y-4">
        <details className="bg-gray-900/40 rounded-lg p-3">
          <summary className="text-xs font-semibold text-gray-300 cursor-pointer">原料市場</summary>
          {referencePrice && (
            <div className="mt-2 rounded-lg border border-teal-700/60 bg-teal-950/30 p-2">
              <div className="text-sm font-semibold text-teal-200">
                国内原料参考価格：${referencePrice.referencePriceUsdPerHosoEqKg.toFixed(2)}/kg
              </div>
              <p className="text-[11px] text-teal-100/80 mt-1">
                {referencePrice.guaranteeActive
                  ? "Turn1はこの価格以上を提示すれば、通常条件で必要量を購入できます（供給量・調達処理能力・買い占め防止シェア上限35%の範囲内）。"
                  : "Turn2以降はこの保証はありません。成立価格・配分は需給と競合各社の買付により変動します。"}
              </p>
            </div>
          )}
          <table className="w-full text-xs mt-2">
            <tbody>
              <tr>
                <td className="py-0.5 pr-2 text-gray-300">前期のベトナム国内原料価格</td>
                <td className="py-0.5 text-right tabular-nums">${rm.vietnamDomesticPriorPrice.toFixed(4)} /HOSO換算kg</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 text-gray-300">
                  農家留保価格 合計（養殖原価 ${rm.farmerReservationPrice.farmingCost.toFixed(2)} ＋ 疾病リスク $
                  {rm.farmerReservationPrice.diseaseRiskAllowance.toFixed(2)} ＋ 最低マージン $
                  {rm.farmerReservationPrice.minimumMargin.toFixed(2)}）
                </td>
                <td className="py-0.5 text-right tabular-nums">${rm.farmerReservationPrice.total.toFixed(2)} /kg</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 text-gray-300">1社あたり国内買付の最大シェア</td>
                <td className="py-0.5 text-right tabular-nums">{pct(rm.maximumBuyerShare, 0)}</td>
              </tr>
            </tbody>
          </table>
          <h5 className="text-[11px] font-semibold text-gray-400 mt-3 mb-1">産地国別 HOSO FOB 初期価格（輸入検討の出発点）</h5>
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(rm.initialHosoFobPriceByCountry).map(([country, price]) => (
                <tr key={country}>
                  <td className="py-0.5 pr-2 text-gray-300">{country}</td>
                  <td className="py-0.5 text-right tabular-nums">${price.toFixed(2)} /kg</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="list-disc list-inside text-[11px] text-gray-400 mt-2 space-y-0.5">
            {rm.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>

        <details className="bg-gray-900/40 rounded-lg p-3">
          <summary className="text-xs font-semibold text-gray-300 cursor-pointer">販売市場（5市場）</summary>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs min-w-[760px]">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-1 pr-2">市場</th>
                  <th className="text-right py-1 pr-2">前期消費量</th>
                  <th className="text-right py-1 pr-2">景気指数</th>
                  <th className="text-right py-1 pr-2">人口成長率</th>
                  <th className="text-right py-1 pr-2">初期構成比 HOSO/PD/VAP</th>
                  <th className="text-right py-1 pr-2">成熟構成比 HOSO/PD/VAP</th>
                </tr>
              </thead>
              <tbody>
                {info.salesMarkets.map((m) => (
                  <tr key={m.market} className="border-b border-gray-800/60 align-top">
                    <td className="py-1 pr-2 text-gray-200">
                      {m.displayName}
                      <div className="text-[10px] text-gray-500 mt-0.5">{m.characteristics}</div>
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{tons(m.priorPeriodConsumption)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{ratio(m.economicIndex, 3)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{pct(m.populationGrowthRate, 2)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {pct(m.initialShareByProduct.hoso, 0)} / {pct(m.initialShareByProduct.pd, 0)} / {pct(m.initialShareByProduct.vap, 0)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {pct(m.matureShareByProduct.hoso, 0)} / {pct(m.matureShareByProduct.pd, 0)} / {pct(m.matureShareByProduct.vap, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <details className="bg-gray-900/40 rounded-lg p-3">
          <summary className="text-xs font-semibold text-gray-300 cursor-pointer">参考価格・需要ウェイト・営業工数</summary>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
            <div>
              <h5 className="text-[11px] font-semibold text-gray-400 mb-1">参考市場価格（USD/HOSO換算kg）</h5>
              <table className="w-full text-xs">
                <tbody>
                  <tr>
                    <td className="py-0.5 pr-2 text-gray-300">HOSO</td>
                    <td className="py-0.5 text-right tabular-nums">${info.referencePriceByProduct.hoso.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-2 text-gray-300">PD（+{pct(info.productPremiumRatio.pd, 0)}）</td>
                    <td className="py-0.5 text-right tabular-nums">${info.referencePriceByProduct.pd.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-2 text-gray-300">VAP（+{pct(info.productPremiumRatio.vap, 0)}）</td>
                    <td className="py-0.5 text-right tabular-nums">${info.referencePriceByProduct.vap.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-[10px] text-gray-500 mt-1">産地FOB初期価格の世界影響度加重平均をHOSO基準とし、PD/VAPは市場エンジンと同じプレミアム率を適用した参考値です。</p>
            </div>
            <div>
              <h5 className="text-[11px] font-semibold text-gray-400 mb-1">成約競争力の需要ウェイト</h5>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(info.competitivenessWeights).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-0.5 pr-2 text-gray-300">{k}</td>
                      <td className="py-0.5 text-right tabular-nums">{pct(v, 0)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-gray-700">
                    <td className="py-0.5 pr-2 text-gray-400">外部選択肢のウェイト</td>
                    <td className="py-0.5 text-right tabular-nums">{ratio(info.externalOptionWeight)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-2 text-gray-400">1社の最大成約シェア</td>
                    <td className="py-0.5 text-right tabular-nums">{pct(info.maximumSupplierShare, 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <h5 className="text-[11px] font-semibold text-gray-400 mb-1">商品別 営業工数係数</h5>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(info.salesEffortCoefficients).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-0.5 pr-2 text-gray-300">{k.toUpperCase()}</td>
                      <td className="py-0.5 text-right tabular-nums">×{ratio(v, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-gray-500 mt-1">同じトン数でもVAPはHOSOの3倍の営業工数を消費します。営業人員の配分計画に影響します。</p>
            </div>
          </div>
        </details>
      </div>
    </CollapsibleSection>
  );
}

/**
 * 【Batch 002】市場×商品別の市場規模（原則2四半期前の実績）。
 *
 * 【重要】ここに出るのは「現在の確定需要」ではない。経営者が現実に手にできるのは
 * 約6か月前に確認された市場規模であり、現在の市場はそこから動いている可能性がある。
 * turn1・turn2はゲーム開始時点の既知市場情報を表示する。
 *
 * この表はStandard AIが参照するのと完全に同じ値を表示している（プレイヤーだけが
 * 不利／有利になることが無いようにするため）。
 */
export function ObservedMarketDemandPanel({ observed }: { readonly observed: ObservedMarketDemand | undefined }) {
  if (!observed) return null;
  const isInitial = observed.observationSource === "INITIAL_MARKET_INFORMATION";
  const heading = isInitial
    ? "ゲーム開始時点の既知市場情報"
    : `${observed.observationLagQuarters}四半期前（第${observed.sourceQuarter}ターン）の実績`;
  const total = observed.entries.reduce((sum, e) => sum + e.observedTotalDemand, 0);
  return (
    <CollapsibleSection
      title={`市場規模（${heading}）`}
      description={
        isInitial
          ? "まだ実績が2四半期ぶん蓄積していないため、ゲーム開始時点で分かっている市場情報を表示しています。現在の確定需要ではありません。"
          : `約6か月遅れの市場情報です。現在の確定需要ではなく、${observed.sourceQuarter}ターン時点で確認された市場規模です。市場はその後動いている可能性があります。`
      }
      tone="info"
      defaultOpen={false}
      testId="observed-market-demand"
      summaryRight={<span className="text-xs text-gray-400">合計 {tons(total)}</span>}
    >
      <table className="w-full text-xs" data-testid="observed-market-demand-table">
        <thead>
          <tr className="border-b border-gray-700 text-gray-400">
            <th className="py-1 pr-2 text-left font-semibold">市場</th>
            <th className="py-1 pr-2 text-right font-semibold">HOSO</th>
            <th className="py-1 pr-2 text-right font-semibold">PD</th>
            <th className="py-1 pr-2 text-right font-semibold">VAP</th>
            <th className="py-1 text-right font-semibold">合計</th>
          </tr>
        </thead>
        <tbody>
          {observed.entries.map((e) => (
            <tr key={e.market} data-testid={`observed-market-demand-row-${e.market}`}>
              <td className="py-0.5 pr-2 text-gray-300">{e.market}</td>
              <td className="py-0.5 pr-2 text-right tabular-nums">{tons(e.observedDemandByProduct.hoso)}</td>
              <td className="py-0.5 pr-2 text-right tabular-nums">{tons(e.observedDemandByProduct.pd)}</td>
              <td className="py-0.5 pr-2 text-right tabular-nums">{tons(e.observedDemandByProduct.vap)}</td>
              <td className="py-0.5 text-right tabular-nums font-semibold">{tons(e.observedTotalDemand)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-500 mt-2">
        この数値は標準AI（他の4社）が見ている情報とまったく同じです。市場の現在の実需要を直接知る手段は、プレイヤーにも標準AIにもありません。
      </p>
    </CollapsibleSection>
  );
}

/**
 * 【Dynamic Scenario 1】シナリオNews（世界情勢）。
 *
 * 【この層がやらないこと】
 *  - 情報の絞り込み判定をしない（scenario/informationEngine.ts が済ませている）。
 *  - 数値の解釈・助言をしない。「この市場が儲かる」といった答えは書かない。
 *  - 他社の意思決定・シェアといった競争情報は一切含まない（別系統の情報）。
 *
 * 噂（Leading Indicator）と確定情報を見分けられるようにラベルを分ける。
 * 先読みできるかどうかはプレイヤーの判断に委ねる。
 */
export function ScenarioNewsPanel({ news, turn }: { readonly news: readonly ScenarioNewsItem[]; readonly turn: number }) {
  if (news.length === 0) return null;
  const newThisTurn = news.filter((n) => n.availableFromTurn === turn).length;
  return (
    <CollapsibleSection
      title="世界のニュース"
      description="外部の市場環境に関する報道です。将来の需給がどう動くかは書かれていません。噂の段階の情報も含まれます。"
      tone="info"
      defaultOpen={newThisTurn > 0}
      testId="scenario-news"
      summaryRight={<span className="text-xs text-gray-400">{newThisTurn > 0 ? `新着 ${newThisTurn}件` : `全${news.length}件`}</span>}
    >
      <ul className="flex flex-col gap-2" data-testid="scenario-news-list">
        {news.map((n) => (
          <li
            key={n.informationId}
            className="border-l-2 border-gray-700 pl-2 py-0.5"
            data-testid={`scenario-news-item-${n.informationId}`}
          >
            <div className="flex items-start gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${n.isRumor ? "bg-amber-900 text-amber-200" : "bg-gray-700 text-gray-200"}`}>
                {n.isRumor ? "観測・噂" : "確報"}
              </span>
              {n.availableFromTurn === turn && (
                <span className="shrink-0 rounded bg-teal-800 px-1.5 py-0.5 text-[10px] text-teal-100">新着</span>
              )}
              <span className="text-xs font-semibold text-gray-100">{n.headline}</span>
            </div>
            {n.body && <p className="mt-1 pl-1 text-[11px] leading-relaxed text-gray-300">{n.body}</p>}
            {n.facts.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-1 text-[10px] text-gray-400">
                {n.facts.map((f) => (
                  <span key={f.label}>
                    {f.label}: {f.value}
                    {f.unit ?? ""}
                  </span>
                ))}
              </div>
            )}
            {n.estimateRange && (
              <div className="mt-0.5 pl-1 text-[10px] text-gray-500">
                推定幅: {n.estimateRange.low} 〜 {n.estimateRange.high}
                {n.estimateRange.unit ?? ""}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-gray-500">
        ニュースは外部世界の情報です。他社が同じ情報をどう読み、どう動くかは書かれていません。
      </p>
    </CollapsibleSection>
  );
}
