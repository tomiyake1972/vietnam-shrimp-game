// ShrimpX V2 — 工場・ワーカー・生産モジュール 生産計画の制約配分（Phase 6、Phase 6.1で修正）
//
// 実際の生産量は、少なくとも次の最小値で制約する（§4「生産可能量」）。
//   生産希望量 / 使用可能な原料在庫 / 工場共通処理能力 / 商品別設備能力 /
//   冷凍・包装能力 / 有効労働能力
// 複数商品が共通能力・原料・労働を競合する場合は、生産優先順位（priority）に従い、
// 同順位では入力順に依存しない決定論的配分を行う（priorityAllocation.ts、
// rawMaterials/waterFill.ts の水位法をそのまま再利用）。
//
// 【Phase 6.1修正】制約の適用順序と単位:
//   1. 原料（会社単位の共有プール、原料HOSO換算量）
//   2. 工場共通処理能力（工場単位の共有プール、原料投入HOSO換算量。
//      commonProcessingCapacityは「原料投入量」の上限であり、完成品側の上限
//      ではない。段階1・2はいずれも同じ原料側の単位で完結させ、この2段階を
//      通過した後で初めてsaleableRecoveryRatioにより完成品HOSO換算量へ変換する）
//   3. 冷凍・包装能力（工場単位の共有プール、完成品HOSO換算量）
//   4. 商品別設備能力（工場×商品単位の専用プール、完成品HOSO換算量）
//   5. 有効労働能力（工場単位の共有ワーカープール、labor.tsの
//      allocateWorkersToPlansが優先順位階層で商品間の奪い合いを解決する。
//      Phase6初版では商品ごとに独立したケイパビリティ上限として扱っていたが、
//      同じ人数を複数商品で重複計上できてしまう欠陥であったため、共有プール化した）
//
// 原料消費量→完成品数量の変換（歩留まり）は、段階1→2（原料投入側の制約）を
// 経た後の1箇所（saleableRecoveryRatio）でのみ適用する。physicalYieldRatio
// （殻・頭の除去等による物理的重量減少の参考値）はHOSO換算数量の計算には
// 一切使わない（yieldConversion.ts参照。二重換算を避ける）。

import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { Product } from "../market/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { calculateFactoryEffectiveCapacity } from "./capacity";
import { allocateWorkersToPlans, WorkerDemandItem } from "./labor";
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

  const recoveryRatios = plans.map((p) => {
    const r = params.yield.saleableRecoveryRatio[p.product];
    if (!(r > 0) || !(r <= 1)) {
      throw new ProductionValidationError(`商品 "${p.product}" の販売可能回収率は(0,1]の範囲である必要があります。設定値: ${r}`);
    }
    return r;
  });

  // 各計画の希望原料消費量（希望量 / 販売可能回収率、maxRawMaterialConsumptionでさらにクリップ）。
  const rawMaterialRequiredDesired = plans.map((p, i) => {
    const required = unwrapUnit(p.desiredQuantity) / recoveryRatios[i];
    return p.maxRawMaterialConsumption !== undefined ? Math.min(required, unwrapUnit(p.maxRawMaterialConsumption)) : required;
  });

  // ---- 段階1: 原料（会社単位の共有プール、原料HOSO換算量） ----
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
    Math.min(unwrapUnit(plans[i].desiredQuantity), raw * recoveryRatios[i])
  );

  // ---- 段階2: 工場共通処理能力（工場単位の共有プール、原料投入HOSO換算量） ----
  // commonProcessingCapacityは原料投入側の上限であるため、段階1の結果（原料側の
  // 数量、rawMaterialAllocated）をそのまま候補・重みとして使う。完成品側の
  // rawMaterialLimitedOutputは使わない（原料投入と完成品を混同しないため）。
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
  const commonProcessingRawAllocated = applyTier(rawMaterialAllocated, ids, priorities, factoryKeys, commonBudgetByFactory);
  // ここで初めて、原料投入側の制約（段階1・2）を経た数量を、販売可能回収率で
  // 完成品HOSO換算量へ変換する（歩留まりの適用はここが唯一の箇所）。
  const commonCapacityLimited = commonProcessingRawAllocated.map((raw, i) =>
    Math.min(rawMaterialLimitedOutput[i], raw * recoveryRatios[i])
  );

  // ---- 段階3: 冷凍・包装能力（工場単位の共有プール、完成品HOSO換算量） ----
  const freezingBudgetByFactory = new Map<string, number>();
  for (const p of plans) {
    if (freezingBudgetByFactory.has(p.factoryId)) continue;
    const cap = capacityById.get(p.factoryId)!;
    freezingBudgetByFactory.set(p.factoryId, unwrapUnit(cap.freezingPackaging));
  }
  const freezingPackagingLimited = applyTier(commonCapacityLimited, ids, priorities, factoryKeys, freezingBudgetByFactory);

  // ---- 段階4: 商品別設備能力（工場×商品単位の専用プール、完成品HOSO換算量） ----
  const productGroupKeys = plans.map((p) => `${p.factoryId}::${p.product}`);
  const productBudgetByGroup = new Map<string, number>();
  plans.forEach((p) => {
    const key = `${p.factoryId}::${p.product}`;
    if (productBudgetByGroup.has(key)) return;
    const cap = capacityById.get(p.factoryId)!;
    productBudgetByGroup.set(key, capacityPoolFor(cap, p.product));
  });
  const productCapacityLimited = applyTier(freezingPackagingLimited, ids, priorities, productGroupKeys, productBudgetByGroup);

  // ---- 段階5: 有効労働能力（工場単位の共有ワーカープール） ----
  const demands: WorkerDemandItem[] = plans.map((p, i) => ({
    id: ids[i],
    factoryId: p.factoryId,
    companyId: p.companyId,
    product: p.product,
    priority: p.priority,
    candidateQuantity: Math.max(0, productCapacityLimited[i]),
    overtimeRateOverride: p.overtimeRateOverride ? unwrapUnit(p.overtimeRateOverride) : undefined,
  }));
  const { entries: laborEntries, factorySummaries } = allocateWorkersToPlans(demands, workerAssignments, capacityById, params);
  const laborByPlanId = new Map(laborEntries.map((e, i) => [demands[i].id, e]));
  const laborLimited = plans.map((_, i) => unwrapUnit(laborByPlanId.get(ids[i])!.laborCapacity));

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

    const requiredRawMaterialQuantity = roundHosoEqTons(roundedAllocated / recoveryRatios[i]);
    const labor = laborByPlanId.get(ids[i])!;

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
      labor: {
        assignedRegularHeadcount: labor.assignedRegularHeadcount,
        assignedTemporaryHeadcount: labor.assignedTemporaryHeadcount,
        appliedOvertimeRate: labor.appliedOvertimeRate,
      },
    };
  });

  return { period, entries, factoryWorkerSummaries: factorySummaries };
}
