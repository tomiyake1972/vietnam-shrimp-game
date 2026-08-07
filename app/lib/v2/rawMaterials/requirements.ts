// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 必要原料量集計（Phase 5）
//
// Phase4の約定残（SalesContract[]）から、会社×納期×商品区分別の必要HOSO換算
// 数量を集計する純粋関数のみを提供する。これは意思決定支援情報であり、
// 必要量を自動発注・自動調達しない（実装指示「必要量を自動調達しないこと」に
// 対応）。調達量（国内買付・輸入・養殖）はすべて会社の入力によって決まる。

import { PeriodV2 } from "../core/period";
import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { Product } from "../market/types";
import { CompanyId, SalesContract } from "../sales/types";
import { RawMaterialRequirementEntry } from "./types";

interface RequirementAccumulator {
  readonly companyId: CompanyId;
  readonly dueDate: PeriodV2;
  readonly product: Product;
  total: number;
}

/**
 * 未完了（open・partiallyFulfilled・overdue）な契約のoutstandingQuantityを、
 * 会社×納期(dueDate)×商品区分ごとに合計する。fulfilled・cancelledの契約は
 * 未履行数量が0のため対象外（overdueは「まだ履行が必要」という点では
 * open/partiallyFulfilledと変わらないため集計に含める）。
 */
export function summarizeRawMaterialRequirements(
  contracts: readonly SalesContract[]
): readonly RawMaterialRequirementEntry[] {
  const totals = new Map<string, RequirementAccumulator>();

  for (const contract of contracts) {
    if (contract.status === "fulfilled" || contract.status === "cancelled") continue;
    const outstanding = unwrapUnit(contract.outstandingQuantity);
    if (outstanding <= 0) continue;

    const key = `${contract.companyId}::${contract.dueDate}::${contract.product}`;
    const existing = totals.get(key);
    if (existing) {
      existing.total += outstanding;
    } else {
      totals.set(key, { companyId: contract.companyId, dueDate: contract.dueDate, product: contract.product, total: outstanding });
    }
  }

  return [...totals.values()]
    .sort((a, b) => {
      if (a.companyId !== b.companyId) return a.companyId.localeCompare(b.companyId);
      if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return a.product.localeCompare(b.product);
    })
    .map((entry) => ({
      companyId: entry.companyId,
      dueDate: entry.dueDate,
      product: entry.product,
      requiredQuantity: hosoEqTons(roundHosoEqTons(entry.total)),
    }));
}
