// ShrimpX V2 — 配当（Dividend）モジュール ユニットテスト（Phase DIV-1・実装指示§28）
//
// finance/dividend.tsの純粋関数（maxDividend算定・validation・BS反映・
// time-weighted score・履歴構築）を確認する。runner.ts経由の統合テストは
// companyLab/__tests__/dividendIntegration.test.tsで行う。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDividendToFinanceState,
  buildDividendQuarterResult,
  computeMaxDividendUsd,
  computeWeightedDividendValueUsd,
  DividendValidationError,
  getDividendTimeWeight,
  resolveDividendDecision,
} from "../dividend";
import { CompanyFinanceState, usd } from "../types";

function financeState(overrides: Partial<CompanyFinanceState> = {}): CompanyFinanceState {
  return {
    companyId: "TEST",
    cash: usd(10_000_000),
    receivables: [],
    payables: [],
    otherCurrentAssets: usd(0),
    fixedAssetsGross: usd(40_000_000),
    accumulatedDepreciation: usd(0),
    shortTermLoans: usd(0),
    longTermLoans: usd(0),
    otherLiabilities: usd(0),
    capitalStock: usd(30_000_000),
    // 会社ごとに大きい初期残差（例: 20M）を持ちうる想定。分配可能額計算には使わない。
    retainedEarnings: usd(20_000_000),
    distributableEarnings: usd(2_000_000),
    finishedGoodsCostLedger: [],
    ...overrides,
  };
}

test("DIV-1: dividend 0 — 未指定は配当なし・却下されない", () => {
  const state = financeState();
  const resolution = resolveDividendDecision(undefined, state);
  assert.equal(resolution.appliedUsd, 0);
  assert.equal(resolution.rejected, false);
  assert.equal(resolution.rejectionReason, null);

  const resolutionZero = resolveDividendDecision({ dividendAmountUsd: 0 }, state);
  assert.equal(resolutionZero.appliedUsd, 0);
  assert.equal(resolutionZero.rejected, false);
});

test("DIV-1: valid dividend — cash・distributableEarnings以内の要求は全額適用される", () => {
  const state = financeState({ cash: usd(10_000_000), distributableEarnings: usd(2_000_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 1_500_000 }, state);
  assert.equal(resolution.appliedUsd, 1_500_000);
  assert.equal(resolution.rejected, false);
  assert.equal(resolution.maxDividendUsd, 2_000_000);
});

test("DIV-1: Cash reduction — 配当実行後、CashがappliedUsdぶんだけ減る", () => {
  const state = financeState({ cash: usd(10_000_000) });
  const next = applyDividendToFinanceState(state, 1_500_000);
  assert.equal(next.cash as unknown as number, 8_500_000);
});

test("DIV-1: Retained Earnings reduction — 配当実行後、retainedEarningsも同額減る", () => {
  const state = financeState({ retainedEarnings: usd(20_000_000) });
  const next = applyDividendToFinanceState(state, 1_500_000);
  assert.equal(next.retainedEarnings as unknown as number, 18_500_000);
});

test("DIV-1: distributableEarnings reduction — 配当実行後、distributableEarningsも同額減る", () => {
  const state = financeState({ distributableEarnings: usd(2_000_000) });
  const next = applyDividendToFinanceState(state, 1_500_000);
  assert.equal(next.distributableEarnings as unknown as number, 500_000);
});

test("DIV-1: P&L unaffected — applyDividendToFinanceStateはcash/retainedEarnings/distributableEarnings以外のフィールドを一切変更しない", () => {
  const state = financeState({
    shortTermLoans: usd(3_000_000),
    longTermLoans: usd(4_000_000),
    capitalStock: usd(30_000_000),
    otherCurrentAssets: usd(500_000),
    fixedAssetsGross: usd(40_000_000),
  });
  const next = applyDividendToFinanceState(state, 1_000_000);
  assert.equal(next.shortTermLoans, state.shortTermLoans, "Debtは自動増加させない（変更されない）");
  assert.equal(next.longTermLoans, state.longTermLoans);
  assert.equal(next.capitalStock, state.capitalStock);
  assert.equal(next.otherCurrentAssets, state.otherCurrentAssets);
  assert.equal(next.fixedAssetsGross, state.fixedAssetsGross);
});

test("DIV-1: dividend > Cash rejected — 全額拒否（部分執行しない）", () => {
  const state = financeState({ cash: usd(1_000_000), distributableEarnings: usd(5_000_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 2_000_000 }, state);
  assert.equal(resolution.rejected, true);
  assert.equal(resolution.appliedUsd, 0);
  assert.ok(resolution.rejectionReason?.includes("現金"));
});

test("DIV-1: dividend > distributable earnings rejected — Cashは足りていても分配可能利益超過は拒否される", () => {
  const state = financeState({ cash: usd(10_000_000), distributableEarnings: usd(500_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 1_000_000 }, state);
  assert.equal(resolution.rejected, true);
  assert.equal(resolution.appliedUsd, 0);
  assert.ok(resolution.rejectionReason?.includes("分配可能利益"));
});

test("DIV-1: 負の配当額は構造的な誤用としてDividendValidationErrorを投げる", () => {
  const state = financeState();
  assert.throws(() => resolveDividendDecision({ dividendAmountUsd: -100 }, state), DividendValidationError);
});

test("DIV-1: maxDividend = min(cash, distributableEarnings)", () => {
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(1_000_000), distributableEarnings: usd(5_000_000) })), 1_000_000);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(5_000_000), distributableEarnings: usd(1_000_000) })), 1_000_000);
  assert.equal(computeMaxDividendUsd(financeState({ cash: usd(-500_000), distributableEarnings: usd(1_000_000) })), 0, "cashが負ならmaxDividendは0（負の配当上限にはならない）");
});

test("DIV-1: initial retained earnings（初期残差20M）はdistributableEarnings（2M）を超えて配当できない", () => {
  // 初期BS上のretainedEarnings(20M)全額を配当可能としてしまうと、game-start直後に
  // 初期設定由来の利益剰余金まで即時大量配当できてしまう（実装指示§6が禁止する挙動）。
  // maxDividendはretainedEarningsではなくdistributableEarningsだけを基準にする。
  const state = financeState({ retainedEarnings: usd(20_000_000), distributableEarnings: usd(2_000_000), cash: usd(50_000_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 20_000_000 }, state);
  assert.equal(resolution.rejected, true, "retainedEarnings全額(20M)の要求はdistributableEarnings(2M)を超えるため拒否されるはず");
  assert.equal(resolution.maxDividendUsd, 2_000_000);
});

test("DIV-1: time-weight — 32Turnの段階方式（T1-8=1.5/T9-16=1.3/T17-24=1.15/T25-32=1.0）", () => {
  assert.equal(getDividendTimeWeight(1), 1.5);
  assert.equal(getDividendTimeWeight(8), 1.5);
  assert.equal(getDividendTimeWeight(9), 1.3);
  assert.equal(getDividendTimeWeight(16), 1.3);
  assert.equal(getDividendTimeWeight(17), 1.15);
  assert.equal(getDividendTimeWeight(24), 1.15);
  assert.equal(getDividendTimeWeight(25), 1.0);
  assert.equal(getDividendTimeWeight(32), 1.0);
});

test("DIV-1: time-weight — scenarioLengthへ比例スケールする（32固定にしない）", () => {
  // 16Turnシナリオでは、8/32=0.25の境界が4/16=0.25に相当するはず。
  assert.equal(getDividendTimeWeight(4, 16), 1.5);
  assert.equal(getDividendTimeWeight(5, 16), 1.3);
  assert.equal(getDividendTimeWeight(8, 16), 1.3);
  assert.equal(getDividendTimeWeight(9, 16), 1.15);
  assert.equal(getDividendTimeWeight(13, 16), 1.0);
  assert.equal(getDividendTimeWeight(16, 16), 1.0);
});

test("DIV-1: weighted dividend value = dividendAmount × timeWeight(turn)", () => {
  assert.equal(computeWeightedDividendValueUsd(1_000_000, 1), 1_500_000);
  assert.equal(computeWeightedDividendValueUsd(1_000_000, 32), 1_000_000);
  assert.equal(computeWeightedDividendValueUsd(0, 1), 0);
});

test("DIV-1: cumulative dividend / cumulative weighted value — buildDividendQuarterResultが過去累積へ加算する", () => {
  const state = financeState({ cash: usd(10_000_000), distributableEarnings: usd(5_000_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 1_000_000 }, state);
  const result = buildDividendQuarterResult({
    companyId: "TEST",
    period: "2015Q3" as never,
    turn: 9,
    resolution,
    priorCumulativeDividendUsd: 2_000_000,
    priorCumulativeWeightedDividendValueUsd: 3_000_000,
    distributableEarningsAfterUsd: 4_000_000,
    cashAfterUsd: 9_000_000,
  });
  assert.equal(result.appliedDividendUsd, 1_000_000);
  assert.equal(result.cumulativeDividendUsd, 3_000_000, "2,000,000 + 1,000,000");
  assert.equal(result.timeWeight, 1.3, "turn9はT9-16帯");
  assert.equal(result.weightedDividendValueUsd, 1_300_000);
  assert.equal(result.cumulativeWeightedDividendValueUsd, 4_300_000, "3,000,000 + 1,300,000");
  assert.equal(result.distributableEarningsAfterUsd, 4_000_000);
  assert.equal(result.cashAfterUsd, 9_000_000);
});

test("DIV-1: history record — rejected時もappliedDividendUsd=0・累積は変化しない", () => {
  const state = financeState({ cash: usd(500_000), distributableEarnings: usd(5_000_000) });
  const resolution = resolveDividendDecision({ dividendAmountUsd: 1_000_000 }, state);
  const result = buildDividendQuarterResult({
    companyId: "TEST",
    period: "2015Q1" as never,
    turn: 1,
    resolution,
    priorCumulativeDividendUsd: 0,
    priorCumulativeWeightedDividendValueUsd: 0,
    distributableEarningsAfterUsd: 5_000_000,
    cashAfterUsd: 500_000,
  });
  assert.equal(result.rejected, true);
  assert.equal(result.appliedDividendUsd, 0);
  assert.equal(result.cumulativeDividendUsd, 0);
  assert.equal(result.cumulativeWeightedDividendValueUsd, 0);
});
