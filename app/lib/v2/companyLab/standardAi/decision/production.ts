// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 生産ドメイン
//
// 【基本方針（実装指示 §生産）】
//   - 生産希望量 = 販売希望量 + 未履行契約残 − 完成品在庫（既存在庫が賄う分は
//     二重に生産しない。受注を止めた商品は生産も自然に止まる）。
//   - 優先順位: 未履行契約がある商品を最優先、次に在庫が目標を下回る商品、
//     残りは通常優先度（全社共通の規則。会社IDによる分岐はしない）。
//   - 各工場の商品別能力でキャップし、複数工場保有時は能力比で按分する。

import { hosoEqTons, unwrapUnit } from "../../../core/units";
import { CompanyProductionPlanEntry } from "../../../production/types";
import { CompanyFixture } from "../../types";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const EPSILON = 1e-6;

export interface ProductionPlanResult {
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  readonly neededByProduct: ProductAmount;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiProductionPlans(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  salesDesiredByProduct: ProductAmount
): ProductionPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const backlog = observation.outstandingContractByProduct;
  const fg = observation.finishedGoodsByProduct;
  const capacityTotals = observation.totalCapacityByProduct;

  const neededByProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    neededByProduct[product] = Math.max(0, salesDesiredByProduct[product] + backlog[product] - fg[product]);
    if (backlog[product] > EPSILON) {
      diagnostics.push({
        code: "CONTRACT_FULFILLMENT_PRIORITY",
        domain: "production",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { outstandingQuantity: backlog[product], plannedQuantity: neededByProduct[product] },
        message: `${product.toUpperCase()}の未履行契約残（${Math.round(backlog[product])}トン）を優先して生産計画に織り込む。`,
      });
    } else if (fg[product] > capacityTotals[product] * 0.001 && pressures.finishedGoodsExcessRatioByProduct[product] > 1) {
      diagnostics.push({
        code: "FINISHED_GOODS_EXCESS",
        domain: "production",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { finishedGoodsInventory: fg[product], excessRatio: pressures.finishedGoodsExcessRatioByProduct[product] },
        message: `${product.toUpperCase()}の完成品在庫が目標を上回るため、生産を抑制する。`,
      });
    }
  }

  // 優先順位: 未履行契約がある商品を最優先(1)、在庫不足(目標未満)の商品を次点(2)、それ以外(3)。
  const priorityByProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    if (backlog[product] > EPSILON) priorityByProduct[product] = 1;
    else if (pressures.finishedGoodsExcessRatioByProduct[product] < 1) priorityByProduct[product] = 2;
    else priorityByProduct[product] = 3;
  }

  const plans: CompanyProductionPlanEntry[] = [];
  let anyCapacityConstraint = false;
  for (const f of fixture.factories) {
    const capacityByProduct: ProductAmount = {
      hoso: unwrapUnit(f.hosoCapacity),
      pd: unwrapUnit(f.pdCapacity),
      vap: unwrapUnit(f.vapCapacity),
    };
    for (const product of ["hoso", "pd", "vap"] as const) {
      const capacity = capacityByProduct[product];
      if (capacity <= EPSILON || neededByProduct[product] <= EPSILON) continue;
      const share = capacityTotals[product] > EPSILON ? capacity / capacityTotals[product] : 0;
      const desired = Math.min(capacity, neededByProduct[product] * share);
      if (desired <= EPSILON) continue;
      if (neededByProduct[product] * share > capacity + EPSILON) anyCapacityConstraint = true;
      plans.push({
        companyId: fixture.companyId,
        factoryId: f.factoryId,
        product,
        desiredQuantity: hosoEqTons(Math.round(desired * 100) / 100),
        priority: priorityByProduct[product],
      });
    }
  }

  if (anyCapacityConstraint) {
    diagnostics.push({
      code: "CAPACITY_CONSTRAINT",
      domain: "production",
      companyId: fixture.companyId,
      severity: "warning",
      message: "設備能力が必要生産量を下回るため、当期の生産計画は能力上限でキャップされる。",
    });
  }

  return { productionPlans: plans, neededByProduct, diagnostics };
}
