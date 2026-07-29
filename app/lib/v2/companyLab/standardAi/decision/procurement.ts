// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 原料調達ドメイン（国内買付・輸入・養殖）
//
// 【基本方針（実装指示 §調達）】
//   - 必要原料量は生産計画から逆算する（歩留まり1.0基準。既存規約を踏襲）。
//   - 在庫＋確定入荷見込みで足りるなら過剰発注しない（在庫補正つき構成比配分）。
//   - 自社養殖だけで完全自給せず、国内買付・輸入の需要を恒常的に残す
//     （maxAquacultureShareOfRequirement、全社一律の上限）。
//   - 輸入はリードタイムを考慮した定常フロー（即時利用可能扱いにしない）。
//   - 現金圧力が深刻なときは、調達希望量を必要最小限（下限）へ寄せる
//     （financing/liquidityClose.tsの事後的な調達スケール制約とは別に、AI自身が
//     過大な希望を出さないようにする一次的な自制。事後制約の計算を先取り・
//     重複実装はしない）。

import { hosoEqTons } from "../../../core/units";
import { CountryId } from "../../../market/types";
import { PeriodV2 } from "../../../core/period";
import { AquacultureStockingPlanEntry, DomesticPurchasePlanEntry, ImportOrderInput } from "../../../rawMaterials/types";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { safeRatio } from "../normalize";

const EPSILON = 1e-6;

export interface ProcurementPlanResult {
  readonly domesticPurchasePlan: DomesticPurchasePlanEntry;
  readonly importOrders: readonly ImportOrderInput[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

function ratioAdjustmentToUsd(ratioAdjustment: number, referencePrice: number | undefined): number {
  if (referencePrice === undefined || referencePrice <= EPSILON) return 0;
  const clamped = Math.max(-0.3, Math.min(0.3, ratioAdjustment));
  return clamped * referencePrice;
}

export function buildStandardAiProcurementPlan(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  requiredRawMaterial: number,
  period: PeriodV2,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): ProcurementPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const severeCash = pressures.cashPressure >= params.severeCashPressureThreshold;

  // --- 養殖: 能力の範囲内で、必要量に対する上限比率までを目標収穫量とする ---
  const aquacultureCapacity = observation.aquacultureCapacity;
  const targetHarvest = Math.min(requiredRawMaterial * params.maxAquacultureShareOfRequirement, aquacultureCapacity * params.expectedAquacultureHarvestRatio);
  const stocking = aquacultureCapacity > EPSILON ? Math.min(aquacultureCapacity, targetHarvest / params.expectedAquacultureHarvestRatio) : 0;
  const aquacultureStockingPlans: AquacultureStockingPlanEntry[] =
    stocking > EPSILON
      ? [
          {
            companyId: fixture.companyId,
            aquacultureCapacity: fixture.aquacultureCapacity,
            plannedStockingQuantity: hosoEqTons(Math.round(stocking * 100) / 100),
            aquacultureIntensity: safeRatio(params.aquacultureIntensity),
            bioSecurityLevel: safeRatio(params.bioSecurityLevel),
            stockingPeriod: period,
          },
        ]
      : [];
  const actualTargetHarvest = stocking > EPSILON ? stocking * params.expectedAquacultureHarvestRatio : 0;

  // --- 輸入: 構成比ベースの定常フロー ---
  const importQuantity = requiredRawMaterial * params.importMixRatio;
  const originCountry: CountryId = "ID";
  const importOrders: ImportOrderInput[] =
    importQuantity > EPSILON
      ? [
          {
            companyId: fixture.companyId,
            originCountry,
            orderedQuantity: hosoEqTons(Math.round(importQuantity * 100) / 100),
            orderedPeriod: period,
          },
        ]
      : [];

  // --- 国内買付: 残余需要 ＋ 在庫補正、下限つき ---
  const mixBase = Math.max(0, requiredRawMaterial - importQuantity - actualTargetHarvest);
  const targetInventory = params.rawMaterialTargetQuarters * requiredRawMaterial;
  const correction = params.inventoryCorrectionDamping * (targetInventory - pressures.rawMaterialInventoryPosition);
  const floor = params.minDomesticPurchaseRatioOfBase * mixBase;
  const cap = mixBase * 2 + targetInventory;
  let desiredDomestic = Math.min(cap, Math.max(floor, mixBase + correction));

  if (severeCash) {
    // 深刻な現金圧力下では、在庫積み増し分を諦め必要最小限（floor寄り）へ縮小する。
    desiredDomestic = floor + (desiredDomestic - floor) * (1 - params.cashConstrainedProcurementDampingAtSeverePressure);
    diagnostics.push({
      code: "PROCUREMENT_CASH_CONSTRAINED",
      domain: "procurement",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: { cashPressure: pressures.cashPressure, desiredDomestic },
      message: "現金圧力が深刻なため、国内買付希望量を必要最小限へ縮小する。",
    });
  }

  const referencePrice = observation.vietnamDomesticPriorPrice;
  const domesticPurchasePlan: DomesticPurchasePlanEntry = {
    companyId: fixture.companyId,
    desiredQuantity: hosoEqTons(Math.round(Math.max(0, desiredDomestic) * 100) / 100),
    priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(0, referencePrice),
    procurementHeadcount: fixture.procurementHeadcountTotal,
    factoryCommonProcessingCapacityTons: observation.totalCommonProcessingCapacity,
  };

  if (pressures.rawMaterialInventoryPosition < requiredRawMaterial * 0.5) {
    diagnostics.push({
      code: "RAW_MATERIAL_SHORTAGE",
      domain: "procurement",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: { inventoryPosition: pressures.rawMaterialInventoryPosition, requiredRawMaterial },
      message: "原料在庫ポジションが必要量に対して低水準のため、調達量を増加させる。",
    });
  } else if (pressures.rawMaterialInventoryPosition > targetInventory * 1.3) {
    diagnostics.push({
      code: "PROCUREMENT_REDUCED_FOR_EXCESS",
      domain: "procurement",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { inventoryPosition: pressures.rawMaterialInventoryPosition, targetInventory },
      message: "原料在庫が目標水準を超えているため、調達量を抑制する。",
    });
  } else {
    diagnostics.push({
      code: "PROCUREMENT_INCREASED_FOR_SHORTAGE",
      domain: "procurement",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { desiredDomestic, requiredRawMaterial },
      message: "生産計画から逆算した必要原料量に基づき、国内買付・輸入・養殖を構成比どおりに計画する。",
    });
  }

  return { domesticPurchasePlan, importOrders, aquacultureStockingPlans, diagnostics };
}
