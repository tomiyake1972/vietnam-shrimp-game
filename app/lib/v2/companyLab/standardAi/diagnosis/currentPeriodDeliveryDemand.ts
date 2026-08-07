// ShrimpX V2 — Phase SAI-6.3: Current Period Delivery Demand層
//
// 【このモジュールが存在する理由（三宅さん指示・設計レポート§11.1）】
// ShrimpXが将来目指す営業活動の時間軸は「今期営業して、次期納品分を受注する」
// であり、当期中の即納（急な需要増・消費国在庫不足・スポット需要・緊急補充）は
// 例外的な場合に限られる。現行ゲームには「当期納品分」と「次期納品分」を区別する
// 機能が存在しないため、営業希望量（salesPlans）が実質的に当期納品量として扱われて
// しまっている。
//
// 【今回のスコープ（重要）】本モジュールは Standard AI 内部の意思決定用「中間概念」
// としてのみ実装する。ゲーム本体側（当期即納営業・次期納品営業・市場側の通常購買
// タイミング・スポット/緊急需要・契約データモデル・営業UI入力項目）を分離する実装は
// Cowork #04側の担当であり、本モジュールはそれらのゲーム側フィールドを一切新設
// しない。将来#04側で当期／次期納品区分が実装された時に、本モジュールのビルダー
// 関数だけを差し替えれば済むよう、`source`フラグで「今は暫定推定である」ことを
// 明示する。
//
// 【現行仕様での暫定計算（実データフロー確認済み）】
// decision/sales.tsのコメント（実装指示§販売）が明記する通り、salesPlans
// （＝realisticSalesByProduct、SAI-6.2で追加した営業人員配分後の現実的販売可能量）
// は「新規に売り込みたい量」のみであり、既存の未履行契約の履行分は含まれない
// （契約履行分はdecision/production.tsのneededByProduct計算で
// 別途outstandingContractByProductとして加算される設計）。したがって
// 二重加算を避けるため、
//   currentPeriodDeliveryDemand.byProduct
//     = realisticSalesByProduct（新規営業のうち、現行仕様では全量を当期納品とみなす）
//     + outstandingContractByProduct（当期履行期限の既存契約。現行仕様では
//       履行期限の区別が無いため、未履行契約残高の全額を「当期履行期限」と
//       みなす暫定近似）
// とする。当期スポット・緊急需要は現行ゲームに対応するフィールドが存在しないため
// 0として扱う（将来、#04側にスポット需要の入力が追加された場合はここに加算する）。

import { ProductAmount, StandardAiObservation, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

/**
 * 【将来の差し替え口】"CURRENT_SALES_PLAN_PROXY" は現行仕様での暫定推定である
 * ことを示す。将来#04側で当期／次期納品区分が実装された場合、この列に
 * "CURRENT_AND_NEXT_PERIOD_SEPARATED" 等の新しい値を追加し、buildCurrentPeriodDeliveryDemand
 * の内部計算だけを差し替える（Situation Diagnosis・将来のInventory & Production
 * Planは、この型・関数シグネチャを変えずに済む）。
 */
export type DeliveryDemandSource = "CURRENT_SALES_PLAN_PROXY";

export interface CurrentPeriodDeliveryDemand {
  /** 商品別の当期納品需要（当期履行期限の既存契約＋新規営業のうち当期即納分＋当期スポット需要、の暫定近似）。 */
  readonly byProduct: ProductAmount;
  /** この値がどのように算出されたかを示すフラグ（暫定proxyか、将来の完成形か）。 */
  readonly source: DeliveryDemandSource;
}

export interface CurrentPeriodDeliveryDemandResult {
  readonly deliveryDemand: CurrentPeriodDeliveryDemand;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildCurrentPeriodDeliveryDemand(
  companyId: string,
  observation: StandardAiObservation,
  realisticSalesByProduct: ProductAmount
): CurrentPeriodDeliveryDemandResult {
  const byProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    byProduct[product] = realisticSalesByProduct[product] + observation.outstandingContractByProduct[product];
  }

  const diagnostics: StandardAiDiagnosticEntry[] = [
    {
      code: "CURRENT_PERIOD_DELIVERY_DEMAND_PROXY",
      domain: "diagnosis",
      companyId,
      severity: "info",
      keyValues: {
        currentPeriodDeliveryDemandHoso: byProduct.hoso,
        currentPeriodDeliveryDemandPd: byProduct.pd,
        currentPeriodDeliveryDemandVap: byProduct.vap,
      },
      message:
        "当期納品需要（currentPeriodDeliveryDemand）は現行仕様上の暫定推定値（現実的販売可能量＋未履行契約残高の全額）であり、" +
        "当期即納分と次期納品分を区別するゲーム機能が実装された場合はこの推定方法を差し替える。",
    },
  ];

  return {
    deliveryDemand: { byProduct, source: "CURRENT_SALES_PLAN_PROXY" },
    diagnostics,
  };
}
