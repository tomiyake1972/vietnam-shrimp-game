// ShrimpX V2 — ENG-TIERED-MKT-1 検証fixture（決定的・乱数なし）
//
// DS1 / DS2 / DS3 のいずれにも触れない、この機能専用の固定入力。
// 会社IDは A〜E の中立な符牒であり、ゲーム本体の会社（BAL/MASS/…）とは無関係
// （会社ID による分岐をコード側にもfixture側にも持たせないため）。

import { hosoEqTons, score0to100, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../types";
import { SALES_PARAMETERS_TIERED_FIXTURE_V0, SalesParameters } from "../parameters";

export const FIXTURE_PERIOD = period(2020, 1);
export const FIXTURE_MARKET: DemandMarketId = "CN";
export const FIXTURE_PRODUCT: Product = "hoso";
export const FIXTURE_REFERENCE_PRICE = usdPerHosoEqKg(4.0);
export const FIXTURE_TARGET_DEMAND = hosoEqTons(10_000);
export const FIXTURE_COMPANY_IDS = ["CO-A", "CO-B", "CO-C", "CO-D", "CO-E"] as const;

export interface FixtureCompanySpec {
  readonly companyId: string;
  /** 参照価格に対する調整額（USD/kg）。 */
  readonly priceAdjustment: number;
  readonly quality: number;
  readonly differentiation: number;
  readonly relationship: number;
  readonly deliveryReliability: number;
  readonly salesBase: number;
  readonly desired: number;
  readonly salesForceHeadcount: number;
  /** 営業工数能力（工数トン）。undefined なら制約なし。 */
  readonly salesEffortCapacity?: number;
  /** deliverableSupplyCap（approvedAllocationCap）。undefined なら制約なし。 */
  readonly deliverableSupplyCap?: number;
}

/** 完全対称な5社（TIER-15 用の基準形）。 */
export function symmetricCompanySpecs(overrides: Partial<FixtureCompanySpec> = {}): FixtureCompanySpec[] {
  return FIXTURE_COMPANY_IDS.map((companyId) => ({
    companyId,
    priceAdjustment: 0,
    quality: 70,
    differentiation: 50,
    relationship: 60,
    deliveryReliability: 60,
    salesBase: 50,
    desired: 5_000,
    salesForceHeadcount: 20,
    ...overrides,
  }));
}

export function buildEntries(
  specs: readonly FixtureCompanySpec[],
  product: Product = FIXTURE_PRODUCT,
  market: DemandMarketId = FIXTURE_MARKET
): CompanySalesPlanEntry[] {
  return specs.map((s) => ({
    companyId: s.companyId,
    market,
    product,
    desiredQuantity: hosoEqTons(s.desired),
    priceAdjustmentUsdPerHosoEqKg: s.priceAdjustment,
    salesForceHeadcount: s.salesForceHeadcount,
    qualityReputation: score0to100(s.quality),
    customerRelationship: score0to100(s.relationship),
    deliveryReliability: score0to100(s.deliveryReliability),
    salesBaseScore: score0to100(s.salesBase),
    ...(product === "vap" ? { vapCapabilityScore: score0to100(s.differentiation) } : {}),
    ...(s.deliverableSupplyCap !== undefined ? { approvedAllocationCap: hosoEqTons(s.deliverableSupplyCap) } : {}),
  }));
}

export function buildSalesCapacityMap(
  specs: readonly FixtureCompanySpec[],
  market: DemandMarketId = FIXTURE_MARKET
): Map<string, number> | undefined {
  const withCapacity = specs.filter((s) => s.salesEffortCapacity !== undefined);
  if (withCapacity.length === 0) return undefined;
  return new Map(specs.map((s) => [`${s.companyId}::${market}`, s.salesEffortCapacity ?? Number.MAX_SAFE_INTEGER]));
}

export const FIXTURE_PARAMS: SalesParameters = SALES_PARAMETERS_TIERED_FIXTURE_V0;
