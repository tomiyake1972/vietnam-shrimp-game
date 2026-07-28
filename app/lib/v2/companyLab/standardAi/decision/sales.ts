// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 販売ドメイン
//
// 【基本方針（実装指示 §販売）】
//   - 既存の未履行契約の履行を最優先する（生産計画側でbacklogを加味するため、
//     ここでは販売希望量が「新規に売り込みたい量」であることに注意）。
//   - 現在庫＋当期生産計画で賄える範囲を超えて売り込まない（過大な新規約束をしない）。
//   - 完成品在庫が過剰な商品はより積極的に販売する（値引き・数量増）。
//   - 供給余力が薄い（前期稼働率が高水準）ときは値引きを避ける。
//   - PD/VAPは市場プレミアムが最低受注水準未満なら販売提案を出さない
//     （premiumPolicy.tsの既存ロジックをそのまま使う。会社×商品の経済性が
//     違えば結果も自然に変わるが、判断ロジック自体は全社共通）。
//   - 市場ごとの優先順位は、会社固有の「好みの市場」ではなく、前期実績の
//     参照価格が高い市場を優先する（pressures.tsのmarketPriceRanking、
//     公開情報だけで完結する規則）。

import { hosoEqTons } from "../../../core/units";
import { DemandMarketId, Product } from "../../../market/types";
import { CompanySalesPlanEntry, PlanCostExpectation } from "../../../sales/types";
import { minimumAcceptablePremium, orderQuantityFactor } from "../../premiumPolicy";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const EPSILON = 1e-6;
/** 商品×工場能力に対する目標稼働比率（全社一律。攻めすぎない標準的な水準）。 */
const BASE_UTILIZATION_TARGET = 0.8;

function ratioAdjustmentToUsd(ratioAdjustment: number, referencePrice: number | undefined): number {
  if (referencePrice === undefined || referencePrice <= EPSILON) return 0;
  const clamped = Math.max(-0.3, Math.min(0.3, ratioAdjustment));
  return clamped * referencePrice;
}

function orderFactorsByProduct(fixture: CompanyFixture, observation: StandardAiObservation): ProductAmount {
  return {
    hoso: 1,
    pd: orderQuantityFactor(fixture.productEconomics.premiumEconomics.pd, observation.marketPremiumByProduct.pd),
    vap: orderQuantityFactor(fixture.productEconomics.premiumEconomics.vap, observation.marketPremiumByProduct.vap),
  };
}

function buildCostExpectation(fixture: CompanyFixture, product: Product, observation: StandardAiObservation, params: StandardAiParameters): PlanCostExpectation {
  const expectedRawPrice = observation.vietnamDomesticPriorPrice ?? params.defaultExpectedRawPriceUsdPerKg;
  const expectedProcessingCost = fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg[product];

  let minimumAcceptablePrice: number;
  if (product === "hoso" || observation.lastHosoPriceVn === undefined) {
    minimumAcceptablePrice = expectedRawPrice + expectedProcessingCost;
  } else {
    const econ = fixture.productEconomics.premiumEconomics[product];
    minimumAcceptablePrice = observation.lastHosoPriceVn + minimumAcceptablePremium(econ);
  }

  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: Math.round(expectedRawPrice * 10000) / 10000,
    expectedProcessingCostUsdPerHosoEqKg: Math.round(expectedProcessingCost * 10000) / 10000,
    minimumAcceptablePriceUsdPerHosoEqKg: Math.round(minimumAcceptablePrice * 10000) / 10000,
  };
}

/** 商品別の価格調整比率（基準価格に対する比率）。fg過剰なら値引き、供給余力が薄ければ値引きしない。 */
function priceAdjustmentRatioByProduct(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters
): ProductAmount {
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    const excessRatio = pressures.finishedGoodsExcessRatioByProduct[product];
    if (excessRatio <= params.excessInventoryRatioForDiscount) continue;
    if (pressures.equipmentUtilizationLastQuarter >= params.highUtilizationRatioForNoDiscount) continue; // 供給余力が薄い＝値引きしない
    const overshoot = Math.min(1, (excessRatio - params.excessInventoryRatioForDiscount) / params.excessInventoryRatioForDiscount);
    result[product] = -params.maxDiscountRatioForExcessStock * overshoot;
  }
  return result;
}

export interface SalesPlanResult {
  readonly salesPlans: readonly CompanySalesPlanEntry[];
  readonly desiredByProduct: ProductAmount;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiSalesPlans(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): SalesPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const capacityTotals = observation.totalCapacityByProduct;
  const orderFactors = orderFactorsByProduct(fixture, observation);
  const priceAdjustments = priceAdjustmentRatioByProduct(observation, pressures, params);

  const potentialByProduct: ProductAmount = {
    hoso: capacityTotals.hoso * BASE_UTILIZATION_TARGET,
    pd: capacityTotals.pd * BASE_UTILIZATION_TARGET,
    vap: capacityTotals.vap * BASE_UTILIZATION_TARGET,
  };

  // 【重要】desiredByProduct（生産計画側が参照するベースライン販売目標）には
  // 在庫過剰による上乗せ（excessBoost）を含めない。含めてしまうと、production.tsの
  // 「販売希望＋約定残−完成品在庫」という抑制式が、同じ上乗せ分だけ相殺されてしまい、
  // 在庫が過剰なのに生産が一向に減らない、という循環（実際にSAI-1開発中の32ターン
  // 検証で確認された不具合）が生じる。在庫の積極的な売り切り（plannedSalesQuantityByProduct）は
  // 販売計画（実際の市場提示数量）だけに反映し、生産計画側には伝播させない
  // （既存在庫から売るのであって、新たに生産させるためのシグナルではない）。
  const desiredByProduct: ProductAmount = zeroProductAmount();
  const plannedSalesQuantityByProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    const excessRatio = pressures.finishedGoodsExcessRatioByProduct[product];
    const excessBoost = excessRatio > params.excessInventoryRatioForDiscount ? Math.min(0.5, excessRatio - 1) : 0;
    desiredByProduct[product] = Math.max(0, potentialByProduct[product] * orderFactors[product]);
    plannedSalesQuantityByProduct[product] = Math.max(0, desiredByProduct[product] * (1 + excessBoost));
    if (orderFactors[product] <= EPSILON && product !== "hoso") {
      diagnostics.push({
        code: "LOW_ORDER_BOOK_PREMIUM_FLOOR",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { marketPremium: observation.marketPremiumByProduct[product] ?? -1 },
        message: `${product.toUpperCase()}の市場プレミアムが最低受注水準未満のため、当期は新規販売提案を停止する。`,
      });
    } else if (excessBoost > EPSILON) {
      diagnostics.push({
        code: "PRICE_REDUCTION_FOR_EXCESS_STOCK",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { excessRatio, priceAdjustmentRatio: priceAdjustments[product] },
        message: `${product.toUpperCase()}の完成品在庫が目標水準を超えたため、値引きと販売数量の上乗せで在庫を圧縮する。`,
      });
    }
  }

  const markets = pressures.marketPriceRanking as readonly DemandMarketId[];
  const plannedRows: { market: DemandMarketId; product: Product }[] = [];
  for (const product of ["hoso", "pd", "vap"] as const) {
    if (plannedSalesQuantityByProduct[product] <= EPSILON) continue;
    markets.forEach((market, idx) => {
      const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
      if (plannedSalesQuantityByProduct[product] * weight <= EPSILON) return;
      plannedRows.push({ market, product });
    });
  }
  const rowCount = plannedRows.length;
  const headcountPerRowBase = rowCount > 0 ? Math.floor(fixture.salesForceHeadcountTotal / rowCount) : 0;
  const headcountRemainder = rowCount > 0 ? fixture.salesForceHeadcountTotal - headcountPerRowBase * rowCount : 0;
  let rowIndex = 0;

  const plans: CompanySalesPlanEntry[] = [];
  for (const product of ["hoso", "pd", "vap"] as const) {
    const totalDesired = plannedSalesQuantityByProduct[product];
    if (totalDesired <= EPSILON) continue;
    const costExpectation = buildCostExpectation(fixture, product, observation, params);
    markets.forEach((market, idx) => {
      const weight = idx === 0 ? 0.5 : 0.5 / (markets.length - 1 || 1);
      const desiredQuantity = totalDesired * weight;
      if (desiredQuantity <= EPSILON) return;
      const rowHeadcount = headcountPerRowBase + (rowIndex === 0 ? headcountRemainder : 0);
      rowIndex += 1;
      plans.push({
        companyId: fixture.companyId,
        market,
        product,
        desiredQuantity: hosoEqTons(Math.round(desiredQuantity * 100) / 100),
        priceAdjustmentUsdPerHosoEqKg: ratioAdjustmentToUsd(
          priceAdjustments[product],
          observation.markets.find((m) => m.market === market)?.referencePriceByProduct?.[product]
        ),
        salesForceHeadcount: rowHeadcount,
        costExpectation,
        qualityReputation: observation.qualityScoreByProduct[product],
        customerRelationship: observation.customerTrustByMarket[market],
        deliveryReliability: observation.deliveryReliabilityByMarket[market],
      });
    });
  }
  return { salesPlans: plans, desiredByProduct, diagnostics };
}
