// ShrimpX V2 — Phase SAI-3A: バッチ実行（runAutoplayBatch）のテスト
//
// 三宅さんの指示§10「1件のケースが失敗しても、残りのケースの実行を継続する」を
// 直接確認する。1 seedぶんの実行に使うcandidate.buildFixtureTemplateを、
// 2回目の呼び出し（=2番目のseed）だけ例外を投げるテストダブルに差し替え、
// 残りのseedが正常に完了し、失敗したseedはCaseErrorとして記録されることを
// 検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayBatch, buildRunSummary } from "../runBatch";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

test("runAutoplayBatch: 1件のseedの実行が例外を投げても、残りのseedの実行を継続し、失敗はCaseErrorとして記録される", () => {
  let callCount = 0;
  const flakyCandidate = {
    ...candidate,
    buildFixtureTemplate: (period: Parameters<typeof candidate.buildFixtureTemplate>[0]) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("意図的なテスト用の失敗（2番目のseedのみ）");
      }
      return candidate.buildFixtureTemplate(period);
    },
  };

  const seeds = ["sai3a-batch-a", "sai3a-batch-b", "sai3a-batch-c"];
  const result = runAutoplayBatch({
    runId: "sai3a-test-batch-isolation",
    scenarioId: "baseline",
    seeds,
    quarters: 2,
    companyIds: ["BAL"],
    candidate: flakyCandidate,
  });

  assert.equal(callCount, 3, "3件のseedすべてでbuildFixtureTemplateが呼ばれているべき");
  assert.equal(result.caseLogs.length, 2, "失敗した1件を除く2件のログが残るべき");
  assert.equal(result.errors.length, 1, "失敗した1件がCaseErrorとして記録されるべき");
  assert.equal(result.errors[0].seed, "sai3a-batch-b");
  assert.match(result.errors[0].errorMessage, /意図的なテスト用の失敗/);

  const succeededSeeds = result.caseLogs.map((l) => l.seed).sort();
  assert.deepEqual(succeededSeeds, ["sai3a-batch-a", "sai3a-batch-c"]);

  assert.equal(result.runSummary.totalCases, seeds.length * 1);
  assert.equal(result.runSummary.completedCases, 2);
  assert.equal(result.runSummary.errorCases, 1);
});

test("runAutoplayBatch: 全seedが正常に完了する場合、completedCases===totalCasesかつerrorCases===0", () => {
  const result = runAutoplayBatch({
    runId: "sai3a-test-batch-all-ok",
    scenarioId: "baseline",
    seeds: ["sai3a-batch-ok-1", "sai3a-batch-ok-2"],
    quarters: 2,
    companyIds: ["BAL", "MASS"],
    candidate,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.caseLogs.length, 2);
  assert.equal(result.runSummary.totalCases, 4);
  assert.equal(result.runSummary.completedCases, 4);
  assert.equal(result.runSummary.errorCases, 0);
});

test("buildRunSummary: paymentDefaultRate/underwritingFrozenRateはcompletedCasesに対する割合として計算される", () => {
  const result = runAutoplayBatch({
    runId: "sai3a-test-run-summary",
    scenarioId: "baseline",
    seeds: ["sai3a-summary-1"],
    quarters: 8,
    companyIds: ALL_COMPANY_IDS,
    candidate,
  });
  const rows = result.caseLogs.flatMap((l) => l.caseSummaryRows);
  const expectedDefaultRate = rows.filter((r) => r.paymentDefaultEverByRequestedTurns).length / rows.length;
  assert.ok(Math.abs(result.runSummary.paymentDefaultRate - expectedDefaultRate) < 1e-9);
  const summaryFromScratch = buildRunSummary(result.runId, result.caseLogs, result.errors, rows.length);
  assert.deepEqual(summaryFromScratch, result.runSummary);
});
