// ShrimpX V2 — 会社経営統合テスト環境 品質・信頼サマリー（Phase 7A）
//
// quality/モジュールの当期出力（BatchQualityAdjustment・MarketDeliveryObservation・
// 更新後QualityReliabilityState）を、CompanyQuarterSummaryへ追加する会社別の
// 品質・信頼フィールドへ集計するアダプター。quality/モジュール自身の計算式は
// 一切変更しない（集計・整形のみ）。

import { hosoEqTons, HosoEqTons, Score0to100, unwrapUnit } from "../core/units";
import { DemandMarketId, Product } from "../market/types";
import type { CompanyId } from "../sales/types";
import { BatchQualityAdjustment, MarketDeliveryObservation, QualityReliabilityState } from "../quality/types";

const EPSILON = 1e-6;

/**
 * 無理な増産の警告閾値（productionRampStressがこの値以上の会社×工場×商品を
 * 警告として拾う）。【暫定値・要校正】
 */
export const RAMP_WARNING_THRESHOLD = 0.5;

export interface CompanyQualitySummaryFields {
  readonly qualityScoreByProduct: Readonly<Partial<Record<Product, Score0to100>>>;
  readonly operationalRiskByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly downgradeQuantity: HosoEqTons;
  readonly reworkQuantity: HosoEqTons;
  readonly discardQuantity: HosoEqTons;
  readonly majorIncidentCount: number;
  readonly onTimeDeliveryRate?: number;
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  readonly rampWarnings: readonly { readonly factoryId: string; readonly product: Product; readonly productionRampStress: number }[];
}

export function buildCompanyQualitySummary(
  companyId: CompanyId,
  adjustments: readonly BatchQualityAdjustment[],
  qualityStateAfter: QualityReliabilityState,
  deliveryObservations: readonly MarketDeliveryObservation[]
): CompanyQualitySummaryFields {
  const companyAdjustments = adjustments.filter((a) => a.companyId === companyId);

  const weightedRiskSumByProduct = new Map<Product, number>();
  const weightByProduct = new Map<Product, number>();
  let downgradeQuantity = 0;
  let reworkQuantity = 0;
  let discardQuantity = 0;
  let majorIncidentCount = 0;
  const rampWarnings: { factoryId: string; product: Product; productionRampStress: number }[] = [];

  for (const a of companyAdjustments) {
    const weight = unwrapUnit(a.originalFinishedGoodsQuantity);
    weightedRiskSumByProduct.set(a.product, (weightedRiskSumByProduct.get(a.product) ?? 0) + a.risk.operationalRisk * weight);
    weightByProduct.set(a.product, (weightByProduct.get(a.product) ?? 0) + weight);
    downgradeQuantity += unwrapUnit(a.downgradeQuantity);
    reworkQuantity += unwrapUnit(a.reworkQuantity);
    discardQuantity += unwrapUnit(a.discardQuantity);
    if (a.outcome.majorIncident.occurred) majorIncidentCount += 1;
    if (a.risk.productionRampStress >= RAMP_WARNING_THRESHOLD) {
      rampWarnings.push({ factoryId: a.factoryId, product: a.product, productionRampStress: a.risk.productionRampStress });
    }
  }

  const operationalRiskByProduct: Record<string, number> = {};
  for (const [product, weight] of weightByProduct.entries()) {
    if (weight > EPSILON) operationalRiskByProduct[product] = (weightedRiskSumByProduct.get(product) ?? 0) / weight;
  }

  const qualityScoreByProduct: Partial<Record<Product, Score0to100>> = {};
  for (const s of qualityStateAfter.qualityByCompanyProduct) {
    if (s.companyId === companyId) qualityScoreByProduct[s.product] = s.qualityScore;
  }

  const customerTrustByMarket: Partial<Record<DemandMarketId, Score0to100>> = {};
  const deliveryReliabilityByMarket: Partial<Record<DemandMarketId, Score0to100>> = {};
  for (const t of qualityStateAfter.trustByCompanyMarket) {
    if (t.companyId !== companyId) continue;
    customerTrustByMarket[t.market] = t.customerTrustScore;
    deliveryReliabilityByMarket[t.market] = t.deliveryReliabilityScore;
  }

  const companyDeliveryObservations = deliveryObservations.filter((d) => d.companyId === companyId && unwrapUnit(d.dueQuantity) > EPSILON);
  let onTimeDeliveryRate: number | undefined;
  if (companyDeliveryObservations.length > 0) {
    const totalDue = companyDeliveryObservations.reduce((sum, d) => sum + unwrapUnit(d.dueQuantity), 0);
    const totalOnTime = companyDeliveryObservations.reduce((sum, d) => sum + unwrapUnit(d.onTimeQuantity), 0);
    onTimeDeliveryRate = totalDue > EPSILON ? Math.round((100 * totalOnTime) / totalDue * 100) / 100 : undefined;
  }

  return {
    qualityScoreByProduct,
    operationalRiskByProduct,
    downgradeQuantity: hosoEqTons(Math.round(downgradeQuantity * 100) / 100),
    reworkQuantity: hosoEqTons(Math.round(reworkQuantity * 100) / 100),
    discardQuantity: hosoEqTons(Math.round(discardQuantity * 100) / 100),
    majorIncidentCount,
    ...(onTimeDeliveryRate !== undefined ? { onTimeDeliveryRate } : {}),
    customerTrustByMarket,
    deliveryReliabilityByMarket,
    rampWarnings,
  };
}

