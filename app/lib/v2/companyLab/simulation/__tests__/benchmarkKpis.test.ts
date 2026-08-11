// ShrimpX V2 — Strategic Posture Phase H: benchmarkKpis.ts の純粋関数テスト。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sumSeries,
  minimumOf,
  maximumOf,
  averageOf,
  postFactoryUtilization,
  strategicLeadTurns,
  pairRuns,
  classifyOutcome,
  RunRow,
} from "../benchmarkKpis";

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    scenario: "baseline",
    seed: "management-console-32q",
    company: "BAL",
    profile: "AGGRESSIVE_EARLY_CAPACITY",
    firstFactoryProposalTurn: 25,
    decisionRoute: "STRATEGIC_FORWARD_CAPACITY",
    factoryCompletionTurn: 29,
    cumulativeOperatingProfitUsd: 100_000_000,
    minimumCashUsd: 10_000_000,
    peakDebtUsd: 20_000_000,
    averageUtilization: 0.8,
    contractsQ32: 30_000,
    productionQ32: 29_000,
    maxFinishedGoodsTons: 2_000,
    maxBacklogTons: 1_000,
    distressQuarters: 0,
    ...overrides,
  };
}

test("BENCH-H1: pairingは同一scenario/seed/companyのAGGRESSIVEとDEMAND_CONFIRMEDだけを組む", () => {
  const rows = [
    row({ profile: "AGGRESSIVE_EARLY_CAPACITY" }),
    row({ profile: "DEMAND_CONFIRMED", firstFactoryProposalTurn: 30 }),
    row({ scenario: "global-demand-boom", profile: "AGGRESSIVE_EARLY_CAPACITY" }),
    // 片方しか無い組み合わせ（ペアにならないはず）
    row({ company: "MASS", profile: "AGGRESSIVE_EARLY_CAPACITY" }),
  ];
  const pairs = pairRuns(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].scenario, "baseline");
  assert.equal(pairs[0].company, "BAL");
  assert.equal(pairs[0].aggressive.profile, "AGGRESSIVE_EARLY_CAPACITY");
  assert.equal(pairs[0].demandConfirmed.profile, "DEMAND_CONFIRMED");
});

test("BENCH-H2: cumulativeOP計算はturn値の単純合計", () => {
  const series = [
    { turn: 1, value: 100 },
    { turn: 2, value: -50 },
    { turn: 3, value: 200 },
  ];
  assert.equal(sumSeries(series), 250);
  assert.equal(sumSeries([]), 0);
});

test("BENCH-H3: minCashは最小値とそのturnを返し、空配列はnull", () => {
  const series = [
    { turn: 1, value: 500 },
    { turn: 2, value: 100 },
    { turn: 3, value: 300 },
  ];
  const min = minimumOf(series);
  assert.deepEqual(min, { turn: 2, value: 100 });
  assert.equal(minimumOf([]), null);
});

test("BENCH-H4: peakDebtは最大値とそのturnを返す", () => {
  const series = [
    { turn: 1, value: 1000 },
    { turn: 2, value: 5000 },
    { turn: 3, value: 3000 },
  ];
  const max = maximumOf(series);
  assert.deepEqual(max, { turn: 2, value: 5000 });
  assert.equal(averageOf(series), (1000 + 5000 + 3000) / 3);
  assert.equal(averageOf([]), null);
});

test("BENCH-H5: post-factory utilizationはcompletionTurn+1/+2/+4を系列から拾う", () => {
  const series = [
    { turn: 29, value: 0.6 },
    { turn: 30, value: 0.35 },
    { turn: 31, value: 0.5 },
    // turn 33（=29+4）は意図的に系列へ含めない（32Qを超えて実在しないケースを再現）。
  ];
  const u = postFactoryUtilization(series, 29);
  assert.equal(u.q1, 0.35);
  assert.equal(u.q2, 0.5);
  assert.equal(u.q4, null, "turn33は系列に無いので拾えない（32Qの範囲外を捏造しない）");
  assert.deepEqual(postFactoryUtilization(series, null), { q1: null, q2: null, q4: null });
});

test("BENCH-H7: strategicLeadTurnsはDEMAND_CONFIRMEDのproposal turn - AGGRESSIVEのproposal turn", () => {
  assert.equal(strategicLeadTurns(25, 30), 5);
  assert.equal(strategicLeadTurns(25, null), null, "DEMAND_CONFIRMEDが32Q以内に一度も提案しなければnull");
  assert.equal(strategicLeadTurns(null, 30), null);
});

test("BENCH-H6a: classifyOutcomeはAGGRESSIVE優位なら ADVANTAGE を返す", () => {
  const pairs = pairRuns([
    row({ profile: "AGGRESSIVE_EARLY_CAPACITY", cumulativeOperatingProfitUsd: 120_000_000, contractsQ32: 32_000, productionQ32: 31_000 }),
    row({ profile: "DEMAND_CONFIRMED", cumulativeOperatingProfitUsd: 100_000_000, contractsQ32: 28_000, productionQ32: 27_000, firstFactoryProposalTurn: 30 }),
  ]);
  assert.equal(classifyOutcome(pairs[0]), "AGGRESSIVE_ADVANTAGE");
});

test("BENCH-H6b: classifyOutcomeは差が小さければ NO_MEANINGFUL_DIFFERENCE を返す", () => {
  const pairs = pairRuns([
    row({ profile: "AGGRESSIVE_EARLY_CAPACITY" }),
    row({ profile: "DEMAND_CONFIRMED", firstFactoryProposalTurn: 26 }), // ほぼ同じKPI
  ]);
  assert.equal(classifyOutcome(pairs[0]), "NO_MEANINGFUL_DIFFERENCE");
});

test("BENCH-H6c: classifyOutcomeは数量↑だがCash/Debt悪化なら MIXED を返しうる", () => {
  const pairs = pairRuns([
    row({
      profile: "AGGRESSIVE_EARLY_CAPACITY",
      cumulativeOperatingProfitUsd: 108_000_000,
      contractsQ32: 34_500,
      minimumCashUsd: 5_000_000,
      peakDebtUsd: 28_000_000,
    }),
    row({
      profile: "DEMAND_CONFIRMED",
      cumulativeOperatingProfitUsd: 100_000_000,
      contractsQ32: 30_000,
      minimumCashUsd: 10_000_000,
      peakDebtUsd: 20_000_000,
      firstFactoryProposalTurn: 30,
    }),
  ]);
  assert.equal(classifyOutcome(pairs[0]), "MIXED");
});
