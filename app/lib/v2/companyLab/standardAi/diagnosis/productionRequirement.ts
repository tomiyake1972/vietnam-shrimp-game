// ShrimpX V2 — Phase SAI-6.4: Inventory & Production Plan 共通計算
//
// 【目的】「基本当期生産必要量」の計算式（設計レポート§12.1）を、診断
// （situationDiagnosis.ts）と実際の意思決定（policy.ts→decision/production.ts）の
// 両方から同一の実装として参照できるよう、ここに一度だけ定義する。SAI-6.1〜6.3の
// 診断専用計算をSAI-6.4で実際の生産計画の入力へ切り替える際に、計算式が2箇所へ
// コピーされて将来ズレることを防ぐための共通モジュール。
//
// 【二重計上の防止（実装指示C-2）】currentPeriodDeliveryDemand（SAI-6.3）は
// 既に「realisticSalesByProduct（現実的販売可能量）＋outstandingContractByProduct
// （既存契約）」として計算済みである（diagnosis/currentPeriodDeliveryDemand.ts参照）。
// したがって、本モジュールの基本当期生産必要量の式は、currentPeriodDeliveryDemand
// に対して既存契約を再度加算しない（既存契約はcurrentPeriodDeliveryDemandへの入力の
// 時点で既に1回だけ含まれている）。

import { CurrentPeriodDeliveryDemand } from "./currentPeriodDeliveryDemand";
import { computeReferenceProductionByProduct } from "../pressures";
import { StandardAiParameters } from "../parameters";
import { ProductAmount, StandardAiObservation, zeroProductAmount } from "../types";

/**
 * 【SAI-6.4 C-4対応】Unit Economics採算フィルターの将来の差し込み口。
 * 今回はUnit Economics本体を実装しないため、identity（currentPeriodDeliveryDemandを
 * そのまま返す）だけを実装する。将来、採算フィルターを実装する際は、この関数の
 * 内部だけを置き換えれば済むようにし、production.ts・policy.tsの側は
 * このシグネチャ（商品別ProductAmountを受け取り、商品別ProductAmountを返す）に
 * 依存しない密結合を避ける。
 */
export function computeEligibleCurrentPeriodDemand(deliveryDemand: CurrentPeriodDeliveryDemand): ProductAmount {
  return deliveryDemand.byProduct;
}

/** 通常在庫目標（商品別）。既存のpressures.tsの参照生産量計算をそのまま再利用する（独自の推定方式は増設しない）。 */
export function computeNormalInventoryTargetByProduct(observation: StandardAiObservation, params: StandardAiParameters): ProductAmount {
  const referenceProductionByProduct = computeReferenceProductionByProduct(observation, params);
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    result[product] = referenceProductionByProduct[product] * params.finishedGoodsTargetQuarters;
  }
  return result;
}

/**
 * 基本当期生産必要量（設計レポート§12.1）:
 *   基本当期生産必要量 = 当期納品需要（採算フィルター後） + 通常安全在庫目標 − 期首完成品在庫
 * 商品別に計算し、下限0とする。
 */
export function computeBasicCurrentPeriodProductionRequirement(
  eligibleDemandByProduct: ProductAmount,
  normalInventoryTargetByProduct: ProductAmount,
  openingFinishedGoodsByProduct: ProductAmount
): ProductAmount {
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    result[product] = Math.max(
      0,
      eligibleDemandByProduct[product] + normalInventoryTargetByProduct[product] - openingFinishedGoodsByProduct[product]
    );
  }
  return result;
}

/**
 * 【設計レポート§17.5.6・C-3対応】最終生産必要量 = 基本当期生産必要量 + 戦略先行生産調整。
 * 今回は戦略先行生産（Unit Economics/Financial Capacity/戦略判断本体と同様、今回は
 * 実装しない）を常に0として、将来の拡張点だけを残す。
 */
export function computeFinalProductionRequirement(
  basicRequirementByProduct: ProductAmount,
  strategicProductionAdjustmentByProduct: ProductAmount = zeroProductAmount()
): ProductAmount {
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    result[product] = Math.max(0, basicRequirementByProduct[product] + strategicProductionAdjustmentByProduct[product]);
  }
  return result;
}
