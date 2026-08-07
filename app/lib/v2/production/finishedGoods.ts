// ShrimpX V2 — 工場・ワーカー・生産モジュール 完成品在庫（Phase 6）
//
// rawMaterials/inventory.ts の原料ロットFIFO消費（consumeRawMaterials）と
// 同じ設計（会社×商品単位、FIFO、過剰消費拒否、数量保存、四半期末の期限切れ処理）を
// 完成品ロットに対して適用する。ロットの形は違う（対応する原料ロット・原産国等の
// トレーサビリティ情報を追加で持つ）ため、rawMaterialsのFIFO関数を直接は
// 呼び出さず、同じアルゴリズム（フィルタ→決定論的ソート→合計確認→順次消費）を
// 完成品ロット向けに実装する。

import { nextPeriod, PeriodV2 } from "../core/period";
import { hosoEqTons, roundHosoEqTons, roundUsdPerHosoEqKg, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { buildFinishedGoodsLotId } from "./ids";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import { FinishedGoodsConsumptionInstruction, FinishedGoodsLot, ProductionBatch, ProductionValidationError } from "./types";

const EPSILON = 1e-6;

function resolveExpiryPeriod(fromPeriod: PeriodV2, params: ProductionParameters): PeriodV2 | undefined {
  const shelfLifeTurns = params.finishedGoods.defaultShelfLifeTurns;
  if (shelfLifeTurns === undefined) return undefined;
  if (!Number.isInteger(shelfLifeTurns) || shelfLifeTurns < 1) {
    throw new ProductionValidationError(`defaultShelfLifeTurns は1以上の整数である必要があります。受け取った値: ${shelfLifeTurns}`);
  }
  let expiry = fromPeriod;
  for (let i = 0; i < shelfLifeTurns; i++) {
    expiry = nextPeriod(expiry);
  }
  return expiry;
}

/** 生産バッチから、即時使用可能な（status="available"）完成品ロットを1件ずつ生成する。finishedGoodsQuantityが0のバッチは対象外。 */
export function createFinishedGoodsLots(batches: readonly ProductionBatch[], params: ProductionParameters = PRODUCTION_PARAMETERS_V1): readonly FinishedGoodsLot[] {
  let sequence = 0;
  return batches
    .filter((b) => unwrapUnit(b.finishedGoodsQuantity) > EPSILON)
    .map((b) => {
      sequence += 1;
      const totalRawQuantity = b.rawMaterialConsumed.reduce((sum, c) => sum + unwrapUnit(c.quantity), 0);
      const weightedUnitCostUsd = b.rawMaterialConsumed.reduce((sum, c) => sum + unwrapUnit(c.quantity) * unwrapUnit(c.unitCost), 0);
      const rawMaterialUnitCost = totalRawQuantity > EPSILON ? weightedUnitCostUsd / totalRawQuantity : 0;
      const originCountries = Array.from(new Set(b.rawMaterialConsumed.map((c) => c.originCountry))).sort();

      return {
        lotId: buildFinishedGoodsLotId(b.companyId, b.factoryId, b.product, b.period, sequence),
        companyId: b.companyId,
        factoryId: b.factoryId,
        product: b.product,
        producedPeriod: b.period,
        originalQuantity: b.finishedGoodsQuantity,
        remainingQuantity: b.finishedGoodsQuantity,
        sourceRawMaterialLots: b.rawMaterialConsumed,
        rawMaterialOriginCountries: originCountries,
        rawMaterialUnitCost: usdPerHosoEqKg(roundUsdPerHosoEqKg(rawMaterialUnitCost)),
        baseProcessingCost: b.baseProcessingCost,
        availableFromPeriod: b.period,
        expiryPeriod: resolveExpiryPeriod(b.period, params),
        status: "available" as const,
      };
    });
}

/**
 * 会社×商品単位の消費指示を、FIFO（availableFromPeriod → producedPeriod → lotId の
 * 順で古い順）で status="available" の完成品ロットへ適用する純粋関数（不変更新）。
 * 1社×1商品の消費可能合計を超える指示は例外（過剰消費拒否）。remainingQuantityが
 * 0になったロットはstatus="allocated"へ遷移する（originalQuantityは変更しない。
 * 数量保存を保証する）。
 */
export function consumeFinishedGoods(
  lots: readonly FinishedGoodsLot[],
  instructions: readonly FinishedGoodsConsumptionInstruction[]
): readonly FinishedGoodsLot[] {
  let current = [...lots];

  for (const instruction of instructions) {
    let remaining = unwrapUnit(instruction.quantity);
    if (remaining <= 0) {
      throw new ProductionValidationError(
        `会社 "${instruction.companyId}" 商品 "${instruction.product}" への消費数量は正の数である必要があります。受け取った値: ${remaining}`
      );
    }

    const candidateIds = current
      .filter(
        (l) => l.companyId === instruction.companyId && l.product === instruction.product && l.status === "available" && unwrapUnit(l.remainingQuantity) > EPSILON
      )
      .sort((a, b) => {
        if (a.availableFromPeriod !== b.availableFromPeriod) return a.availableFromPeriod.localeCompare(b.availableFromPeriod);
        if (a.producedPeriod !== b.producedPeriod) return a.producedPeriod.localeCompare(b.producedPeriod);
        return a.lotId.localeCompare(b.lotId);
      })
      .map((l) => l.lotId);

    const totalAvailable = candidateIds.reduce((sum, id) => {
      const lot = current.find((l) => l.lotId === id);
      return sum + (lot ? unwrapUnit(lot.remainingQuantity) : 0);
    }, 0);

    if (remaining > totalAvailable + EPSILON) {
      throw new ProductionValidationError(
        `会社 "${instruction.companyId}" 商品 "${instruction.product}" の消費数量（${remaining}）が、使用可能完成品在庫の合計（${totalAvailable}）を超えています（過剰消費拒否）。`
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
          ? { ...l, remainingQuantity: hosoEqTons(newRemaining), status: newRemaining <= EPSILON ? ("allocated" as const) : l.status }
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
export function applyFinishedGoodsExpiryForQuarterEnd(lots: readonly FinishedGoodsLot[], asOfPeriod: PeriodV2): readonly FinishedGoodsLot[] {
  return lots.map((lot) => {
    if (lot.status !== "available") return lot;
    if (!lot.expiryPeriod) return lot;
    if (lot.expiryPeriod.localeCompare(asOfPeriod) >= 0) return lot;
    return { ...lot, status: "expired" as const };
  });
}
