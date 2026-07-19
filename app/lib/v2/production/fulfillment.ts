// ShrimpX V2 — 工場・ワーカー・生産モジュール 契約履行（Phase 6）
//
// Phase4の約定残（SalesContract）へ完成品を充当する計画を立てる純粋関数。
// 実際の契約状態遷移はPhase4の既存関数 applyFulfillments（sales/backlog.ts）を
// そのまま再利用する（本ファイルは契約状態を直接書き換えない。呼び出し側が
// planContractFulfillmentの出力をapplyFulfillmentsへ渡す）。
//
//   - 会社と商品が一致する完成品だけを使用する（市場・原産国は今回は制約としない。
//     将来Phaseで拡張できるようRawMaterialLotSelectorに類する構造を追加できる
//     余地を残す）。
//   - 納期の早い契約から処理する。同一納期では契約ID順（入力順に依存しない）。
//   - 部分履行を認める。完成品不足では約定残を残す。契約数量を超えて履行しない。
//   - 履行量と使用完成品ロットを追跡する（usage）。
//
// applyFulfillments はFIFO指示にmarketも要求するが、本Phaseは商品一致のみを
// 必須条件とする（market横断でのFIFO）ため、ExplicitFulfillmentInstruction
// （契約ID指定）へ変換して渡す。完成品ロットの実消費（remainingQuantityの減少）は
// 別途 finishedGoods.ts の consumeFinishedGoods を、本関数が返す
// finishedGoodsConsumption（会社×商品単位の集計量）で呼び出す想定（同じFIFO順序
// ルールで消費するため、契約側の使用内訳と完成品ロット側の消費量は整合する）。

import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { SalesContract } from "../sales/types";
import { ContractFulfillmentPlan, FinishedGoodsConsumptionInstruction, FinishedGoodsLot, FinishedGoodsUsageRecord } from "./types";

const EPSILON = 1e-6;

function isFulfillableContract(c: SalesContract): boolean {
  return c.status !== "cancelled" && c.status !== "fulfilled" && unwrapUnit(c.outstandingQuantity) > EPSILON;
}

/**
 * 完成品在庫（status="available"）を、約定残の中で納期の早い契約から順に
 * 割り当てる計画を立てる（純粋関数、入力contracts/finishedGoodsLotsは変更しない）。
 */
export function planContractFulfillment(
  contracts: readonly SalesContract[],
  finishedGoodsLots: readonly FinishedGoodsLot[]
): ContractFulfillmentPlan {
  // 会社×商品ごとに、使用可能な完成品ロットをFIFO順（consumeFinishedGoodsと
  // 同一の並び替えルール: availableFromPeriod → producedPeriod → lotId）で並べ、
  // 残量をローカルにシミュレートする。
  type LotCursor = { readonly lotId: string; remaining: number };
  const key = (companyId: string, product: string) => `${companyId}::${product}`;

  const lotCursorsByKey = new Map<string, LotCursor[]>();
  const availableLots = finishedGoodsLots.filter((l) => l.status === "available" && unwrapUnit(l.remainingQuantity) > EPSILON);
  const groupKeys = new Set(availableLots.map((l) => key(l.companyId, l.product)));
  for (const k of groupKeys) {
    const cursors = availableLots
      .filter((l) => key(l.companyId, l.product) === k)
      .sort((a, b) => {
        if (a.availableFromPeriod !== b.availableFromPeriod) return a.availableFromPeriod.localeCompare(b.availableFromPeriod);
        if (a.producedPeriod !== b.producedPeriod) return a.producedPeriod.localeCompare(b.producedPeriod);
        return a.lotId.localeCompare(b.lotId);
      })
      .map((l) => ({ lotId: l.lotId, remaining: unwrapUnit(l.remainingQuantity) }));
    lotCursorsByKey.set(k, cursors);
  }

  const sortedContracts = [...contracts]
    .filter(isFulfillableContract)
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return a.contractId.localeCompare(b.contractId);
    });

  const explicitByContract = new Map<string, number>();
  const usage: FinishedGoodsUsageRecord[] = [];
  const consumptionByKey = new Map<string, number>();

  for (const contract of sortedContracts) {
    const k = key(contract.companyId, contract.product);
    const cursors = lotCursorsByKey.get(k);
    if (!cursors) continue;

    let need = unwrapUnit(contract.outstandingQuantity);
    for (const cursor of cursors) {
      if (need <= EPSILON) break;
      if (cursor.remaining <= EPSILON) continue;
      const take = Math.min(need, cursor.remaining);
      cursor.remaining = roundHosoEqTons(cursor.remaining - take);
      need = roundHosoEqTons(need - take);

      usage.push({
        contractId: contract.contractId,
        companyId: contract.companyId,
        product: contract.product,
        lotId: cursor.lotId,
        quantity: hosoEqTons(take),
      });
      explicitByContract.set(contract.contractId, roundHosoEqTons((explicitByContract.get(contract.contractId) ?? 0) + take));
      consumptionByKey.set(k, roundHosoEqTons((consumptionByKey.get(k) ?? 0) + take));
    }
  }

  const explicitInstructions = Array.from(explicitByContract.entries())
    .filter(([, quantity]) => quantity > EPSILON)
    .map(([contractId, quantity]) => ({ kind: "explicit" as const, contractId, quantity: hosoEqTons(quantity) }));

  const finishedGoodsConsumption: FinishedGoodsConsumptionInstruction[] = Array.from(consumptionByKey.entries())
    .filter(([, quantity]) => quantity > EPSILON)
    .map(([k, quantity]) => {
      const [companyId, product] = k.split("::");
      return { companyId, product: product as FinishedGoodsConsumptionInstruction["product"], quantity: hosoEqTons(quantity) };
    });

  return { explicitInstructions, finishedGoodsConsumption, usage };
}
