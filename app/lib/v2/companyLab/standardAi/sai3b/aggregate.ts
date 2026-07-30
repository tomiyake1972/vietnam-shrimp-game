// ShrimpX V2 — Phase SAI-3B-1: SAI-3Aログからの集計行の組み立て（純粋関数のみ）
//
// 【方針】ここで行うのは「既存ログの値をそのまま転記する」「単純な合計・平均・
// 件数集計」のみであり、財務・販売・生産の結果を独自ロジックで再計算しない
// （三宅さんの指示§2）。値が存在しない場合はundefinedのまま（0として扱わない）。
// 集計対象・分母を明示するため、関数名・コメントに集計単位を明記する。

import {
  AdjustmentAnalysisRow,
  CompanyPerformanceRow,
  DashboardSummaryRow,
  DecisionTraceRow,
  DefaultWarningEventRow,
  HeadcountComparisonRow,
  HeadcountDivergenceRow,
  LoadedSai3aRun,
  MarketShareRow,
  ProcurementProductionRow,
  QuarterPerformanceRow,
  ReasonCodeTallyRow,
  Sai3bAdjustmentTraceRow,
  Sai3bQuarterSummaryRow,
  SalesAnalysisRow,
  SalesCapacityMarketBreakdownRow,
  SalesCapacityRow,
} from "./schema";
import type { DecisionTraceLine } from "../autoplay/output";
import { lookupReasonCode } from "./reasonCodeCatalog";

const EPSILON = 1e-9;

function sum(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? sum(values) / values.length : undefined;
}

function keyOf(seed: string, companyId: string): string {
  return `${seed}::${companyId}`;
}

// ---------------------------------------------------------------------
// 4-2. 全体サマリー（ダッシュボード）
// ---------------------------------------------------------------------

export function buildDashboardSummary(runs: readonly LoadedSai3aRun[]): readonly DashboardSummaryRow[] {
  return runs.map((run) => {
    const totalCases = run.runSummary.runSummary.totalCases;
    const completedCases = run.caseSummaryRows.length;
    const errorCases = run.runSummary.runSummary.errorCases;

    const paymentDefaultCaseCount = run.caseSummaryRows.filter((r) => r.paymentDefaultEverByRequestedTurns).length;
    const underwritingFrozenCaseCount = run.caseSummaryRows.filter((r) => r.underwritingFrozenEverByRequestedTurns).length;
    const criticalWarningCount = run.warningRows.filter((w) => w.severity === "critical").length;

    const totalRevenueUsd = sum(run.caseSummaryRows.map((r) => r.cumulativeRevenueUsd));
    const totalGrossProfitUsd = sum(run.caseSummaryRows.map((r) => r.cumulativeGrossProfitUsd));
    const totalOperatingProfitUsd = sum(run.caseSummaryRows.map((r) => r.cumulativeOperatingProfitUsd));
    const averageFinalCashUsd = average(run.caseSummaryRows.map((r) => r.finalCashUsd));
    const averageFinalLoansUsd = average(run.caseSummaryRows.map((r) => r.finalLoansUsd));

    const allSalesTrace = run.decisionTraceLines.flatMap((l) => l.salesQuantityTrace);
    const totalFinalSalesQuantityHosoEqTons = sum(allSalesTrace.map((t) => t.finalPlannedQuantity));
    const totalDesiredBeforeEffortConstraintHosoEqTons = sum(allSalesTrace.map((t) => t.desiredQuantityBeforeEffortConstraint));
    const totalReductionFromEffortConstraintHosoEqTons = totalDesiredBeforeEffortConstraintHosoEqTons - totalFinalSalesQuantityHosoEqTons;
    const effortConstraintReductionRate =
      totalDesiredBeforeEffortConstraintHosoEqTons > EPSILON
        ? totalReductionFromEffortConstraintHosoEqTons / totalDesiredBeforeEffortConstraintHosoEqTons
        : undefined;

    const utilizationValues = run.quarterSummaryRows.map((q) => q.salesEffortUtilizationRate).filter((v): v is number => v !== undefined);
    const averageSalesEffortUtilizationRate = average(utilizationValues);

    const top = run.runSummary.runSummary.topReasonCodeCounts[0];

    const row: DashboardSummaryRow = {
      runLabel: run.runLabel,
      runId: run.manifest.runId,
      salesForceHeadcountTotal: run.manifest.salesForceHeadcountTotal,
      totalCases,
      completedCases,
      errorCases,
      paymentDefaultCaseCount,
      paymentDefaultRateByCase: completedCases > 0 ? paymentDefaultCaseCount / completedCases : 0,
      underwritingFrozenCaseCount,
      underwritingFrozenRateByCase: completedCases > 0 ? underwritingFrozenCaseCount / completedCases : 0,
      criticalWarningCount,
      totalRevenueUsd,
      totalGrossProfitUsd,
      totalOperatingProfitUsd,
      averageFinalCashUsd: averageFinalCashUsd ?? 0,
      averageFinalLoansUsd: averageFinalLoansUsd ?? 0,
      totalFinalSalesQuantityHosoEqTons,
      totalReductionFromEffortConstraintHosoEqTons,
      totalDesiredBeforeEffortConstraintHosoEqTons,
      effortConstraintReductionRate,
      averageSalesEffortUtilizationRate,
      topReasonCode: top?.code,
      topReasonCodeCount: top?.count,
    };
    return row;
  });
}

// ---------------------------------------------------------------------
// 4-3. 会社別業績
// ---------------------------------------------------------------------

export function buildCompanyPerformance(runs: readonly LoadedSai3aRun[]): readonly CompanyPerformanceRow[] {
  const result: CompanyPerformanceRow[] = [];
  for (const run of runs) {
    const quarterByKey = new Map<string, Sai3bQuarterSummaryRow[]>();
    for (const q of run.quarterSummaryRows) {
      const k = keyOf(q.seed, q.companyId);
      const arr = quarterByKey.get(k);
      if (arr) arr.push(q);
      else quarterByKey.set(k, [q]);
    }
    const salesByKey = new Map<string, DecisionTraceLine[]>();
    for (const l of run.decisionTraceLines) {
      const k = keyOf(l.seed, l.companyId);
      const arr = salesByKey.get(k);
      if (arr) arr.push(l);
      else salesByKey.set(k, [l]);
    }

    for (const r of run.caseSummaryRows) {
      const k = keyOf(r.seed, r.companyId);
      const quarters = (quarterByKey.get(k) ?? []).slice().sort((a, b) => a.turn - b.turn);
      const lastQuarter = quarters[quarters.length - 1];
      const lines = salesByKey.get(k) ?? [];
      const cumulativeSalesQuantityHosoEqTons =
        lines.length > 0 ? sum(lines.flatMap((l) => l.salesQuantityTrace.map((t) => t.finalPlannedQuantity))) : undefined;

      result.push({
        runLabel: run.runLabel,
        companyId: r.companyId,
        seed: r.seed,
        completed: r.completed,
        completedTurns: r.completedTurns,
        requestedTurns: r.requestedTurns,
        paymentDefaultEver: r.paymentDefaultEverByRequestedTurns,
        paymentDefaultFirstTurn: r.paymentDefaultFirstTurn,
        underwritingFrozenEver: r.underwritingFrozenEverByRequestedTurns,
        underwritingFrozenFirstTurn: r.underwritingFrozenFirstTurn,
        cumulativeRevenueUsd: r.cumulativeRevenueUsd,
        cumulativeGrossProfitUsd: r.cumulativeGrossProfitUsd,
        cumulativeOperatingProfitUsd: r.cumulativeOperatingProfitUsd,
        finalCashUsd: r.finalCashUsd,
        finalLoansUsd: r.finalLoansUsd,
        finalFinishedGoodsInventoryHosoEqTons: lastQuarter?.finishedGoodsInventoryHosoEqTons,
        cumulativeSalesQuantityHosoEqTons,
        warningCount: r.warningCount,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-4. 四半期業績
// ---------------------------------------------------------------------

export function buildQuarterPerformance(runs: readonly LoadedSai3aRun[]): readonly QuarterPerformanceRow[] {
  const result: QuarterPerformanceRow[] = [];
  for (const run of runs) {
    const decisionByKey = new Map<string, DecisionTraceLine>();
    for (const l of run.decisionTraceLines) decisionByKey.set(`${keyOf(l.seed, l.companyId)}::${l.turn}`, l);
    const warningsByKey = new Map<string, string[]>();
    for (const w of run.warningRows) {
      const k = `${keyOf(w.seed, w.companyId)}::${w.turn}`;
      const arr = warningsByKey.get(k);
      if (arr) arr.push(w.code);
      else warningsByKey.set(k, [w.code]);
    }
    // market-allocation-trace.csv由来の、会社×seed×turnの実際の獲得数量合計
    // （商品・市場を問わず合算。ファイルが無いrun=古いrunでは空Map=常にundefined）。
    const actualSalesByKey = new Map<string, number>();
    for (const a of run.marketAllocationTraceRows) {
      const k = `${keyOf(a.seed, a.companyId)}::${a.turn}`;
      actualSalesByKey.set(k, (actualSalesByKey.get(k) ?? 0) + a.allocatedQuantityHosoEqTons);
    }

    for (const q of run.quarterSummaryRows) {
      const k = `${keyOf(q.seed, q.companyId)}::${q.turn}`;
      const line = decisionByKey.get(k);
      const productionPlanQuantityTotal = line
        ? sum(Object.values(line.decision.wish.productionDesiredQuantityByProduct))
        : undefined;
      const finalPlannedSalesQuantityTotal = line ? sum(line.salesQuantityTrace.map((t) => t.finalPlannedQuantity)) : undefined;
      const topWarningCodes = (warningsByKey.get(k) ?? []).join("|");

      result.push({
        runLabel: run.runLabel,
        companyId: q.companyId,
        seed: q.seed,
        turn: q.turn,
        period: q.period,
        netRevenueUsd: q.netRevenueUsd,
        grossProfitUsd: q.grossProfitUsd,
        operatingProfitUsd: q.operatingProfitUsd,
        netIncomeUsd: q.netIncomeUsd,
        closingCashUsd: q.closingCashUsd,
        shortTermLoansUsd: q.endingShortTermLoansUsd,
        longTermLoansUsd: q.endingLongTermLoansUsd,
        accountsReceivableUsdAtStart: line?.startState.accountsReceivableUsd,
        accountsPayableUsdAtStart: line?.startState.accountsPayableUsd,
        rawMaterialInventoryHosoEqTons: q.rawMaterialInventoryHosoEqTons,
        finishedGoodsInventoryHosoEqTons: q.finishedGoodsInventoryHosoEqTons,
        productionPlanQuantityTotal,
        finalPlannedSalesQuantityTotal,
        operatingCashFlowUsd: q.operatingCashFlowUsd,
        investingCashFlowUsd: q.investingCashFlowUsd,
        financingCashFlowUsd: q.financingCashFlowUsd,
        endingAvailableAdditionalCapacityUsd: q.endingAvailableAdditionalCapacityUsd,
        actualSalesQuantityHosoEqTons: actualSalesByKey.get(k),
        newContractedQuantityHosoEqTons: q.newContractedQuantityHosoEqTons,
        fulfilledQuantityHosoEqTons: q.fulfilledQuantityHosoEqTons,
        outstandingQuantityHosoEqTons: q.outstandingQuantityHosoEqTons,
        overdueQuantityHosoEqTons: q.overdueQuantityHosoEqTons,
        paymentDefault: q.paymentDefault,
        underwritingFrozen: q.underwritingFrozen,
        startCreditTier: q.startCreditTier,
        topWarningCodes,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-13（SAI-3B-2で追加）. 市場別シェア推移
// ---------------------------------------------------------------------

export function buildMarketShare(runs: readonly LoadedSai3aRun[]): readonly MarketShareRow[] {
  const result: MarketShareRow[] = [];
  for (const run of runs) {
    // run×seed×turn×市場 で、会社をまたいだ配分数量合計・会社数を先に集計する
    // （商品を問わず合算。三宅さんの指示どおり「市場別」の粒度で会社別シェアを見る）。
    const byRunSeedTurnMarket = new Map<string, Map<string, number>>(); // key -> (companyId -> qty)
    for (const a of run.marketAllocationTraceRows) {
      const key = `${a.seed}::${a.turn}::${a.market}`;
      let byCompany = byRunSeedTurnMarket.get(key);
      if (!byCompany) {
        byCompany = new Map();
        byRunSeedTurnMarket.set(key, byCompany);
      }
      byCompany.set(a.companyId, (byCompany.get(a.companyId) ?? 0) + a.allocatedQuantityHosoEqTons);
    }

    for (const [key, byCompany] of byRunSeedTurnMarket.entries()) {
      const [seed, turnStr, market] = key.split("::");
      const turn = Number(turnStr);
      const total = sum(Array.from(byCompany.values()));
      const period = run.quarterSummaryRows.find((q) => q.seed === seed && q.turn === turn)?.period ?? "";
      for (const [companyId, qty] of byCompany.entries()) {
        result.push({
          runLabel: run.runLabel,
          seed,
          turn,
          period,
          market,
          companyId,
          allocatedQuantityHosoEqTons: qty,
          totalAllocatedQuantityHosoEqTonsAcrossCompanies: total,
          quantityShare: total > EPSILON ? qty / total : 0,
          companyCountInMarket: byCompany.size,
        });
      }
    }
  }
  return result.sort(
    (a, b) =>
      a.runLabel.localeCompare(b.runLabel) ||
      a.market.localeCompare(b.market) ||
      a.seed.localeCompare(b.seed) ||
      a.turn - b.turn ||
      a.companyId.localeCompare(b.companyId)
  );
}

// ---------------------------------------------------------------------
// 4-14（SAI-3B-2で追加）. 80/85/90人比較: 最初に乖離が始まった四半期の追跡
// ---------------------------------------------------------------------

/** 乖離検出に用いるKPI候補（優先順位順。同一turnで複数KPIが同時に乖離した
 *  場合は先頭のものを採用する）。財務系KPIを優先し、比率(0〜1)のKPIは
 *  スケールが異なるため別途相対乖離率を計算する。 */
const DIVERGENCE_KPI_CANDIDATES: readonly { readonly key: string; readonly extract: (r: QuarterPerformanceRow) => number | undefined }[] = [
  { key: "netRevenueUsd", extract: (r) => r.netRevenueUsd },
  { key: "operatingProfitUsd", extract: (r) => r.operatingProfitUsd },
  { key: "closingCashUsd", extract: (r) => r.closingCashUsd },
  { key: "operatingCashFlowUsd", extract: (r) => r.operatingCashFlowUsd },
  { key: "shortTermLoansUsd", extract: (r) => r.shortTermLoansUsd },
  { key: "finishedGoodsInventoryHosoEqTons", extract: (r) => r.finishedGoodsInventoryHosoEqTons },
];

/** ヒューリスティックな相対乖離率の閾値。財務系KPIの通常の四半期間変動幅を
 *  上回る値として、経験的に5%を採用（統計的根拠のある値ではなく、あくまで
 *  「どこから見た目上ばらつき始めたか」を機械的に拾うためのパラメータ）。 */
const DIVERGENCE_THRESHOLD = 0.05;

export function buildHeadcountDivergence(
  runs: readonly LoadedSai3aRun[],
  quarterPerformance: readonly QuarterPerformanceRow[],
  commonSeeds: readonly string[],
  commonCompanyIds: readonly string[]
): readonly HeadcountDivergenceRow[] {
  if (runs.length < 2) return [];
  const headcounts = Array.from(new Set(runs.map((r) => r.manifest.salesForceHeadcountTotal))).sort((a, b) => a - b);
  const runLabelByHeadcount = new Map<number, string>();
  for (const r of runs) runLabelByHeadcount.set(r.manifest.salesForceHeadcountTotal, r.runLabel);

  const maxTurn = Math.max(...runs.map((r) => r.manifest.quarters));

  const result: HeadcountDivergenceRow[] = [];
  for (const companyId of commonCompanyIds) {
    for (const seed of commonSeeds) {
      // headcount -> turn -> QuarterPerformanceRow（このcompany×seedのみ）。
      const byHeadcountTurn = new Map<number, Map<number, QuarterPerformanceRow>>();
      for (const hc of headcounts) {
        const runLabel = runLabelByHeadcount.get(hc);
        const byTurn = new Map<number, QuarterPerformanceRow>();
        for (const r of quarterPerformance) {
          if (r.runLabel === runLabel && r.companyId === companyId && r.seed === seed) byTurn.set(r.turn, r);
        }
        if (byTurn.size > 0) byHeadcountTurn.set(hc, byTurn);
      }
      if (byHeadcountTurn.size < 2) continue; // 比較対象が2つ未満なら乖離判定不能。

      let firstDivergingTurn: number | undefined;
      let firstDivergingKpi: string | undefined;
      outer: for (let turn = 1; turn <= maxTurn; turn++) {
        for (const { key, extract } of DIVERGENCE_KPI_CANDIDATES) {
          const values: number[] = [];
          for (const byTurn of byHeadcountTurn.values()) {
            const row = byTurn.get(turn);
            const v = row ? extract(row) : undefined;
            if (v !== undefined && Number.isFinite(v)) values.push(v);
          }
          if (values.length < 2) continue;
          const maxV = Math.max(...values);
          const minV = Math.min(...values);
          const denom = Math.max(Math.abs(maxV), EPSILON);
          const relativeDivergence = (maxV - minV) / denom;
          if (relativeDivergence > DIVERGENCE_THRESHOLD) {
            firstDivergingTurn = turn;
            firstDivergingKpi = key;
            break outer;
          }
        }
      }

      result.push({
        companyId,
        seed,
        headcounts: Array.from(byHeadcountTurn.keys()).sort((a, b) => a - b),
        firstDivergingTurn,
        firstDivergingKpi,
        divergenceThreshold: DIVERGENCE_THRESHOLD,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-5. 販売分析
// ---------------------------------------------------------------------

export function buildSalesAnalysis(runs: readonly LoadedSai3aRun[]): readonly SalesAnalysisRow[] {
  const result: SalesAnalysisRow[] = [];
  for (const run of runs) {
    for (const line of run.decisionTraceLines) {
      for (const t of line.salesQuantityTrace) {
        const reduction = t.desiredQuantityBeforeEffortConstraint - t.finalPlannedQuantity;
        result.push({
          runLabel: run.runLabel,
          companyId: line.companyId,
          seed: line.seed,
          turn: line.turn,
          market: t.market,
          product: t.product,
          desiredQuantityBeforeEffortConstraint: t.desiredQuantityBeforeEffortConstraint,
          finalPlannedQuantity: t.finalPlannedQuantity,
          engineEffortScaleFactor: t.engineEffortScaleFactor,
          reductionFromEffortConstraint: reduction,
          reductionRate: t.desiredQuantityBeforeEffortConstraint > EPSILON ? reduction / t.desiredQuantityBeforeEffortConstraint : undefined,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-6. 調達・生産・在庫
// ---------------------------------------------------------------------

export function buildProcurementProduction(runs: readonly LoadedSai3aRun[]): readonly ProcurementProductionRow[] {
  const result: ProcurementProductionRow[] = [];
  for (const run of runs) {
    const quarterByKey = new Map<string, Sai3bQuarterSummaryRow>();
    for (const q of run.quarterSummaryRows) quarterByKey.set(`${keyOf(q.seed, q.companyId)}::${q.turn}`, q);

    for (const line of run.decisionTraceLines) {
      const q = quarterByKey.get(`${keyOf(line.seed, line.companyId)}::${line.turn}`);
      result.push({
        runLabel: run.runLabel,
        companyId: line.companyId,
        seed: line.seed,
        turn: line.turn,
        domesticPurchaseDesiredQuantity: line.decision.wish.domesticPurchaseDesiredQuantity,
        domesticPurchaseFinalQuantity: line.decision.final.domesticPurchaseFinalQuantity,
        importOrdersDesiredQuantity: line.decision.wish.importOrdersDesiredQuantity,
        importOrdersFinalQuantity: line.decision.final.importOrdersFinalQuantity,
        importOrdersBlocked: line.decision.final.importOrdersBlocked,
        aquacultureStockingDesiredQuantity: line.decision.wish.aquacultureStockingDesiredQuantity,
        aquacultureStockingFinalQuantity: line.decision.final.aquacultureStockingFinalQuantity,
        productionDesiredQuantityByProduct: line.decision.wish.productionDesiredQuantityByProduct,
        rawMaterialInventoryHosoEqTons: q?.rawMaterialInventoryHosoEqTons ?? Number.NaN,
        finishedGoodsInventoryHosoEqTons: q?.finishedGoodsInventoryHosoEqTons ?? Number.NaN,
        discardQuantityHosoEqTons: q?.discardQuantityHosoEqTons ?? Number.NaN,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-7. 営業能力分析
// ---------------------------------------------------------------------

export function buildSalesCapacity(runs: readonly LoadedSai3aRun[]): readonly SalesCapacityRow[] {
  const result: SalesCapacityRow[] = [];
  for (const run of runs) {
    for (const q of run.quarterSummaryRows) {
      result.push({
        runLabel: run.runLabel,
        companyId: q.companyId,
        seed: q.seed,
        turn: q.turn,
        salesForceHeadcountTotal: q.startSalesForceHeadcountTotal,
        capacityHosoEqTonsActual: q.salesEffortCapacityHosoEqTonsActual,
        usedHosoEqTons: q.salesEffortUsedHosoEqTons,
        utilizationRate: q.salesEffortUtilizationRate,
        reductionFromEffortConstraintHosoEqTons: q.salesReductionFromEffortConstraintHosoEqTons,
      });
    }
  }
  return result;
}

export function buildSalesCapacityMarketBreakdown(runs: readonly LoadedSai3aRun[]): readonly SalesCapacityMarketBreakdownRow[] {
  const result: SalesCapacityMarketBreakdownRow[] = [];
  for (const run of runs) {
    for (const line of run.decisionTraceLines) {
      const byMarket = new Map<string, { headcount?: number; desired: number; final: number }>();
      for (const t of line.salesQuantityTrace) {
        const existing = byMarket.get(t.market) ?? { headcount: t.salesForceHeadcount, desired: 0, final: 0 };
        existing.desired += t.desiredQuantityBeforeEffortConstraint;
        existing.final += t.finalPlannedQuantity;
        existing.headcount = t.salesForceHeadcount;
        byMarket.set(t.market, existing);
      }
      for (const [market, v] of Array.from(byMarket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const reduction = v.desired - v.final;
        result.push({
          runLabel: run.runLabel,
          companyId: line.companyId,
          seed: line.seed,
          turn: line.turn,
          market,
          headcount: v.headcount,
          desiredPhysicalQuantityTotal: v.desired,
          finalPlannedPhysicalQuantityTotal: v.final,
          reductionPhysicalQuantityTotal: reduction,
          reductionRate: v.desired > EPSILON ? reduction / v.desired : undefined,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-8. 計画調整分析
// ---------------------------------------------------------------------

function classifyDomainGroup(row: Sai3bAdjustmentTraceRow): AdjustmentAnalysisRow["domainGroup"] {
  if (row.source === "standardAi") return "standardAiDiagnostic";
  switch (row.affectedDecision) {
    case "sales":
      return "sales";
    case "procurement":
      return "procurement";
    case "financing":
    case "production_or_sales":
      return "production_labor_finance";
    default:
      return "other";
  }
}

export function buildAdjustmentAnalysis(runs: readonly LoadedSai3aRun[]): readonly AdjustmentAnalysisRow[] {
  const result: AdjustmentAnalysisRow[] = [];
  for (const run of runs) {
    for (const row of run.adjustmentTraceRows) {
      const deltaRate = row.before !== undefined && row.after !== undefined && Math.abs(row.before) > EPSILON ? (row.after - row.before) / row.before : undefined;
      result.push({
        runLabel: run.runLabel,
        companyId: row.companyId,
        seed: row.seed,
        turn: row.turn,
        domainGroup: classifyDomainGroup(row),
        market: row.affectedMarketOrProduct,
        product: undefined,
        adjustmentStage: row.category,
        before: row.before,
        after: row.after,
        delta: row.delta,
        deltaRate,
        code: row.code,
        threshold: row.threshold,
        relevantMetric: row.relevantMetric,
        logRefKey: `${row.seed}::${row.companyId}::${row.turn}`,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-9. Default・信用・警告
// ---------------------------------------------------------------------

export function buildDefaultWarningEvents(runs: readonly LoadedSai3aRun[]): readonly DefaultWarningEventRow[] {
  const result: DefaultWarningEventRow[] = [];
  for (const run of runs) {
    const quarterByKey = new Map<string, Sai3bQuarterSummaryRow[]>();
    for (const q of run.quarterSummaryRows) {
      const k = keyOf(q.seed, q.companyId);
      const arr = quarterByKey.get(k);
      if (arr) arr.push(q);
      else quarterByKey.set(k, [q]);
    }
    const warningsByKey = new Map<string, string[]>();
    for (const w of run.warningRows) {
      const k = `${keyOf(w.seed, w.companyId)}::${w.turn}`;
      const arr = warningsByKey.get(k);
      if (arr) arr.push(w.code);
      else warningsByKey.set(k, [w.code]);
    }

    for (const r of run.caseSummaryRows) {
      const k = keyOf(r.seed, r.companyId);
      const quarters = (quarterByKey.get(k) ?? []).slice().sort((a, b) => a.turn - b.turn);
      const events: readonly ["paymentDefault" | "underwritingFrozen", number | undefined][] = [
        ["paymentDefault", r.paymentDefaultFirstTurn],
        ["underwritingFrozen", r.underwritingFrozenFirstTurn],
      ];
      for (const [eventType, firstTurn] of events) {
        if (firstTurn === undefined) continue;
        const eventQuarter = quarters.find((q) => q.turn === firstTurn);
        const priorQuarter = quarters.find((q) => q.turn === firstTurn - 1);
        const makeRow = (q: Sai3bQuarterSummaryRow | undefined, isPrior: boolean): DefaultWarningEventRow | undefined => {
          if (!q) return undefined;
          const priorCash = isPrior ? undefined : priorQuarter?.closingCashUsd;
          return {
            runLabel: run.runLabel,
            companyId: r.companyId,
            seed: r.seed,
            eventType,
            turn: q.turn,
            period: q.period,
            cashUsd: q.closingCashUsd,
            loansUsd: q.endingShortTermLoansUsd + q.endingLongTermLoansUsd,
            availableAdditionalCapacityUsd: q.endingAvailableAdditionalCapacityUsd,
            revenueUsd: q.netRevenueUsd,
            grossProfitUsd: q.grossProfitUsd,
            operatingProfitUsd: q.operatingProfitUsd,
            inventoryHosoEqTons: q.finishedGoodsInventoryHosoEqTons,
            cashUsdDeltaFromPriorQuarter: priorCash !== undefined ? q.closingCashUsd - priorCash : undefined,
            warningCodes: (warningsByKey.get(`${k}::${q.turn}`) ?? []).join("|"),
            isPriorQuarter: isPrior,
          };
        };
        const priorRow = makeRow(priorQuarter, true);
        if (priorRow) result.push(priorRow);
        const eventRow = makeRow(eventQuarter, false);
        if (eventRow) result.push(eventRow);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-10. Reason Code集計（全run横断）
// ---------------------------------------------------------------------

export function buildReasonCodeTally(runs: readonly LoadedSai3aRun[]): readonly ReasonCodeTallyRow[] {
  interface Acc {
    totalOccurrences: number;
    cases: Set<string>;
    defaultCases: number;
    nonDefaultCases: number;
    companyBreakdown: Map<string, number>;
    headcountBreakdown: Map<number, number>;
    quarterBreakdown: Map<number, number>;
    source: string;
  }
  const acc = new Map<string, Acc>();

  for (const run of runs) {
    const defaultByCompanySeed = new Set(
      run.caseSummaryRows.filter((r) => r.paymentDefaultEverByRequestedTurns).map((r) => keyOf(r.seed, r.companyId))
    );
    for (const w of run.warningRows) {
      const key = `${w.source}::${w.code}`;
      let a = acc.get(key);
      if (!a) {
        a = {
          totalOccurrences: 0,
          cases: new Set(),
          defaultCases: 0,
          nonDefaultCases: 0,
          companyBreakdown: new Map(),
          headcountBreakdown: new Map(),
          quarterBreakdown: new Map(),
          source: w.source,
        };
        acc.set(key, a);
      }
      a.totalOccurrences += 1;
      a.cases.add(keyOf(w.seed, w.companyId));
      const isDefaultCase = defaultByCompanySeed.has(keyOf(w.seed, w.companyId));
      if (isDefaultCase) a.defaultCases += 1;
      else a.nonDefaultCases += 1;
      a.companyBreakdown.set(w.companyId, (a.companyBreakdown.get(w.companyId) ?? 0) + 1);
      const hc = run.manifest.salesForceHeadcountTotal;
      a.headcountBreakdown.set(hc, (a.headcountBreakdown.get(hc) ?? 0) + 1);
      a.quarterBreakdown.set(w.turn, (a.quarterBreakdown.get(w.turn) ?? 0) + 1);
    }
  }

  return Array.from(acc.entries())
    .map(([key, a]) => {
      const code = key.split("::").slice(1).join("::");
      const catalogEntry = lookupReasonCode(code, a.source);
      return {
        code,
        source: a.source,
        domain: catalogEntry.domain,
        description: catalogEntry.description,
        totalOccurrences: a.totalOccurrences,
        caseCount: a.cases.size,
        occurrencesInDefaultCases: a.defaultCases,
        occurrencesInNonDefaultCases: a.nonDefaultCases,
        companyBreakdown: Object.fromEntries(a.companyBreakdown),
        headcountBreakdown: Object.fromEntries(a.headcountBreakdown),
        quarterBreakdown: Object.fromEntries(a.quarterBreakdown),
      };
    })
    .sort((a, b) => b.totalOccurrences - a.totalOccurrences);
}

// ---------------------------------------------------------------------
// 4-11. 80・85・90人比較（複数run入力時のみ意味を持つ）
// ---------------------------------------------------------------------

export function buildHeadcountComparison(runs: readonly LoadedSai3aRun[], commonSeeds: readonly string[], commonCompanyIds: readonly string[]): readonly HeadcountComparisonRow[] {
  if (runs.length < 2) return [];
  const headcounts = runs.map((r) => r.manifest.salesForceHeadcountTotal);
  const sortedHeadcounts = Array.from(new Set(headcounts)).sort((a, b) => a - b);

  const runByHeadcount = new Map<number, LoadedSai3aRun>();
  for (const r of runs) runByHeadcount.set(r.manifest.salesForceHeadcountTotal, r);

  const result: HeadcountComparisonRow[] = [];
  for (const companyId of commonCompanyIds) {
    for (const seed of commonSeeds) {
      const paymentDefaultByHeadcount: Record<number, boolean> = {};
      const paymentDefaultFirstTurnByHeadcount: Record<number, number | undefined> = {};
      const revenueByHeadcount: Record<number, number> = {};
      const grossProfitByHeadcount: Record<number, number> = {};
      const operatingProfitByHeadcount: Record<number, number> = {};
      const finalCashByHeadcount: Record<number, number> = {};
      const finalLoansByHeadcount: Record<number, number> = {};
      let hasAnyData = false;

      for (const hc of sortedHeadcounts) {
        const run = runByHeadcount.get(hc);
        const caseRow = run?.caseSummaryRows.find((r) => r.seed === seed && r.companyId === companyId);
        if (!caseRow) continue;
        hasAnyData = true;
        paymentDefaultByHeadcount[hc] = caseRow.paymentDefaultEverByRequestedTurns;
        paymentDefaultFirstTurnByHeadcount[hc] = caseRow.paymentDefaultFirstTurn;
        revenueByHeadcount[hc] = caseRow.cumulativeRevenueUsd;
        grossProfitByHeadcount[hc] = caseRow.cumulativeGrossProfitUsd;
        operatingProfitByHeadcount[hc] = caseRow.cumulativeOperatingProfitUsd;
        finalCashByHeadcount[hc] = caseRow.finalCashUsd;
        finalLoansByHeadcount[hc] = caseRow.finalLoansUsd;
      }
      if (!hasAnyData) continue;

      const presentHeadcounts = sortedHeadcounts.filter((hc) => hc in paymentDefaultByHeadcount);
      let middleHeadcountOnlyDefaultFlag = false;
      if (presentHeadcounts.length >= 3) {
        for (let i = 1; i < presentHeadcounts.length - 1; i++) {
          const hc = presentHeadcounts[i];
          const isMiddleDefault = paymentDefaultByHeadcount[hc] === true;
          const othersAllNonDefault = presentHeadcounts.every((other) => other === hc || paymentDefaultByHeadcount[other] === false);
          if (isMiddleDefault && othersAllNonDefault) {
            middleHeadcountOnlyDefaultFlag = true;
            break;
          }
        }
      }

      result.push({
        companyId,
        seed,
        headcounts: presentHeadcounts,
        paymentDefaultByHeadcount,
        paymentDefaultFirstTurnByHeadcount,
        revenueByHeadcount,
        grossProfitByHeadcount,
        operatingProfitByHeadcount,
        finalCashByHeadcount,
        finalLoansByHeadcount,
        middleHeadcountOnlyDefaultFlag,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 4-12. 四半期判断トレース
// ---------------------------------------------------------------------

export function buildDecisionTrace(runs: readonly LoadedSai3aRun[]): readonly DecisionTraceRow[] {
  const result: DecisionTraceRow[] = [];
  for (const run of runs) {
    const warningsByKey = new Map<string, string[]>();
    for (const w of run.warningRows) {
      const k = `${keyOf(w.seed, w.companyId)}::${w.turn}`;
      const arr = warningsByKey.get(k);
      if (arr) arr.push(`${w.code}(${w.severity})`);
      else warningsByKey.set(k, [`${w.code}(${w.severity})`]);
    }
    const quarterByKey = new Map<string, Sai3bQuarterSummaryRow>();
    for (const q of run.quarterSummaryRows) quarterByKey.set(`${keyOf(q.seed, q.companyId)}::${q.turn}`, q);

    for (const line of run.decisionTraceLines) {
      const base = { runLabel: run.runLabel, companyId: line.companyId, seed: line.seed, turn: line.turn, period: line.period };
      result.push({
        ...base,
        stage: "start_state",
        stageOrder: 1,
        summary: `現金$${line.startState.cashUsd.toLocaleString()}、在庫(原料${line.startState.rawMaterialInventoryHosoEqTons.toFixed(0)}/製品${line.startState.finishedGoodsInventoryHosoEqTons.toFixed(0)})、信用${line.startState.creditTier}、underwritingFrozen=${line.startState.underwritingFrozen}`,
      });
      result.push({
        ...base,
        stage: "ai_wish",
        stageOrder: 2,
        summary: `国内買付希望${line.decision.wish.domesticPurchaseDesiredQuantity.toFixed(0)}、生産希望合計${sum(Object.values(line.decision.wish.productionDesiredQuantityByProduct)).toFixed(0)}、資金希望$${line.decision.wish.financingRequestDesiredAmountUsd.toFixed(0)}`,
      });
      const totalReduction = sum(line.salesQuantityTrace.map((t) => t.desiredQuantityBeforeEffortConstraint - t.finalPlannedQuantity));
      result.push({
        ...base,
        stage: "constraint_adjustment",
        stageOrder: 3,
        summary: `営業工数制約による販売削減合計${totalReduction.toFixed(1)}トン、調達最終量（国内${line.decision.final.domesticPurchaseFinalQuantity.toFixed(0)}/輸入${line.decision.final.importOrdersFinalQuantity.toFixed(0)}${line.decision.final.importOrdersBlocked ? "・ブロック" : ""}）`,
      });
      result.push({
        ...base,
        stage: "final_decision",
        stageOrder: 4,
        summary: `養殖投入最終量${line.decision.final.aquacultureStockingFinalQuantity.toFixed(0)}、最終販売計画合計${sum(line.salesQuantityTrace.map((t) => t.finalPlannedQuantity)).toFixed(1)}トン`,
      });
      const q = quarterByKey.get(`${keyOf(line.seed, line.companyId)}::${line.turn}`);
      result.push({
        ...base,
        stage: "quarter_result",
        stageOrder: 5,
        summary: q
          ? `売上$${q.netRevenueUsd.toFixed(0)}、営業利益$${q.operatingProfitUsd.toFixed(0)}、期末現金$${q.closingCashUsd.toFixed(0)}、paymentDefault=${q.paymentDefault}、underwritingFrozen=${q.underwritingFrozen}`
          : "(quarter-summary.csvに対応する行が見つかりません)",
      });
      result.push({
        ...base,
        stage: "warning_reason_code",
        stageOrder: 6,
        summary: (warningsByKey.get(`${keyOf(line.seed, line.companyId)}::${line.turn}`) ?? []).join("; ") || "(なし)",
      });
    }
  }
  return result.sort((a, b) => a.runLabel.localeCompare(b.runLabel) || a.seed.localeCompare(b.seed) || a.companyId.localeCompare(b.companyId) || a.turn - b.turn || a.stageOrder - b.stageOrder);
}
