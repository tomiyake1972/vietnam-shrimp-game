// ShrimpX V2 — 工場・ワーカー・生産モジュール 有効労働能力（Phase 6）
//
// 有効労働能力は、人数・技能水準・稼働可能率・残業から算出する。
//   - 人員増加の効果は設備能力を超えない（factoryCapacityの対応する能力プールで
//     クリップする）。
//   - 残業には設定可能な上限（parameters.labor.overtimeRateCap）を設ける。
//   - 臨時ワーカーは即時利用できるが、常用ワーカーより基準効率
//     （regularEfficiencyPerHeadTons > temporaryEfficiencyPerHeadTons）を低くする。
//   - ワーカーが0人（あるいは対象商品のスキルが0）であれば、設備能力があっても
//     有効労働能力は0となる（＝生産できない。laborShortageとして表面化する）。
// 人件費（USD）は本Phaseでは一切算出しない（記録すべき数量・労働量のみを出力する）。

import { hosoEqTons, ratio, roundHosoEqTons, roundRatio, unwrapUnit } from "../core/units";
import { Product } from "../market/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import { EffectiveLaborCapacityEntry, EffectiveLaborCapacityResult, FactoryEffectiveCapacity, WorkerAssignment } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function skillLevelFor(assignment: WorkerAssignment, product: Product): number {
  const entry = assignment.skills.find((s) => s.product === product);
  return entry ? unwrapUnit(entry.skillLevel) : 0;
}

function capacityPoolFor(factoryCapacity: FactoryEffectiveCapacity, product: Product): number {
  if (product === "hoso") return unwrapUnit(factoryCapacity.hoso);
  if (product === "pd") return unwrapUnit(factoryCapacity.pd);
  return unwrapUnit(factoryCapacity.vap);
}

/**
 * 1工場・1ワーカー配置の有効労働能力を、商品区分ごとに算出する。
 * overtimeRateOverride が指定された場合、その配置に対する残業率として使う
 * （生産計画側からの上書き。省略時はassignment.overtimeRateを使う）。
 */
export function calculateEffectiveLaborCapacity(
  assignment: WorkerAssignment,
  factoryCapacity: FactoryEffectiveCapacity,
  overtimeRateOverride?: number,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): EffectiveLaborCapacityResult {
  const cap = params.labor.overtimeRateCap;
  const requestedOvertime = overtimeRateOverride ?? unwrapUnit(assignment.overtimeRate);
  const appliedOvertime = Math.min(Math.max(0, requestedOvertime), cap);
  const attendance = unwrapUnit(assignment.attendanceRate);

  const rawHeadcountCapacity =
    assignment.regularHeadcount * params.labor.regularEfficiencyPerHeadTons +
    assignment.temporaryHeadcount * params.labor.temporaryEfficiencyPerHeadTons;

  const overtimeMultiplier = 1 + appliedOvertime * params.labor.overtimeEfficiencyFactor;

  const byProduct: EffectiveLaborCapacityEntry[] = PRODUCTS.map((product) => {
    const skill = skillLevelFor(assignment, product);
    const raw = rawHeadcountCapacity * attendance * skill * overtimeMultiplier;
    // 人員増加の効果は設備能力を超えない。
    const capped = Math.min(Math.max(0, raw), Math.max(0, capacityPoolFor(factoryCapacity, product)));
    return {
      factoryId: assignment.factoryId,
      companyId: assignment.companyId,
      product,
      capacity: hosoEqTons(roundHosoEqTons(capped)),
    };
  });

  const totalHeadcount = assignment.regularHeadcount + assignment.temporaryHeadcount;
  const temporaryWorkerShare = totalHeadcount > 0 ? assignment.temporaryHeadcount / totalHeadcount : 0;

  return {
    factoryId: assignment.factoryId,
    companyId: assignment.companyId,
    byProduct,
    temporaryWorkerShare: ratio(roundRatio(temporaryWorkerShare)),
    appliedOvertimeRate: ratio(roundRatio(appliedOvertime)),
  };
}

/** 指定した商品区分の有効労働能力（HosoEqTons）だけを取り出すヘルパー。 */
export function effectiveLaborCapacityForProduct(result: EffectiveLaborCapacityResult, product: Product): number {
  const entry = result.byProduct.find((e) => e.product === product);
  return entry ? unwrapUnit(entry.capacity) : 0;
}
