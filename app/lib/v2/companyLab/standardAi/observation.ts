// ShrimpX V2 — 標準AI（SAI-1）観測可能情報の組み立て
//
// CompanyFixture（自社の静的設定）・CompanyOwnState（自社の前期末状態）・
// PublicMarketInfo（前期の公開市場結果）から、標準AIの判断ロジック（policy.ts）が
// 直接参照する平坦な観測情報 StandardAiObservation を組み立てる、純粋関数のみを
// 提供する。ここでの集約はすべて ../decisionHelpers.ts の既存関数をそのまま
// 呼び出すだけで、新しい集計ロジックは持たない。
//
// 【重要】この観測情報には、他社の非公開計画・当期の市場結果・将来のシナリオは
// 一切含まれない（受け取る CompanyOwnState / PublicMarketInfo 自体がそもそも
// それらを含まないため、構造的に混入しえない）。

import { PeriodV2 } from "../../core/period";
import { unwrapUnit } from "../../core/units";
import { unwrapUsd } from "../../finance/types";
import { Product } from "../../market/types";
import { CompanyFixture, CompanyOwnState, CompanyPremiumEconomics, PublicMarketInfo } from "../types";
import {
  availableRawMaterialQuantity,
  finishedGoodsByProduct,
  marketPremiumsFromPublicInfo,
  outstandingContractQuantityByProduct,
  overdueContractQuantityByProduct,
  pipelineRawMaterialQuantity,
  referencePricesByMarketProduct,
  totalCommonProcessingCapacity,
  totalProductCapacity,
} from "../decisionHelpers";

const EPSILON = 1e-6;

/** 1工場ぶんの労務観測情報（前期末時点）。 */
export interface StandardAiFactoryObservation {
  readonly factoryId: string;
  /** 前期末までの常用人数（workforceStateがあればそれを使い、無ければfixtureの初期値）。 */
  readonly currentRegularHeadcount: number;
  readonly skills: CompanyFixture["workerBaseline"][number]["skills"];
  readonly attendanceRate: CompanyFixture["workerBaseline"][number]["attendanceRate"];
  /** 前期の労働稼働率（turn1等でデータが無ければundefined）。 */
  readonly laborUtilizationRateLastQuarter?: number;
  readonly overtimeRateLastQuarter?: number;
  readonly temporaryWorkerShareLastQuarter?: number;
  readonly productionShortfallRateLastQuarter?: number;
}

/** 標準AIの判断ロジックが直接参照する、1社ぶんの平坦な観測情報。 */
export interface StandardAiObservation {
  readonly companyId: string;
  readonly period: PeriodV2;
  readonly turn: number;

  // --- 財務（前期末までの状態のみ） ---
  readonly cashUsd: number;
  readonly existingLoanBalanceUsd: number;

  // --- 原料 ---
  readonly availableRawMaterial: number;
  readonly pipelineRawMaterial: number;

  // --- 契約・完成品在庫（商品別、前期末時点） ---
  readonly backlogByProduct: Readonly<Record<Product, number>>;
  readonly overdueBacklogByProduct: Readonly<Record<Product, number>>;
  readonly finishedGoodsByProduct: Readonly<Record<Product, number>>;

  // --- 能力 ---
  readonly factoryCapacityByProduct: Readonly<Record<Product, number>>;
  readonly commonProcessingCapacity: number;
  readonly aquacultureCapacity: number;
  readonly factories: readonly StandardAiFactoryObservation[];
  readonly salesForceHeadcountTotal: number;
  readonly procurementHeadcountTotal: number;

  // --- 市場（前期公開情報のみ） ---
  readonly referencePricesByMarket?: ReturnType<typeof referencePricesByMarketProduct>;
  readonly marketPremiums: Readonly<Record<"pd" | "vap", number | undefined>>;
  readonly vietnamDomesticPriorPrice: number;
  readonly lastHosoPriceVn?: number;

  // --- 商品経済性（会社固有の実データ。パーソナリティではない） ---
  readonly premiumEconomicsByProduct: Readonly<Record<"pd" | "vap", CompanyPremiumEconomics>>;
}

/** 会社IDに紐づく workforceState から、工場ごとの現在常用人数を引く（無ければfixtureの初期値）。 */
function currentRegularHeadcountByFactory(fixture: CompanyFixture, ownState: CompanyOwnState): ReadonlyMap<string, number> {
  const fromState = new Map(ownState.workforceState.factories.map((f) => [f.factoryId, f.regularHeadcount]));
  const result = new Map<string, number>();
  for (const base of fixture.workerBaseline) {
    result.set(base.factoryId, fromState.get(base.factoryId) ?? base.regularHeadcount);
  }
  return result;
}

/** CompanyOwnState.lastQuarterFactoryLoadMetrics から、指定工場の前期指標を引く（無ければundefined）。 */
function factoryLoadMetricsFor(ownState: CompanyOwnState, factoryId: string) {
  return ownState.lastQuarterFactoryLoadMetrics.find((m) => m.factoryId === factoryId);
}

/**
 * StandardAiObservation を組み立てる（純粋関数）。fixture・ownState・publicInfo・
 * period・turn 以外の情報源は一切参照しない。
 */
export function buildStandardAiObservation(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): StandardAiObservation {
  const headcountByFactory = currentRegularHeadcountByFactory(fixture, ownState);
  const lastHoso = publicInfo.lastMarketResult ? unwrapUnit(publicInfo.lastMarketResult.hosoPrices.VN.price) : undefined;

  return {
    companyId: fixture.companyId,
    period,
    turn,

    cashUsd: unwrapUsd(ownState.financeState.cash),
    existingLoanBalanceUsd: ownState.financingState.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0),

    availableRawMaterial: availableRawMaterialQuantity(ownState),
    pipelineRawMaterial: pipelineRawMaterialQuantity(ownState),

    backlogByProduct: outstandingContractQuantityByProduct(ownState),
    overdueBacklogByProduct: overdueContractQuantityByProduct(ownState),
    finishedGoodsByProduct: finishedGoodsByProduct(ownState),

    factoryCapacityByProduct: totalProductCapacity(fixture),
    commonProcessingCapacity: totalCommonProcessingCapacity(fixture),
    aquacultureCapacity: unwrapUnit(fixture.aquacultureCapacity),
    factories: fixture.workerBaseline.map((base) => {
      const metrics = factoryLoadMetricsFor(ownState, base.factoryId);
      return {
        factoryId: base.factoryId,
        currentRegularHeadcount: headcountByFactory.get(base.factoryId) ?? base.regularHeadcount,
        skills: base.skills,
        attendanceRate: base.attendanceRate,
        laborUtilizationRateLastQuarter: metrics ? unwrapUnit(metrics.laborUtilizationRate) : undefined,
        overtimeRateLastQuarter: metrics ? unwrapUnit(metrics.overtimeRate) : undefined,
        temporaryWorkerShareLastQuarter: metrics ? unwrapUnit(metrics.temporaryWorkerShare) : undefined,
        productionShortfallRateLastQuarter: metrics ? unwrapUnit(metrics.productionShortfallRate) : undefined,
      };
    }),
    salesForceHeadcountTotal: fixture.salesForceHeadcountTotal,
    procurementHeadcountTotal: fixture.procurementHeadcountTotal,

    referencePricesByMarket: referencePricesByMarketProduct(publicInfo.lastMarketResult),
    marketPremiums: marketPremiumsFromPublicInfo(publicInfo),
    vietnamDomesticPriorPrice: publicInfo.vietnamDomesticPriorPrice,
    lastHosoPriceVn: lastHoso !== undefined && lastHoso > EPSILON ? lastHoso : undefined,

    premiumEconomicsByProduct: fixture.productEconomics.premiumEconomics,
  };
}
