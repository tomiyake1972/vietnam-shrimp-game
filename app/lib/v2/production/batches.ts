// ShrimpX V2 — 工場・ワーカー・生産モジュール 生産バッチ生成（Phase 6）
//
// allocateProductionPlans（allocation.ts）が算出した配分結果を実際の原料消費・
// 生産バッチへ変換する。原料の実消費は、rawMaterials/inventory.ts の
// consumeRawMaterials をそのまま呼び出して行う（FIFO消費ロジックを再実装しない）。
// rawMaterialLotSelector（産地・調達源による絞り込み）が指定された場合のみ、
// 対象ロットを一時的に部分配列へ切り出してconsumeRawMaterialsへ渡し、結果を
// 元のロット配列へマージし直す（FIFOアルゴリズム自体はconsumeRawMaterialsの
// ものをそのまま使う。呼び出し前後の差分から消費内訳を復元するため、
// 独自のFIFO実装を持たない）。
//
// 原料消費量 = 完成品数量 + 加工損失（数量保存。歩留まりはallocation.tsで
// 既に一度だけ適用済みのallocatedQuantity/requiredRawMaterialQuantityを
// そのまま使うため、ここでは歩留まりを再適用しない）。

import { hosoEqTons, ratio, roundHosoEqTons, roundUsdM, unwrapUnit, usdM } from "../core/units";
import { PeriodV2 } from "../core/period";
import { consumeRawMaterials } from "../rawMaterials/inventory";
import { RawMaterialLot } from "../rawMaterials/types";
import { buildBatchId } from "./ids";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import {
  CompanyProductionPlanEntry,
  ProductionAllocationEntry,
  ProductionBatch,
  ProductionBatchRawMaterialConsumption,
  ProductionValidationError,
} from "./types";

const EPSILON = 1e-6;

function matchesSelector(lot: RawMaterialLot, selector: CompanyProductionPlanEntry["rawMaterialLotSelector"]): boolean {
  if (!selector) return true;
  if (selector.source !== undefined && lot.source !== selector.source) return false;
  if (selector.originCountry !== undefined && lot.originCountry !== selector.originCountry) return false;
  return true;
}

function totalAvailableForCompany(lots: readonly RawMaterialLot[], companyId: string, selector: CompanyProductionPlanEntry["rawMaterialLotSelector"]): number {
  return lots
    .filter((l) => l.companyId === companyId && l.status === "available" && matchesSelector(l, selector))
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function diffConsumed(before: readonly RawMaterialLot[], after: readonly RawMaterialLot[]): readonly ProductionBatchRawMaterialConsumption[] {
  const beforeById = new Map(before.map((l) => [l.lotId, l]));
  const consumed: ProductionBatchRawMaterialConsumption[] = [];
  for (const a of after) {
    const b = beforeById.get(a.lotId);
    if (!b) continue;
    const delta = unwrapUnit(b.remainingQuantity) - unwrapUnit(a.remainingQuantity);
    if (delta > EPSILON) {
      consumed.push({
        lotId: a.lotId,
        quantity: hosoEqTons(roundHosoEqTons(delta)),
        unitCost: b.unitCost,
        originCountry: b.originCountry,
      });
    }
  }
  return consumed;
}

/**
 * 会社の原料ロット群に対し、選択条件（省略時は全ロット・FIFO）で数量を消費する。
 * consumeRawMaterials（rawMaterials/inventory.ts）を必ず経由し、消費内訳は
 * 呼び出し前後のremainingQuantityの差分から復元する。
 */
function consumeForPlan(
  lots: readonly RawMaterialLot[],
  companyId: string,
  quantity: number,
  selector: CompanyProductionPlanEntry["rawMaterialLotSelector"]
): { readonly updatedLots: readonly RawMaterialLot[]; readonly consumed: readonly ProductionBatchRawMaterialConsumption[] } {
  if (quantity <= EPSILON) {
    return { updatedLots: lots, consumed: [] };
  }

  if (!selector) {
    const after = consumeRawMaterials(lots, [{ companyId, quantity: hosoEqTons(quantity) }]);
    return { updatedLots: after, consumed: diffConsumed(lots, after) };
  }

  const matching = lots.filter((l) => l.companyId === companyId && matchesSelector(l, selector));
  const matchingAvailable = matching
    .filter((l) => l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  const clippedQuantity = Math.min(quantity, matchingAvailable);
  if (clippedQuantity <= EPSILON) {
    return { updatedLots: lots, consumed: [] };
  }

  const updatedMatching = consumeRawMaterials(matching, [{ companyId, quantity: hosoEqTons(clippedQuantity) }]);
  const updatedById = new Map(updatedMatching.map((l) => [l.lotId, l]));
  const updatedLots = lots.map((l) => updatedById.get(l.lotId) ?? l);
  return { updatedLots, consumed: diffConsumed(matching, updatedMatching) };
}

function weightedRawMaterialCost(consumed: readonly ProductionBatchRawMaterialConsumption[], hosoEqKgPerTon: number): number {
  const totalUsd = consumed.reduce((sum, c) => sum + unwrapUnit(c.quantity) * hosoEqKgPerTon * unwrapUnit(c.unitCost), 0);
  return totalUsd / 1_000_000;
}

export interface ProductionBatchBuildResult {
  readonly batches: readonly ProductionBatch[];
  readonly updatedRawMaterialLots: readonly RawMaterialLot[];
}

/**
 * 配分結果（allocation.tsの出力）と原料在庫から、生産バッチを生成し、
 * 消費された原料ロットを反映した新しい原料ロット配列を返す（純粋関数、
 * 入力lotsは変更しない）。plansとallocation.entriesは同じ配列長・同じ順序
 * （allocation.tsがplansをそのままmapして生成する）であることを前提とする。
 *
 * 消費順序（複数会社・複数計画が同じ会社の原料在庫を取り合う場合の実消費順）は
 * (companyId, priority昇順, factoryId, product, 元のplans配列インデックス) で
 * 決定論的に固定する（優先度が高い計画から先に実際の在庫を引き当てる）。
 */
export function buildProductionBatches(
  plans: readonly CompanyProductionPlanEntry[],
  entries: readonly ProductionAllocationEntry[],
  rawMaterialLots: readonly RawMaterialLot[],
  period: PeriodV2,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): ProductionBatchBuildResult {
  if (plans.length !== entries.length) {
    throw new ProductionValidationError("plansとentriesの配列長が一致しません。allocateProductionPlansの出力をそのまま渡してください。");
  }

  const order = plans
    .map((p, index) => ({ p, e: entries[index], index }))
    .sort((a, b) => {
      if (a.p.companyId !== b.p.companyId) return a.p.companyId.localeCompare(b.p.companyId);
      if (a.p.priority !== b.p.priority) return a.p.priority - b.p.priority;
      if (a.p.factoryId !== b.p.factoryId) return a.p.factoryId.localeCompare(b.p.factoryId);
      if (a.p.product !== b.p.product) return a.p.product.localeCompare(b.p.product);
      return a.index - b.index;
    });

  const batchByIndex = new Map<number, ProductionBatch>();
  let currentLots = rawMaterialLots;

  for (const { p, e, index } of order) {
    const requiredRaw = unwrapUnit(e.requiredRawMaterialQuantity);
    const clippedRequired = Math.min(requiredRaw, totalAvailableForCompany(currentLots, p.companyId, p.rawMaterialLotSelector));
    const { updatedLots, consumed } = consumeForPlan(currentLots, p.companyId, clippedRequired, p.rawMaterialLotSelector);
    currentLots = updatedLots;

    const rawMaterialConsumedTotal = consumed.reduce((sum, c) => sum + unwrapUnit(c.quantity), 0);
    // 完成品数量は、実際に消費できた原料量に基づいて再計算する（原料不足で
    // clippedRequiredがrequiredRawより小さくなった場合、完成品数量もそれに応じて
    // 減らす。歩留まりはここでも一度だけ、allocatedQuantity/requiredRawより
    // 導出した比率で適用する）。
    const yieldRatio = requiredRaw > EPSILON ? unwrapUnit(e.allocatedQuantity) / requiredRaw : 0;
    const finishedGoodsQuantity = Math.max(0, roundHosoEqTons(rawMaterialConsumedTotal * yieldRatio));
    const processingLoss = Math.max(0, roundHosoEqTons(rawMaterialConsumedTotal - finishedGoodsQuantity));

    const rawMaterialCost = usdM(roundUsdM(weightedRawMaterialCost(consumed, params.cost.hosoEqKgPerTon)));
    const baseProcessingCost = usdM(roundUsdM((finishedGoodsQuantity * params.cost.baseProcessingCostUsdPerTon[p.product]) / 1_000_000));

    const desired = unwrapUnit(e.desiredQuantity);
    const utilizationIndex = desired > EPSILON ? Math.min(1, Math.max(0, finishedGoodsQuantity / desired)) : 0;

    const batch: ProductionBatch = {
      batchId: buildBatchId(p.companyId, p.factoryId, p.product, period, index + 1),
      companyId: p.companyId,
      factoryId: p.factoryId,
      product: p.product,
      period,
      rawMaterialConsumed: consumed,
      rawMaterialConsumedTotal: hosoEqTons(roundHosoEqTons(rawMaterialConsumedTotal)),
      finishedGoodsQuantity: hosoEqTons(finishedGoodsQuantity),
      processingLoss: hosoEqTons(processingLoss),
      rawMaterialCost,
      baseProcessingCost,
      capacityUtilizationIndex: ratio(Math.round(utilizationIndex * 10000) / 10000),
      shortfallQuantity: e.shortfallQuantity,
      shortfallReasons: e.shortfallReasons,
    };
    batchByIndex.set(index, batch);
  }

  const batches = plans.map((_, index) => batchByIndex.get(index)!);
  return { batches, updatedRawMaterialLots: currentLots };
}
