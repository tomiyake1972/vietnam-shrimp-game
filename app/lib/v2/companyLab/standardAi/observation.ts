// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 Observationビルダー
//
// 【情報境界】この関数のシグネチャは既存のCompanyDecisionProvider
// （companyLab/types.ts）と同じ4引数＋turnだけを受け取る。fixture・ownState・
// publicInfoはいずれも「自社の状態」「前四半期までの公開市場情報」のみを
// 保持する既存型であり、本関数はこれ以外の情報源（turn runnerの内部状態・
// 他社の非公開データ・将来の乱数列）に一切アクセスしない（アクセスする手段が
// 関数シグネチャ上そもそも存在しない）。

import { unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, MarketQuarterResult, Product } from "../../market/types";
import { deriveMarketReferencePrices } from "../../market/destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "../../market/destinationPricingParameters";
import { PeriodV2 } from "../../core/period";
import { unwrapUsd } from "../../finance/types";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { findFactoryRegularHeadcount } from "../workforce";
import { computeCapacityEffectForCompany, isCapexProjectOperationalAt } from "../../capex/capacityEffect";
import { FactoryObservation, MarketObservationEntry, ProductAmount, StandardAiObservation, zeroProductAmount } from "./types";

const EPSILON = 1e-6;

function availableRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function pipelineRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots
    .filter((l) => l.status === "inTransitImport" || l.status === "growingAquaculture")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function outstandingContractByProduct(ownState: CompanyOwnState): ProductAmount {
  const result = { hoso: 0, pd: 0, vap: 0 };
  for (const c of ownState.contracts) {
    if (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue") {
      result[c.product] += unwrapUnit(c.outstandingQuantity);
    }
  }
  return result;
}

function finishedGoodsByProduct(ownState: CompanyOwnState): ProductAmount {
  const result = { hoso: 0, pd: 0, vap: 0 };
  for (const l of ownState.finishedGoodsLots) {
    if (l.status === "available") result[l.product] += unwrapUnit(l.remainingQuantity);
  }
  return result;
}

function referencePricesByMarketProduct(
  lastMarketResult: MarketQuarterResult | undefined
): Partial<Record<(typeof DEMAND_MARKET_IDS)[number], ProductAmount>> | undefined {
  if (!lastMarketResult) return undefined;
  const breakdown = deriveMarketReferencePrices(lastMarketResult, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const result: Partial<Record<(typeof DEMAND_MARKET_IDS)[number], ProductAmount>> = {};
  for (const market of DEMAND_MARKET_IDS) {
    result[market] = {
      hoso: unwrapUnit(breakdown[market].hoso),
      pd: unwrapUnit(breakdown[market].pd),
      vap: unwrapUnit(breakdown[market].vap),
    };
  }
  return result;
}

function buildMarkets(publicInfo: PublicMarketInfo): readonly MarketObservationEntry[] {
  const byMarket = referencePricesByMarketProduct(publicInfo.lastMarketResult);
  return DEMAND_MARKET_IDS.map((market) => ({
    market,
    referencePriceByProduct: byMarket ? byMarket[market] : undefined,
  }));
}

function buildFactoryObservations(fixture: CompanyFixture, ownState: CompanyOwnState, period: PeriodV2): readonly FactoryObservation[] {
  // 【SAI-5F修正（Fable事前監査で特定した既存の観測ギャップ）】完成・稼働開始済み
  // のcapex能力増加を、エンジン側（runner.tsのapplyCapexCapacityToFactories）と
  // 同じ規則で観測へ反映する。従来は静的fixtureの能力のみを観測していたため、
  // 増設が完成してもAIは旧能力を分母に使い続け、同じボトルネックを恒久的に
  // 再提案し得た（判断根拠と実際のエンジン能力の食い違い）。
  // エンジン側と同じく「その会社の最初の工場（factoryId昇順）」へ加算する。
  const capexEffect = computeCapacityEffectForCompany(ownState.capexState.portfolio.projects, period);
  const firstFactoryId = [...fixture.factories].map((f) => f.factoryId).sort()[0];
  return fixture.factories.map((f) => {
    const baseline = fixture.workerBaseline.find((w) => w.factoryId === f.factoryId);
    const currentRegularHeadcount =
      findFactoryRegularHeadcount({ companies: [ownState.workforceState] }, fixture.companyId, f.factoryId) ?? baseline?.regularHeadcount ?? 0;
    const skillByProduct: ProductAmount = zeroProductAmount();
    if (baseline) {
      for (const s of baseline.skills) {
        skillByProduct[s.product] = unwrapUnit(s.skillLevel);
      }
    }
    const isMainFactory = f.factoryId === firstFactoryId;
    return {
      factoryId: f.factoryId,
      capacityByProduct: {
        hoso: unwrapUnit(f.hosoCapacity) + (isMainFactory ? capexEffect.hoso : 0),
        pd: unwrapUnit(f.pdCapacity) + (isMainFactory ? capexEffect.pd : 0),
        vap: unwrapUnit(f.vapCapacity) + (isMainFactory ? capexEffect.vap : 0),
      },
      commonProcessingCapacity: unwrapUnit(f.commonProcessingCapacity) + (isMainFactory ? capexEffect.commonProcessing : 0),
      freezingPackagingCapacity: unwrapUnit(f.freezingPackagingCapacity) + (isMainFactory ? capexEffect.freezingPackaging : 0),
      currentRegularHeadcount,
      skillByProduct,
      attendanceRate: baseline ? unwrapUnit(baseline.attendanceRate) : 1,
    };
  });
}

function totalCapacityByProduct(factories: readonly FactoryObservation[]): ProductAmount {
  return factories.reduce(
    (acc, f) => ({
      hoso: acc.hoso + f.capacityByProduct.hoso,
      pd: acc.pd + f.capacityByProduct.pd,
      vap: acc.vap + f.capacityByProduct.vap,
    }),
    zeroProductAmount()
  );
}

function averageEquipmentUtilization(ownState: CompanyOwnState): number | undefined {
  const metrics = ownState.lastQuarterFactoryLoadMetrics;
  if (!metrics || metrics.length === 0) return undefined;
  const sum = metrics.reduce((s, m) => s + unwrapUnit(m.equipmentUtilizationRate), 0);
  return sum / metrics.length;
}

function averageLaborUtilization(ownState: CompanyOwnState): number | undefined {
  const metrics = ownState.lastQuarterFactoryLoadMetrics;
  if (!metrics || metrics.length === 0) return undefined;
  const sum = metrics.reduce((s, m) => s + unwrapUnit(m.laborUtilizationRate), 0);
  return sum / metrics.length;
}

function activeCapexTargets(ownState: CompanyOwnState, period: PeriodV2): ReadonlySet<Product | "commonProcessing" | "freezingPackaging" | "coldStorage"> {
  const targets = new Set<Product | "commonProcessing" | "freezingPackaging" | "coldStorage">();
  for (const project of ownState.capexState.portfolio.projects) {
    // 【SAI-5F修正（Fable事前監査）】従来はapproved/underConstructionのみを
    // 「進行中」とみなしていたため、(a) suspended（資金難で中断中。再開待ちの
    // 実在する案件）、(b) completedだが稼働開始前（readiness期間中の1〜2四半期）
    // の窓で同一ターゲットを重複提案し得た。cancelled と「completedかつ稼働開始
    // 済み（＝能力へ反映済み、上のcapexEffectが観測に含める）」だけを除外する。
    if (project.status === "cancelled") continue;
    if (project.status === "completed" && isCapexProjectOperationalAt(project, period)) continue;
    const target = project.futureCapacityEffect?.targetProduct;
    if (target) targets.add(target);
  }
  return targets;
}

export function buildStandardAiObservation(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): StandardAiObservation {
  const factories = buildFactoryObservations(fixture, ownState, period);
  const lastMarketResult = publicInfo.lastMarketResult;

  return {
    companyId: fixture.companyId,
    period,
    turn,

    outstandingContractByProduct: outstandingContractByProduct(ownState),
    finishedGoodsByProduct: finishedGoodsByProduct(ownState),
    rawMaterialAvailable: availableRawMaterialQuantity(ownState),
    rawMaterialPipeline: pipelineRawMaterialQuantity(ownState),

    factories,
    totalCapacityByProduct: totalCapacityByProduct(factories),
    totalCommonProcessingCapacity: factories.reduce((s, f) => s + f.commonProcessingCapacity, 0),
    aquacultureCapacity: unwrapUnit(fixture.aquacultureCapacity),
    salesForceHeadcountTotal: fixture.salesForceHeadcountTotal,
    procurementHeadcountTotal: fixture.procurementHeadcountTotal,

    lastQuarterEquipmentUtilizationRate: averageEquipmentUtilization(ownState),
    lastQuarterLaborUtilizationRate: averageLaborUtilization(ownState),
    lastQuarterActualProductionByProduct: ownState.lastQuarterActualProductionByProduct,

    markets: buildMarkets(publicInfo),
    marketPremiumByProduct: {
      pd: lastMarketResult ? unwrapUnit(lastMarketResult.pdPremium.byCountry.VN.premium) : undefined,
      vap: lastMarketResult ? unwrapUnit(lastMarketResult.vapPremium.byCountry.VN.premium) : undefined,
    },
    vietnamDomesticPriorPrice: publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : undefined,
    lastHosoPriceVn: lastMarketResult ? unwrapUnit(lastMarketResult.hosoPrices.VN.price) : undefined,

    productEconomics: {
      expectedProcessingCostUsdPerHosoEqKg: fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg,
    },

    cashUsd: unwrapUsd(ownState.financeState.cash),
    existingLoanBalanceUsd: ownState.financingState.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0),
    regularHeadcountTotal: factories.reduce((s, f) => s + f.currentRegularHeadcount, 0),

    activeCapexProjectTargets: activeCapexTargets(ownState, period),
    // 【SAI-5F】中断中案件（projectId昇順の決定論的順序。resume提案の対象）。
    suspendedCapexProjectIds: ownState.capexState.portfolio.projects
      .filter((p) => p.status === "suspended")
      .map((p) => p.projectId)
      .sort(),

    qualityScoreByProduct: ownState.qualityScoreByProduct,
    customerTrustByMarket: ownState.customerTrustByMarket,
    deliveryReliabilityByMarket: ownState.deliveryReliabilityByMarket,

    // 【SAI-5D】自社の営業基盤（前四半期末までの値。ownState経由の一本道）。
    salesBaseByMarketProduct: ownState.salesBaseByMarketProduct,
    salesBaseCompetitivenessWeight: ownState.salesBaseCompetitivenessWeight,

    // 【VAP差別化戦略】自社のVAP能力係数（前四半期末までの値。ownState経由の一本道）。
    vapCapabilityCoefficient: ownState.vapCapabilityCoefficient,

    // 【SAI-5C】ライフサイクル公開トレンド（前四半期までの公開情報のみ。
    // publicInfo経由の一本道＝当期需要の先読みリークはない）。
    lifecycleSharesByMarket: publicInfo.productLifecycleOutlook?.sharesByMarket,
    lifecycleTrendByMarket: publicInfo.productLifecycleOutlook?.quarterlyTrendByMarket,

    // 【SAI-5E】商品別供給圧力の公開統計（前四半期末までのEWMA）。
    productSupplyPressureByProduct: publicInfo.productSupplyPressureOutlook,
  };
}
