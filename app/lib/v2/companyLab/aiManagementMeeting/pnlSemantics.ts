// ShrimpX V2 — AI Management Meeting: P&L / Cash Flow / Balance Sheet Semantics（AMM-M2.3）
//
// 【背景・root cause】Test26 BAL Turn2で、CFOが「売上債権の現金回収の遅れが営業利益の
// 赤字要因」と説明した（会計上明確な誤り。売掛金の回収タイミングはBalance Sheet/Cash
// Flowの事象であり、発生主義のOperating Profitには直接関係しない）。プレイヤーが
// 3回訂正してようやくP&Lの話へ修正されたが、その後も「現金支出が売上を上回った」という
// cash用語のままP&Lを説明していた。
//
// 【根本原因】CFO向けbriefingがP&L・Cash Flow・Balance Sheetを区別せず、
// receivablesUsd（BS残高）とnetRevenueUsd（P&L）だけを渡していたため、Claudeが
// 3表を混同する余地があった。
//
// 【会計監査結果（変更しない。既存の値をそのまま転記するだけ）】
// app/lib/v2/finance/types.ts の ProfitAndLossStatement・BalanceSheet・
// CashFlowStatement・CostOfSalesBreakdown を監査した結果、実装指示§4-§6が要求する
// 全フィールドは既にengineが計算済みであり、新しい会計計算を一切増設する必要が
// ないことを確認した（finance/quarterClose.tsのfinance計算式自体は一切変更しない）。

import { CashFlowStatement, BalanceSheet, ProfitAndLossStatement } from "../../finance/types";

/** 実装指示§4のP&L packet。ProfitAndLossStatement.costOfSalesの内訳をトップレベルへ展開するだけ（新しい計算はしない）。 */
export interface PnlPacket {
  readonly periodLabel: string;
  readonly grossRevenue: number;
  readonly qualitySalesDeduction: number;
  readonly netRevenue: number;
  readonly rawMaterialCost: number;
  readonly processingCost: number;
  readonly laborCost: number;
  readonly factoryFixedCost: number;
  readonly reworkCost: number;
  readonly discardLoss: number;
  readonly unabsorbedFixedManufacturingCost: number;
  readonly idleLaborCost: number;
  readonly capexMaintenanceCost: number;
  readonly totalCostOfSales: number;
  readonly grossProfit: number;
  readonly sellingGeneralAdmin: number;
  readonly operatingProfit: number;
  readonly interestExpense: number;
  readonly profitBeforeTax: number;
  readonly incomeTax: number;
  readonly netIncome: number;
}

/** 実装指示§5のCash Flow packet。CashFlowStatement.operatingDirectの内訳をトップレベルへ展開するだけ。 */
export interface CashFlowPacket {
  readonly periodLabel: string;
  readonly receiptsFromCustomers: number;
  readonly paymentsForRawMaterials: number;
  readonly paymentsForManufacturing: number;
  readonly paymentsForSellingGeneralAdmin: number;
  readonly interestPaid: number;
  readonly incomeTaxPaid: number;
  readonly operatingCashFlow: number;
  readonly investingCashFlow: number;
  readonly financingCashFlow: number;
  readonly netCashChange: number;
  readonly openingCash: number;
  readonly closingCash: number;
}

/** 実装指示§6のBalance Sheet packet。既存BalanceSheetのうち残高項目のみを渡す（totalDebtのみshortTerm+longTermの単純合算として派生）。 */
export interface BalanceSheetPacket {
  readonly periodLabel: string;
  readonly cash: number;
  readonly accountsReceivable: number;
  readonly rawMaterialInventory: number;
  readonly finishedGoodsInventory: number;
  readonly accountsPayable: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly totalDebt: number;
  readonly totalEquity: number;
}

export interface FinancialStatementsPacket {
  readonly pnl: PnlPacket;
  readonly cashFlow: CashFlowPacket;
  readonly balanceSheet: BalanceSheetPacket;
}

/** 実装指示§9のP&L variance（当期 - 前期の単純な差分。新しい会計解釈はしない）。 */
export interface PnlVariance {
  readonly currentPeriodLabel: string;
  readonly priorPeriodLabel: string;
  readonly revenueDelta: number;
  readonly qualityDeductionDelta: number;
  readonly rawMaterialCostDelta: number;
  readonly processingCostDelta: number;
  readonly laborCostDelta: number;
  readonly factoryFixedCostDelta: number;
  readonly reworkCostDelta: number;
  readonly discardLossDelta: number;
  readonly idleLaborCostDelta: number;
  readonly sgaDelta: number;
  readonly operatingProfitDelta: number;
}

/** 実装指示§12のprice/volume facts（既存のfulfilledQuantity・netRevenueの単純な除算のみ。新しいPVM分解エンジンは作らない）。 */
export interface VolumePriceFacts {
  readonly currentPeriodLabel: string;
  readonly priorPeriodLabel: string;
  readonly currentVolumeTons: number;
  readonly priorVolumeTons: number;
  readonly volumeDeltaTons: number;
  /** netRevenue / fulfilledQuantity（USD/トン）。既存の2値の単純な除算であり、新しい価格観測ではない。fulfilledQuantityが0の場合はnull。 */
  readonly currentAverageRealizedPriceUsdPerTon: number | null;
  readonly priorAverageRealizedPriceUsdPerTon: number | null;
}

export function buildPnlPacket(pnl: ProfitAndLossStatement, periodLabel: string): PnlPacket {
  const c = pnl.costOfSales;
  return {
    periodLabel,
    grossRevenue: pnl.grossRevenue as unknown as number,
    qualitySalesDeduction: pnl.qualitySalesDeduction as unknown as number,
    netRevenue: pnl.netRevenue as unknown as number,
    rawMaterialCost: c.rawMaterialCost as unknown as number,
    processingCost: c.processingCost as unknown as number,
    laborCost: c.laborCost as unknown as number,
    factoryFixedCost: c.factoryFixedCost as unknown as number,
    reworkCost: c.reworkCost as unknown as number,
    discardLoss: c.discardLoss as unknown as number,
    unabsorbedFixedManufacturingCost: c.unabsorbedFixedManufacturingCost as unknown as number,
    idleLaborCost: c.idleLaborCost as unknown as number,
    capexMaintenanceCost: c.capexMaintenanceCost as unknown as number,
    totalCostOfSales: pnl.totalCostOfSales as unknown as number,
    grossProfit: pnl.grossProfit as unknown as number,
    sellingGeneralAdmin: pnl.sellingGeneralAdmin as unknown as number,
    operatingProfit: pnl.operatingProfit as unknown as number,
    interestExpense: pnl.interestExpense as unknown as number,
    profitBeforeTax: pnl.profitBeforeTax as unknown as number,
    incomeTax: pnl.incomeTax as unknown as number,
    netIncome: pnl.netIncome as unknown as number,
  };
}

export function buildCashFlowPacket(cf: CashFlowStatement, periodLabel: string): CashFlowPacket {
  const d = cf.operatingDirect;
  return {
    periodLabel,
    receiptsFromCustomers: d.receiptsFromCustomers as unknown as number,
    paymentsForRawMaterials: d.paymentsForRawMaterials as unknown as number,
    paymentsForManufacturing: d.paymentsForManufacturing as unknown as number,
    paymentsForSellingGeneralAdmin: d.paymentsForSellingGeneralAdmin as unknown as number,
    interestPaid: d.interestPaid as unknown as number,
    incomeTaxPaid: d.incomeTaxPaid as unknown as number,
    operatingCashFlow: cf.operatingCashFlow as unknown as number,
    investingCashFlow: cf.investingCashFlow as unknown as number,
    financingCashFlow: cf.financingCashFlow as unknown as number,
    netCashChange: cf.netCashChange as unknown as number,
    openingCash: cf.openingCash as unknown as number,
    closingCash: cf.closingCash as unknown as number,
  };
}

export function buildBalanceSheetPacket(bs: BalanceSheet, periodLabel: string): BalanceSheetPacket {
  const shortTermLoans = bs.shortTermLoans as unknown as number;
  const longTermLoans = bs.longTermLoans as unknown as number;
  return {
    periodLabel,
    cash: bs.cash as unknown as number,
    accountsReceivable: bs.accountsReceivable as unknown as number,
    rawMaterialInventory: bs.rawMaterialInventory as unknown as number,
    finishedGoodsInventory: bs.finishedGoodsInventory as unknown as number,
    accountsPayable: bs.accountsPayable as unknown as number,
    shortTermLoans,
    longTermLoans,
    totalDebt: shortTermLoans + longTermLoans,
    totalEquity: bs.totalEquity as unknown as number,
  };
}

export function computePnlVariance(current: ProfitAndLossStatement, prior: ProfitAndLossStatement, currentPeriodLabel: string, priorPeriodLabel: string): PnlVariance {
  const c = current.costOfSales;
  const p = prior.costOfSales;
  const num = (v: unknown): number => v as unknown as number;
  return {
    currentPeriodLabel,
    priorPeriodLabel,
    revenueDelta: num(current.netRevenue) - num(prior.netRevenue),
    qualityDeductionDelta: num(current.qualitySalesDeduction) - num(prior.qualitySalesDeduction),
    rawMaterialCostDelta: num(c.rawMaterialCost) - num(p.rawMaterialCost),
    processingCostDelta: num(c.processingCost) - num(p.processingCost),
    laborCostDelta: num(c.laborCost) - num(p.laborCost),
    factoryFixedCostDelta: num(c.factoryFixedCost) - num(p.factoryFixedCost),
    reworkCostDelta: num(c.reworkCost) - num(p.reworkCost),
    discardLossDelta: num(c.discardLoss) - num(p.discardLoss),
    idleLaborCostDelta: num(c.idleLaborCost) - num(p.idleLaborCost),
    sgaDelta: num(current.sellingGeneralAdmin) - num(prior.sellingGeneralAdmin),
    operatingProfitDelta: num(current.operatingProfit) - num(prior.operatingProfit),
  };
}

export function computeVolumePriceFacts(
  currentVolumeTons: number,
  currentNetRevenueUsd: number,
  priorVolumeTons: number,
  priorNetRevenueUsd: number,
  currentPeriodLabel: string,
  priorPeriodLabel: string
): VolumePriceFacts {
  return {
    currentPeriodLabel,
    priorPeriodLabel,
    currentVolumeTons,
    priorVolumeTons,
    volumeDeltaTons: currentVolumeTons - priorVolumeTons,
    currentAverageRealizedPriceUsdPerTon: currentVolumeTons > 1e-9 ? currentNetRevenueUsd / currentVolumeTons : null,
    priorAverageRealizedPriceUsdPerTon: priorVolumeTons > 1e-9 ? priorNetRevenueUsd / priorVolumeTons : null,
  };
}
