// ShrimpX V2 — Phase SAI-1.5: レポート用データ収集（会社ラボ本体を1回実行し、
// 診断情報・実行結果を「希望値 vs 実行値」を含む1枚のフラット行へ整形するだけ。
// ゲームバランス・AIロジックには一切手を加えない読み取り専用モジュール。

import { CompanyLabConfig, CompanyLabResult, CompanyQuarterRecord } from "../../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { createStandardAiProvider, StandardAiQuarterDiagnostics } from "../policy";
import { CompanyId } from "../../../sales/types";
import { DemandMarketId, Product } from "../../../market/types";
import { unwrapUnit } from "../../../core/units";
import { unwrapUsd } from "../../../finance/types";
import { CompanyQuarterReportRow, NOT_AVAILABLE } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export type AiKind = "standardAi" | "autoPolicy";

export interface CollectedRun {
  readonly runLabel: string;
  readonly aiKind: AiKind;
  readonly config: CompanyLabConfig;
  readonly result: CompanyLabResult;
  /** standardAi実行のみ。autoPolicy実行では空配列。 */
  readonly diagnostics: readonly StandardAiQuarterDiagnostics[];
  readonly rows: readonly CompanyQuarterReportRow[];
}

/** 会社ラボを1回実行し（standardAiまたはautoPolicy）、フラットなレポート行へ整形する。 */
export function collectRun(runLabel: string, config: CompanyLabConfig, aiKind: AiKind): CollectedRun {
  let diagnostics: readonly StandardAiQuarterDiagnostics[] = [];
  let result: CompanyLabResult;
  if (aiKind === "standardAi") {
    const { provider, diagnostics: d } = createStandardAiProvider();
    result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
    diagnostics = d;
  } else {
    result = runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
  }
  const diagByCompanyTurn = new Map<string, StandardAiQuarterDiagnostics>();
  for (const d of diagnostics) diagByCompanyTurn.set(`${d.companyId}::${d.turn}`, d);

  const rows: CompanyQuarterReportRow[] = [];
  for (const record of result.history) {
    for (const companyId of result.companies.map((f) => f.companyId)) {
      rows.push(buildRow(runLabel, companyId, record, diagByCompanyTurn.get(`${companyId}::${record.turn}`)));
    }
  }
  return { runLabel, aiKind, config, result, diagnostics, rows };
}

function averageNewContractPriceByProduct(record: CompanyQuarterRecord, companyId: CompanyId): Record<Product, number | typeof NOT_AVAILABLE> {
  const out = {} as Record<Product, number | typeof NOT_AVAILABLE>;
  for (const product of PRODUCTS) {
    const matching = record.salesRecord.newContracts.filter((c) => c.companyId === companyId && c.product === product);
    const totalQty = matching.reduce((s, c) => s + unwrapUnit(c.originalQuantity), 0);
    out[product] = totalQty > 0 ? matching.reduce((s, c) => s + unwrapUnit(c.originalQuantity) * unwrapUnit(c.unitPrice), 0) / totalQty : NOT_AVAILABLE;
  }
  return out;
}

function salesQuantityByMarketAndProduct(
  record: CompanyQuarterRecord,
  companyId: CompanyId
): { byMarket: Partial<Record<DemandMarketId, number>>; byProduct: Record<Product, number>; marketShare: Partial<Record<DemandMarketId, number>> } {
  const byMarket: Partial<Record<DemandMarketId, number>> = {};
  const byProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  const shareNumerator: Partial<Record<DemandMarketId, number>> = {};
  const shareDenominator: Partial<Record<DemandMarketId, number>> = {};
  for (const alloc of record.salesRecord.allocations) {
    const totalAllocated = alloc.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(alloc.externalOptionQuantity);
    shareDenominator[alloc.market] = (shareDenominator[alloc.market] ?? 0) + totalAllocated;
    const mine = alloc.companies.find((c) => c.companyId === companyId);
    if (!mine) continue;
    const qty = unwrapUnit(mine.allocatedQuantity);
    byMarket[alloc.market] = (byMarket[alloc.market] ?? 0) + qty;
    byProduct[alloc.product] += qty;
    shareNumerator[alloc.market] = (shareNumerator[alloc.market] ?? 0) + qty;
  }
  const marketShare: Partial<Record<DemandMarketId, number>> = {};
  for (const market of Object.keys(shareDenominator) as DemandMarketId[]) {
    const denom = shareDenominator[market] ?? 0;
    marketShare[market] = denom > 0 ? (shareNumerator[market] ?? 0) / denom : 0;
  }
  return { byMarket, byProduct, marketShare };
}

function buildRow(
  runLabel: string,
  companyId: CompanyId,
  record: CompanyQuarterRecord,
  diag: StandardAiQuarterDiagnostics | undefined
): CompanyQuarterReportRow {
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  const financial = record.financialResults.find((f) => f.companyId === companyId);
  const financing = record.financingResults.find((f) => f.companyId === companyId);
  const decision = record.decisions.find((d) => d.companyId === companyId);
  if (!summary || !financial || !financing) {
    throw new Error(`会社 "${companyId}" のturn ${record.turn} 結果が見つかりません（companySummaries/financialResults/financingResultsの不整合）。`);
  }

  const productionDesired: Record<Product, number | undefined> = { hoso: undefined, pd: undefined, vap: undefined };
  for (const p of decision?.productionPlans ?? []) {
    productionDesired[p.product] = (productionDesired[p.product] ?? 0) + unwrapUnit(p.desiredQuantity);
  }
  const productionActual: Record<Product, number> = {
    hoso: unwrapUnit(summary.hosoProduced),
    pd: unwrapUnit(summary.pdProduced),
    vap: unwrapUnit(summary.vapProduced),
  };

  // 完成品在庫は会社合計のみ CompanyQuarterSummary.finishedGoodsInventory に持つ（商品別内訳は
  // productionAllocation側にしかないため、商品別在庫月数は「当期生産量に対する概算」に留める。
  const fgTotal = unwrapUnit(summary.finishedGoodsInventory);
  const totalActualProd = productionActual.hoso + productionActual.pd + productionActual.vap;
  const fgByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  if (totalActualProd > 0) {
    for (const p of PRODUCTS) fgByProduct[p] = fgTotal * (productionActual[p] / totalActualProd);
  } else {
    fgByProduct.hoso = fgTotal;
  }
  const fgMonths: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const p of PRODUCTS) fgMonths[p] = productionActual[p] > 0 ? (fgByProduct[p] / productionActual[p]) * 3 : 0;

  const rawMaterialTons = unwrapUnit(summary.rawMaterialInventory);
  const totalDomesticImportAqua =
    unwrapUnit(summary.domesticPurchaseQuantity) + unwrapUnit(summary.importArrivedQuantity) + unwrapUnit(summary.aquacultureHarvestedQuantity);
  const rawMaterialMonths = totalDomesticImportAqua > 0 ? (rawMaterialTons / totalDomesticImportAqua) * 3 : NOT_AVAILABLE;

  const { byMarket: salesByMarket, byProduct: salesByProduct, marketShare } = salesQuantityByMarketAndProduct(record, companyId);

  const pl = financial.profitAndLoss;
  const bs = financial.balanceSheet;
  const cf = financial.cashFlow;
  const mc = financial.manufacturingCost;
  const cm = financial.contributionMargin;
  const cmByProduct: Record<Product, number | typeof NOT_AVAILABLE> = { hoso: NOT_AVAILABLE, pd: NOT_AVAILABLE, vap: NOT_AVAILABLE };
  for (const entry of cm.byProduct) {
    if (entry.key === "hoso" || entry.key === "pd" || entry.key === "vap") cmByProduct[entry.key] = unwrapUsd(entry.contributionMargin);
  }

  return {
    runLabel,
    companyId,
    turn: record.turn,
    period: record.period,

    domesticPurchaseDesiredTons: decision ? unwrapUnit(decision.domesticPurchasePlan.desiredQuantity) : undefined,
    domesticPurchaseActualTons: unwrapUnit(summary.domesticPurchaseQuantity),
    domesticPurchasePriceUsdPerKg: summary.domesticPurchasePrice,
    importOrderDesiredTons: decision ? decision.importOrders.reduce((s, o) => s + unwrapUnit(o.orderedQuantity), 0) : undefined,
    importArrivedTons: unwrapUnit(summary.importArrivedQuantity),
    aquacultureHarvestedTons: unwrapUnit(summary.aquacultureHarvestedQuantity),
    rawMaterialInventoryTons: rawMaterialTons,
    rawMaterialInventoryMonths: rawMaterialMonths,

    productionDesiredTonsByProduct: productionDesired,
    productionActualTonsByProduct: productionActual,
    finishedGoodsInventoryTonsByProduct: fgByProduct,
    finishedGoodsInventoryMonthsByProduct: fgMonths,

    regularHeadcount: decision ? decision.workerAssignments.reduce((s, w) => s + w.regularHeadcount, 0) : 0,
    temporaryHeadcountShareActual: unwrapUnit(summary.temporaryWorkerShare),
    overtimeRateActual: unwrapUnit(summary.overtimeRate),
    laborUtilizationRateActual: unwrapUnit(summary.laborUtilizationRate),
    equipmentUtilizationRateActual: unwrapUnit(summary.equipmentUtilizationRate),

    grossRevenueUsd: unwrapUsd(pl.grossRevenue),
    netRevenueUsd: unwrapUsd(pl.netRevenue),
    averageSellingPriceUsdPerKgByProduct: averageNewContractPriceByProduct(record, companyId),
    salesQuantityByMarket: salesByMarket,
    salesQuantityByProduct: salesByProduct,
    outstandingContractTons: unwrapUnit(summary.outstandingQuantity),
    overdueContractTons: unwrapUnit(summary.overdueQuantity),
    contractFulfillmentRate:
      unwrapUnit(summary.fulfilledQuantity) + unwrapUnit(summary.outstandingQuantity) > 0
        ? unwrapUnit(summary.fulfilledQuantity) / (unwrapUnit(summary.fulfilledQuantity) + unwrapUnit(summary.outstandingQuantity))
        : NOT_AVAILABLE,
    marketShareByMarket: marketShare,

    domesticRawMaterialCostUsd: unwrapUsd(mc.domesticRawMaterialCost),
    importedRawMaterialCostUsd: unwrapUsd(mc.importedRawMaterialCost),
    aquacultureRawMaterialCostUsd: unwrapUsd(mc.aquacultureRawMaterialCost),
    grossProfitUsd: unwrapUsd(pl.grossProfit),
    grossProfitMarginRatio: unwrapUsd(pl.netRevenue) !== 0 ? unwrapUsd(pl.grossProfit) / unwrapUsd(pl.netRevenue) : 0,
    operatingProfitUsd: unwrapUsd(pl.operatingProfit),
    operatingProfitMarginRatio: unwrapUsd(pl.netRevenue) !== 0 ? unwrapUsd(pl.operatingProfit) / unwrapUsd(pl.netRevenue) : 0,
    netIncomeUsd: unwrapUsd(pl.netIncome),
    contributionMarginByProduct: cmByProduct,

    cashUsd: unwrapUsd(bs.cash),
    accountsReceivableUsd: unwrapUsd(bs.accountsReceivable),
    accountsPayableUsd: unwrapUsd(bs.accountsPayable),
    shortTermLoansUsd: financing.endingShortTermLoansUsd,
    longTermLoansUsd: financing.endingLongTermLoansUsd,
    emergencyLoanUsd: financing.emergencyLoan ? financing.emergencyLoan.approvedUsd : 0,
    totalEquityUsd: unwrapUsd(bs.totalEquity),
    operatingCashFlowUsd: unwrapUsd(cf.operatingCashFlow),
    financialHealthPrimary: financing.financialHealth.primary,
    paymentDefault: financing.financialHealth.paymentDefault,
    covenantBreach: financing.financialHealth.covenantBreach,
    procurementScaleRatio: financing.procurementConstraint ? financing.procurementConstraint.scaleRatio : NOT_AVAILABLE,

    qualityScoreByProduct: {
      hoso: summary.qualityScoreByProduct.hoso !== undefined ? unwrapUnit(summary.qualityScoreByProduct.hoso) : undefined,
      pd: summary.qualityScoreByProduct.pd !== undefined ? unwrapUnit(summary.qualityScoreByProduct.pd) : undefined,
      vap: summary.qualityScoreByProduct.vap !== undefined ? unwrapUnit(summary.qualityScoreByProduct.vap) : undefined,
    },
    customerTrustByMarket: Object.fromEntries(
      Object.entries(summary.customerTrustByMarket).map(([k, v]) => [k, v !== undefined ? unwrapUnit(v) : undefined])
    ) as Partial<Record<DemandMarketId, number>>,
    deliveryReliabilityByMarket: Object.fromEntries(
      Object.entries(summary.deliveryReliabilityByMarket).map(([k, v]) => [k, v !== undefined ? unwrapUnit(v) : undefined])
    ) as Partial<Record<DemandMarketId, number>>,
    onTimeDeliveryRate: summary.onTimeDeliveryRate,
    downgradeQuantityTons: unwrapUnit(summary.downgradeQuantity),
    reworkQuantityTons: unwrapUnit(summary.reworkQuantity),
    discardQuantityTons: unwrapUnit(summary.discardQuantity),
    majorIncidentCount: summary.majorIncidentCount,

    pressures: diag?.pressures,
    firedReasonCodes: diag?.entries,
    financingDesiredAmountUsd: decision?.financingRequest.desiredAmountUsd,
    financingDesiredPrepaymentUsd: decision?.financingRequest.desiredPrepaymentUsd,
    capexProposalCount: decision?.capexDecision.newProjectProposals.length,
  };
}

export function findFirstDefaultQuarter(rows: readonly CompanyQuarterReportRow[], companyId: CompanyId): number | null {
  const hit = rows.filter((r) => r.companyId === companyId && r.paymentDefault).sort((a, b) => a.turn - b.turn)[0];
  return hit ? hit.turn : null;
}
