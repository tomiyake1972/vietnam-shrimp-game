// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 契約生成（Phase 4）
//
// 成約配分結果（MarketProductAllocationResult[]）から、決定論的なcontractIdを
// 持つ契約（SalesContract）を生成する純粋関数のみを提供する。
// 標準納期は成約の翌四半期（core/period.ts の nextPeriod を1回適用）。
// 希望リードタイムが指定されていれば nextPeriod を複数回適用する。

import { nextPeriod, PeriodV2 } from "../core/period";
import { hosoEqTons, unwrapUnit } from "../core/units";
import { SalesParameters } from "./parameters";
import { CompanySalesPlanEntry, MarketProductAllocationResult, SalesContract, SalesValidationError } from "./types";

/**
 * 決定論的な契約ID。同じ (成約四半期, 市場, 商品区分, 会社) の組は1四半期に
 * 高々1件しか生成されない（成約配分が会社×市場×商品につき1件のため）ため、
 * この4値の組み合わせだけで一意性が保証される。
 */
export function buildContractId(period: PeriodV2, market: string, product: string, companyId: string): string {
  return `SC-${period}-${market}-${product}-${companyId}`;
}

function resolveDueDate(contractedPeriod: PeriodV2, leadTimeTurns: number): PeriodV2 {
  if (!Number.isInteger(leadTimeTurns) || leadTimeTurns < 1) {
    throw new SalesValidationError(`リードタイムは1以上の整数である必要があります。受け取った値: ${leadTimeTurns}`);
  }
  let due = contractedPeriod;
  for (let i = 0; i < leadTimeTurns; i++) {
    due = nextPeriod(due);
  }
  return due;
}

/**
 * 成約配分結果一式から、この四半期に生成される契約一覧を作る
 * （成約量が0の会社には契約を作らない）。
 */
export function createContractsFromAllocation(
  allocations: readonly MarketProductAllocationResult[],
  plans: readonly CompanySalesPlanEntry[],
  params: SalesParameters
): readonly SalesContract[] {
  const planByKey = new Map<string, CompanySalesPlanEntry>();
  for (const p of plans) {
    planByKey.set(`${p.companyId}::${p.market}::${p.product}`, p);
  }

  const contracts: SalesContract[] = [];
  const seenIds = new Set<string>();

  for (const allocation of allocations) {
    for (const company of allocation.companies) {
      if (unwrapUnit(company.allocatedQuantity) <= 0) continue;

      const plan = planByKey.get(`${company.companyId}::${allocation.market}::${allocation.product}`);
      const leadTimeTurns = plan?.desiredLeadTimeTurns ?? params.standardLeadTimeTurns;
      const dueDate = resolveDueDate(allocation.period, leadTimeTurns);
      const contractId = buildContractId(allocation.period, allocation.market, allocation.product, company.companyId);

      if (seenIds.has(contractId)) {
        throw new SalesValidationError(`契約ID "${contractId}" が重複しています（内部不整合）。`);
      }
      seenIds.add(contractId);

      // 【Phase 6.3（実装指示 §9）】販売計画が予想原価を持つ場合、契約時
      // スナップショットとして保持する（契約後の原料高でも契約単価は自動改定
      // しない。Phase 8で実績原価との突き合わせに使う）。
      const expectation = plan?.costExpectation;
      const costSnapshot =
        expectation !== undefined
          ? {
              ...expectation,
              expectedContributionMarginUsdPerHosoEqKg:
                unwrapUnit(company.askPrice) -
                expectation.expectedRawMaterialPriceUsdPerHosoEqKg -
                expectation.expectedProcessingCostUsdPerHosoEqKg,
            }
          : undefined;

      contracts.push({
        contractId,
        companyId: company.companyId,
        market: allocation.market,
        product: allocation.product,
        contractedPeriod: allocation.period,
        dueDate,
        originalQuantity: hosoEqTons(unwrapUnit(company.allocatedQuantity)),
        outstandingQuantity: hosoEqTons(unwrapUnit(company.allocatedQuantity)),
        unitPrice: company.askPrice,
        status: "open",
        ...(costSnapshot !== undefined ? { costSnapshot } : {}),
      });
    }
  }

  return contracts;
}
