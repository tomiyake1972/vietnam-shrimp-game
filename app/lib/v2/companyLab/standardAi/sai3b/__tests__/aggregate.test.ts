// ShrimpX V2 — Phase SAI-3B-1: aggregate.ts のユニットテスト
//
// 集計値が元ログ（フィクスチャ）から再計算した値と一致することを検証する
// （三宅さんの指示§9「集計値が元ログから再計算した値と一致する」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSai3aRun } from "../loadRun";
import {
  buildCompanyPerformance,
  buildDashboardSummary,
  buildHeadcountComparison,
  buildReasonCodeTally,
  buildSalesAnalysis,
} from "../aggregate";
import { validateComparableRuns } from "../compareRuns";
import { buildFixtureRunFiles } from "./testFixtures";

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
