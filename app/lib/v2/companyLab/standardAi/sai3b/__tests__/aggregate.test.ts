// ShrimpX V2 — Phase SAI-3B-1: aggregate.ts のユニットテスト
//
// 集計値が元ログ（フィクスチャ）から再計算した値と一致することを検証する
// （三宅さんの指示§9「集計値が元ログから再計算した値と一致する」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSai3aRun } from "../loadRun";
import {
  buildCompanyPerformance,
  buildCompanyQuarterStats,
  buildDashboardSummary,
  buildHeadcountComparison,
  buildHeadcountDivergence,
  buildMarketShare,
  buildQuarterPerformance,
  buildReasonCodeTally,
  buildSalesAnalysis,
} from "../aggregate";
import { validateComparableRuns } from "../compareRuns";
import { buildFixtureRunFiles } from "./testFixtures";
import { LoadedSai3aRun, Sai3bMarketAllocationTraceRow, Sai3bQuarterSummaryRow } from "../schema";

function loadedRun(runId: string, headcount: number, cases: Parameters<typeof buildFixtureRunFiles>[0]["cases"]) {
  const files = buildFixtureRunFiles({ runId, headcount, quarters: 2, cases });
  return loadSai3aRun({ runLabel: runId, sourceDir: `/tmp/${runId}`, files });
}

test("buildDashboardSummary: default率はケース単位（分母=completedCases）で正しく計算される", () => {
  const run = loadedRun("r1", 80, [
    { seed: "s1", companyId: "BAL", quarters: 2, headcount: 80, defaultAtTurn: 2 },
    { seed: "s2", companyId: "BAL", quarters: 2, headcount: 80 },
  ]);
  const [row] = buildDashboardSummary([run]);
  assert.equal(row.completedCases, 2);
  assert.equal(row.paymentDefaultCaseCount, 1);
  assert.equal(row.paymentDefaultRateByCase, 0.5);
});

test("buildDashboardSummary: 希望販売量・最終計画量・削減量がsalesQuantityTraceの合計と一致する", () => {
  const run = loadedRun("r1", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const [row] = buildDashboardSummary([run]);
  // fixtureでは各turnでdesired=4400, final=1200なので、2turn分の合計は8800/2400。
  assert.equal(row.totalDesiredBeforeEffortConstraintHosoEqTons, 8800);
  assert.equal(row.totalFinalSalesQuantityHosoEqTons, 2400);
  assert.equal(row.totalReductionFromEffortConstraintHosoEqTons, 6400);
  assert.ok(row.effortConstraintReductionRate !== undefined);
  assert.ok(Math.abs((row.effortConstraintReductionRate as number) - 6400 / 8800) < 1e-9);
});

test("buildCompanyPerformance: 会社×seed単位の行数・default初回turnが正しい", () => {
  const run = loadedRun("r1", 80, [
    { seed: "s1", companyId: "BAL", quarters: 3, headcount: 80, defaultAtTurn: 2 },
    { seed: "s2", companyId: "BAL", quarters: 3, headcount: 80 },
  ]);
  const rows = buildCompanyPerformance([run]);
  assert.equal(rows.length, 2);
  const defaultedRow = rows.find((r) => r.seed === "s1")!;
  assert.equal(defaultedRow.paymentDefaultEver, true);
  assert.equal(defaultedRow.paymentDefaultFirstTurn, 2);
  const okRow = rows.find((r) => r.seed === "s2")!;
  assert.equal(okRow.paymentDefaultEver, false);
});

test("buildSalesAnalysis: 市場×商品×turn単位の行を正しく展開する", () => {
  const run = loadedRun("r1", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const rows = buildSalesAnalysis([run]);
  assert.equal(rows.length, 2); // 2 turns * 1 market/product each in fixture
  for (const r of rows) {
    assert.equal(r.desiredQuantityBeforeEffortConstraint, 4400);
    assert.equal(r.finalPlannedQuantity, 1200);
    assert.equal(r.reductionFromEffortConstraint, 3200);
  }
});

test("buildReasonCodeTally: 会社別・headcount別・quarter別の内訳が総件数と整合する", () => {
  const run80 = loadedRun("r80", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const run85 = loadedRun("r85", 85, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85 }]);
  const tally = buildReasonCodeTally([run80, run85]);
  const raw = tally.find((t) => t.code === "RAW_MATERIAL_SHORTAGE" && t.source === "companyLab")!;
  assert.ok(raw, "RAW_MATERIAL_SHORTAGE (companyLab) should be present");
  // fixtureでは各turnに1件ずつ = run80(2turn) + run85(2turn) = 4件
  assert.equal(raw.totalOccurrences, 4);
  const headcountSum = Object.values(raw.headcountBreakdown).reduce((s, v) => s + v, 0);
  assert.equal(headcountSum, raw.totalOccurrences);
  const companySum = Object.values(raw.companyBreakdown).reduce((s, v) => s + v, 0);
  assert.equal(companySum, raw.totalOccurrences);
  const quarterSum = Object.values(raw.quarterBreakdown).reduce((s, v) => s + v, 0);
  assert.equal(quarterSum, raw.totalOccurrences);
});

test("buildHeadcountComparison: 85人だけdefaultするケースを機械的に検出する", () => {
  const run80 = loadedRun("r80", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const run85 = loadedRun("r85", 85, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85, defaultAtTurn: 1 }]);
  const run90 = loadedRun("r90", 90, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 90 }]);
  const runs = [run80, run85, run90];
  const comparison = validateComparableRuns(runs);
  const rows = buildHeadcountComparison(runs, comparison.commonSeeds, comparison.commonCompanyIds);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].middleHeadcountOnlyDefaultFlag, true);
  assert.equal(rows[0].paymentDefaultByHeadcount[85], true);
  assert.equal(rows[0].paymentDefaultByHeadcount[80], false);
  assert.equal(rows[0].paymentDefaultByHeadcount[90], false);
});

test("buildHeadcountComparison: 全headcountでdefaultしない場合はフラグがfalse", () => {
  const run80 = loadedRun("r80", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const run85 = loadedRun("r85", 85, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85 }]);
  const run90 = loadedRun("r90", 90, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 90 }]);
  const runs = [run80, run85, run90];
  const comparison = validateComparableRuns(runs);
  const rows = buildHeadcountComparison(runs, comparison.commonSeeds, comparison.commonCompanyIds);
  assert.equal(rows[0].middleHeadcountOnlyDefaultFlag, false);
});

test("buildHeadcountComparison: 単一runでは空配列を返す", () => {
  const run80 = loadedRun("r80", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const comparison = validateComparableRuns([run80]);
  const rows = buildHeadcountComparison([run80], comparison.commonSeeds, comparison.commonCompanyIds);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------
// SAI-3B-2で追加: buildQuarterPerformance拡張・buildMarketShare・buildHeadcountDivergence
// ---------------------------------------------------------------------

function makeQuarterSummaryRow(overrides: Partial<Sai3bQuarterSummaryRow> & Pick<Sai3bQuarterSummaryRow, "seed" | "companyId" | "turn">): Sai3bQuarterSummaryRow {
  return {
    period: `2015Q${overrides.turn}`,
    netRevenueUsd: 1_000_000,
    grossProfitUsd: 200_000,
    operatingProfitUsd: 100_000,
    netIncomeUsd: 80_000,
    closingCashUsd: 5_000_000,
    endingShortTermLoansUsd: 1_000_000,
    endingLongTermLoansUsd: 2_000_000,
    salesEffortCapacityHosoEqTonsActual: 4000,
    salesEffortUsedHosoEqTons: 3800,
    salesReductionFromEffortConstraintHosoEqTons: 200,
    rawMaterialInventoryHosoEqTons: 3000,
    finishedGoodsInventoryHosoEqTons: 500,
    discardQuantityHosoEqTons: 10,
    paymentDefault: false,
    paymentDefaultNewlyTriggered: false,
    underwritingFrozen: false,
    underwritingFrozenNewlyTriggered: false,
    warningCount: 0,
    ...overrides,
  };
}

function makeAllocationRow(overrides: Partial<Sai3bMarketAllocationTraceRow> & Pick<Sai3bMarketAllocationTraceRow, "seed" | "turn" | "market" | "product" | "companyId" | "allocatedQuantityHosoEqTons">): Sai3bMarketAllocationTraceRow {
  return {
    period: `2015Q${overrides.turn}`,
    targetDemandHosoEqTons: 1000,
    externalOptionQuantityHosoEqTons: 0,
    askPriceUsdPerHosoEqKg: 4.5,
    basePriceUsdPerHosoEqKg: 4.2,
    coverageScore: 70,
    competitivenessWeight: 1.0,
    ...overrides,
  };
}

function makeLoadedRun(overrides: Partial<LoadedSai3aRun> & Pick<LoadedSai3aRun, "runLabel">): LoadedSai3aRun {
  return {
    sourceDir: `/tmp/${overrides.runLabel}`,
    manifest: {
      schemaVersion: "1.0.0",
      runId: overrides.runLabel,
      scenarioId: "baseline",
      standardBaselineId: "moderate-pressure",
      seeds: ["s1"],
      quarters: 4,
      companyIds: ["BAL", "MASS"],
      aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
      salesForceHeadcountTotal: 80,
      keyParameters: {},
      outputFormats: ["json", "csv"],
    },
    caseSummaryRows: [],
    quarterSummaryRows: [],
    decisionTraceLines: [],
    adjustmentTraceRows: [],
    warningRows: [],
    marketAllocationTraceRows: [],
    runSummary: { runSummary: { runId: overrides.runLabel, totalCases: 0, completedCases: 0, errorCases: 0, paymentDefaultRate: 0, underwritingFrozenRate: 0, averageCumulativeRevenueUsd: 0, averageCumulativeGrossProfitUsd: 0, averageCumulativeOperatingProfitUsd: 0, averageFinalCashUsd: 0, topReasonCodeCounts: [], totalWarningCount: 0 }, errors: [] },
    loadWarnings: [],
    ...overrides,
  };
}

test("buildQuarterPerformance: market-allocation-trace由来のactualSalesQuantityHosoEqTonsは、finalPlannedSalesQuantityTotal（計画）とは別の値として、商品・市場を問わず会社単位で正しく合算される", () => {
  const run = makeLoadedRun({
    runLabel: "r1",
    quarterSummaryRows: [makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1 })],
    marketAllocationTraceRows: [
      makeAllocationRow({ seed: "s1", turn: 1, market: "CN", product: "hoso", companyId: "BAL", allocatedQuantityHosoEqTons: 900 }),
      makeAllocationRow({ seed: "s1", turn: 1, market: "US", product: "pd", companyId: "BAL", allocatedQuantityHosoEqTons: 300 }),
      makeAllocationRow({ seed: "s1", turn: 1, market: "CN", product: "hoso", companyId: "MASS", allocatedQuantityHosoEqTons: 500 }),
    ],
  });
  const rows = buildQuarterPerformance([run]);
  const balRow = rows.find((r) => r.companyId === "BAL")!;
  assert.equal(balRow.actualSalesQuantityHosoEqTons, 1200); // 900 + 300、MASSの分は含まない
});

test("buildMarketShare: 市場ごとの数量シェアが正しく計算され、同一run×seed×turn×市場内の全社シェア合計が1になる", () => {
  const run = makeLoadedRun({
    runLabel: "r1",
    quarterSummaryRows: [
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1 }),
      makeQuarterSummaryRow({ seed: "s1", companyId: "MASS", turn: 1 }),
    ],
    marketAllocationTraceRows: [
      makeAllocationRow({ seed: "s1", turn: 1, market: "CN", product: "hoso", companyId: "BAL", allocatedQuantityHosoEqTons: 300 }),
      makeAllocationRow({ seed: "s1", turn: 1, market: "CN", product: "pd", companyId: "BAL", allocatedQuantityHosoEqTons: 100 }),
      makeAllocationRow({ seed: "s1", turn: 1, market: "CN", product: "hoso", companyId: "MASS", allocatedQuantityHosoEqTons: 600 }),
    ],
  });
  const rows = buildMarketShare([run]);
  assert.equal(rows.length, 2); // BAL, MASS の2行（CN市場、turn=1）
  const balRow = rows.find((r) => r.companyId === "BAL")!;
  const massRow = rows.find((r) => r.companyId === "MASS")!;
  assert.equal(balRow.allocatedQuantityHosoEqTons, 400); // 300+100（商品を問わず合算）
  assert.equal(massRow.allocatedQuantityHosoEqTons, 600);
  assert.equal(balRow.totalAllocatedQuantityHosoEqTonsAcrossCompanies, 1000);
  assert.ok(Math.abs(balRow.quantityShare + massRow.quantityShare - 1) < 1e-9, "同一市場内の全社シェア合計は1になるはず");
  assert.equal(balRow.companyCountInMarket, 2);
});

test("buildMarketShare: market-allocation-trace.csvが空（古いrun）の場合は空配列を返す", () => {
  const run = makeLoadedRun({ runLabel: "r1", marketAllocationTraceRows: [] });
  assert.deepEqual(buildMarketShare([run]), []);
});

test("buildHeadcountDivergence: 乖離が発生したturnとKPIを機械的に検出する", () => {
  const run80 = makeLoadedRun({
    runLabel: "r80",
    manifest: {
      schemaVersion: "1.0.0",
      runId: "r80",
      scenarioId: "baseline",
      standardBaselineId: "moderate-pressure",
      seeds: ["s1"],
      quarters: 3,
      companyIds: ["BAL"],
      aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
      salesForceHeadcountTotal: 80,
      keyParameters: {},
      outputFormats: ["json", "csv"],
    },
    quarterSummaryRows: [
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1, netRevenueUsd: 1_000_000 }),
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 2, netRevenueUsd: 1_000_000 }),
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 3, netRevenueUsd: 1_000_000 }),
    ],
  });
  const run85 = makeLoadedRun({
    runLabel: "r85",
    manifest: {
      schemaVersion: "1.0.0",
      runId: "r85",
      scenarioId: "baseline",
      standardBaselineId: "moderate-pressure",
      seeds: ["s1"],
      quarters: 3,
      companyIds: ["BAL"],
      aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
      salesForceHeadcountTotal: 85,
      keyParameters: {},
      outputFormats: ["json", "csv"],
    },
    quarterSummaryRows: [
      // turn1は80人条件と同じ（乖離なし）。turn2から売上が大きく乖離する。
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1, netRevenueUsd: 1_000_000 }),
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 2, netRevenueUsd: 500_000 }),
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 3, netRevenueUsd: 400_000 }),
    ],
  });
  const runs = [run80, run85];
  const comparison = validateComparableRuns(runs);
  const quarterPerformance = buildQuarterPerformance(runs);
  const rows = buildHeadcountDivergence(runs, quarterPerformance, comparison.commonSeeds, comparison.commonCompanyIds);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstDivergingTurn, 2);
  assert.equal(rows[0].firstDivergingKpi, "netRevenueUsd");
});

test("buildCompanyQuarterStats: 複数seedの分布からaverage/median/min/maxが正しく計算され、defaultedSeedCountが正しい", () => {
  const run = makeLoadedRun({
    runLabel: "r1",
    quarterSummaryRows: [
      makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1, netRevenueUsd: 1_000_000, grossProfitUsd: 200_000 }),
      makeQuarterSummaryRow({ seed: "s2", companyId: "BAL", turn: 1, netRevenueUsd: 2_000_000, grossProfitUsd: 400_000 }),
      makeQuarterSummaryRow({ seed: "s3", companyId: "BAL", turn: 1, netRevenueUsd: 3_000_000, grossProfitUsd: 600_000, paymentDefault: true }),
    ],
  });
  const quarterPerformance = buildQuarterPerformance([run]);
  const rows = buildCompanyQuarterStats([run], quarterPerformance);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.seedCount, 3);
  assert.equal(row.defaultedSeedCount, 1);
  assert.equal(row.netRevenueUsd.average, 2_000_000);
  assert.equal(row.netRevenueUsd.median, 2_000_000);
  assert.equal(row.netRevenueUsd.min, 1_000_000);
  assert.equal(row.netRevenueUsd.max, 3_000_000);
  // grossMarginRateは各seedのgrossProfit/netRevenueが全て0.2なので、平均・中央値とも0.2。
  assert.ok(Math.abs(row.grossMarginRate.average! - 0.2) < 1e-9);
});

test("buildCompanyQuarterStats: 値が1件も無いKPI（market-allocation-trace無しのactualSalesQuantityHosoEqTons）はn=0でaverage等がundefined", () => {
  const run = makeLoadedRun({
    runLabel: "r1",
    quarterSummaryRows: [makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1 })],
    marketAllocationTraceRows: [],
  });
  const quarterPerformance = buildQuarterPerformance([run]);
  const rows = buildCompanyQuarterStats([run], quarterPerformance);
  assert.equal(rows[0].actualSalesQuantityHosoEqTons.n, 0);
  assert.equal(rows[0].actualSalesQuantityHosoEqTons.average, undefined);
});

test("buildHeadcountDivergence: 全turnで乖離が閾値を超えない場合はfirstDivergingTurnがundefined", () => {
  const makeRun = (runLabel: string, headcount: number) =>
    makeLoadedRun({
      runLabel,
      manifest: {
        schemaVersion: "1.0.0",
        runId: runLabel,
        scenarioId: "baseline",
        standardBaselineId: "moderate-pressure",
        seeds: ["s1"],
        quarters: 2,
        companyIds: ["BAL"],
        aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
        salesForceHeadcountTotal: headcount,
        keyParameters: {},
        outputFormats: ["json", "csv"],
      },
      quarterSummaryRows: [
        makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 1, netRevenueUsd: 1_000_000 }),
        makeQuarterSummaryRow({ seed: "s1", companyId: "BAL", turn: 2, netRevenueUsd: 1_010_000 }),
      ],
    });
  const runs = [makeRun("r80", 80), makeRun("r85", 85)];
  const comparison = validateComparableRuns(runs);
  const quarterPerformance = buildQuarterPerformance(runs);
  const rows = buildHeadcountDivergence(runs, quarterPerformance, comparison.commonSeeds, comparison.commonCompanyIds);
  assert.equal(rows[0].firstDivergingTurn, undefined);
  assert.equal(rows[0].firstDivergingKpi, undefined);
});
