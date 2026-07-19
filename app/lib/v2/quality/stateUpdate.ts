// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール 状態更新（Phase 7A）
//
// 当期の品質調整結果（BatchQualityAdjustment）・納期観測（MarketDeliveryObservation）・
// 顧客信頼観測（MarketTrustObservation）から、次ターンへ渡すQualityReliabilityState
// を組み立てる。
//   - 品質: 生産実績がない商品（当期production対象外の会社×商品）は据え置く
//   - 顧客信頼: 当期その市場向けの履行実績がない会社×市場は据え置く
//   - 納期信頼性: 当期dueQuantity=0の会社×市場は据え置く
// （2つのスコア更新条件は独立しており、同じ会社×市場でも片方だけ更新される
// ことがある）。

import { score0to100, unwrapUnit } from "../core/units";
import { DemandMarketId, DEMAND_MARKET_IDS, Product } from "../market/types";
import { CompanyId } from "../sales/types";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { updateCustomerTrustScore, updateDeliveryReliabilityScore, updateQualityScore } from "./scoreUpdates";
import {
  BatchQualityAdjustment,
  CompanyMarketTrustState,
  CompanyProductQualityState,
  MarketDeliveryObservation,
  MarketTrustObservation,
  QualityReliabilityState,
} from "./types";

function qpKey(companyId: string, product: string): string {
  return `${companyId}::${product}`;
}
function cmKey(companyId: string, market: string): string {
  return `${companyId}::${market}`;
}

/** 会社×商品ぶんの品質スコアを、当期の生産バッチ品質調整結果（複数工場ぶんを数量加重平均）で更新する。 */
export function updateQualityByCompanyProduct(
  previous: readonly CompanyProductQualityState[],
  adjustments: readonly BatchQualityAdjustment[],
  params: QualityParameters = QUALITY_PARAMETERS_V1
): readonly CompanyProductQualityState[] {
  const weightedSumByKey = new Map<string, number>();
  const weightByKey = new Map<string, number>();
  for (const a of adjustments) {
    const k = qpKey(a.companyId, a.product);
    const weight = unwrapUnit(a.originalFinishedGoodsQuantity);
    if (weight <= 1e-6) continue;
    weightedSumByKey.set(k, (weightedSumByKey.get(k) ?? 0) + unwrapUnit(a.outcome.observedQualityScore) * weight);
    weightByKey.set(k, (weightByKey.get(k) ?? 0) + weight);
  }

  const previousByKey = new Map(previous.map((s) => [qpKey(s.companyId, s.product), s]));
  const touchedKeys = new Set(weightByKey.keys());

  const updated: CompanyProductQualityState[] = previous.map((s) => {
    const k = qpKey(s.companyId, s.product);
    const weight = weightByKey.get(k);
    if (!weight || weight <= 1e-6) return s; // 生産実績なし → 据え置く
    const observed = score0to100(Math.min(100, Math.max(0, (weightedSumByKey.get(k) ?? 0) / weight)));
    return { ...s, qualityScore: updateQualityScore(s.qualityScore, observed, params) };
  });

  // previousに存在しなかった会社×商品の組み合わせ（初期化漏れ等）が当期
  // 生産実績を持つ場合は、中立値を起点に新規追加する（安全側のフォールバック）。
  for (const k of touchedKeys) {
    if (previousByKey.has(k)) continue;
    const [companyId, product] = k.split("::") as [CompanyId, Product];
    const weight = weightByKey.get(k)!;
    const observed = score0to100(Math.min(100, Math.max(0, (weightedSumByKey.get(k) ?? 0) / weight)));
    updated.push({ companyId, product, qualityScore: updateQualityScore(params.neutralScore, observed, params) });
  }

  return updated;
}

/**
 * 会社×市場ぶんの顧客信頼・納期信頼性を更新する。2つのスコアは独立した
 * トリガー条件（顧客信頼=当期履行実績あり、納期信頼性=当期dueQuantity>0）を
 * 持つため、片方だけ更新されることがある。
 */
export function updateTrustByCompanyMarket(
  previous: readonly CompanyMarketTrustState[],
  deliveryObservations: readonly MarketDeliveryObservation[],
  trustObservations: readonly MarketTrustObservation[],
  params: QualityParameters = QUALITY_PARAMETERS_V1
): readonly CompanyMarketTrustState[] {
  const deliveryByKey = new Map(deliveryObservations.map((d) => [cmKey(d.companyId, d.market), d]));
  const trustByKey = new Map(trustObservations.map((t) => [cmKey(t.companyId, t.market), t]));

  const previousByKey = new Map(previous.map((s) => [cmKey(s.companyId, s.market), s]));
  const touchedKeys = new Set<string>([...deliveryByKey.keys(), ...trustByKey.keys()]);

  const updated: CompanyMarketTrustState[] = previous.map((s) => {
    const k = cmKey(s.companyId, s.market);
    let customerTrustScore = s.customerTrustScore;
    let deliveryReliabilityScore = s.deliveryReliabilityScore;

    const trustObs = trustByKey.get(k);
    if (trustObs) {
      customerTrustScore = updateCustomerTrustScore(
        s.customerTrustScore,
        trustObs.deliveredQualityScore,
        trustObs.observedDeliveryScore,
        trustObs.majorIncidentTrustPenalty,
        params
      );
    }

    const deliveryObs = deliveryByKey.get(k);
    if (deliveryObs && unwrapUnit(deliveryObs.dueQuantity) > 1e-6) {
      deliveryReliabilityScore = updateDeliveryReliabilityScore(
        s.deliveryReliabilityScore,
        unwrapUnit(deliveryObs.dueQuantity),
        unwrapUnit(deliveryObs.onTimeQuantity),
        unwrapUnit(deliveryObs.continuingOverdueQuantity),
        params
      );
    }

    return { ...s, customerTrustScore, deliveryReliabilityScore };
  });

  for (const k of touchedKeys) {
    if (previousByKey.has(k)) continue;
    const [companyId, market] = k.split("::") as [CompanyId, DemandMarketId];
    let customerTrustScore = params.neutralScore;
    let deliveryReliabilityScore = params.neutralScore;
    const trustObs = trustByKey.get(k);
    if (trustObs) {
      customerTrustScore = updateCustomerTrustScore(
        params.neutralScore,
        trustObs.deliveredQualityScore,
        trustObs.observedDeliveryScore,
        trustObs.majorIncidentTrustPenalty,
        params
      );
    }
    const deliveryObs = deliveryByKey.get(k);
    if (deliveryObs && unwrapUnit(deliveryObs.dueQuantity) > 1e-6) {
      deliveryReliabilityScore = updateDeliveryReliabilityScore(
        params.neutralScore,
        unwrapUnit(deliveryObs.dueQuantity),
        unwrapUnit(deliveryObs.onTimeQuantity),
        unwrapUnit(deliveryObs.continuingOverdueQuantity),
        params
      );
    }
    updated.push({ companyId, market, customerTrustScore, deliveryReliabilityScore });
  }

  return updated;
}

/** 初期状態（全社×全商品・全社×全市場を中立値で初期化）を組み立てる。 */
export function initializeQualityReliabilityState(
  companyIds: readonly CompanyId[],
  products: readonly Product[],
  params: QualityParameters = QUALITY_PARAMETERS_V1
): QualityReliabilityState {
  const qualityByCompanyProduct: CompanyProductQualityState[] = [];
  for (const companyId of companyIds) {
    for (const product of products) {
      qualityByCompanyProduct.push({ companyId, product, qualityScore: params.qualityOutcome.baselineOperationalQuality });
    }
  }

  const trustByCompanyMarket: CompanyMarketTrustState[] = [];
  for (const companyId of companyIds) {
    for (const market of DEMAND_MARKET_IDS) {
      trustByCompanyMarket.push({ companyId, market, customerTrustScore: params.neutralScore, deliveryReliabilityScore: params.neutralScore });
    }
  }

  return { qualityByCompanyProduct, trustByCompanyMarket, rampHistory: [] };
}
