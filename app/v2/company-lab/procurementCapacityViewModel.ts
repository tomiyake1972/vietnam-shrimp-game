// ShrimpX V2 — Procurement Planning: 調達人員 → 調達能力 → Effective Purchase Intent
//
// 【目的】「調達人員を入れなければ買えない（能力が伸びない）」ことと、
// Desired Quantity（希望量）・Effective Purchase Intent（信認上限適用後の意向）・
// Actual Purchase Quantity（他社との競争後に決まる実際の成立量）の3つが
// 別物であることを、UIで混同しないための構造を提供する。
//
// 【この層がやること】既存のpure function（domesticPurchase.ts の
// procurementCapacity / procurementCoverageScore / calculateEffectivePurchaseIntent）を
// そのまま呼び出すだけ。新しい能力曲線・新しい上限式は一切作らない。
//
// 【Effective Purchase Intent ≠ Actual Purchase Quantity】
//   Effective Purchase Intentは「実際には買えない量を過大申告して価格だけを
//   吊り上げる」ことを防ぐための、当社視点の意向上限（希望量・調達能力・
//   承認枠・シェア上限の最小値）である。実際の成立量（Actual Purchase Quantity）は
//   5社の入札を国内価格市場が競争配分（allocateDomesticPurchase）した結果で
//   決まり、当期の意思決定画面の時点では確定していない。本VMはこの2つを
//   別フィールドとして提供し、Effective Purchase Intentを確定値として扱わない
//   （このVMはActual Purchase Quantityを一切計算しない＝当期未確定のため）。
//
// 【bindingConstraintの求め方】calculateEffectivePurchaseIntent（唯一の正）が
// 実際に返す値と、4つの候補上限（希望量・調達能力・承認枠・シェア上限。
// いずれも既存関数・既存パラメータからそのまま導出）を突き合わせ、
// どれが実際に効いたかを特定するだけであり、min()の計算式自体を複製しない。

import { hosoEqTons, unwrapUnit } from "../../lib/v2/core/units";
import {
  calculateEffectivePurchaseIntent,
  procurementCapacity,
  procurementCoverageScore,
} from "../../lib/v2/rawMaterials/domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "../../lib/v2/rawMaterials/parameters";
import { CompanyId, DomesticPurchasePlanEntry } from "../../lib/v2/rawMaterials/types";

const EPSILON = 1e-6;

export type ProcurementCapacityBindingConstraint = "desiredQuantity" | "procurementCapacity" | "approvedPurchaseCap" | "shareOfSupplyCap";

export interface ProcurementCapacityViewModel {
  readonly procurementHeadcount: number;
  /** 調達人員（＋工場共通処理能力があれば連動）から導かれる調達処理能力（HOSO換算MT）。 */
  readonly procurementCapacityTons: number;
  /** 調達人員から導かれる調達カバレッジ（0〜1）。 */
  readonly coverageScore: number;
  /** draft入力そのままの買付希望量（HOSO換算MT）。 */
  readonly desiredQuantityTons: number;
  /**
   * 有効買付意向（HOSO換算MT）。**確定した買付量ではない**。実際の成立量
   * （Actual Purchase Quantity）は5社競争配分の結果でしか決まらず、この画面の
   * 時点では存在しない。
   */
  readonly effectivePurchaseIntentTons: number;
  /** 承認済み買付枠（未設定ならundefined＝上限なし）。 */
  readonly approvedPurchaseCapTons: number | undefined;
  /** 基準供給量 × 最大価格影響シェア（rawMaterials/parameters.ts の maximumPriceInfluenceShare）。 */
  readonly shareOfSupplyCapTons: number;
  /** 4つの候補（希望量/調達能力/承認枠/シェア上限）のうち、実際にeffectivePurchaseIntentTonsへ効いたもの。 */
  readonly bindingConstraint: ProcurementCapacityBindingConstraint;
  /** desiredQuantityTons が effectivePurchaseIntentTons によって縮小されているか。 */
  readonly isConstrained: boolean;
}

export interface BuildProcurementCapacityInput {
  readonly companyId: CompanyId;
  readonly desiredQuantityTons: number;
  readonly procurementHeadcount: number;
  /** Phase 6.3 工場能力連動方式。未指定時はエンジンが絶対値カーブへフォールバックする。 */
  readonly factoryCommonProcessingCapacityTons?: number;
  readonly approvedPurchaseCapTons?: number;
  /** 国内市場の基準供給量（shareOfSupplyCapの算出に使う）。 */
  readonly referenceSupplyTons: number;
}

export function buildProcurementCapacityViewModel(
  input: BuildProcurementCapacityInput,
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): ProcurementCapacityViewModel {
  const headcount = Number.isInteger(input.procurementHeadcount) && input.procurementHeadcount >= 0 ? input.procurementHeadcount : 0;

  const entry: DomesticPurchasePlanEntry = {
    companyId: input.companyId,
    desiredQuantity: hosoEqTons(Math.max(0, input.desiredQuantityTons)),
    priceAdjustmentUsdPerHosoEqKg: 0,
    procurementHeadcount: headcount,
    ...(input.factoryCommonProcessingCapacityTons !== undefined
      ? { factoryCommonProcessingCapacityTons: input.factoryCommonProcessingCapacityTons }
      : {}),
    ...(input.approvedPurchaseCapTons !== undefined ? { approvedPurchaseCap: hosoEqTons(input.approvedPurchaseCapTons) } : {}),
  };

  const capacityTons = unwrapUnit(procurementCapacity(headcount, params, input.factoryCommonProcessingCapacityTons));
  const coverageScore = procurementCoverageScore(headcount, params);
  const referenceSupply = hosoEqTons(Math.max(0, input.referenceSupplyTons));
  const effectivePurchaseIntentTons = unwrapUnit(calculateEffectivePurchaseIntent(entry, referenceSupply, params));

  const shareOfSupplyCapTons = Math.max(0, input.referenceSupplyTons) * params.domesticPurchase.maximumPriceInfluenceShare;
  const approvedPurchaseCapTons = input.approvedPurchaseCapTons;

  // calculateEffectivePurchaseIntent と同じ4候補（式は複製せず、engineが実際に
  // 返した値との突き合わせだけを行う）。
  const candidates: readonly { readonly key: ProcurementCapacityBindingConstraint; readonly value: number }[] = [
    { key: "desiredQuantity", value: Math.max(0, input.desiredQuantityTons) },
    { key: "procurementCapacity", value: capacityTons },
    { key: "shareOfSupplyCap", value: shareOfSupplyCapTons },
    { key: "approvedPurchaseCap", value: approvedPurchaseCapTons ?? Number.POSITIVE_INFINITY },
  ];
  const binding = candidates.reduce((min, c) => (c.value < min.value ? c : min), candidates[0]);
  const bindingConstraint: ProcurementCapacityBindingConstraint =
    Math.abs(binding.value - effectivePurchaseIntentTons) <= EPSILON ? binding.key : "desiredQuantity";

  return {
    procurementHeadcount: headcount,
    procurementCapacityTons: capacityTons,
    coverageScore,
    desiredQuantityTons: Math.max(0, input.desiredQuantityTons),
    effectivePurchaseIntentTons,
    approvedPurchaseCapTons,
    shareOfSupplyCapTons,
    bindingConstraint,
    isConstrained: effectivePurchaseIntentTons + EPSILON < Math.max(0, input.desiredQuantityTons),
  };
}
