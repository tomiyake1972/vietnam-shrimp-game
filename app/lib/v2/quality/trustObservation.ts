// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 顧客信頼観測（Phase 7A）
//
// 当期の契約履行実績（production/fulfillment.tsのFinishedGoodsUsageRecord）と、
// 履行に使われた完成品ロットの品質情報（quality/finishedGoodsQuality.tsが
// 付与したqualityInfo）から、会社×市場ぶんの顧客信頼観測を組み立てる。
// 重大事故の影響市場は、履行に使われたロットのlotId経由で事故対象商品を
// 受領した市場を直接特定できるため、実装指示が許容する「全市場へ限定的に
// 反映するフォールバック」は使わず、市場を正確に特定した反映のみを行う
// （lotId→qualityInfoのトレーサビリティが失われる将来の変更が入った場合は、
// フォールバック処理を追加検討すること。§文書化参照）。

import { score0to100, Score0to100, unwrapUnit } from "../core/units";
import { DemandMarketId } from "../market/types";
import { CompanyId, SalesContract } from "../sales/types";
import { FinishedGoodsLot, FinishedGoodsUsageRecord } from "../production/types";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { MarketDeliveryObservation, MarketTrustObservation } from "./types";

function key(companyId: string, market: string): string {
  return `${companyId}::${market}`;
}

/**
 * 当期の履行実績（usage）を会社×市場で集計し、品質加重平均・重大事故の
 * 影響有無から顧客信頼観測を組み立てる（純粋関数）。対象市場に当期の
 * 履行実績が1件もない場合は観測を返さない（呼び出し側が「観測なし＝
 * 顧客信頼を据え置く」と判断できるようにするため）。
 */
export function computeMarketTrustObservations(
  usage: readonly FinishedGoodsUsageRecord[],
  contractsById: ReadonlyMap<string, SalesContract>,
  lotsById: ReadonlyMap<string, FinishedGoodsLot>,
  deliveryObservations: readonly MarketDeliveryObservation[],
  params: QualityParameters = QUALITY_PARAMETERS_V1
): readonly MarketTrustObservation[] {
  const qualityWeightedSumByKey = new Map<string, number>();
  const quantityByKey = new Map<string, number>();
  const maxSeverityByKey = new Map<string, number>();

  for (const u of usage) {
    const contract = contractsById.get(u.contractId);
    if (!contract) continue;
    const market = contract.market;
    const k = key(u.companyId, market);
    const lot = lotsById.get(u.lotId);
    const quantity = unwrapUnit(u.quantity);
    const qualityScore = lot?.qualityInfo ? unwrapUnit(lot.qualityInfo.qualityScore) : unwrapUnit(params.neutralScore);

    qualityWeightedSumByKey.set(k, (qualityWeightedSumByKey.get(k) ?? 0) + qualityScore * quantity);
    quantityByKey.set(k, (quantityByKey.get(k) ?? 0) + quantity);

    if (lot?.qualityInfo?.majorIncidentSeverity !== undefined) {
      maxSeverityByKey.set(k, Math.max(maxSeverityByKey.get(k) ?? 0, lot.qualityInfo.majorIncidentSeverity));
    }
  }

  const deliveryByKey = new Map(deliveryObservations.map((d) => [key(d.companyId, d.market), d]));

  const observations: MarketTrustObservation[] = [];
  for (const [k, totalQuantity] of quantityByKey.entries()) {
    if (totalQuantity <= 1e-6) continue;
    const [companyId, market] = k.split("::") as [CompanyId, DemandMarketId];
    const deliveredQualityScore: Score0to100 = score0to100(Math.min(100, Math.max(0, (qualityWeightedSumByKey.get(k) ?? 0) / totalQuantity)));

    const delivery = deliveryByKey.get(k);
    const observedDeliveryScore: Score0to100 =
      delivery && unwrapUnit(delivery.dueQuantity) > 1e-6
        ? score0to100(Math.min(100, Math.max(0, (100 * unwrapUnit(delivery.onTimeQuantity)) / unwrapUnit(delivery.dueQuantity))))
        : params.neutralScore;

    const severity = maxSeverityByKey.get(k) ?? 0;
    const majorIncidentTrustPenalty = severity * params.majorIncident.severityToTrustPenalty;

    observations.push({ companyId, market, deliveredQualityScore, observedDeliveryScore, majorIncidentTrustPenalty });
  }

  return observations;
}
