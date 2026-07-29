// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — 構造化ログの組み立て
//
// 【方針】ここでは新しい判定・新しい計算を一切行わない。既存の実行結果
// （CompanyQuarterRecord・StandardAiQuarterDiagnostics・QuarterStartCapture・
// FinancingQuarterResult・MarketSalesEffortAdjustment・CompanyQuarterSummary等）
// を「読み取って、schema.tsの構造へ詰め直す」だけの純粋関数群。

import { periodToString } from "../../../core/period";
import { unwrapUnit } from "../../../core/units";
import { unwrapUsd } from "../../../finance/types";
import { CompanyQuarterRecord, CompanyReasonEntry } from "../../types";
import { StandardAiQuarterDiagnostics } from "../policy";
import { QuarterStartCapture } from "./capture";
import { processingCapacity } from "../../../sales/salesForce";
import { salesEffortWeightedQuantity } from "../../../sales/marketEffort";
import { SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { Product } from "../../../market/types";
import { FinancingQuarterResult } from "../../../financing/types";
import { AutoplayCaseResult } from "./runCase";
import { categorizeCompanyReasonCode, categorizeStandardAiReasonCode } from "./reasonTaxonomy";
import {
  AdjustmentTraceEntry,
  AutoplayCaseLog,
  CaseSummaryRow,
  QuarterDecisionLog,
  QuarterResultLog,
  QuarterStartState,
  QuarterStateDelta,
  SaiCompanyId,
  SalesQuantityTraceEntry,
} from "./schema";

const EPSILON = 1e-6;

function availableRawMaterialTons(ownState: QuarterStartCapture["ownState"]): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function finishedGoodsTons(ownState: QuarterStartCapture["ownState"]): number {
  return ownState.finishedGoodsLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function totalFactoryCapacityTons(fixture: QuarterStartCapture["fixture"]): number {
  return fixture.factories.reduce((sum, f) => sum + unwrapUnit(f.commonProcessingCapacity), 0);
}

function regularWorkerCount(ownState: QuarterStartCapture["ownState"]): number {
  return ownState.workforceState.factories.reduce((sum, f) => sum + f.regularHeadcount, 0);
}

/** QuarterStartCapture一覧を companyId::turn でひけるMapへ変換する。 */
export function indexQuarterStartCaptures(captures: readonly QuarterStartCapture[]): Map<string, QuarterStartCapture> {
  const map = new Map<string, QuarterStartCapture>();
  for (const c of captures) map.set(`${c.companyId}::${c.turn}`, c);
  return map;
}

export function indexDiagnostics(diagnostics: readonly StandardAiQuarterDiagnostics[]): Map<string, StandardAiQuarterDiagnostics> {
  const map = new Map<string, StandardAiQuarterDiagnostics>();
  for (const d of diagnostics) map.set(`${d.companyId}::${d.turn}`, d);
  return map;
}

/** セクションA: 四半期開始時の状態を組み立てる。turn=1以外はpreviousの同セクションを
 *  渡すことで、前四半期からの変化（changeFromPreviousQuarter）も一緒に計算する。
 *
 *  信用スコア・借入余力・underwritingFrozen・支払不能状態は、いずれも
 *  「四半期処理の一部として」計算される値であり、四半期開始（意思決定生成）の
 *  時点ではまだ当期分は存在しない。したがってここでは「前四半期末の
 *  FinancingQuarterResult」（=標準AIが実際にこの四半期の意思決定を行った時点で
 *  参照可能だった、直近の確定値）をpreviousFinancingとして受け取り、それを
 *  四半期開始時の状態として転記する。turn=1（前四半期が存在しない run 開始時点）
 *  はまだ一度も信用スコアが計算されていないため、存在しない値を捏造せず
 *  creditTier="unscored" / NaN のままにする。 */
export function buildQuarterStartState(
  companyId: SaiCompanyId,
  capture: QuarterStartCapture,
  diagnostics: StandardAiQuarterDiagnostics | undefined,
  previous: QuarterStartState | undefined,
  previousFinancing: FinancingQuarterResult | undefined
): QuarterStartState {
  const { fixture, ownState } = capture;
  const financingHistory = ownState.financingState.history;
  const arrears = financingHistory.consecutiveArrearsQuarters;
  const lastHealth = financingHistory.lastFinancialHealth ?? "healthy";

  const cashUsd = unwrapUsd(ownState.financeState.cash);
  const shortTermLoansUsd = unwrapUsd(ownState.financeState.shortTermLoans);
  const longTermLoansUsd = unwrapUsd(ownState.financeState.longTermLoans);
  const accountsReceivableUsd = ownState.financeState.receivables.reduce((s, r) => s + unwrapUsd(r.amount), 0);
  const accountsPayableUsd = ownState.financeState.payables.reduce((s, p) => s + unwrapUsd(p.amount), 0);

  const salesEffortCapacityHosoEqTons = unwrapUnit(processingCapacity(fixture.salesForceHeadcountTotal, SALES_PARAMETERS_V1));

  // 前四半期のFinancingQuarterResultが手に入る場合はそれを正とする（正確な値）。
  // turn=1等、まだ存在しない場合のみ、履歴上のlastFinancialHealthから近似する。
  const availableAdditionalCapacityUsd = previousFinancing
    ? previousFinancing.borrowingCapacity.availableAdditionalCapacityUsd
    : NaN;
  const creditTier: string = previousFinancing ? previousFinancing.creditScore.tier : "unscored";
  const creditScore0to100 = previousFinancing ? previousFinancing.creditScore.score0to100 : NaN;
  const underwritingFrozen = previousFinancing
    ? previousFinancing.borrowingCapacity.underwritingFrozen
    : lastHealth === "paymentDefault" || lastHealth === "insolvent";
  const paymentDefault = previousFinancing ? previousFinancing.financialHealth.paymentDefault : lastHealth === "paymentDefault";

  const current: Omit<QuarterStartState, "changeFromPreviousQuarter"> = {
    companyId,
    turn: capture.turn,
    period: periodToString(capture.period),
    cashUsd,
    accountsReceivableUsd,
    accountsPayableUsd,
    shortTermLoansUsd,
    longTermLoansUsd,
    availableAdditionalCapacityUsd,
    creditTier,
    creditScore0to100,
    financialHealthTier: lastHealth,
    paymentDefault,
    underwritingFrozen,
    consecutiveArrearsQuarters: arrears,
    rawMaterialInventoryHosoEqTons: availableRawMaterialTons(ownState),
    finishedGoodsInventoryHosoEqTons: finishedGoodsTons(ownState),
    totalFactoryCapacityHosoEqTons: totalFactoryCapacityTons(fixture),
    regularWorkerCount: regularWorkerCount(ownState),
    salesForceHeadcountTotal: fixture.salesForceHeadcountTotal,
    salesEffortCapacityHosoEqTons,
    qualityScoreByProduct: { ...ownState.qualityScoreByProduct },
    customerTrustByMarket: { ...ownState.customerTrustByMarket },
    deliveryReliabilityByMarket: { ...ownState.deliveryReliabilityByMarket },
    pressures: diagnostics ? { ...diagnostics.pressures } : {},
  };

  const changeFromPreviousQuarter: QuarterStateDelta | null = previous
    ? {
        cashUsdDelta: current.cashUsd - previous.cashUsd,
        creditTierChanged: current.creditTier !== previous.creditTier,
        underwritingFrozenChanged: current.underwritingFrozen !== previous.underwritingFrozen,
        financialHealthTierChanged: current.financialHealthTier !== previous.financialHealthTier,
      }
    : null;

  return { ...current, changeFromPreviousQuarter };
}

/** セクションB/D: 標準AIの事前希望案・最終意思決定を組み立てる。 */
export function buildQuarterDecisionLog(
  companyId: SaiCompanyId,
  diagnostics: StandardAiQuarterDiagnostics,
  record: CompanyQuarterRecord
): QuarterDecisionLog {
  const decision = diagnostics.decision;
  const financing = record.financingResults.find((f) => f.companyId === companyId);
  const procurementConstraint = financing?.procurementConstraint;

  const productionDesiredQuantityByProduct: Record<string, number> = {};
  for (const p of decision.productionPlans) {
    productionDesiredQuantityByProduct[p.product] = (productionDesiredQuantityByProduct[p.product] ?? 0) + unwrapUnit(p.desiredQuantity);
  }

  const workerRegularHeadcountTotal = decision.workerAssignments.reduce((s, w) => s + w.regularHeadcount, 0);
  const workerTemporaryHeadcountTotal = decision.workerAssignments.reduce((s, w) => s + w.temporaryHeadcount, 0);
  const overtimeRates = decision.workerAssignments.map((w) => unwrapUnit(w.overtimeRate));
  const workerOvertimeRateAvg = overtimeRates.length > 0 ? overtimeRates.reduce((s, r) => s + r, 0) / overtimeRates.length : 0;

  const domesticPurchaseDesiredQuantity = unwrapUnit(decision.domesticPurchasePlan.desiredQuantity);
  const importOrdersDesiredQuantity = decision.importOrders.reduce((s, o) => s + unwrapUnit(o.orderedQuantity), 0);
  const aquacultureStockingDesiredQuantity = decision.aquacultureStockingPlans.reduce((s, p) => s + unwrapUnit(p.plannedStockingQuantity), 0);

  const domesticPurchaseFinalQuantity = procurementConstraint
    ? procurementConstraint.constrainedDomesticPurchaseQuantityTons
    : domesticPurchaseDesiredQuantity;
  const importOrdersBlocked = procurementConstraint?.importOrdersBlocked ?? false;
  const importOrdersFinalQuantity = importOrdersBlocked ? 0 : importOrdersDesiredQuantity;
  const scaleRatio = procurementConstraint?.scaleRatio ?? 1;
  const aquacultureStockingFinalQuantity = aquacultureStockingDesiredQuantity * scaleRatio;

  return {
    companyId,
    turn: diagnostics.turn,
    period: periodToString(diagnostics.period),
    wish: {
      domesticPurchaseDesiredQuantity,
      importOrdersDesiredQuantity,
      aquacultureStockingDesiredQuantity,
      productionDesiredQuantityByProduct,
      workerRegularHeadcountTotal,
      workerTemporaryHeadcountTotal,
      workerOvertimeRateAvg,
      financingRequestDesiredAmountUsd: decision.financingRequest.desiredAmountUsd,
      financingRequestDesiredPrepaymentUsd: decision.financingRequest.desiredPrepaymentUsd,
      capexNewProposalCount: decision.capexDecision.newProjectProposals.length,
      capexCancelCount: decision.capexDecision.cancelRequests.length,
      capexResumeCount: decision.capexDecision.resumeRequests.length,
    },
    final: {
      domesticPurchaseFinalQuantity,
      importOrdersBlocked,
      importOrdersFinalQuantity,
      aquacultureStockingFinalQuantity,
    },
  };
}

/** セクションC: 希望→最終決定までの調整過程（before/after/delta/reason code）。 */
export function buildAdjustmentTrace(
  companyId: SaiCompanyId,
  diagnostics: StandardAiQuarterDiagnostics,
  record: CompanyQuarterRecord
): readonly AdjustmentTraceEntry[] {
  const turn = diagnostics.turn;
  const period = periodToString(diagnostics.period);
  const entries: AdjustmentTraceEntry[] = [];

  // --- 標準AI側の診断エントリ（決定論的なStandardAiDiagnosticEntry） ---
  for (const d of diagnostics.entries) {
    entries.push({
      companyId,
      turn,
      period,
      category: categorizeStandardAiReasonCode(d.code),
      source: "standardAi",
      code: d.code,
      severity: d.severity,
      affectedDecision: d.domain,
      before: undefined,
      after: undefined,
      delta: undefined,
      message: d.message,
      threshold: d.threshold,
      relevantMetric: d.keyValues ? Object.keys(d.keyValues)[0] : undefined,
    });
  }

  // --- 営業工数制約（エンジン側の実測値。市場ごとのbefore/after/scaleFactor）。
  //     市場×商品ぶんの希望→最終数量そのものはbuildSalesQuantityTraceが全市場分
  //     （制約の有無に関わらず）保持するため、ここでは重複させず「実際に
  //     scaleFactor<1で縮小が発生した市場」のみをC節の調整エントリとして記録する。 ---
  for (const adj of record.salesRecord.salesEffortAdjustments) {
    if (adj.companyId !== companyId) continue;
    entries.push({
      companyId,
      turn,
      period,
      category: "sales_effort_capacity",
      source: "companyLab",
      code: "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY",
      severity: "warning",
      affectedDecision: "sales",
      affectedMarketOrProduct: adj.market,
      before: adj.desiredEffortWeightedQuantity,
      after: adj.desiredEffortWeightedQuantity * adj.scaleFactor,
      delta: adj.desiredEffortWeightedQuantity * (adj.scaleFactor - 1),
      message: `市場 "${adj.market}": 営業人員${adj.headcount}人の処理能力(${adj.capacityHosoEqTons.toFixed(1)}トン)により、営業工数換算数量を${(adj.scaleFactor * 100).toFixed(1)}%へ縮小。`,
      threshold: adj.capacityHosoEqTons,
      relevantMetric: "salesEffortScaleFactor",
    });
  }

  // --- 資金制約（procurementConstraint。国内買付・輸入・養殖の縮小） ---
  const financing = record.financingResults.find((f) => f.companyId === companyId);
  const constraint = financing?.procurementConstraint;
  if (constraint && constraint.scaleRatio < 1 - EPSILON) {
    entries.push({
      companyId,
      turn,
      period,
      category: "cash_constraint",
      source: "companyLab",
      code: "PROCUREMENT_CASH_CONSTRAINED",
      severity: constraint.scaleRatio <= EPSILON ? "critical" : "warning",
      affectedDecision: "procurement",
      before: constraint.originalDomesticPurchaseQuantityTons,
      after: constraint.constrainedDomesticPurchaseQuantityTons,
      delta: constraint.constrainedDomesticPurchaseQuantityTons - constraint.originalDomesticPurchaseQuantityTons,
      message: constraint.reason,
      relevantMetric: "scaleRatio",
      threshold: constraint.scaleRatio,
    });
  }
  if (constraint?.importOrdersBlocked) {
    entries.push({
      companyId,
      turn,
      period,
      category: "underwriting",
      source: "companyLab",
      code: "PROCUREMENT_CASH_CONSTRAINED",
      severity: "critical",
      affectedDecision: "procurement",
      message: "重大延滞・支払不能により輸入発注を停止した。",
    });
  }

  // --- 借入余力・underwriting（結果側のfinancingResultsから、期首との差分は
  //     buildQuarterResultLogのnewlyTriggeredフラグで別途表現する。ここでは
  //     underwritingFrozenが実際に発火した四半期のみ1件記録する）。 ---
  if (financing?.borrowingCapacity.underwritingFrozen) {
    entries.push({
      companyId,
      turn,
      period,
      category: "borrowing_capacity",
      source: "companyLab",
      code: "UNDERWRITING_FROZEN",
      severity: "critical",
      affectedDecision: "financing",
      after: financing.borrowingCapacity.availableAdditionalCapacityUsd,
      message: "信用悪化により融資余力がゼロとなり、通常融資が停止している（underwritingFrozen）。",
      relevantMetric: "availableAdditionalCapacityUsd",
    });
  }

  // --- 会社ラボ側の理由コード（生産・在庫・品質等。既存companySummaries.reasonCodesを再利用） ---
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (summary) {
    for (const r of summary.reasonCodes) {
      entries.push({
        companyId,
        turn,
        period,
        category: categorizeCompanyReasonCode(r.code),
        source: "companyLab",
        code: r.code,
        severity: "info",
        affectedDecision: "production_or_sales",
        message: r.message,
      });
    }
  }

  return entries;
}

/** セクションD向け: 市場×商品ぶんの販売数量トレース（希望→営業工数調整後→エンジン実測）。 */
export function buildSalesQuantityTrace(
  companyId: SaiCompanyId,
  diagnostics: StandardAiQuarterDiagnostics,
  record: CompanyQuarterRecord
): readonly SalesQuantityTraceEntry[] {
  const turn = diagnostics.turn;
  const scaleFactorByMarket = new Map<string, number>();
  for (const adj of record.salesRecord.salesEffortAdjustments) {
    if (adj.companyId === companyId) scaleFactorByMarket.set(adj.market, adj.scaleFactor);
  }
  const finalByMarketProduct = new Map<string, { quantity: number; headcount: number }>();
  for (const plan of diagnostics.decision.salesPlans) {
    finalByMarketProduct.set(`${plan.market}::${plan.product}`, {
      quantity: unwrapUnit(plan.desiredQuantity),
      headcount: plan.salesForceHeadcount,
    });
  }

  return diagnostics.salesWishByMarketProduct.map((w) => {
    const key = `${w.market}::${w.product}`;
    const final = finalByMarketProduct.get(key);
    return {
      companyId,
      turn,
      market: w.market,
      product: w.product,
      desiredQuantityBeforeEffortConstraint: w.desiredQuantityBeforeEffortConstraint,
      salesForceHeadcount: final?.headcount ?? 0,
      finalPlannedQuantity: final?.quantity ?? 0,
      engineEffortScaleFactor: scaleFactorByMarket.get(w.market) ?? 1,
    };
  });
}

/**
 * 会社単位の営業工数換算能力・使用量を、「実際にその四半期に使われた
 * 会社×市場ごとの営業人員配分」から求める（sales/marketEffort.tsの
 * computeMarketSalesEffort・salesEffortWeightedQuantityと完全に同じ計算式を
 * 再利用するだけで、新しい判定・新しい係数は一切導入しない）。
 *
 * 【注記・既知の設計上の制約】company全体のsalesForceHeadcountTotalに対して
 * 一度だけprocessingCapacity()を呼ぶ方式（旧実装）は、市場ごとに200トンの
 * 基礎能力フロアが独立して積み上がる仕様（processingCapacity(0)=200t）を
 * 考慮できず、実際の市場別配分から求めた能力合計と一致しない
 * （例: 80人を5市場へ配分した場合、5市場分の基礎フロアが積み上がるため、
 * 単純に1回だけ計算した能力より実際の合計能力は大きくなりうる）。本関数は
 * 実際にAIが提出した市場別配分（decision.salesPlansのsalesForceHeadcount）を
 * 使って市場ごとに正しく計算し直すことで、この不整合を避ける。
 */
function computeCompanyLevelSalesEffort(salesPlans: readonly CompanySalesPlanEntry[]): { capacity: number; used: number } {
  const byMarket = new Map<string, { headcount: number; byProduct: Record<Product, number> }>();
  for (const p of salesPlans) {
    const entry = byMarket.get(p.market) ?? { headcount: p.salesForceHeadcount, byProduct: { hoso: 0, pd: 0, vap: 0 } };
    entry.byProduct[p.product] = unwrapUnit(p.desiredQuantity);
    byMarket.set(p.market, entry);
  }
  let capacity = 0;
  let used = 0;
  for (const { headcount, byProduct } of byMarket.values()) {
    capacity += unwrapUnit(processingCapacity(headcount, SALES_PARAMETERS_V1));
    used += salesEffortWeightedQuantity(byProduct, SALES_PARAMETERS_V1);
  }
  return { capacity, used };
}

/** セクションE: 四半期結果。 */
export function buildQuarterResultLog(
  companyId: SaiCompanyId,
  turn: number,
  record: CompanyQuarterRecord,
  previousUnderwritingFrozen: boolean,
  previousPaymentDefault: boolean,
  salesQuantityTrace: readonly SalesQuantityTraceEntry[],
  salesPlans: readonly CompanySalesPlanEntry[]
): QuarterResultLog {
  const fin = record.financialResults.find((f) => f.companyId === companyId);
  const financing = record.financingResults.find((f) => f.companyId === companyId);
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (!fin || !financing || !summary) {
    throw new Error(`会社 "${companyId}" のturn ${turn} の結果が見つかりません（financialResults/financingResults/companySummariesのいずれかが欠落）。`);
  }

  // 会社単位の営業工数換算能力・使用量（市場別配分から正しく積み上げた値。
  // 単位は「営業工数換算トン」であり、salesQuantityTraceのfinalPlannedQuantity
  // （複数市場の物理数量の単純合計）とは単位が異なる点に注意）。
  const { capacity: salesEffortCapacityHosoEqTons, used: salesEffortUsedHosoEqTons } = computeCompanyLevelSalesEffort(salesPlans);
  const salesReductionFromEffortConstraintHosoEqTons = salesQuantityTrace.reduce(
    (s, t) => s + Math.max(0, t.desiredQuantityBeforeEffortConstraint - t.finalPlannedQuantity),
    0
  );

  const paymentDefault = financing.financialHealth.paymentDefault;
  const underwritingFrozen = financing.borrowingCapacity.underwritingFrozen;

  const reasonCodes: QuarterResultLog["reasonCodes"] = [
    ...summary.reasonCodes.map((r) => ({ code: r.code, source: "companyLab" as const, severity: "info", message: r.message })),
  ];

  return {
    companyId,
    turn,
    period: periodToString(fin.period),
    netRevenueUsd: unwrapUsd(fin.profitAndLoss.netRevenue),
    grossProfitUsd: unwrapUsd(fin.profitAndLoss.grossProfit),
    operatingProfitUsd: unwrapUsd(fin.profitAndLoss.operatingProfit),
    netIncomeUsd: unwrapUsd(fin.profitAndLoss.netIncome),
    operatingCashFlowUsd: unwrapUsd(fin.cashFlow.operatingCashFlow),
    investingCashFlowUsd: unwrapUsd(fin.cashFlow.investingCashFlow),
    financingCashFlowUsd: unwrapUsd(fin.cashFlow.financingCashFlow),
    closingCashUsd: unwrapUsd(fin.balanceSheet.cash),
    shortTermLoansUsd: unwrapUsd(fin.balanceSheet.shortTermLoans),
    longTermLoansUsd: unwrapUsd(fin.balanceSheet.longTermLoans),
    availableAdditionalCapacityUsd: financing.borrowingCapacity.availableAdditionalCapacityUsd,
    salesQuantityByProduct: {
      hoso: summary.hosoProduced !== undefined ? unwrapUnit(summary.hosoProduced) : 0,
      pd: summary.pdProduced !== undefined ? unwrapUnit(summary.pdProduced) : 0,
      vap: summary.vapProduced !== undefined ? unwrapUnit(summary.vapProduced) : 0,
    },
    productionQuantityByProduct: {
      hoso: unwrapUnit(summary.hosoProduced),
      pd: unwrapUnit(summary.pdProduced),
      vap: unwrapUnit(summary.vapProduced),
    },
    rawMaterialInventoryHosoEqTons: unwrapUnit(summary.rawMaterialInventory),
    finishedGoodsInventoryHosoEqTons: unwrapUnit(summary.finishedGoodsInventory),
    discardQuantityHosoEqTons: unwrapUnit(summary.discardQuantity),
    downgradeQuantityHosoEqTons: unwrapUnit(summary.downgradeQuantity),
    salesEffortCapacityHosoEqTons,
    salesEffortUsedHosoEqTons,
    salesReductionFromEffortConstraintHosoEqTons,
    newContractedQuantityHosoEqTons: unwrapUnit(summary.newContractedQuantity),
    fulfilledQuantityHosoEqTons: unwrapUnit(summary.fulfilledQuantity),
    outstandingQuantityHosoEqTons: unwrapUnit(summary.outstandingQuantity),
    overdueQuantityHosoEqTons: unwrapUnit(summary.overdueQuantity),
    customerTrustByMarket: { ...summary.customerTrustByMarket },
    qualityScoreByProduct: { ...summary.qualityScoreByProduct },
    deliveryReliabilityByMarket: { ...summary.deliveryReliabilityByMarket },
    paymentDefault,
    paymentDefaultNewlyTriggered: paymentDefault && !previousPaymentDefault,
    underwritingFrozen,
    underwritingFrozenNewlyTriggered: underwritingFrozen && !previousUnderwritingFrozen,
    reasonCodes,
    warningCount: reasonCodes.length,
  };
}

function salesForceCostUsdForTurn(record: CompanyQuarterRecord, companyId: SaiCompanyId): number {
  const fin = record.financialResults.find((f) => f.companyId === companyId);
  if (!fin) return 0;
  const rec = fin.costRecords.find((r) => r.account === "salesForceSalary");
  if (!rec) return 0;
  return unwrapUsd(rec.fixedPortion) + unwrapUsd(rec.variablePortion);
}

/** ケース単位（1 seed×1社）の四半期結果ログ配列から、累計・最終サマリー行を作る。 */
export function buildCaseSummaryRow(
  seed: string,
  companyId: SaiCompanyId,
  requestedTurns: number,
  history: readonly CompanyQuarterRecord[],
  quarterResults: readonly QuarterResultLog[]
): CaseSummaryRow {
  let cumulativeRevenueUsd = 0;
  let cumulativeGrossProfitUsd = 0;
  let cumulativeOperatingProfitUsd = 0;
  let cumulativeSalesForceCostUsd = 0;
  let paymentDefaultFirstTurn: number | undefined;
  let underwritingFrozenFirstTurn: number | undefined;
  const reasonCodeCounts = new Map<string, number>();
  let warningCount = 0;

  for (let i = 0; i < quarterResults.length; i++) {
    const r = quarterResults[i];
    cumulativeRevenueUsd += r.netRevenueUsd;
    cumulativeGrossProfitUsd += r.grossProfitUsd;
    cumulativeOperatingProfitUsd += r.operatingProfitUsd;
    cumulativeSalesForceCostUsd += salesForceCostUsdForTurn(history[i], companyId);
    if (r.paymentDefault && paymentDefaultFirstTurn === undefined) paymentDefaultFirstTurn = r.turn;
    if (r.underwritingFrozen && underwritingFrozenFirstTurn === undefined) underwritingFrozenFirstTurn = r.turn;
    for (const rc of r.reasonCodes) reasonCodeCounts.set(rc.code, (reasonCodeCounts.get(rc.code) ?? 0) + 1);
    warningCount += r.warningCount;
  }

  const last = quarterResults[quarterResults.length - 1];
  const topReasonCodes = Array.from(reasonCodeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code]) => code);

  return {
    seed,
    companyId,
    completedTurns: quarterResults.length,
    requestedTurns,
    completed: quarterResults.length === requestedTurns,
    cumulativeRevenueUsd,
    cumulativeGrossProfitUsd,
    cumulativeOperatingProfitUsd,
    cumulativeSalesForceCostUsd,
    finalCashUsd: last ? last.closingCashUsd : 0,
    finalLoansUsd: last ? last.shortTermLoansUsd + last.longTermLoansUsd : 0,
    finalAvailableAdditionalCapacityUsd: last ? last.availableAdditionalCapacityUsd : 0,
    paymentDefaultEverByRequestedTurns: paymentDefaultFirstTurn !== undefined,
    paymentDefaultFirstTurn,
    underwritingFrozenEverByRequestedTurns: underwritingFrozenFirstTurn !== undefined,
    underwritingFrozenFirstTurn,
    topReasonCodes,
    warningCount,
  };
}

/**
 * 1ケース（runAutoplayCaseの戻り値=1 seed×指定会社群×指定クォーター数）ぶんを、
 * A〜E全節・ケースサマリーまで組み立てる。既存のbuild*関数を会社×turnの順で
 * 順に呼び出し、前四半期のQuarterStartState・FinancingQuarterResult・
 * underwritingFrozen/paymentDefaultを次のturnへ引き継ぐだけで、新しい判定・
 * 新しい計算は一切行わない。
 *
 * ある会社・turnについて標準AIの意思決定キャプチャ（quarterStartCapture・
 * diagnostics）が見つからない場合（想定外の実行条件）は、存在しないデータを
 * 捏造せず、その会社についてはそのturn以降のログ構築を打ち切る
 * （それより前のturn分のログはそのまま保持する）。
 */
export function buildAutoplayCaseLogs(caseResult: AutoplayCaseResult): AutoplayCaseLog {
  const captureIndex = indexQuarterStartCaptures(caseResult.quarterStartCaptures);
  const diagnosticsIndex = indexDiagnostics(caseResult.diagnostics);

  const quarterStartStates: QuarterStartState[] = [];
  const decisionLogs: QuarterDecisionLog[] = [];
  const adjustmentTrace: AdjustmentTraceEntry[] = [];
  const salesQuantityTrace: SalesQuantityTraceEntry[] = [];
  const quarterResults: QuarterResultLog[] = [];
  const caseSummaryRows: CaseSummaryRow[] = [];

  for (const rawCompanyId of caseResult.companyIds) {
    const companyId = rawCompanyId as SaiCompanyId;
    let previousStartState: QuarterStartState | undefined;
    let previousFinancing: FinancingQuarterResult | undefined;
    let previousUnderwritingFrozen = false;
    let previousPaymentDefault = false;
    const companyQuarterResults: QuarterResultLog[] = [];

    for (const record of caseResult.history) {
      const turn = record.turn;
      const capture = captureIndex.get(`${companyId}::${turn}`);
      const diagnostics = diagnosticsIndex.get(`${companyId}::${turn}`);
      if (!capture || !diagnostics) break;

      const startState = buildQuarterStartState(companyId, capture, diagnostics, previousStartState, previousFinancing);
      quarterStartStates.push(startState);

      decisionLogs.push(buildQuarterDecisionLog(companyId, diagnostics, record));
      adjustmentTrace.push(...buildAdjustmentTrace(companyId, diagnostics, record));

      const salesTrace = buildSalesQuantityTrace(companyId, diagnostics, record);
      salesQuantityTrace.push(...salesTrace);

      const resultLog = buildQuarterResultLog(
        companyId,
        turn,
        record,
        previousUnderwritingFrozen,
        previousPaymentDefault,
        salesTrace,
        diagnostics.decision.salesPlans
      );
      quarterResults.push(resultLog);
      companyQuarterResults.push(resultLog);

      previousStartState = startState;
      previousFinancing = record.financingResults.find((f) => f.companyId === companyId);
      previousUnderwritingFrozen = resultLog.underwritingFrozen;
      previousPaymentDefault = resultLog.paymentDefault;
    }

    caseSummaryRows.push(
      buildCaseSummaryRow(caseResult.seed, companyId, caseResult.quarters, caseResult.history, companyQuarterResults)
    );
  }

  return {
    seed: caseResult.seed,
    companyIds: caseResult.companyIds as readonly SaiCompanyId[],
    quarterStartStates,
    decisionLogs,
    adjustmentTrace,
    salesQuantityTrace,
    quarterResults,
    caseSummaryRows,
  };
}

export type { CompanyReasonEntry };
