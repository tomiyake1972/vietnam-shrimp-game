// ShrimpX V2 — 標準AI（SAI-1）判断ロジック
//
// 5社すべてに同一の StandardAiConfig・同一の判断原則を適用する、決定論的
// ルールベースの意思決定生成器。CompanyDecisionProvider型（../types.ts）を
// 満たす（会社ID・archetypeによる分岐は一切行わない。会社間の違いは
// fixture／ownState の実データにのみ由来する）。
//
// 判断原則（実装指示より）:
//   1. 正常な状態では、前四半期から大きく動かさない
//   2. 既存契約の履行を優先する
//   3. 完成品在庫が過剰なら、該当商品の生産・販売希望を調整する
//   4. 原料在庫が不足するなら調達を増やすが、必要量を大きく超えない
//   5. Worker不足なら、生産優先順位／残業／臨時増員の順序を合理的に使う
//   6. 現金不足なら、調達や在庫積み増しを抑え、必要最小限を借りる
//   7. 採算の悪い商品を機械的に増産しない
//   8. 入力エラー・NaN・Infinity・負数・不正な配分でゲームを停止させない
//
// 参照してよい情報は StandardAiObservation（observation.ts）のみ。乱数は
// 一切使わない（完全に決定論的。autoPolicy.ts と同じ方針）。

import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../../sales/types";
import { AquacultureStockingPlanEntry, DomesticPurchasePlanEntry, ImportOrderInput } from "../../rawMaterials/types";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../../production/types";
import { FinancingRequestInput } from "../../financing/types";
import { CapexDecisionInput } from "../../capex/types";
import { orderQuantityFactor } from "../premiumPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { buildCostExpectation, DEFAULT_IMPORT_ORIGIN_COUNTRY } from "../decisionHelpers";
import { buildStandardAiObservation, StandardAiObservation } from "./observation";
import { StandardAiConfig, StandardAiDecisionResult, StandardAiReasonEntry } from "./types";
import { DEFAULT_STANDARD_AI_CONFIG_V1 } from "./config";

const EPSILON = 1e-6;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
/** 商品の基準生産優先順位（期日超過契約が無い場合の既定順位。5社共通・固定）。 */
const BASE_PRODUCTION_PRIORITY: Readonly<Record<Product, number>> = { hoso: 1, pd: 2, vap: 3 };

class DiagnosticsCollector {
  private readonly entries: StandardAiReasonEntry[] = [];
  constructor(private readonly companyId: string) {}
  add(code: StandardAiReasonEntry["code"], message: string, extra?: { product?: Product; factoryId?: string }): void {
    this.entries.push({ code, companyId: this.companyId, message, ...extra });
  }
  toArray(): readonly StandardAiReasonEntry[] {
    return this.entries;
  }
}

/** 商品別の受注量係数（HOSOは基準商品として常に1、PD/VAPは最低受注プレミアム判断）。 */
function orderFactorsByProduct(obs: StandardAiObservation): Record<Product, number> {
  return {
    hoso: 1,
    pd: orderQuantityFactor(obs.premiumEconomicsByProduct.pd, obs.marketPremiums.pd),
    vap: orderQuantityFactor(obs.premiumEconomicsByProduct.vap, obs.marketPremiums.vap),
  };
}

/**
 * 完成品在庫過剰による抑制係数（0〜1、1なら抑制なし）。在庫が
 * 「潜在販売希望量×finishedGoodsExcessQuarters」を超えた分だけ、
 * finishedGoodsExcessMaxDampingを上限として比例的に抑制する。
 */
function excessDampingFactor(config: StandardAiConfig, potential: number, finishedGoods: number): number {
  const threshold = potential * config.finishedGoodsExcessQuarters;
  if (potential <= EPSILON || finishedGoods <= threshold) return 1;
  const overRatio = (finishedGoods - threshold) / Math.max(potential, EPSILON);
  const damping = Math.min(config.finishedGoodsExcessMaxDamping, overRatio);
  return Math.max(0, 1 - damping);
}

function buildSalesAndProductionDesired(
  fixture: CompanyFixture,
  obs: StandardAiObservation,
  config: StandardAiConfig,
  diag: DiagnosticsCollector
): { readonly salesDesiredByProduct: Record<Product, number>; readonly productionDesiredByProduct: Record<Product, number> } {
  const orderFactors = orderFactorsByProduct(obs);
  const salesDesiredByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  const productionDesiredByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };

  for (const product of PRODUCTS) {
    const capacity = obs.factoryCapacityByProduct[product];
    const potential = capacity * config.productionTargetRatio;
    const fg = obs.finishedGoodsByProduct[product];
    const damping = excessDampingFactor(config, potential, fg);

    if (damping < 1 - EPSILON) {
      diag.add(
        "SALES_REDUCED_FINISHED_GOODS_EXCESS",
        `完成品在庫過剰(${fg.toFixed(0)})のため${product.toUpperCase()}の販売希望を${Math.round((1 - damping) * 100)}%抑制`,
        { product }
      );
      diag.add(
        "PRODUCTION_REDUCED_FINISHED_GOODS_EXCESS",
        `完成品在庫過剰のため${product.toUpperCase()}の生産希望を抑制`,
        { product }
      );
    } else {
      diag.add("SALES_STABLE_NO_CHANGE", `${product.toUpperCase()}は正常水準のため販売方針を維持`, { product });
    }

    if (orderFactors[product] < 1 - EPSILON) {
      diag.add(
        "SALES_REDUCED_LOW_MARGIN",
        `${product.toUpperCase()}の市場プレミアムが目標水準未満のため受注量を${Math.round(orderFactors[product] * 100)}%に縮小`,
        { product }
      );
    }

    salesDesiredByProduct[product] = potential * orderFactors[product] * damping;

    const backlog = obs.backlogByProduct[product];
    productionDesiredByProduct[product] = Math.max(0, salesDesiredByProduct[product] + backlog - fg);
  }

  return { salesDesiredByProduct, productionDesiredByProduct };
}

function buildSalesPlans(
  fixture: CompanyFixture,
  obs: StandardAiObservation,
  salesDesiredByProduct: Readonly<Record<Product, number>>,
  publicInfo: PublicMarketInfo
): readonly CompanySalesPlanEntry[] {
  const markets: readonly DemandMarketId[] = DEMAND_MARKET_IDS;
  const plannedRows: { readonly market: DemandMarketId; readonly product: Product }[] = [];
  for (const product of PRODUCTS) {
    if (salesDesiredByProduct[product] <= EPSILON) continue;
    for (const market of markets) plannedRows.push({ market, product });
  }
  const rowCount = plannedRows.length;
  const headcountPerRowBase = rowCount > 0 ? Math.floor(obs.salesForceHeadcountTotal / rowCount) : 0;
  const headcountRemainder = rowCount > 0 ? obs.salesForceHeadcountTotal - headcountPerRowBase * rowCount : 0;

  const plans: CompanySalesPlanEntry[] = [];
  let rowIndex = 0;
  for (const product of PRODUCTS) {
    const totalDesired = salesDesiredByProduct[product];
    if (totalDesired <= EPSILON) continue;
    const costExpectation = buildCostExpectation(fixture, product, publicInfo);
    const perMarket = totalDesired / markets.length;
    for (const market of markets) {
      if (perMarket <= EPSILON) continue;
      const rowHeadcount = headcountPerRowBase + (rowIndex === 0 ? headcountRemainder : 0);
      rowIndex += 1;
      plans.push({
        companyId: fixture.companyId,
        market,
        product,
        // 標準AIは基準価格どおりで受注する（値引き・値上げの戦略調整は行わない）。
        desiredQuantity: hosoEqTons(Math.round(perMarket * 100) / 100),
        priceAdjustmentUsdPerHosoEqKg: 0,
        salesForceHeadcount: rowHeadcount,
        costExpectation,
      });
    }
  }
  return plans;
}

function buildProductionPlans(
  fixture: CompanyFixture,
  obs: StandardAiObservation,
  productionDesiredByProduct: Readonly<Record<Product, number>>,
  diag: DiagnosticsCollector
): readonly CompanyProductionPlanEntry[] {
  const capacityTotals = obs.factoryCapacityByProduct;
  const overdueByProduct = obs.overdueBacklogByProduct;
  const plans: CompanyProductionPlanEntry[] = [];

  for (const f of fixture.factories) {
    const capacityByProduct: Readonly<Record<Product, number>> = {
      hoso: unwrapUnit(f.hosoCapacity),
      pd: unwrapUnit(f.pdCapacity),
      vap: unwrapUnit(f.vapCapacity),
    };
    for (const product of PRODUCTS) {
      const capacity = capacityByProduct[product];
      const needed = productionDesiredByProduct[product];
      if (capacity <= EPSILON || needed <= EPSILON) continue;
      const share = capacityTotals[product] > EPSILON ? capacity / capacityTotals[product] : 0;
      const desired = Math.min(capacity, needed * share);
      if (desired <= EPSILON) continue;

      const hasOverdue = overdueByProduct[product] > EPSILON;
      const priority = hasOverdue ? 0 : BASE_PRODUCTION_PRIORITY[product];
      if (hasOverdue) {
        diag.add(
          "PRODUCTION_PRIORITIZED_CONTRACT_FULFILLMENT",
          `${product.toUpperCase()}に期日超過契約があるため生産優先順位を最上位へ引き上げ`,
          { product, factoryId: f.factoryId }
        );
      }

      plans.push({
        companyId: fixture.companyId,
        factoryId: f.factoryId,
        product,
        desiredQuantity: hosoEqTons(Math.round(desired * 100) / 100),
        priority,
      });
    }
  }
  return plans;
}

function buildWorkerAssignments(
  fixture: CompanyFixture,
  obs: StandardAiObservation,
  config: StandardAiConfig,
  diag: DiagnosticsCollector
): readonly WorkerAssignment[] {
  return obs.factories.map((factoryObs) => {
    const baseline = fixture.workerBaseline.find((b) => b.factoryId === factoryObs.factoryId)!;
    const utilization = factoryObs.laborUtilizationRateLastQuarter ?? 0;
    const priorOvertime = factoryObs.overtimeRateLastQuarter ?? config.baseOvertimeRate;
    const priorTemp = factoryObs.temporaryWorkerShareLastQuarter ?? config.baseTemporaryWorkerRatio;

    let overtimeRate = config.baseOvertimeRate;
    let temporaryRatio = config.baseTemporaryWorkerRatio;

    if (utilization >= config.laborShortageUtilizationThreshold) {
      const overtimeAtCap = priorOvertime >= config.maxOvertimeRate - EPSILON;
      if (!overtimeAtCap) {
        overtimeRate = Math.min(config.maxOvertimeRate, priorOvertime + config.overtimeStepUp);
        diag.add(
          "LABOR_OVERTIME_INCREASED_SHORTAGE",
          `前期労働稼働率${Math.round(utilization * 100)}%のため残業率を${Math.round(overtimeRate * 100)}%へ引き上げ`,
          { factoryId: factoryObs.factoryId }
        );
      } else {
        overtimeRate = config.maxOvertimeRate;
        temporaryRatio = Math.min(config.maxTemporaryWorkerRatio, priorTemp + config.temporaryWorkerStepUp);
        diag.add(
          "LABOR_TEMPORARY_INCREASED_SHORTAGE",
          `残業率が上限(${Math.round(config.maxOvertimeRate * 100)}%)に達しているため臨時ワーカー比率を${Math.round(
            temporaryRatio * 100
          )}%へ引き上げ`,
          { factoryId: factoryObs.factoryId }
        );
      }
    } else {
      diag.add("LABOR_STABLE_NO_CHANGE", "労働稼働率は正常水準のため常用人数・残業・臨時比率を維持", {
        factoryId: factoryObs.factoryId,
      });
    }

    return {
      factoryId: factoryObs.factoryId,
      companyId: fixture.companyId,
      // 正常な状態では前四半期から大きく動かさない：常用人数は現状維持（増減は別フェーズの検討事項）。
      regularHeadcount: factoryObs.currentRegularHeadcount,
      temporaryHeadcount: Math.round(factoryObs.currentRegularHeadcount * temporaryRatio),
      skills: baseline.skills,
      overtimeRate: ratio(overtimeRate),
      attendanceRate: baseline.attendanceRate,
    };
  });
}

function buildProcurement(
  fixture: CompanyFixture,
  obs: StandardAiObservation,
  productionDesiredByProduct: Readonly<Record<Product, number>>,
  config: StandardAiConfig,
  period: PeriodV2,
  diag: DiagnosticsCollector
): {
  readonly domesticPurchasePlan: DomesticPurchasePlanEntry;
  readonly importOrders: readonly ImportOrderInput[];
  readonly aquacultureStockingPlans: readonly AquacultureStockingPlanEntry[];
} {
  const requiredRawMaterial = PRODUCTS.reduce((sum, p) => sum + productionDesiredByProduct[p], 0);

  const mixBase = {
    domestic: config.sourcingMix.domestic * requiredRawMaterial,
    import: config.sourcingMix.import * requiredRawMaterial,
    aquaculture: config.sourcingMix.aquaculture * requiredRawMaterial,
  };
  const targetInventory = config.rawInventoryTargetQuarters * requiredRawMaterial;
  const inventoryPosition = obs.availableRawMaterial + obs.pipelineRawMaterial * 0.5;
  const correction = config.inventoryCorrectionDamping * (targetInventory - inventoryPosition);
  const floor = config.minDomesticPurchaseRatioOfMix * mixBase.domestic;
  const cap = mixBase.domestic * 2 + targetInventory;
  let domesticDesired = Math.min(cap, Math.max(floor, mixBase.domestic + correction));

  // 【原則4】来期の projected shortfall（現有＋パイプライン < 必要量）があれば調達を積み増すが、
  // 必要量を大きく超えない（rawMaterialShortageMaxBoostRatioで上限）。
  const projectedShortfall = requiredRawMaterial - (obs.availableRawMaterial + obs.pipelineRawMaterial);
  let procurementBoostApplied = false;
  if (projectedShortfall > EPSILON) {
    const maxBoost = requiredRawMaterial * config.rawMaterialShortageMaxBoostRatio;
    const boost = Math.min(projectedShortfall, maxBoost);
    domesticDesired += boost;
    procurementBoostApplied = true;
  }

  // 【原則6】現金不足時は調達・在庫積み増しを抑える。
  let importDesired = mixBase.import;
  let aquacultureTargetHarvest = mixBase.aquaculture;
  let cashThrottleApplied = false;
  if (obs.cashUsd < config.targetMinimumCashUsd) {
    const rawRatio = config.targetMinimumCashUsd > EPSILON ? Math.max(0, obs.cashUsd) / config.targetMinimumCashUsd : 1;
    const throttle = Math.max(config.minProcurementThrottleRatio, Math.min(1, rawRatio));
    domesticDesired *= throttle;
    importDesired *= throttle;
    aquacultureTargetHarvest *= throttle;
    cashThrottleApplied = true;
  }

  if (procurementBoostApplied) {
    diag.add(
      "PROCUREMENT_INCREASED_RAW_MATERIAL_SHORTAGE",
      `来期の原料不足見込み（必要${requiredRawMaterial.toFixed(0)} > 保有${(obs.availableRawMaterial + obs.pipelineRawMaterial).toFixed(
        0
      )}）のため国内買付を積み増し`
    );
  }
  if (cashThrottleApplied) {
    diag.add("PROCUREMENT_REDUCED_CASH_SHORTAGE", `現金が最低水準を下回っているため調達量を抑制`);
  }
  if (!procurementBoostApplied && !cashThrottleApplied) {
    diag.add("PROCUREMENT_STABLE_NO_CHANGE", "原料在庫・現金とも正常水準のため標準の調達構成比を維持");
  }

  const domesticPurchasePlan: DomesticPurchasePlanEntry = {
    companyId: fixture.companyId,
    desiredQuantity: hosoEqTons(Math.round(Math.max(0, domesticDesired) * 100) / 100),
    priceAdjustmentUsdPerHosoEqKg: 0,
    procurementHeadcount: obs.procurementHeadcountTotal,
    factoryCommonProcessingCapacityTons: obs.commonProcessingCapacity,
  };

  const importOrders: ImportOrderInput[] =
    importDesired > EPSILON
      ? [
          {
            companyId: fixture.companyId,
            originCountry: DEFAULT_IMPORT_ORIGIN_COUNTRY,
            orderedQuantity: hosoEqTons(Math.round(Math.max(0, importDesired) * 100) / 100),
            orderedPeriod: period,
          },
        ]
      : [];

  const aquacultureStockingPlans: AquacultureStockingPlanEntry[] = (() => {
    if (obs.aquacultureCapacity <= EPSILON) return [];
    const stocking = Math.min(obs.aquacultureCapacity, aquacultureTargetHarvest / config.expectedAquacultureHarvestRatio);
    if (stocking <= EPSILON) return [];
    return [
      {
        companyId: fixture.companyId,
        aquacultureCapacity: hosoEqTons(obs.aquacultureCapacity),
        plannedStockingQuantity: hosoEqTons(Math.round(Math.max(0, stocking) * 100) / 100),
        // 標準AIは強度・バイオセキュリティともに中庸の固定値を使う（会社間で差をつけない）。
        aquacultureIntensity: ratio(0.5),
        bioSecurityLevel: ratio(0.7),
        stockingPeriod: period,
      },
    ];
  })();

  return { domesticPurchasePlan, importOrders, aquacultureStockingPlans };
}

function buildFinancingRequest(obs: StandardAiObservation, config: StandardAiConfig, diag: DiagnosticsCollector): FinancingRequestInput {
  const desiredAmountUsd = obs.cashUsd < config.targetMinimumCashUsd ? config.targetMinimumCashUsd - obs.cashUsd : 0;
  const desiredPrepaymentUsd =
    obs.cashUsd > config.voluntaryPrepaymentThresholdCashUsd && obs.existingLoanBalanceUsd > 0
      ? Math.min(obs.cashUsd - config.voluntaryPrepaymentThresholdCashUsd, obs.existingLoanBalanceUsd)
      : 0;

  if (desiredAmountUsd > EPSILON) {
    diag.add(
      "FINANCING_MINIMUM_BORROW_CASH_SHORTAGE",
      `現金(${Math.round(obs.cashUsd).toLocaleString()})が最低水準(${config.targetMinimumCashUsd.toLocaleString()})を下回るため、` +
        `不足分(${Math.round(desiredAmountUsd).toLocaleString()})のみ短期借入を申請`
    );
  } else if (desiredPrepaymentUsd > EPSILON) {
    diag.add(
      "FINANCING_VOLUNTARY_PREPAYMENT",
      `現金余剰のため既存借入(${Math.round(desiredPrepaymentUsd).toLocaleString()})を任意期限前返済`
    );
  } else {
    diag.add("FINANCING_NONE_CASH_SUFFICIENT", "現金水準は十分のため新規借入・返済とも行わない");
  }

  return {
    desiredAmountUsd,
    desiredLoanType: "workingCapital",
    desiredTermQuarters: config.desiredTermQuarters,
    desiredRepaymentMethod: "bulletAtMaturity",
    desiredPrepaymentUsd,
    emergencyAcceptable: config.emergencyAcceptable,
  };
}

function buildCapexDecision(companyId: string, diag: DiagnosticsCollector): CapexDecisionInput {
  diag.add("CAPEX_DEFERRED_STANDARD_POLICY", "SAI-1では標準方針として新規設備投資を提案しない");
  return { companyId, newProjectProposals: [], cancelRequests: [], resumeRequests: [] };
}

/**
 * 標準AI（SAI-1）の意思決定生成（純粋関数）。同一の fixture・ownState・
 * publicInfo・period・turn・config を与えれば常に同じ結果を返す。
 * fixture.archetype・fixture.companyId による分岐は一切行わない
 * （会社ごとの違いはすべて fixture／ownState の実データにのみ由来する）。
 */
export function computeStandardAiDecision(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number,
  config: StandardAiConfig = DEFAULT_STANDARD_AI_CONFIG_V1
): StandardAiDecisionResult {
  const obs = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const diag = new DiagnosticsCollector(fixture.companyId);

  const { salesDesiredByProduct, productionDesiredByProduct } = buildSalesAndProductionDesired(fixture, obs, config, diag);
  const salesPlans = buildSalesPlans(fixture, obs, salesDesiredByProduct, publicInfo);
  const productionPlans = buildProductionPlans(fixture, obs, productionDesiredByProduct, diag);
  const { domesticPurchasePlan, importOrders, aquacultureStockingPlans } = buildProcurement(
    fixture,
    obs,
    productionDesiredByProduct,
    config,
    period,
    diag
  );
  const workerAssignments = buildWorkerAssignments(fixture, obs, config, diag);
  const financingRequest = buildFinancingRequest(obs, config, diag);
  const capexDecision = buildCapexDecision(fixture.companyId, diag);

  const decision: CompanyDecisionInput = {
    companyId: fixture.companyId,
    salesPlans,
    domesticPurchasePlan,
    importOrders,
    aquacultureStockingPlans,
    productionPlans,
    workerAssignments,
    financingRequest,
    capexDecision,
  };

  return {
    decision,
    diagnostics: { companyId: fixture.companyId, period, turn, reasons: diag.toArray() },
  };
}
