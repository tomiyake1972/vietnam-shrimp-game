// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 約定残管理（Phase 4）
//
// 実際の生産・出荷量はPhase6で決まるため、本ファイルは「履行実績を外部から
// 受け取り、約定残へ適用する」純粋関数のみを提供する。自動的に生産・出荷した
// ことにはしない（advanceSalesQuarterはこれらの関数を呼ばない。呼び出し側が
// 明示的に呼ぶ設計）。
//
// 売上・売掛金・利益はまだ計上しない（本モジュールの型に金額フィールドは
// 一切存在しない）。

import { PeriodV2 } from "../core/period";
import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { ContractStatus, FulfillmentInstruction, SalesContract, SalesValidationError } from "./types";

const EPSILON = 1e-6;

function statusAfterFulfillment(previousStatus: ContractStatus, outstandingQuantity: number): ContractStatus {
  if (previousStatus === "cancelled") return previousStatus;
  if (outstandingQuantity <= EPSILON) return "fulfilled";
  // 既に部分履行または未履行のいずれかから、少しでも履行が進めば一部履行とする。
  return "partiallyFulfilled";
}

/** 1件の契約へ履行数量を適用した新しい契約を返す（不変更新）。過剰履行・完了済み契約への適用は例外。 */
function applyQuantityToContract(contract: SalesContract, quantity: number): SalesContract {
  if (contract.status === "cancelled") {
    throw new SalesValidationError(`契約 "${contract.contractId}" はキャンセル済みのため履行を適用できません。`);
  }
  if (contract.status === "fulfilled") {
    throw new SalesValidationError(`契約 "${contract.contractId}" はすでに完了しているため履行を適用できません。`);
  }
  if (quantity <= 0) {
    throw new SalesValidationError(`契約 "${contract.contractId}" への履行数量は正の数である必要があります。受け取った値: ${quantity}`);
  }
  const outstanding = unwrapUnit(contract.outstandingQuantity);
  if (quantity > outstanding + EPSILON) {
    throw new SalesValidationError(
      `契約 "${contract.contractId}" の未履行数量（${outstanding}）を超える履行（${quantity}）は適用できません（過剰履行拒否）。`
    );
  }
  const newOutstanding = Math.max(0, roundHosoEqTons(outstanding - quantity));
  return {
    ...contract,
    outstandingQuantity: hosoEqTons(newOutstanding),
    status: statusAfterFulfillment(contract.status, newOutstanding),
  };
}

/**
 * 履行指示（明示的な契約指定、または会社・市場・商品別FIFO）を順に適用し、
 * 更新後の契約一覧を返す（不変更新。入力contractsは変更しない）。
 * FIFOは contractedPeriod → dueDate → contractId の順で決定論的にソートする。
 */
export function applyFulfillments(
  contracts: readonly SalesContract[],
  instructions: readonly FulfillmentInstruction[]
): readonly SalesContract[] {
  let current = [...contracts];

  for (const instruction of instructions) {
    if (instruction.kind === "explicit") {
      const idx = current.findIndex((c) => c.contractId === instruction.contractId);
      if (idx === -1) {
        throw new SalesValidationError(`契約ID "${instruction.contractId}" が見つかりません。`);
      }
      current = current.map((c, i) => (i === idx ? applyQuantityToContract(c, unwrapUnit(instruction.quantity)) : c));
      continue;
    }

    // FIFO: 対象を絞り込み、古い契約から順に消費する。
    let remaining = unwrapUnit(instruction.quantity);
    if (remaining <= 0) {
      throw new SalesValidationError(`FIFO履行数量は正の数である必要があります。受け取った値: ${remaining}`);
    }

    const candidateIds = current
      .filter(
        (c) =>
          c.companyId === instruction.companyId &&
          c.market === instruction.market &&
          c.product === instruction.product &&
          c.status !== "cancelled" &&
          c.status !== "fulfilled" &&
          unwrapUnit(c.outstandingQuantity) > EPSILON
      )
      .sort((a, b) => {
        if (a.contractedPeriod !== b.contractedPeriod) return a.contractedPeriod.localeCompare(b.contractedPeriod);
        if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        return a.contractId.localeCompare(b.contractId);
      })
      .map((c) => c.contractId);

    const totalAvailable = candidateIds.reduce((sum, id) => {
      const c = current.find((x) => x.contractId === id);
      return sum + (c ? unwrapUnit(c.outstandingQuantity) : 0);
    }, 0);

    if (remaining > totalAvailable + EPSILON) {
      throw new SalesValidationError(
        `会社 "${instruction.companyId}" market="${instruction.market}" product="${instruction.product}" のFIFO履行数量（${remaining}）が、未履行契約の合計（${totalAvailable}）を超えています（過剰履行拒否）。`
      );
    }

    for (const id of candidateIds) {
      if (remaining <= EPSILON) break;
      const contract = current.find((c) => c.contractId === id);
      if (!contract) continue;
      const outstanding = unwrapUnit(contract.outstandingQuantity);
      const consume = Math.min(outstanding, remaining);
      current = current.map((c) => (c.contractId === id ? applyQuantityToContract(c, consume) : c));
      remaining -= consume;
    }
  }

  return current;
}

/**
 * 契約を明示的にキャンセルする（不変更新）。既に完了・キャンセル済みの契約は例外。
 */
export function cancelContract(contracts: readonly SalesContract[], contractId: string): readonly SalesContract[] {
  const idx = contracts.findIndex((c) => c.contractId === contractId);
  if (idx === -1) {
    throw new SalesValidationError(`契約ID "${contractId}" が見つかりません。`);
  }
  const contract = contracts[idx];
  if (contract.status === "fulfilled" || contract.status === "cancelled") {
    throw new SalesValidationError(`契約 "${contractId}" は状態 "${contract.status}" のためキャンセルできません。`);
  }
  return contracts.map((c, i) => (i === idx ? { ...c, status: "cancelled" as const } : c));
}

/**
 * 四半期末の契約状態更新（純粋関数）。currentPeriod時点で dueDate を過ぎており、
 * まだ未履行数量が残っている契約を "overdue" にする。完了・キャンセル済みの
 * 契約はそのまま。文字列比較でよい（PeriodV2は "YYYYQn" 形式で辞書順=時系列順）。
 */
export function updateContractStatusesForQuarterEnd(
  contracts: readonly SalesContract[],
  currentPeriod: PeriodV2
): readonly SalesContract[] {
  return contracts.map((c) => {
    if (c.status === "fulfilled" || c.status === "cancelled") return c;
    const isPastDue = c.dueDate.localeCompare(currentPeriod) < 0;
    const hasOutstanding = unwrapUnit(c.outstandingQuantity) > EPSILON;
    if (isPastDue && hasOutstanding) {
      return { ...c, status: "overdue" as const };
    }
    return c;
  });
}
