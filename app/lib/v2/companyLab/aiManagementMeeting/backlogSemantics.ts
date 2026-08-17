// ShrimpX V2 — AI Management Meeting: Backlog Semantics（AMM-M2.1）
//
// 【根本原因（M2.1監査で確定）】briefing.ts初版は、既存のcomputeBacklogByMarketProduct
// （openingStateSummary.ts）が返す「outstanding合計（納期を問わず全件合算）」を
// そのまま `overdueBacklogTopN` という名前のフィールドへ格納していた。名前が
// "overdue" を名乗っているにもかかわらず、実際にはoverdue（納期超過）かどうかを
// 一切判定していなかったため、Claudeが「backlogが存在する＝納期遅延している」と
// 誤って解釈する土台をこちらが作ってしまっていた（Test26 BAL Turn1の誤回答の
// 直接の原因）。
//
// 【原則（ChatGPT #05指示・最重要原則）】Backlog != Overdue。Healthy Forward
// Backlog（納期未到来の確定受注）は存在するだけではCustomer Trustを悪化させない
// （app/lib/v2/quality/scoreUpdates.tsのupdateDeliveryReliabilityScore/
// updateCustomerTrustScoreを監査した結果、実際のengineもdueQuantity/onTimeQuantity/
// continuingOverdueQuantity——「当期に納期が来た分の履行実績」——だけで更新しており、
// 未到来のoutstanding残高そのものは一切参照していない。engine側の設計は既に
// この原則どおりであり、変更不要）。
//
// 本モジュールは、既存のSalesContract.dueDate・outstandingQuantity（新しい観測を
// 追加しない）だけから、Healthy Forward / Due This Turn / Overdueを分離する。
// PC-2C（scripts/pc2BacklogProductDiagnosis.ts）で確立した同じ方法論
// （periodIndex(dueDate) < currentPeriodIdx ならoverdue）を、AI Management Meeting
// の実行時briefingとして再利用できる形にしたもの（新しいpersistent SSoTは作らない。
// 呼び出しのたびにcontractsから再導出する）。

import { toYearQuarter } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import { SalesContract } from "../../sales/types";

function periodIndexOf(p: SalesContract["dueDate"]): number {
  const yq = toYearQuarter(p);
  return yq.year * 4 + yq.quarter;
}

export interface BacklogMarketProductEntry {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly totalTons: number;
  readonly overdueTons: number;
  readonly dueThisTurnTons: number;
  readonly healthyForwardTons: number;
  /** この組み合わせの中で最も早い納期のラベル（例: "2015年Q2"）。参考情報。 */
  readonly earliestDueLabel: string;
}

export interface BacklogSemantics {
  readonly totalTons: number;
  readonly healthyForwardTons: number;
  readonly dueThisTurnTons: number;
  readonly overdueTons: number;
  readonly byMarket: readonly { readonly market: DemandMarketId; readonly totalTons: number; readonly overdueTons: number }[];
  readonly byProduct: readonly { readonly product: Product; readonly totalTons: number; readonly overdueTons: number }[];
  /** 上位N件（totalTons降順）。全件が必要な監査用途にはscripts/配下の別ツールを使う。 */
  readonly byMarketProduct: readonly BacklogMarketProductEntry[];
}

const TOP_N_MARKET_PRODUCT = 8;

/**
 * 既存のSalesContract配列から、Healthy Forward / Due This Turn / Overdueを分離した
 * BacklogSemanticsを導出する。currentYear/currentQuarterは
 * ExplanationContext.identity.year/quarterをそのまま渡す想定（新しい期間表現は作らない）。
 */
export function computeBacklogSemantics(contracts: readonly SalesContract[], companyId: string, currentYear: number, currentQuarter: number): BacklogSemantics {
  const currentPeriodIdx = currentYear * 4 + currentQuarter;

  interface Bucket {
    market: DemandMarketId;
    product: Product;
    totalTons: number;
    overdueTons: number;
    dueThisTurnTons: number;
    earliestDueIdx: number;
    earliestDueLabel: string;
  }
  const buckets = new Map<string, Bucket>();

  let totalTons = 0;
  let overdueTons = 0;
  let dueThisTurnTons = 0;

  for (const c of contracts) {
    if (c.companyId !== companyId) continue;
    const qty = c.outstandingQuantity as unknown as number;
    if (qty <= 1e-9) continue;

    const dueIdx = periodIndexOf(c.dueDate);
    const isOverdue = dueIdx < currentPeriodIdx;
    const isDueThisTurn = dueIdx === currentPeriodIdx;

    totalTons += qty;
    if (isOverdue) overdueTons += qty;
    else if (isDueThisTurn) dueThisTurnTons += qty;

    const key = `${c.market}::${c.product}`;
    const existing = buckets.get(key);
    const dueLabel = (() => {
      const yq = toYearQuarter(c.dueDate);
      return `${yq.year}年Q${yq.quarter}`;
    })();
    if (existing) {
      existing.totalTons += qty;
      if (isOverdue) existing.overdueTons += qty;
      if (isDueThisTurn) existing.dueThisTurnTons += qty;
      if (dueIdx < existing.earliestDueIdx) {
        existing.earliestDueIdx = dueIdx;
        existing.earliestDueLabel = dueLabel;
      }
    } else {
      buckets.set(key, {
        market: c.market,
        product: c.product,
        totalTons: qty,
        overdueTons: isOverdue ? qty : 0,
        dueThisTurnTons: isDueThisTurn ? qty : 0,
        earliestDueIdx: dueIdx,
        earliestDueLabel: dueLabel,
      });
    }
  }

  const byMarketMap = new Map<DemandMarketId, { totalTons: number; overdueTons: number }>();
  const byProductMap = new Map<Product, { totalTons: number; overdueTons: number }>();
  for (const b of buckets.values()) {
    const m = byMarketMap.get(b.market) ?? { totalTons: 0, overdueTons: 0 };
    m.totalTons += b.totalTons;
    m.overdueTons += b.overdueTons;
    byMarketMap.set(b.market, m);

    const p = byProductMap.get(b.product) ?? { totalTons: 0, overdueTons: 0 };
    p.totalTons += b.totalTons;
    p.overdueTons += b.overdueTons;
    byProductMap.set(b.product, p);
  }

  const byMarketProduct: BacklogMarketProductEntry[] = Array.from(buckets.values())
    .sort((a, b) => b.totalTons - a.totalTons)
    .slice(0, TOP_N_MARKET_PRODUCT)
    .map((b) => ({
      market: b.market,
      product: b.product,
      totalTons: b.totalTons,
      overdueTons: b.overdueTons,
      dueThisTurnTons: b.dueThisTurnTons,
      healthyForwardTons: b.totalTons - b.overdueTons - b.dueThisTurnTons,
      earliestDueLabel: b.earliestDueLabel,
    }));

  return {
    totalTons,
    healthyForwardTons: totalTons - overdueTons - dueThisTurnTons,
    dueThisTurnTons,
    overdueTons,
    byMarket: Array.from(byMarketMap.entries()).map(([market, v]) => ({ market, ...v })),
    byProduct: Array.from(byProductMap.entries()).map(([product, v]) => ({ product, ...v })),
    byMarketProduct,
  };
}
