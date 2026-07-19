// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 原料在庫管理（Phase 5）
//
// 国内買付・輸入・自社養殖のいずれの調達源から生まれたロットも、同じ
// RawMaterialLot型・同じFIFO消費関数で扱う。次を明確に区別する。
//   使用可能在庫(available) / 輸送中輸入原料(inTransitImport) /
//   養殖中(growingAquaculture) / 消費済み(consumed) / 期限切れ・廃棄(expired)
//
// Phase6から外部消費量を受け取り、FIFOで在庫を消費する純粋関数を提供する
// （過剰消費は拒否し、数量保存を保証する）。廃棄損・棚卸資産の会計計上は
// Phase8へ渡せる情報（expired状態のロット一覧）だけ保持し、本Phaseでは行わない。

import { nextPeriod, PeriodV2 } from "../core/period";
import { hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import {
  DomesticPurchaseAllocationResult,
  RawMaterialConsumptionInstruction,
  RawMaterialLot,
  RawMaterialsValidationError,
} from "./types";
import { RawMaterialsParameters } from "./parameters";
import { buildLotId } from "./inventoryIds";

const EPSILON = 1e-6;

/** 空の原料在庫状態を作る（ロット・履歴なし）。 */
export function initializeRawMaterialInventory(startPeriod: PeriodV2): { readonly currentPeriod: PeriodV2; readonly lots: readonly RawMaterialLot[] } {
  return { currentPeriod: startPeriod, lots: [] };
}

function resolveExpiryPeriod(fromPeriod: PeriodV2, params: RawMaterialsParameters): PeriodV2 | undefined {
  const shelfLifeTurns = params.inventory.defaultShelfLifeTurns;
  if (shelfLifeTurns === undefined) return undefined;
  if (!Number.isInteger(shelfLifeTurns) || shelfLifeTurns < 1) {
    throw new RawMaterialsValidationError(`defaultShelfLifeTurns は1以上の整数である必要があります。受け取った値: ${shelfLifeTurns}`);
  }
  let expiry = fromPeriod;
  for (let i = 0; i < shelfLifeTurns; i++) {
    expiry = nextPeriod(expiry);
  }
  return expiry;
}

/**
 * 国内買付配分結果から、即時使用可能な（status="available"）原料ロットを
 * 会社ごとに1件ずつ生成する（配分量が0の会社にはロットを作らない）。
 *
 * ロットの単位取得原価（unitCost）は max(marketPrice, bidPrice) とする。
 * 提示買付価格（bidPrice）はminBidPriceRatioOfMarket（既定0.5倍）まで市場価格を
 * 下回ることを許容しているため、bidPriceをそのまま取得原価とすると「市場価格より
 * 安く自動的に原料を確保できる」ことになってしまう。高値を提示して優先的に
 * 確保した会社はその提示価格をそのまま取得原価として保持する一方、低い提示価格
 * では市場価格を下回る取得原価にはならないようにする。
 */
export function createDomesticPurchaseLots(
  allocation: DomesticPurchaseAllocationResult,
  params: RawMaterialsParameters
): readonly RawMaterialLot[] {
  let sequence = 0;
  return allocation.companies
    .filter((c) => unwrapUnit(c.allocatedQuantity) > 0)
    .map((c) => {
      sequence += 1;
      const lotId = buildLotId("domestic", c.companyId, allocation.period, "VN", sequence);
      const unitCost = usdPerHosoEqKg(Math.max(unwrapUnit(allocation.marketPrice), unwrapUnit(c.bidPrice)));
      return {
        lotId,
        companyId: c.companyId,
        source: "domestic" as const,
        originCountry: "VN" as const,
        inboundPeriod: allocation.period,
        originalQuantity: c.allocatedQuantity,
        remainingQuantity: c.allocatedQuantity,
        unitCost,
        availableFromPeriod: allocation.period,
        expiryPeriod: resolveExpiryPeriod(allocation.period, params),
        status: "available" as const,
      };
    });
}

/**
 * Phase6から渡される会社別の消費指示を、FIFO（availableFromPeriod →
 * inboundPeriod → lotId の順で古い順）で status="available" のロットへ適用する
 * 純粋関数（不変更新）。1社の消費可能合計を超える指示は例外（過剰消費拒否）。
 * 部分消費・完全消費のいずれでも数量は保存される
 * （originalQuantityは変更せず、remainingQuantityのみ減少する）。
 */
export function consumeRawMaterials(
  lots: readonly RawMaterialLot[],
  instructions: readonly RawMaterialConsumptionInstruction[]
): readonly RawMaterialLot[] {
  let current = [...lots];

  for (const instruction of instructions) {
    let remaining = unwrapUnit(instruction.quantity);
    if (remaining <= 0) {
      throw new RawMaterialsValidationError(`会社 "${instruction.companyId}" への消費数量は正の数である必要があります。受け取った値: ${remaining}`);
    }

    const candidateIds = current
      .filter((l) => l.companyId === instruction.companyId && l.status === "available" && unwrapUnit(l.remainingQuantity) > EPSILON)
      .sort((a, b) => {
        if (a.availableFromPeriod !== b.availableFromPeriod) return a.availableFromPeriod.localeCompare(b.availableFromPeriod);
        if (a.inboundPeriod !== b.inboundPeriod) return a.inboundPeriod.localeCompare(b.inboundPeriod);
        return a.lotId.localeCompare(b.lotId);
      })
      .map((l) => l.lotId);

    const totalAvailable = candidateIds.reduce((sum, id) => {
      const lot = current.find((l) => l.lotId === id);
      return sum + (lot ? unwrapUnit(lot.remainingQuantity) : 0);
    }, 0);

    if (remaining > totalAvailable + EPSILON) {
      throw new RawMaterialsValidationError(
        `会社 "${instruction.companyId}" の消費数量（${remaining}）が、使用可能在庫の合計（${totalAvailable}）を超えています（過剰消費拒否）。`
      );
    }

    for (const id of candidateIds) {
      if (remaining <= EPSILON) break;
      const lot = current.find((l) => l.lotId === id);
      if (!lot) continue;
      const lotRemaining = unwrapUnit(lot.remainingQuantity);
      const consume = Math.min(lotRemaining, remaining);
      const newRemaining = Math.max(0, roundHosoEqTons(lotRemaining - consume));
      current = current.map((l) =>
        l.lotId === id
          ? { ...l, remainingQuantity: hosoEqTons(newRemaining), status: newRemaining <= EPSILON ? ("consumed" as const) : l.status }
          : l
      );
      remaining -= consume;
    }
  }

  return current;
}

/**
 * 四半期末の期限切れ処理（純粋関数）。status="available"かつexpiryPeriodが
 * asOfPeriodより前のロットをstatus="expired"へ遷移させる（remainingQuantityは
 * そのまま保持し、数量を保存する。廃棄損の会計計上はPhase8）。
 */
export function applyExpiryForQuarterEnd(lots: readonly RawMaterialLot[], asOfPeriod: PeriodV2): readonly RawMaterialLot[] {
  return lots.map((lot) => {
    if (lot.status !== "available") return lot;
    if (!lot.expiryPeriod) return lot;
    if (lot.expiryPeriod.localeCompare(asOfPeriod) >= 0) return lot;
    return { ...lot, status: "expired" as const };
  });
}
