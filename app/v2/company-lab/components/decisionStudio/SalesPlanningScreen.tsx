// ShrimpX V2 — Decision Studio: SALES（市場×商品販売計画・営業人員配員/採用/減員）
//
// 【UI-TRIAL-1 §3】営業人員は市場単位の意思決定なのに、以前は市場×商品の全行
// （CN/HOSO・CN/PD・CN/VAP…）に同じ営業人員の入力欄が並んでいた。同じ値を3回
// 見せて3回編集できる形は「何人配置したのか」を読み取りにくく、予行演習で
// 迷わせる原因になる（入力自体は syncMarketSalesForceHeadcount で同期していた
// ので値は壊れていなかったが、画面上は重複していた）。
// そこで市場ごとのブロックへ組み替え、
//   - 営業配員の編集欄は市場ごとに1つだけ
//   - その下に HOSO / PD / VAP の販売数量・価格調整を並べる
// という形にする。数量と価格は従来どおり市場×商品単位で編集する。
//
// 【計算しない】配員可能人数・超過判定・採用上限はいずれも既存の共有ロジック
// （summarizeSalesForceAllocation / summarizeSalesForceHiring /
// computeMaxSalesHiresPerQuarter、DecisionStudioViewModel 経由）の結果をそのまま
// 表示する。この画面に独自の算式は無い。配員ルール・提出データの意味・
// 営業Engineの挙動はいずれも変更していない。

import { CompanyDecisionDraft, resetAllSalesForceHeadcountToZero, SalesForceAllocationSummary, SalesForceHiringPreview, syncMarketSalesForceHeadcount } from "../../decisionDraft";
import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { computeSalesPlanTotals } from "../../salesPlanTotals";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { DemandMarketId, Product } from "../../../../lib/v2/market/types";
import { MarketProductBasePriceReference } from "../../../../lib/v2/sales/marketBasePriceReference";
import { NumberCell, PriceAdjustmentCell } from "../InputCells";
import CollapsibleSection from "../CollapsibleSection";
import BacklogByProductPanel from "../BacklogByProductPanel";
import { BacklogSemantics } from "../../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { INFO_TABLE_HEAD_CLASS } from "../panelStyles";
import { InputFieldLabel, ReferenceValue } from "../FieldAnnotations";

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * 【SALES基準価格参考表示】表示専用フォーマッタ（$X.XX固定・小数2桁）。
 * 既存formatUsdPerHosoEqKg（最大4桁）とは意図的に異なる（今回のUI要件が2桁固定のため）。
 * 新しい価格計算は一切しない。
 */
export function formatPricePerKgPlain(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * 【SALES基準価格参考表示】前四半期の確定済みMarketProductAllocationResultから
 * 該当market×productのbasePriceを読み取るだけ（新しい価格計算・予測は一切しない）。
 * 見つからない（前四半期データ自体が無い・当該組合せの配分結果が無い）場合はnull。
 */
export function findLastQuarterBasePrice(
  allocations: readonly MarketProductBasePriceReference[] | undefined,
  market: DemandMarketId,
  product: Product
): number | null {
  const found = allocations?.find((a) => a.market === market && a.product === product);
  return found ? unwrapUnit(found.basePrice) : null;
}

interface SalesPlanRowRef {
  readonly index: number;
  readonly product: Product;
  readonly desiredQuantity: number;
  readonly priceAdjustmentUsdPerHosoEqKg: number;
}

interface MarketGroup {
  readonly market: DemandMarketId;
  /** この市場の営業配員（同一市場の全商品行が共有する1つの値）。 */
  readonly salesForceHeadcount: number;
  readonly rows: readonly SalesPlanRowRef[];
}

/**
 * 【UI-TRIAL-1 §3】市場ごとにまとめる。draft.salesPlans の並び順（市場の初出順・
 * 商品の並び）はそのまま保つ。行の index を持ち回るのは、既存の編集処理
 * （salesPlans 配列の該当要素だけを差し替える）を変えないため。
 *
 * 営業配員は同一市場で必ず同じ値になっている（syncMarketSalesForceHeadcount が
 * 常にそう保つ）。万一ずれた下書きを読み込んだ場合も、ここでは勝手に直さず
 * 最初の行の値を代表として表示する（提出値を画面が書き換えない）。
 */
export function groupSalesPlansByMarket(
  salesPlans: readonly { readonly market: DemandMarketId; readonly product: Product; readonly desiredQuantity: number; readonly priceAdjustmentUsdPerHosoEqKg: number; readonly salesForceHeadcount: number }[]
): readonly MarketGroup[] {
  const order: DemandMarketId[] = [];
  const byMarket = new Map<DemandMarketId, { headcount: number; rows: SalesPlanRowRef[] }>();
  salesPlans.forEach((row, index) => {
    let group = byMarket.get(row.market);
    if (group === undefined) {
      group = { headcount: row.salesForceHeadcount, rows: [] };
      byMarket.set(row.market, group);
      order.push(row.market);
    }
    group.rows.push({
      index,
      product: row.product,
      desiredQuantity: row.desiredQuantity,
      priceAdjustmentUsdPerHosoEqKg: row.priceAdjustmentUsdPerHosoEqKg,
    });
  });
  return order.map((market) => {
    const group = byMarket.get(market)!;
    return { market, salesForceHeadcount: group.headcount, rows: group.rows };
  });
}

interface SalesPlanningScreenProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly currentSalesForceHeadcount: number;
  readonly salesForceAllocation: SalesForceAllocationSummary;
  readonly salesForceHiring: SalesForceHiringPreview;
  readonly salesForceHireLimit: number;
  /**
   * 【SALES基準価格参考表示】直近確定四半期の市場×商品別「基準価格」だけの
   * 最小DTO。省略時・turn1等は前Turn価格「－」表示。
   */
  readonly lastQuarterSalesAllocations?: readonly MarketProductBasePriceReference[];
  /**
   * 【INT-1 §2A】商品別受注残。DecisionStudio が既存SSoT
   * （aiManagementMeeting/backlogSemantics.ts）から導出した値をそのまま受け取る。
   * この画面では再集計・再分類を行わない。
   */
  readonly backlogSemantics?: BacklogSemantics;
}

export default function SalesPlanningScreen({
  draft,
  onChange,
  disabled,
  currentSalesForceHeadcount,
  salesForceAllocation,
  salesForceHiring,
  salesForceHireLimit,
  lastQuarterSalesAllocations,
  backlogSemantics,
}: SalesPlanningScreenProps) {
  const totals = computeSalesPlanTotals(draft.salesPlans);
  const marketGroups = groupSalesPlansByMarket(draft.salesPlans);

  return (
    <div className="space-y-3" data-testid="decision-studio-sales-screen">
      {/* 【INT-1 §2A】販売数量を決める前に、商品別の受注残（未履行の確定受注）を見られるようにする。 */}
      {backlogSemantics ? (
        <BacklogByProductPanel
          backlog={backlogSemantics}
          context="販売計画の参考情報です。"
          testIdPrefix="sales"
        />
      ) : null}

      {/* 販売計画 */}
      <CollapsibleSection
        title="販売計画と営業配員（市場ごと）"
        description="営業人員は市場単位の意思決定です。市場ごとに1つだけ人数を入れ、その下に商品別の販売数量と価格調整を入れてください。"
        tone="input"
        testId="sales-plan-section"
        summaryRight={
          salesForceAllocation.isOverAllocated
            ? `営業人員 ${salesForceAllocation.overBy}人超過`
            : `営業人員 配員済み ${salesForceAllocation.assignedTotal}人 / 配員可能 ${salesForceAllocation.availableTotal}人`
        }
      >
        {/* 営業人員の全体像。採用（次期から効く）と配員（当期の割り振り）を分けて示す。 */}
        <div
          data-testid="sales-force-allocation-summary"
          className={`rounded-lg px-3 py-2 text-xs ${
            salesForceAllocation.isOverAllocated
              ? "bg-rose-950/50 border border-rose-700/60 text-rose-200"
              : "bg-gray-900/60 border border-gray-700/60 text-gray-300"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">営業人員の配員状況（当期）</h4>
            <button
              type="button"
              onClick={() => onChange(resetAllSalesForceHeadcountToZero(draft))}
              disabled={disabled}
              className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-100 rounded-md px-2 py-1 text-[11px] whitespace-nowrap"
            >
              営業配員をすべて0に戻す
            </button>
          </div>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <div>
              <dt className="text-[10px] text-gray-400">営業人員の総数（当期に配員できる人数）</dt>
              <dd className="text-sm font-semibold tabular-nums text-gray-100" data-testid="sales-force-total-headcount">
                {salesForceAllocation.availableTotal}人
              </dd>
            </div>
            <div>
              <dt className="text-[10px] text-gray-400">配員済み</dt>
              <dd className="text-sm font-semibold tabular-nums text-gray-100" data-testid="sales-force-assigned-headcount">
                {salesForceAllocation.assignedTotal}人
              </dd>
            </div>
            <div>
              <dt className="text-[10px] text-gray-400">{salesForceAllocation.isOverAllocated ? "超過" : "未配員"}</dt>
              <dd
                className={`text-sm font-semibold tabular-nums ${salesForceAllocation.isOverAllocated ? "text-rose-200" : "text-gray-100"}`}
                data-testid="sales-force-unassigned-headcount"
                data-over-allocated={salesForceAllocation.isOverAllocated ? "true" : "false"}
              >
                {salesForceAllocation.isOverAllocated ? `${salesForceAllocation.overBy}人` : `${salesForceAllocation.remaining}人`}
              </dd>
            </div>
          </dl>
          {salesForceAllocation.isOverAllocated && (
            <p className="mt-1 text-[11px] text-rose-200" data-testid="sales-force-over-allocated-warning" role="alert">
              配員済みが営業人員の総数を超えています。この内容のままでは提出できません。どこかの市場を減らしてください。
            </p>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-gray-400" data-testid="sales-force-assign-vs-hire-note">
            ここで入れるのは<strong className="text-gray-200">配員人数</strong>（いまいる営業人員を市場へ割り振る人数）です。
            <strong className="text-gray-200">採用人数</strong>は下の「営業人員の追加採用・減員」で入れます。今期採用した人は次の四半期から配員できるようになり、
            当期に配員できる人数は増えません。
          </p>
        </div>

        {/* 【SALES基準価格参考表示】必ず表示する注意書き（市場ブロックごとに繰り返さない）。 */}
        <p className="text-[11px] text-amber-300/90" data-testid="sales-price-reference-disclaimer">
          ※ 今Turnの実際の市場基準価格は、全社の意思決定確定後に決まります。ここに表示する参考提示価格は、前Turnの確定基準価格を使った参考値です。
        </p>

        {/* 市場ごとのブロック。狭い画面でも、どの市場の入力欄かが見出しと各行のラベルで分かる。 */}
        <div className="space-y-2" data-testid="sales-plan-market-blocks">
          {marketGroups.map((group) => (
            <section
              key={group.market}
              data-testid={`sales-plan-market-block-${group.market}`}
              data-market={group.market}
              className="rounded-lg border border-sky-800/50 bg-sky-950/20"
            >
              <header className="flex flex-wrap items-end justify-between gap-2 border-b border-sky-800/40 px-3 py-2">
                <h4 className="text-sm font-semibold text-sky-100">
                  <span className="text-[10px] font-normal text-sky-300/80">市場</span> {group.market}
                </h4>
                <div className="flex items-end gap-2">
                  <div>
                    <InputFieldLabel
                      name="この市場へ配員する営業人員"
                      unit="人"
                      target={`${group.market}市場`}
                      htmlFor={`sales-force-market-headcount-${group.market}`}
                      testId={`sales-force-market-assign-label-${group.market}`}
                    >
                      市場ごとに1つだけ入力します（商品別には分けません）。
                    </InputFieldLabel>
                    <div className="mt-0.5">
                      <NumberCell
                        value={group.salesForceHeadcount}
                        disabled={disabled}
                        warn={salesForceAllocation.isOverAllocated}
                        testId={`sales-force-market-headcount-${group.market}`}
                        ariaLabel={`${group.market}市場へ配員する営業人員（人）`}
                        onChange={(n) => {
                          // 営業人員は市場単位の意思決定。同一市場の全商品行へ同じ値を同期する
                          // 既存の共有操作をそのまま呼ぶ（提出データの形は変えない）。
                          onChange(syncMarketSalesForceHeadcount(draft, group.market, Math.round(n)));
                        }}
                      />
                    </div>
                  </div>
                </div>
              </header>

              <div className="overflow-x-auto px-3 py-2">
                <table className="min-w-full text-xs text-gray-300" data-testid={`sales-plan-products-${group.market}`}>
                  <thead>
                    <tr className={INFO_TABLE_HEAD_CLASS}>
                      <th className="pr-3 py-1">商品</th>
                      <th className="pr-3 py-1">販売希望量(t)</th>
                      <th className="pr-3 py-1">価格調整($/kg)</th>
                      <th className="pr-3 py-1">価格の参考情報</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => {
                      const lastQuarterBasePrice = findLastQuarterBasePrice(lastQuarterSalesAllocations, group.market, row.product);
                      const referenceAskPrice = lastQuarterBasePrice !== null ? lastQuarterBasePrice + row.priceAdjustmentUsdPerHosoEqKg : null;
                      return (
                        <tr key={`${group.market}-${row.product}`} className="border-t border-gray-700/60" data-testid={`sales-plan-row-${group.market}-${row.product}`}>
                          <td className="pr-3 py-1">
                            {/* 狭い画面で行だけが見えている状態でも市場が分かるように、
                                商品名に市場を併記する。 */}
                            <span className="uppercase">{row.product}</span>
                            <span className="ml-1 text-[10px] text-gray-500">（{group.market}）</span>
                          </td>
                          <td className="pr-3 py-1">
                            <NumberCell
                              value={row.desiredQuantity}
                              disabled={disabled}
                              warn={row.desiredQuantity > currentSalesForceHeadcount * 500}
                              testId={`sales-plan-desired-quantity-${group.market}-${row.product}`}
                              ariaLabel={`${group.market}市場 ${row.product} の販売希望量（t）`}
                              onChange={(n) => {
                                const next = [...draft.salesPlans];
                                next[row.index] = { ...next[row.index], desiredQuantity: n };
                                onChange({ ...draft, salesPlans: next });
                              }}
                            />
                          </td>
                          <td className="pr-3 py-1">
                            <PriceAdjustmentCell
                              value={row.priceAdjustmentUsdPerHosoEqKg}
                              disabled={disabled}
                              testId={`sales-plan-price-adjustment-${group.market}-${row.product}`}
                              ariaLabel={`${group.market}市場 ${row.product} の価格調整（$/kg）`}
                              onChange={(n) => {
                                const next = [...draft.salesPlans];
                                next[row.index] = { ...next[row.index], priceAdjustmentUsdPerHosoEqKg: n };
                                onChange({ ...draft, salesPlans: next });
                              }}
                            />
                          </td>
                          <td className="pr-3 py-1">
                            <div className="space-y-0.5" data-testid={`sales-price-reference-${group.market}-${row.product}`}>
                              <ReferenceValue
                                label="前Turn市場基準"
                                kind="actual"
                                value={
                                  <span data-testid={`sales-price-reference-prior-base-${group.market}-${row.product}`}>
                                    {lastQuarterBasePrice !== null ? formatPricePerKgPlain(lastQuarterBasePrice) : "－"}
                                  </span>
                                }
                              />
                              <ReferenceValue
                                label="参考提示"
                                kind="reference"
                                value={
                                  <span data-testid={`sales-price-reference-ask-${group.market}-${row.product}`}>
                                    {referenceAskPrice !== null ? `${formatPricePerKgPlain(referenceAskPrice)}/kg` : "－"}
                                  </span>
                                }
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-3" data-testid="sales-plan-totals">
          <div className="mb-2 flex items-center justify-between rounded-lg border border-gray-700/60 bg-gray-900/50 px-3 py-2">
            <span className="text-xs font-semibold text-gray-300">
              販売希望数量 合計
              <span className="ml-1 rounded bg-gray-800 px-1 py-[1px] text-[10px] text-gray-300 border border-gray-600/70">自動計算値</span>
            </span>
            <span className="text-base font-bold tabular-nums text-gray-100" data-testid="sales-plan-grand-total">
              {formatHosoEqTons(totals.grandTotalTons)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300" data-testid="sales-plan-totals-table">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">市場＼商品</th>
                  {totals.products.map((product) => (
                    <th key={product} className="pr-3 py-1 text-right uppercase">
                      {product}
                    </th>
                  ))}
                  <th className="pr-3 py-1 text-right font-semibold">市場合計</th>
                </tr>
              </thead>
              <tbody>
                {totals.markets.map((market) => (
                  <tr key={market} className="border-t border-gray-700/60">
                    <td className="pr-3 py-1">{market}</td>
                    {totals.products.map((product) => (
                      <td key={product} className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-plan-cell-${market}-${product}`}>
                        {formatHosoEqTons(totals.cellTons(market, product))}
                      </td>
                    ))}
                    <td className="pr-3 py-1 text-right font-semibold tabular-nums" data-testid={`sales-plan-market-total-${market}`}>
                      {formatHosoEqTons(totals.marketTotalTons(market))}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-gray-600 font-semibold">
                  <td className="pr-3 py-1">商品合計</td>
                  {totals.products.map((product) => (
                    <td key={product} className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-plan-product-total-${product}`}>
                      {formatHosoEqTons(totals.productTotalTons(product))}
                    </td>
                  ))}
                  <td className="pr-3 py-1 text-right tabular-nums text-gray-200" data-testid="sales-plan-grand-total-cell">
                    {formatHosoEqTons(totals.grandTotalTons)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </CollapsibleSection>

      {/* 営業人員の追加採用・減員 */}
      <CollapsibleSection
        title="営業人員の追加採用・減員（次の四半期から効きます）"
        description="ここは採用・減員の人数です。当期の市場への配員は上の「販売計画と営業配員」で入れてください。"
        tone="input"
        testId="sales-force-hiring-section"
        summaryRight={
          salesForceHiring.plannedHireCount > 0
            ? `今回 採用予定 ${salesForceHiring.plannedHireCount}人 → 次期見込み ${salesForceHiring.nextQuarterHeadcount}人`
            : salesForceHiring.plannedLayoffCount > 0
              ? `今回 減員予定 ${salesForceHiring.plannedLayoffCount}人 → 次期見込み ${salesForceHiring.nextQuarterHeadcount}人`
              : `現在の営業人員 ${salesForceHiring.currentHeadcount}人`
        }
      >
        <div className="space-y-2">
          {/* 参照情報（読むだけ）と入力欄を、同じ表の中で混ぜない。 */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-900/50 px-3 py-2" data-testid="sales-force-hiring-reference">
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">いまの営業人員（読むだけ）</h4>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <ReferenceValue
                label="現在の営業人員"
                kind="current"
                value={<span data-testid="sales-force-hiring-current-headcount">{salesForceHiring.currentHeadcount}</span>}
                unit="人"
              />
              <ReferenceValue label="当期に配員できる人数" kind="current" value={salesForceHiring.currentHeadcount} unit="人" />
              <ReferenceValue
                label="次期の営業人員見込み"
                kind="derived"
                value={<span data-testid="sales-force-hiring-next-quarter-headcount">{salesForceHiring.nextQuarterHeadcount}</span>}
                unit="人"
              />
              <ReferenceValue label="採用・減員の反映時期" kind="reference" value="次の四半期から" />
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <InputFieldLabel
                name="営業人員 採用数（今回の採用予定）"
                unit="人"
                target="全社（市場別ではありません）"
                htmlFor="sales-force-hire-count"
                testId="sales-force-hire-count-label"
              >
                採用した人は次の四半期から配員できます。当期の配員可能人数は増えません。
              </InputFieldLabel>
              <div className="mt-0.5">
                <NumberCell
                  value={draft.salesForceHireCount ?? 0}
                  disabled={disabled}
                  testId="sales-force-hire-count"
                  ariaLabel="営業人員 採用数（人・全社）"
                  onChange={(n) => onChange({ ...draft, salesForceHireCount: Math.round(Math.max(0, n)) })}
                />
              </div>
              <div className="mt-0.5 text-[10px] text-gray-500" data-testid="sales-hire-ramp-limit">
                営業組織の受入能力上、今期の増員上限は {salesForceHireLimit}人です
                （現在{salesForceHiring.currentHeadcount}人の30%、最低3人）。
                一度に増やしすぎると顧客の引継ぎ・育成・商談情報の共有が追いつきません。
              </div>
              {(draft.salesForceHireCount ?? 0) > salesForceHireLimit && (
                <div className="mt-0.5 text-[10px] text-amber-300" data-testid="sales-hire-ramp-exceeded">
                  上限を超えています。このままでは四半期処理でエラーになります。
                </div>
              )}
            </div>

            <div>
              <InputFieldLabel
                name="営業人員 減員数（今回の減員予定）"
                unit="人"
                target="全社（市場別ではありません）"
                htmlFor="sales-force-layoff-count"
                testId="sales-force-layoff-count-label"
              >
                当期は配員・給与の対象のままで、次の四半期から配員可能人数が減ります。
              </InputFieldLabel>
              <div className="mt-0.5">
                <NumberCell
                  value={draft.salesForceLayoffCount ?? 0}
                  disabled={disabled}
                  testId="sales-force-layoff-count"
                  ariaLabel="営業人員 減員数（人・全社）"
                  onChange={(n) => onChange({ ...draft, salesForceLayoffCount: Math.round(Math.max(0, n)) })}
                />
              </div>
            </div>

            {salesForceHiring.plannedLayoffCount > 0 && (
              <div className="rounded-lg border border-gray-700/60 bg-gray-900/50 px-3 py-2">
                <ReferenceValue
                  label="今回発生する退職金（当期一括）"
                  kind="derived"
                  value={
                    <span data-testid="sales-force-hiring-severance-cost">
                      {formatUsd(salesForceHiring.severanceCostUsd)}
                      {salesForceHiring.effectiveLayoffCount < salesForceHiring.plannedLayoffCount && (
                        <span className="ml-1 text-amber-400">
                          （現在の営業人員{salesForceHiring.currentHeadcount}人が上限のため、実際の減員は
                          {salesForceHiring.effectiveLayoffCount}人）
                        </span>
                      )}
                    </span>
                  }
                />
              </div>
            )}
          </div>

          <p className="text-[11px] text-gray-400">
            今期採用した営業人員は、教育・引継ぎ期間を経て、次の四半期から営業活動に参加します。
            今期減員を決定した営業人員は、当期は引き続き配員・給与の対象のままで、次の四半期から
            配員可能人数が減ります（退職金は減員を決定した当期に一括で発生します）。
          </p>
          {salesForceHiring.hasMutualExclusionConflict && (
            <p className="text-[11px] text-red-400" data-testid="sales-force-hiring-conflict-warning" role="alert">
              営業人員の採用と減員を同一四半期に同時入力することはできません。いずれか一方を0にしてください
              （この内容のままでは提出できません）。
            </p>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}
