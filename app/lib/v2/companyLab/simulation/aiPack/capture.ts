// ShrimpX V2 — AI Analysis Pack: 実行中の記録（capture）
//
// 【なぜ実行中に記録するのか】
// 期首状態・実効能力・工場スペース・進行中の投資案件は、ゲームの確定履歴
// （CompanyQuarterRecord）には残らない導出値である。あとから復元するには、
// その時点の CompanyLabState を見るしかない。そこで advanceSimulationTurn の
// 中で、**そのターンの前後の状態**から必要な値だけを正規化して拾う。
//
// 【CompanyLabState を丸ごと複製しない】
// ここで作るのは会社数×ターン数ぶんの小さなスカラー集合であり、
// scenarioState・contracts・rawMaterialLots 等の生の状態は一切含めない。
//
// 【新しい計算式を作らない】
// 能力は computeEffectiveFactories / calculateFactoryEffectiveCapacity、
// スペースは factorySpace.ts の関数をそのまま通す（唯一の情報源）。

import { CompanyFixture, CompanyLabState } from "../../types";
import { Product } from "../../../market/types";
import { unwrapUnit } from "../../../core/units";
import { toYearQuarter } from "../../../core/period";
import { computeEffectiveFactories } from "../../../capex/factoryConstruction";
import { calculateFactoryEffectiveCapacity } from "../../../production/capacity";
import {
  FACTORY_SPACE_PARAMETERS_V1,
  computeFactoryUsedSpaceUnits,
  resolveFactoryTotalSpaceUnits,
} from "../../../production/factorySpace";
import { PackCapitalProject, PackCompanyStateSnapshot, PackWorldTurn } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function num(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function tons(v: unknown): number | null {
  return num(unwrapUnit(v as never));
}

/**
 * その時点の会社状態のスナップショット。
 * 期首（当期処理前）にも期末（当期処理後）にも同じ関数を使うため、
 * Beginning → Decision → Result → Ending を同じ軸で比較できる。
 */
export function captureCompanyStateSnapshot(state: CompanyLabState, fixture: CompanyFixture): PackCompanyStateSnapshot {
  const companyId = fixture.companyId;

  const financeState = state.financeState.companies.find((c) => c.companyId === companyId);
  const financingState = state.financingState.companies.find((c) => c.companyId === companyId);
  const cashUsd = financeState ? num(financeState.cash) : null;
  // 借入残高は融資ポートフォリオが唯一の真実（financing/types.ts）。
  // 未接続（ポートフォリオ未生成）の場合のみ finance 側の残高へフォールバックする。
  const portfolioDebt = financingState
    ? financingState.loanPortfolio.loans.filter((l) => l.status !== "closed").reduce((sum, l) => sum + l.currentPrincipalUsd, 0)
    : null;
  const debtUsd =
    portfolioDebt !== null
      ? portfolioDebt
      : financeState
        ? (num(financeState.shortTermLoans) ?? 0) + (num(financeState.longTermLoans) ?? 0)
        : null;
  const equityUsd = financeState ? (num(financeState.capitalStock) ?? 0) + (num(financeState.retainedEarnings) ?? 0) : null;

  const rawMaterialInventoryTons = state.rawMaterialLots
    .filter((lot) => lot.companyId === companyId)
    .reduce((sum, lot) => sum + (tons(lot.remainingQuantity) ?? 0), 0);
  const finishedGoodsInventoryTons = state.productionState.finishedGoodsLots
    .filter((lot) => lot.companyId === companyId)
    .reduce((sum, lot) => sum + (tons(lot.remainingQuantity) ?? 0), 0);
  // 未履行残（backlog）＝ まだ納品しきっていない契約の残量。
  const backlogTons = state.contracts
    .filter((c) => c.companyId === companyId && c.status !== "fulfilled" && c.status !== "cancelled")
    .reduce((sum, c) => sum + Math.max(0, tons(c.outstandingQuantity) ?? 0), 0);

  const capexForCompany = state.capexState.companies.find((c) => c.companyId === companyId);
  const effectiveFactories = capexForCompany
    ? computeEffectiveFactories(fixture.factories, { companies: [capexForCompany] }, state.currentPeriod)
    : fixture.factories;

  const capacityTotals = effectiveFactories.reduce(
    (acc, f) => {
      const c = calculateFactoryEffectiveCapacity(f);
      return {
        hoso: acc.hoso + unwrapUnit(c.hoso),
        pd: acc.pd + unwrapUnit(c.pd),
        vap: acc.vap + unwrapUnit(c.vap),
        commonProcessing: acc.commonProcessing + unwrapUnit(c.commonProcessing),
      };
    },
    { hoso: 0, pd: 0, vap: 0, commonProcessing: 0 }
  );

  let spaceTotal = 0;
  let spaceUsed = 0;
  for (const factory of effectiveFactories) {
    spaceTotal += resolveFactoryTotalSpaceUnits(factory, FACTORY_SPACE_PARAMETERS_V1);
    spaceUsed += computeFactoryUsedSpaceUnits(factory, FACTORY_SPACE_PARAMETERS_V1);
  }

  return {
    cashUsd,
    debtUsd,
    equityUsd,
    salesHeadcount: state.salesForceHiringState?.companies.find((c) => c.companyId === companyId)?.headcount ?? fixture.salesForceHeadcountTotal,
    rawMaterialInventoryTons,
    finishedGoodsInventoryTons,
    backlogTons,
    factoryCount: effectiveFactories.length,
    capacityTonsByProduct: { hoso: capacityTotals.hoso, pd: capacityTotals.pd, vap: capacityTotals.vap },
    commonProcessingCapacityTons: capacityTotals.commonProcessing,
    factorySpaceTotalUnits: spaceTotal,
    factorySpaceUsedUnits: spaceUsed,
    factorySpaceRemainingUnits: spaceTotal - spaceUsed,
  };
}

/** 期末時点の設備投資案件（進行中・完成済み）。 */
export function captureCapitalProjects(state: CompanyLabState, companyId: string): readonly PackCapitalProject[] {
  const capexForCompany = state.capexState.companies.find((c) => c.companyId === companyId);
  if (!capexForCompany) return [];
  return capexForCompany.portfolio.projects.map((p) => ({
    projectId: p.projectId,
    projectType: p.projectType,
    status: p.status,
    approvedBudgetUsd: num(p.approvedBudgetUsd),
    cumulativePaidUsd: num(p.cumulativePaidUsd),
    requiredConstructionQuarters: num(p.requiredConstructionQuarters),
    elapsedConstructionQuartersWithPayment: num(p.elapsedConstructionQuartersWithPayment),
    completedYear: p.completedPeriod ? toYearQuarter(p.completedPeriod).year : null,
    completedQuarter: p.completedPeriod ? toYearQuarter(p.completedPeriod).quarter : null,
  }));
}

/**
 * 世界（TRUE WORLD と OBSERVABLE）のターン記録。
 * すべて確定済みの marketInput / marketResult / salesRecord から取り出すだけで、
 * 需要・価格の再計算はしない。
 */
export function captureWorldTurn(
  turn: number,
  record: CompanyLabState["history"][number],
  observable: {
    readonly entries: readonly { readonly market: string; readonly observedDemandByProduct: Readonly<Record<Product, number>> }[];
    readonly sourceTurn: number | null;
    readonly lagQuarters: number | null;
    readonly vietnamDomesticPriorPrice: number | null;
  } | null,
  scenarioEvents: readonly { readonly eventId: string; readonly title: string; readonly startTurn: number; readonly durationTurns: number; readonly magnitudeScale: number }[]
): PackWorldTurn {
  const marketProducts = record.salesRecord.allocations.map((a) => ({
    market: a.market,
    product: a.product,
    trueDemandTons: tons(a.targetDemand),
    priceUsdPerKg: num(unwrapUnit(a.basePrice as never)),
    contractedTons: a.companies.reduce((s, c) => s + (tons(c.allocatedQuantity) ?? 0), 0),
    externalOptionTons: tons(a.externalOptionQuantity),
  }));

  const domestic = record.marketResult.vietnamDomestic;
  const countries = Object.keys(record.marketInput.countries).map((country) => {
    const supply = record.marketInput.countries[country as keyof typeof record.marketInput.countries];
    const price = record.marketResult.hosoPrices[country as keyof typeof record.marketResult.hosoPrices];
    return {
      country,
      productionTons: tons(supply?.production),
      exportableSupplyTons: tons(price?.exportableSupply),
      allocatedDemandTons: tons(price?.allocatedDemand),
      utilizationRatio: num(price?.utilizationRatio),
      hosoFobPriceUsdPerKg: num(unwrapUnit(price?.price as never)),
      aquacultureCostIndex: num(supply?.aquacultureCostIndex),
      qualityScore: num(unwrapUnit(supply?.qualityScore as never)),
      reliabilityScore: num(unwrapUnit(supply?.reliabilityScore as never)),
    };
  });

  const observableMarketProducts = (observable?.entries ?? []).flatMap((entry) =>
    PRODUCTS.map((product) => ({
      market: entry.market as PackWorldTurn["standardAiObservable"]["marketProducts"][number]["market"],
      product,
      observableDemandTons: num(entry.observedDemandByProduct[product]),
      sourceTurn: observable?.sourceTurn ?? null,
    }))
  );

  return {
    turn,
    year: toYearQuarter(record.period).year,
    quarter: toYearQuarter(record.period).quarter,
    trueWorld: {
      marketProducts,
      vietnamDomesticRawMaterial: {
        priceUsdPerKg: num(unwrapUnit(domestic?.price as never)),
        supplyTons: tons(domestic?.supply),
        effectiveDemandTons: tons(domestic?.effectiveDemand),
        transactedTons: tons(domestic?.transactedVolume),
        buyingCeilingUsdPerKg: num(unwrapUnit(domestic?.buyingCeiling as never)),
        farmerReservationPriceUsdPerKg: num(unwrapUnit(domestic?.farmerReservationPrice as never)),
      },
      producerCountries: countries,
    },
    standardAiObservable: {
      marketProducts: observableMarketProducts,
      observationLagQuarters: observable?.lagQuarters ?? null,
      vietnamDomesticPriorPriceUsdPerKg: observable?.vietnamDomesticPriorPrice ?? null,
    },
    scenarioEvents,
  };
}

/** そのターンに有効だったシナリオイベント（記録から取り出すだけ）。 */
export function captureScenarioEvents(
  state: CompanyLabState,
  turn: number
): readonly { readonly eventId: string; readonly title: string; readonly startTurn: number; readonly durationTurns: number; readonly magnitudeScale: number }[] {
  return state.scenarioState.resolvedEvents
    .filter((e) => turn >= e.resolvedStartTurn && turn < e.resolvedStartTurn + e.resolvedDurationTurns)
    .map((e) => ({
      eventId: e.source.eventId,
      title: e.source.eventType,
      startTurn: e.resolvedStartTurn,
      durationTurns: e.resolvedDurationTurns,
      magnitudeScale: e.resolvedMagnitudeScale,
    }));
}
