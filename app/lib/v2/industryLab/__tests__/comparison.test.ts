import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../simulationRunner";
import { compareIndustrySimulations } from "../ui/comparison";
import { IndustrySimulationConfig } from "../types";

function configFor(scenarioId: string, overrides?: Partial<IndustrySimulationConfig>): IndustrySimulationConfig {
  return { scenarioId, mode: "canonical", seed: "compare-seed", turns: 32, ...overrides };
}

test("同じシナリオ・同じシードで比較すると全項目の差分がゼロになる", () => {
  const resultA = runIndustrySimulation(configFor("baseline-v0.1"));
  const resultB = runIndustrySimulation(configFor("baseline-v0.1"));
  const comparison = compareIndustrySimulations(resultA, resultB);

  for (const q of comparison.quarters) {
    assert.equal(q.vietnamDomesticPriceDiff, 0);
    assert.equal(q.worldSupplyDiff, 0);
    assert.equal(q.worldDemandDiff, 0);
    assert.equal(q.pdPremiumDiff, 0);
    assert.equal(q.vapPremiumDiff, 0);
    for (const diff of Object.values(q.hosoPriceDiff)) {
      assert.equal(diff, 0);
    }
  }
  assert.deepEqual(comparison.eventDiff.onlyInA, []);
  assert.deepEqual(comparison.eventDiff.onlyInB, []);
});

test("異なるシナリオを比較すると、差分がゼロでない四半期が存在する", () => {
  const resultA = runIndustrySimulation(configFor("baseline-v0.1"));
  const resultB = runIndustrySimulation(configFor("global-demand-boom-v0.1"));
  const comparison = compareIndustrySimulations(resultA, resultB);

  const anyNonZero = comparison.quarters.some(
    (q) => q.worldDemandDiff !== 0 || Object.values(q.hosoPriceDiff).some((d) => d !== 0)
  );
  assert.ok(anyNonZero);
});

test("エクアドル早期増産と遅延増産は、シミュレーション期間内でエクアドルの供給軌道が異なる", () => {
  const early = runIndustrySimulation(configFor("ecuador-early-expansion-v0.1"));
  const delayed = runIndustrySimulation(configFor("ecuador-delayed-expansion-v0.1"));

  // 中盤（turn=16程度）では、早期増産の方がエクアドルの輸出可能供給量が大きいはず
  // （早期増産は序盤から段階的に稼働率を引き上げるのに対し、遅延増産はturn24頃まで抑制される）。
  const earlyMid = early.quarters[15].marketResult.hosoPrices.EC.exportableSupply;
  const delayedMid = delayed.quarters[15].marketResult.hosoPrices.EC.exportableSupply;
  assert.notEqual(earlyMid, delayedMid);
});

test("比較結果はイベントの真実（hiddenDescription等）は含むが、情報公開レベルによる非公開情報の混入はない（比較結果に情報リリースを一切含まない）", () => {
  const resultA = runIndustrySimulation(configFor("global-disease-crisis-v0.1"));
  const resultB = runIndustrySimulation(configFor("baseline-v0.1"));
  const comparison = compareIndustrySimulations(resultA, resultB);

  const serialized = JSON.stringify(comparison);
  // ScenarioComparisonResultの型にはInformationRelease系フィールドが一切存在しない。
  assert.ok(!serialized.includes("informationId"));
  assert.ok(!serialized.includes("postGameTruth"));
});

test("ターン数が異なる2つの結果は比較できず例外を投げる", () => {
  const resultA = runIndustrySimulation(configFor("baseline-v0.1", { turns: 20 }));
  const resultB = runIndustrySimulation(configFor("baseline-v0.1", { turns: 24 }));
  assert.throws(() => compareIndustrySimulations(resultA, resultB));
});
