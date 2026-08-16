// ShrimpX V2 — Standard AI Factory Activation Strategy（Phase FA-1新設）
//
// 【指示§3-4・監査結果】新設Factory（newFactoryConstruction完成後）は
// capex/factoryConstruction.tsのnewFactoryEffect（fullCapacities×rampMultipliers）
// により、common/HOSO/PD/VAPの各ライン容量が「棟の完成」と同時に自動的に
// ランプアップする（＝別途ライン増設CAPEXを提案しなくても、数四半期でフル容量に
// 達する設計。既存コードそのまま、今回変更しない）。
//
// 一方、companyLab/standardAi/decision/labor.tsは、本監査で修正するまで
// fixture.workerBaseline（静的fixture由来）だけを走査しており、新設Factoryへは
// 一度もWorkerAssignmentが生成されなかった（regularHeadcount=0のまま放置）。
// 「設備はあるが働く人がいない」状態が、新工場完成後にBacklogが爆発する
// 主要因の1つだったと考えられる（同じくFA-1でlabor.tsを修正済み）。
//
// このモジュールは、新しい独立SSoTを一切作らず、既存のFactoryObservation
// （effectiveCapacityByProduct・effectiveCommonProcessingCapacity・
// currentRegularHeadcount・skillByProduct・qualityMetrics.productionTons）だけから、
// Factory単位のボトルネック診断（common/product-line/labor/none）を導出する
// 純粋関数を提供する。CAPEX候補生成ロジック自体は変更しない
// （既存のselectTargetFactoryIdが「実効能力最小のFactory」を既に選んでおり、
// 新設Factoryを含めて機能する。指示§16の「bottleneck-first」は既存ロジックの
// 観測可能性を上げるだけで満たせるため、新しい判断ロジックの重複実装を避ける）。

import { computeRequiredRegularHeadcount } from "../workforce";
import { FactoryObservation } from "./types";

const EPSILON = 1e-6;
/** 共通前処理能力が各ラインの合計に対してこの比率を下回れば、共通前処理をボトルネックとみなす。 */
const COMMON_BOTTLENECK_RATIO = 0.9;
/** 稼働率がこの比率を超えれば、商品別ラインが逼迫しているとみなす。 */
const PRODUCT_LINE_HIGH_UTILIZATION_RATIO = 0.85;
/** 必要常用人数に対しこの比率を下回れば、労働力をボトルネックとみなす。 */
const LABOR_SHORTAGE_RATIO = 0.9;

export type FactoryActivationBottleneck = "COMMON" | "PRODUCT_LINE" | "LABOR" | "NONE";

export interface FactoryActivationDiagnosis {
  readonly factoryId: string;
  readonly effectiveCapacityTons: number;
  readonly effectiveCommonProcessingCapacity: number;
  readonly productionTons: number;
  readonly utilization: number;
  readonly currentRegularHeadcount: number;
  readonly requiredRegularHeadcount: number;
  readonly bottleneck: FactoryActivationBottleneck;
  /** 0〜1程度。ボトルネックが無ければ0。値が大きいほど戦力化の優先度が高い。 */
  readonly activationNeed: number;
}

/**
 * 1 Factoryぶんのボトルネック診断（純粋関数）。既存のFactoryObservationだけを
 * 入力にする（新しい能力・労働モデルは作らない）。
 */
export function diagnoseFactoryActivation(factory: FactoryObservation): FactoryActivationDiagnosis {
  const effectiveCapacityTons = factory.effectiveCapacityByProduct.hoso + factory.effectiveCapacityByProduct.pd + factory.effectiveCapacityByProduct.vap;
  const productionTons = factory.qualityMetrics.productionTons;
  const utilization = effectiveCapacityTons > EPSILON ? Math.min(1, productionTons / effectiveCapacityTons) : 0;

  // 【近似】FactoryObservationにはFactory単位の商品別生産量の内訳until持たない
  // （qualityMetricsは商品横断の集計、CE-3新設）。productionTonsのうち
  // qualitySensitiveProductionTons（PD+VAP、CE-3新設）をpdへ、残りをhosoへ
  // 割り当てる近似（vapは0扱い、pdへ寄せる＝PD/VAPはHOSOよりlabor集約度が高いため
  // 労働力不足を過小評価しない安全側の近似）。新しい商品別生産追跡モデルは作らない。
  const qualitySensitiveTons = factory.qualityMetrics.qualitySensitiveProductionTons;
  const hosoTons = Math.max(0, productionTons - qualitySensitiveTons);
  const requiredRegularHeadcount = computeRequiredRegularHeadcount({
    quantityByProduct: { hoso: hosoTons, pd: qualitySensitiveTons, vap: 0 },
    skillByProduct: factory.skillByProduct,
    attendanceRate: factory.attendanceRate,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  }).requiredRegularHeadcount;

  const commonBottleneck = effectiveCapacityTons > EPSILON && factory.effectiveCommonProcessingCapacity < effectiveCapacityTons * COMMON_BOTTLENECK_RATIO;
  const productLineBottleneck = !commonBottleneck && utilization >= PRODUCT_LINE_HIGH_UTILIZATION_RATIO;
  const laborBottleneck = factory.currentRegularHeadcount < requiredRegularHeadcount * LABOR_SHORTAGE_RATIO;

  let bottleneck: FactoryActivationBottleneck = "NONE";
  let activationNeed = 0;
  if (commonBottleneck) {
    bottleneck = "COMMON";
    activationNeed = effectiveCapacityTons > EPSILON ? 1 - factory.effectiveCommonProcessingCapacity / effectiveCapacityTons : 0;
  } else if (laborBottleneck) {
    // 【指示§16】equipment十分・labor不足の場合はhiringを優先する（common/product-lineより後に判定するのは、
    // 設備自体が無ければ人を増やしても生産できないため。設備が十分にある前提でlabor判定する）。
    bottleneck = "LABOR";
    activationNeed = requiredRegularHeadcount > EPSILON ? Math.min(1, 1 - factory.currentRegularHeadcount / requiredRegularHeadcount) : 0;
  } else if (productLineBottleneck) {
    bottleneck = "PRODUCT_LINE";
    activationNeed = utilization;
  }

  return {
    factoryId: factory.factoryId,
    effectiveCapacityTons,
    effectiveCommonProcessingCapacity: factory.effectiveCommonProcessingCapacity,
    productionTons,
    utilization,
    currentRegularHeadcount: factory.currentRegularHeadcount,
    requiredRegularHeadcount,
    bottleneck,
    activationNeed: Math.max(0, Math.min(1, activationNeed)),
  };
}

export function diagnoseFactoryActivationForCompany(factories: readonly FactoryObservation[]): readonly FactoryActivationDiagnosis[] {
  return factories.map(diagnoseFactoryActivation);
}
