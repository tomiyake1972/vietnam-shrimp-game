// ShrimpX V2 — Phase SAI-3B-1: buildAnalysis.ts の結合テスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSai3aRun } from "../loadRun";
import { buildSai3bAnalysis } from "../buildAnalysis";
import { buildFixtureRunFiles } from "./testFixtures";

function loadedRun(runId: string, headcount: number, cases: Parameters<typeof buildFixtureRunFiles>[0]["cases"]) {
  const files = buildFixtureRunFiles({ runId, headcount, quarters: 2, cases });
  return loadSai3aRun({ runLabel: runId, sourceDir: `/tmp/${runId}`, files });
}

test("buildSai3bAnalysis: 単一runからすべてのシート用データを組み立てる", () => {
  const run = loadedRun("r1", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const analysis = buildSai3bAnalysis([run], { generatedAtIso: "2026-01-01T00:00:00.000Z" });

  assert.equal(analysis.sai3bVersion, "1.0.0");
  assert.equal(analysis.loadedRuns.length, 1);
  assert.equal(analysis.comparison.comparable, true);
  assert.equal(analysis.dashboard.length, 1);
  assert.equal(analysis.companyPerformance.length, 1);
  assert.equal(analysis.quarterPerformance.length, 2);
  assert.equal(analysis.salesAnalysis.length, 2);
  assert.equal(analysis.procurementProduction.length, 2);
  assert.equal(analysis.salesCapacity.length, 2);
  assert.ok(analysis.salesCapacityMarketBreakdown.length >= 2);
  assert.ok(analysis.adjustmentAnalysis.length > 0);
  assert.ok(analysis.reasonCodeTally.length > 0);
  assert.equal(analysis.headcountComparison.length, 0); // 単一runのため空
  assert.ok(analysis.decisionTrace.length > 0);
  assert.ok(analysis.missingFieldReports.length > 0);
});

test("buildSai3bAnalysis: 複数run（headcount比較）から比較シート用データも組み立てる", () => {
  const run80 = loadedRun("r80", 80, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }]);
  const run85 = loadedRun("r85", 85, [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85, defaultAtTurn: 1 }]);
  const analysis = buildSai3bAnalysis([run80, run85], { generatedAtIso: "2026-01-01T00:00:00.000Z" });

  assert.equal(analysis.dashboard.length, 2);
  assert.equal(analysis.headcountComparison.length, 1);
  assert.equal(analysis.headcountComparison[0].paymentDefaultByHeadcount[85], true);
});

test("buildSai3bAnalysis: 生成日時・バージョンがオプション経由でそのまま反映される（Date.now非依存）", () => {
  const run = loadedRun("r1", 80, [{ seed: "s1", companyId: "BAL", quarters: 1, headcount: 80 }]);
  const analysis = buildSai3bAnalysis([run], { generatedAtIso: "2099-12-31T23:59:59.000Z" });
  assert.equal(analysis.generatedAtIso, "2099-12-31T23:59:59.000Z");
});
