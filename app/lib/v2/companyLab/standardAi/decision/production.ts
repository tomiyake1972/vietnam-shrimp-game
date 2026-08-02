// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 生産ドメイン
// 【SAI-6.4改訂】生産計画の営業側inputを、工場能力起点の理論希望量
// （desiredByProduct）から、Standard AI内部の当期納品需要
// （currentPeriodDeliveryDemand、SAI-6.3）を起点とした「基本当期生産必要量」
// （diagnosis/productionRequirement.tsの共通実装、policy.ts側で算出）へ切り替える。
//
// 【基本方針（改訂）】
//   - 生産必要量 = 基本当期生産必要量（＝当期納品需要＋通常安全在庫目標－期首完成品
//     在庫。呼び出し側のpolicy.tsで算出済み）。当期納品需要は既にrealisticSales
//     ByProduct（現実的販売可能量）＋outstandingContractByProduct（既存契約）を
//     含んでいるため、ここで未履行契約残・完成品在庫を再度加算・減算しない
//     （二重計上防止。実装指示C-2）。
//   - 優先順位: 未履行契約がある商品を最優先、次に在庫が目標を下回る商品、
//     残りは通常優先度（全社共通の規則。会社IDによる分岐はしない）。
//     ※優先順位付けのためだけにbacklog（未履行契約残）・在庫超過比率は参照するが、
//       生産必要量そのものの計算には使わない。
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

/**
 * @param finalProductionRequirementByProduct SAI-6.4：policy.tsが
 *   diagnosis/productionRequirement.tsの共通実装で算出した、商品別の
 *   最終生産必要量（基本当期生産必要量＋戦略先行生産調整。今回は戦略先行生産は常に0）。
 *   当期納品需要（既存契約分を含む）・通常在庫目標・期首完成品在庫は、この値の
 *   計算時点で既に反映済みであり、本関数の内部では再加算・再減算しない。
 */
export function buildStandardAiProductionPlans(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  finalProductionRequirementByProduct: ProductAmount
): ProductionPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const backlog = observation.outstandingContractByProduct;
  const fg = observation.finishedGoodsByProduct;
  const capacityTotals = observation.totalCapacityByProduct;

  // 【SAI-6.4】neededByProductは、もはや「desiredByProduct+backlog-fg」を計算しない。
  // 呼び出し側（policy.ts）がcurrentPeriodDeliveryDemand起点で算出した値をそのまま使う
  // （二重計上防止。実装指示C-2）。優先順位付け・診断メッセージのためにbacklog・fgは
  // 引き続き参照するが、量そのものには影響させない。
  const neededByProduct: ProductAmount = finalProductionRequirementByProduct;
  for (const product of ["hoso", "pd", "vap"] as const) {
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
