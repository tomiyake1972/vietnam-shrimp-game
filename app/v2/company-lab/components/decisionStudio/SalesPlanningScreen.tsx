// ShrimpX V2 — Decision Studio: SALES（市場×商品販売計画・営業人員配分/採用/減員）
//
// 旧DecisionEditor.tsxの「販売計画（市場×商品）」「営業人員の追加採用・減員」の
// 2 CollapsibleSectionをそのまま移設。計算ロジック（computeSalesPlanTotals・
// summarizeSalesForceAllocation・summarizeSalesForceHiring・
// computeMaxSalesHiresPerQuarter）は一切変更せず、既存の呼び出し結果
// （DecisionStudioViewModel経由）をそのまま表示・入力欄へ橋渡しするだけ。

import { CompanyDecisionDraft, resetAllSalesForceHeadcountToZero, SalesForceAllocationSummary, SalesForceHiringPreview, syncMarketSalesForceHeadcount } from "../../decisionDraft";
import { formatHosoEqTons } from "../../../../lib/v2/industryLab/ui/formatters";
import { computeSalesPlanTotals } from "../../salesPlanTotals";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { DemandMarketId, Product } from "../../../../lib/v2/market/types";
import { MarketProductAllocationResult } from "../../../../lib/v2/sales/types";
import { NumberCell, PriceAdjustmentCell } from "../InputCells";
import CollapsibleSection from "../CollapsibleSection";
import { INFO_TABLE_HEAD_CLASS } from "../panelStyles";

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * 【SALES基準価格参考表示・新設】表示専用フォーマッタ（$X.XX固定・小数2桁）。
 * 既存formatUsdPerHosoEqKg（最大4桁）とは意図的に異なる（今回のUI要件が2桁固定のため）。
 * 新しい価格計算は一切しない。
 */
export function formatPricePerKgPlain(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * 【SALES基準価格参考表示・新設】前四半期の確定済みMarketProductAllocationResultから
 * 該当market×productのbasePriceを読み取るだけ（新しい価格計算・予測は一切しない）。
 * 見つからない（前四半期データ自体が無い・当該組合せの配分結果が無い）場合はnull。
 */
export function findLastQuarterBasePrice(
  allocations: readonly MarketProductAllocationResult[] | undefined,
  market: DemandMarketId,
  product: Product
): number | null {
  const found = allocations?.find((a) => a.market === market && a.product === product);
  return found ? unwrapUnit(found.basePrice) : null;
}

interface SalesPlanningScreenProps {
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly currentSalesForceHeadcount: number;
  readonly salesForceAllocation: SalesForceAllocationSummary;
  readonly salesForceHiring: SalesForceHiringPreview;
  readonly salesForceHireLimit: number;
  /** 【SALES基準価格参考表示・新設】直近確定四半期の市場×商品別配分結果（全社共通・公開情報）。省略時・turn1等は前Turン価格「－」表示。 */
  readonly lastQuarterSalesAllocations?: readonly MarketProductAllocationResult[];
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
}: SalesPlanningScreenProps) {
  const totals = computeSalesPlanTotals(draft.salesPlans);

  return (
    <div className="space-y-3" data-testid="decision-studio-sales-screen">
      {/* 販売計画 */}
      <CollapsibleSection
        title="販売計画（市場×商品）"
        tone="input"
        testId="sales-plan-section"
        summaryRight={
          salesForceAllocation.isOverAllocated
            ? `営業人員 ${salesForceAllocation.overBy}人超過`
            : `営業人員 配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人`
        }
      >
        <div
          data-testid="sales-force-allocation-summary"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs ${
            salesForceAllocation.isOverAllocated
              ? "bg-rose-950/50 border border-rose-700/60 text-rose-200"
              : "bg-gray-900/60 border border-gray-700/60 text-gray-300"
          }`}
        >
          <span>
            {salesForceAllocation.isOverAllocated
              ? `配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人 / ${salesForceAllocation.overBy}人超過 — 現在の人員数に収まるように再編集してください。`
              : `配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人 / 未配分 ${salesForceAllocation.remaining}人`}
          </span>
          <button
            type="button"
            onClick={() => onChange(resetAllSalesForceHeadcountToZero(draft))}
            disabled={disabled}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-100 rounded-md px-2 py-1 text-[11px] whitespace-nowrap"
          >
            営業配分をすべて0に戻す
          </button>
        </div>

        {/* 【SALES基準価格参考表示・新設】必ず表示する注意書き（表全体で1回・行ごとに繰り返さない）。 */}
        <p className="text-[11px] text-amber-300/90" data-testid="sales-price-reference-disclaimer">
          ※ 今Turnの実際の市場基準価格は、全社の意思決定確定後に決まります。ここに表示する参考提示価格は、前Turnの確定基準価格を使った参考値です。
        </p>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">市場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">販売希望量(t)</th>
                <th className="pr-3 py-1">価格調整($/kg)</th>
                <th className="pr-3 py-1">営業人員</th>
              </tr>
            </thead>
            <tbody>
              {draft.salesPlans.map((row, idx) => {
                const lastQuarterBasePrice = findLastQuarterBasePrice(lastQuarterSalesAllocations, row.market, row.product);
                const referenceAskPrice = lastQuarterBasePrice !== null ? lastQuarterBasePrice + row.priceAdjustmentUsdPerHosoEqKg : null;
                return (
                <tr key={`${row.market}-${row.product}`} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.market}</td>
                  <td className="pr-3 py-1 uppercase">{row.product}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.desiredQuantity}
                      disabled={disabled}
                      warn={row.desiredQuantity > currentSalesForceHeadcount * 500}
                      testId={`sales-plan-desired-quantity-${row.market}-${row.product}`}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, desiredQuantity: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <PriceAdjustmentCell
                      value={row.priceAdjustmentUsdPerHosoEqKg}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, priceAdjustmentUsdPerHosoEqKg: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                    <div className="mt-0.5 whitespace-nowrap text-[10px] leading-tight text-gray-400" data-testid={`sales-price-reference-${row.market}-${row.product}`}>
                      <div>
                        前Turn市場基準{" "}
                        <span data-testid={`sales-price-reference-prior-base-${row.market}-${row.product}`}>
                          {lastQuarterBasePrice !== null ? formatPricePerKgPlain(lastQuarterBasePrice) : "－"}
                        </span>
                      </div>
                      <div>
                        参考提示{" "}
                        <span data-testid={`sales-price-reference-ask-${row.market}-${row.product}`}>
                          {referenceAskPrice !== null ? `${formatPricePerKgPlain(referenceAskPrice)}/kg` : "－"}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.salesForceHeadcount}
                      disabled={disabled}
                      warn={salesForceAllocation.isOverAllocated}
                      onChange={(n) => {
                        // 【SAI-2追加作業: 市場別営業配置】営業人員は市場単位で共有される
                        // （同一市場のHOSO/PD/VAP行は必ず同じ人数を持つ必要がある）ため、
                        // このセルの編集は同じ市場の全商品行へ同期する。
                        onChange(syncMarketSalesForceHeadcount(draft, row.market, Math.round(n)));
                      }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3" data-testid="sales-plan-totals">
          <div className="mb-2 flex items-center justify-between rounded-lg border border-sky-700/60 bg-sky-950/30 px-3 py-2">
            <span className="text-xs font-semibold text-sky-200">販売希望数量 合計</span>
            <span className="text-base font-bold tabular-nums text-sky-100" data-testid="sales-plan-grand-total">
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
                  <td className="pr-3 py-1 text-right tabular-nums text-sky-200" data-testid="sales-plan-grand-total-cell">
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
        title="営業人員の追加採用・減員"
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
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <tbody>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">現在の営業人員</td>
                  <td className="pr-3 py-1" data-testid="sales-force-hiring-current-headcount">
                    {salesForceHiring.currentHeadcount}人
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">当期に配分可能</td>
                  <td className="pr-3 py-1">{salesForceHiring.currentHeadcount}人</td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">営業人員採用数（今回の採用予定）</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={draft.salesForceHireCount ?? 0}
                      disabled={disabled}
                      onChange={(n) => onChange({ ...draft, salesForceHireCount: Math.round(Math.max(0, n)) })}
                    />
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
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">営業人員減員数（今回の減員予定）</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={draft.salesForceLayoffCount ?? 0}
                      disabled={disabled}
                      onChange={(n) => onChange({ ...draft, salesForceLayoffCount: Math.round(Math.max(0, n)) })}
                    />
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">次期の営業人員見込み</td>
                  <td className="pr-3 py-1" data-testid="sales-force-hiring-next-quarter-headcount">
                    {salesForceHiring.nextQuarterHeadcount}人
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">採用・減員の反映時期</td>
                  <td className="pr-3 py-1">次の四半期から</td>
                </tr>
                {salesForceHiring.plannedLayoffCount > 0 && (
                  <tr className="border-t border-gray-700/60">
                    <td className="pr-3 py-1 text-gray-400">今回発生する退職金（当期一括）</td>
                    <td className="pr-3 py-1" data-testid="sales-force-hiring-severance-cost">
                      {formatUsd(salesForceHiring.severanceCostUsd)}
                      {salesForceHiring.effectiveLayoffCount < salesForceHiring.plannedLayoffCount && (
                        <span className="ml-1 text-amber-400">
                          （現在の営業人員{salesForceHiring.currentHeadcount}人が上限のため、実際の減員は
                          {salesForceHiring.effectiveLayoffCount}人）
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            今期採用した営業人員は、教育・引継ぎ期間を経て、次の四半期から営業活動に参加します。
            今期減員を決定した営業人員は、当期は引き続き配置・給与の対象のままで、次の四半期から
            配分可能人数が減ります（退職金は減員を決定した当期に一括で発生します）。
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
