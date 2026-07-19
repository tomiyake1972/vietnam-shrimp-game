// ShrimpX V2 — 工場・ワーカー・生産モジュール 生産計画の制約配分（Phase 6）
//
// 実際の生産量は、少なくとも次の最小値で制約する（§4「生産可能量」）。
//   生産希望量 / 使用可能な原料在庫 / 工場共通処理能力 / 商品別設備能力 /
//   冷凍・包装能力 / 有効労働能力
// 複数商品が共通能力・原料を競合する場合は、生産優先順位（priority）に従い、
// 同順位では入力順に依存しない決定論的配分を行う（priorityAllocation.ts、
// rawMaterials/waterFill.ts の水位法をそのまま再利用）。
//
// 制約の適用順序: 原料（会社単位の共有プール）→ 工場共通処理能力（工場単位の
// 共有プール）→ 冷凍・包装能力（工場単位の共有プール）→ 商品別設備能力
// （工場×商品単位の専用プール）→ 有効労働能力（商品ごとに独立したケイパビリティ
// 上限。労働は複数商品間で奪い合う共有プールとしては扱わない設計判断。
// §「単位についての設計判断」注記のとおり、これは仕様が明記していない箇所への
// 実装判断であり、将来より精緻な「共有労働時間プール」モデルへ拡張する余地がある）。
//
// 原料消費量→完成品数量の変換（歩留まり）は、この配分計算の中で一度だけ適用する
// （希望量→必要原料量の逆算、および最終配分量→必要原料量の順算のいずれも
// 同じ baseYieldRatio を使い、二重に適用しない）。

import { hosoEqTons, ratio, roundHosoEqTons, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { Product } from "../market/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { calculateFactoryEffectiveCapacity } from "./capacity";
import { calculateEffectiveLaborCapacity, effectiveLaborCapacityForProduct } from "./labor";
import { allocateByPriorityTiers, PriorityAllocationItem } from "./priorityAllocation";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import {
  CompanyProductionPlanEntry,
  Factory,
  FactoryEffectiveCapacity,
  ProductionAllocationEntry,
  ProductionAllocationResult,
  ProductionShortfallReason,
  ProductionValidationError,
  WorkerAssignment,
} from "./types";

function capacityPoolFor(factoryCapacity: FactoryEffectiveCapacity, product: Product): number {
  if (product === "hoso") return unwrapUnit(factoryCapacity.hoso);
  if (product === "pd") return unwrapUnit(factoryCapacity.pd);
  return unwrapUnit(factoryCapacity.vap);
}

function emptyWorkerAssignment(factoryId: string, companyId: string): WorkerAssignment {
  return {
    factoryId,
    companyId,
    regularHeadcount: 0,
    temporaryHeadcount: 0,
    skills: [],
    overtimeRate: ratio(0),
    attendanceRate: ratio(0),
  };
}

function applyTier(
  candidates: readonly number[],
  ids: readonly string[],
  priorities: readonly number[],
  groupKeys: readonly string[],
  budgetByGroup: ReadonlyMap<string, number>
): number[] {
  const groups = new Set(groupKeys);
  const result = new Array<number>(ids.length).fill(0);
  for (const group of groups) {
    const items: PriorityAllocationItem[] = [];
    const indices: number[] = [];
    ids.forEach((id, idx) => {
      if (groupKeys[idx] === group) {
        items.push({ id, priority: priorities[idx], desired: candidates[idx] });
        indices.push(idx);
      }
    });
    const budget = budgetByGroup.get(group) ?? 0;
    const allocated = allocateByPriorityTiers(items, budget);
    indices.forEach((idx) => {
      result[idx] = allocated.get(ids[idx]) ?? 0;
    });
  }
  return result;
}

/**
 * 生産計画一式を、原料・工場設備・労働の各制約に従って配分する（純粋関数）。
 * 入力（plans/factories/workerAssignments/rawMaterialLots）は一切変更しない。
 */
export function allocateProductionPlans(
  plans: readonly CompanyProductionPlanEntry[],
  factories: readonly Factory[],
  workerAssignments: readonly WorkerAssignment[],
  rawMaterialLots: readonly RawMaterialLot[],
  period: PeriodV2,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): ProductionAllocationResult {
  const epsilon = params.capacity.epsilon;

  const capacityById = new Map(factories.map((f) => [f.factoryId, calculateFactoryEffectiveCapacity(f)]));

  const ids = plans.map((_, i) => `plan-${i}`);
  const priorities = plans.map((p) => p.priority);

  const yieldRatios = plans.map((p) => {
    const r = params.yield.baseYieldRatio[p.product];
    if (!(r > 0) || !(r <= 1)) {
      throw new ProductionValidationError(`商品 "${p.product}" の基準歩留まりは(0,1]の範囲である必要があります。設定値: ${r}`);
    }
    return r;
  });

  // 各計画の希望原料消費量（希望量 / 歩留まり、maxRawMaterialConsumptionでさらにクリップ）。
  const rawMaterialRequiredDesired = plans.map((p, i) => {
    const required = unwrapUnit(p.desiredQuantity) / yieldRatios[i];
    return p.maxRawMaterialConsumption !== undefined ? Math.min(required, unwrapUnit(p.maxRawMaterialConsumption)) : required;
  });

  // ---- 段階1: 原料（会社単位の共有プール） ----
  const companyKeys = plans.map((p) => p.companyId);
  const rawMaterialBudgetByCompany = new Map<string, number>();
  for (const p of plans) {
    if (rawMaterialBudgetByCompany.has(p.companyId)) continue;
    const total = rawMaterialLots
      .filter((l) => l.companyId === p.companyId && l.status === "available")
      .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
    rawMaterialBudgetByCompany.set(p.companyId, total);
  }
  const rawMaterialAllocated = applyTier(rawMaterialRequiredDesired, ids, priorities, companyKeys, rawMaterialBudgetByCompany);
  const rawMaterialLimitedOutput = rawMaterialAllocated.map((raw, i) =>
    Math.min(unwrapUnit(plans[i].desiredQuantity), raw * yieldRatios[i])
  );

  // ---- 段階2: 工場共通処理能力（工場単位の共有プール） ----
  const factoryKeys = plans.map((p) => p.factoryId);
  const commonBudgetByFactory = new Map<string, number>();
  for (const p of plans) {
    if (commonBudgetByFactory.has(p.factoryId)) continue;
    const cap = capacityById.get(p.factoryId);
    if (!cap) {
      throw new ProductionValidationError(`工場ID "${p.factoryId}" が factories に見つかりません。`);
    }
    commonBudgetByFactory.set(p.factoryId, unwrapUnit(cap.commonProcessing));
  }
  const commonCapacityLimited = applyTier(rawMaterialLimitedOutput, ids, priorities, factoryKeys, commonBudgetByFactory);

  // ---- 段階3: 冷凍・包装能力（工場単位の共有プール） ----
  const freezingBudgetByFactory = new Map<string, number>();
  for (const p of plans) {
    if (freezingBudgetByFactory.has(p.factoryId)) continue;
    const cap = capacityById.get(p.factoryId)!;
    freezingBudgetByFactory.set(p.factoryId, unwrapUnit(cap.freezingPackaging));
  }
  const freezingPackagingLimited = applyTier(commonCapacityLimited, ids, priorities, factoryKeys, freezingBudgetByFactory);

  // ---- 段階4: 商品別設備能力（工場×商品単位の専用プール） ----
  const productGroupKeys = plans.map((p) => `${p.factoryId}::${p.product}`);
  const productBudgetByGroup = new Map<string, number>();
  plans.forEach((p) => {
    const key = `${p.factoryId}::${p.product}`;
    if (productBudgetByGroup.has(key)) return;
    const cap = capacityById.get(p.factoryId)!;
    productBudgetByGroup.set(key, capacityPoolFor(cap, p.product));
  });
  const productCapacityLimited = applyTier(freezingPackagingLimited, ids, priorities, productGroupKeys, productBudgetByGroup);

  // ---- 段階5: 有効労働能力（商品ごとに独立したケイパビリティ上限。共有プールとしては扱わない） ----
  const assignmentByKey = new Map(workerAssignments.map((a) => [`${a.factoryId}::${a.companyId}`, a]));
  const laborLimited = plans.map((p, i) => {
    const key = `${p.factoryId}::${p.companyId}`;
    const assignment: WorkerAssignment = assignmentByKey.get(key) ?? emptyWorkerAssignment(p.factoryId, p.companyId);
    const cap = capacityById.get(p.factoryId)!;
    const laborResult = calculateEffectiveLaborCapacity(assignment, cap, p.overtimeRateOverride ? unwrapUnit(p.overtimeRateOverride) : undefined, params);
    const laborCapacity = effectiveLaborCapacityForProduct(laborResult, p.product);
    return Math.min(productCapacityLimited[i], laborCapacity);
  });

  const entries: ProductionAllocationEntry[] = plans.map((p, i) => {
    const desired = unwrapUnit(p.desiredQuantity);
    const allocated = Math.min(desired, Math.max(0, laborLimited[i]));
    const roundedAllocated = roundHosoEqTons(allocated);
    const shortfall = Math.max(0, roundHosoEqTons(desired - roundedAllocated));

    const stageValues: { readonly value: number; readonly reason: ProductionShortfallReason }[] = [
      { value: rawMaterialLimitedOutput[i], reason: "rawMaterialShortage" },
      { value: commonCapacityLimited[i], reason: "commonCapacityShortage" },
      { value: freezingPackagingLimited[i], reason: "packagingCapacityShortage" },
      { value: productCapacityLimited[i], reason: "productCapacityShortage" },
      { value: laborLimited[i], reason: "laborShortage" },
    ];
    const reasons: ProductionShortfallReason[] = [];
    let prev = desired;
    for (const stage of stageValues) {
      if (stage.value < prev - epsilon) {
        reasons.push(stage.reason);
      }
      prev = stage.value;
    }

    const requiredRawMaterialQuantity = roundHosoEqTons(roundedAllocated / yieldRatios[i]);

    return {
      companyId: p.companyId,
      factoryId: p.factoryId,
      product: p.product,
      priority: p.priority,
      desiredQuantity: hosoEqTons(desired),
      allocatedQuantity: hosoEqTons(roundedAllocated),
      shortfallQuantity: hosoEqTons(shortfall),
      shortfallReasons: reasons,
      requiredRawMaterialQuantity: hosoEqTons(requiredRawMaterialQuantity),
      stages: {
        rawMaterialLimited: hosoEqTons(roundHosoEqTons(Math.max(0, rawMaterialLimitedOutput[i]))),
        commonCapacityLimited: hosoEqTons(roundHosoEqTons(Math.max(0, commonCapacityLimited[i]))),
        freezingPackagingLimited: hosoEqTons(roundHosoEqTons(Math.max(0, freezingPackagingLimited[i]))),
        productCapacityLimited: hosoEqTons(roundHosoEqTons(Math.max(0, productCapacityLimited[i]))),
        laborLimited: hosoEqTons(roundHosoEqTons(Math.max(0, laborLimited[i]))),
      },
    };
  });

  return { period, entries };
}
