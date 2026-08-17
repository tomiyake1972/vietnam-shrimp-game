// ShrimpX V2 — EVAL-1: 任意Turn評価サービス ユニット・統合テスト（実装指示§30）

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../../types";
import { computeAllCompaniesEvaluationSnapshot, computeCompanyEvaluationSnapshot, computeCompanyKpiSnapshot } from "../evaluationSemantics";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "eval-semantics-001", turns: 4, ...overrides };
}

function stepOnce(state: CompanyLabState, fixtures: readonly CompanyFixture[]): CompanyLabState {
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  }
  return advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
}

test("EVAL-1: 履歴が空ならKPIスナップショットは例外を投げず、null/0で返る", () => {
  const { fixtures } = initializeCompanyLab(baseConfig());
  const snapshot = computeCompanyKpiSnapshot([], fixtures[0].companyId, 1);
  assert.equal(snapshot.firstRecordedTurn, null);
  assert.equal(snapshot.lastRecordedTurn, null);
  assert.equal(snapshot.cumulativeOperatingProfitUsd, 0);
  assert.equal(snapshot.cumulativeRevenueUsd, 0);
  assert.equal(snapshot.averageOperatingMarginRatio, null);
  assert.equal(snapshot.endingCashUsd, null);
  assert.equal(snapshot.distressTurnCount, 0);
  assert.equal(snapshot.cumulativeDividendUsd, 0);
});

test("EVAL-1: asOfTurnは指定Turn以下だけを集計する（未来のTurnを混ぜない）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures);
  const state2 = stepOnce(state1, fixtures);

  const asOf1 = computeCompanyKpiSnapshot(state2.history, targetCompanyId, 1);
  const asOf2 = computeCompanyKpiSnapshot(state2.history, targetCompanyId, 2);

  assert.equal(asOf1.lastRecordedTurn, 1);
  assert.equal(asOf2.lastRecordedTurn, 2);
  const turn1Financial = state2.history[0].financialResults.find((f) => f.companyId === targetCompanyId)!;
  const turn2Financial = state2.history[1].financialResults.find((f) => f.companyId === targetCompanyId)!;
  assert.equal(asOf1.cumulativeRevenueUsd, Number(turn1Financial.profitAndLoss.netRevenue));
  assert.equal(
    asOf2.cumulativeRevenueUsd,
    Number(turn1Financial.profitAndLoss.netRevenue) + Number(turn2Financial.profitAndLoss.netRevenue)
  );
});

test("EVAL-1（§13）: 同じTurnの評価は、その後さらにTurnが進んでも変化しない（早期終了と最後まで進めた場合で同じ評価になる）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;

  // シナリオA: turn2までしか進めない（Turn2で早期終了した想定）。
  const shortState1 = stepOnce(state0, fixtures);
  const shortState2 = stepOnce(shortState1, fixtures);
  const evaluationAtEarlyStop = computeCompanyEvaluationSnapshot(shortState2.history, targetCompanyId, 2);

  // シナリオB: 同じseedでturn4まで進める（Turn32相当の最後まで進めた想定）。
  const longState1 = stepOnce(state0, fixtures);
  const longState2 = stepOnce(longState1, fixtures);
  const longState3 = stepOnce(longState2, fixtures);
  const longState4 = stepOnce(longState3, fixtures);
  const evaluationAtTurn2WithinLongerRun = computeCompanyEvaluationSnapshot(longState4.history, targetCompanyId, 2);

  assert.deepEqual(evaluationAtEarlyStop, evaluationAtTurn2WithinLongerRun, "Turn2時点の評価は、Runがその後何Turn続いたかに関わらず同一であるべき（同じ評価システムであることの核心）");
});

test("EVAL-1（§15/§16/§17）: Current/Total Shareholder Valueは常に暫定プレースホルダーであり、ランキングに使える実数を返さない", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures);

  const snapshot = computeCompanyEvaluationSnapshot(state1.history, targetCompanyId, 1);
  assert.equal(snapshot.currentShareholderValueUsd, null);
  assert.equal(snapshot.shareholderValueModelVersion, "pending-v1");
  assert.equal(snapshot.totalShareholderValueUsd, null);
  assert.equal(snapshot.totalShareholderValueStatus, "not_finalized");
});

test("EVAL-1: weightedCumulativeDividendValueUsdは、finance/dividend.tsが確定済みのCompanyQuarterRecord.dividendResultsの値をそのまま読む（再計算しない）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures);
  const state2 = stepOnce(state1, fixtures);

  const snapshot = computeCompanyEvaluationSnapshot(state2.history, targetCompanyId, 2);
  const dividendEntry = state2.history[1].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.ok(dividendEntry);
  assert.equal(snapshot.weightedCumulativeDividendValueUsd, dividendEntry?.cumulativeWeightedDividendValueUsd);
  assert.equal(snapshot.kpis.cumulativeDividendUsd, dividendEntry?.cumulativeDividendUsd);
});

test("EVAL-1: computeAllCompaniesEvaluationSnapshotは、渡した全会社ぶんのスナップショットを返す", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const state1 = stepOnce(state0, fixtures);
  const companyIds = fixtures.map((f) => f.companyId);

  const snapshots = computeAllCompaniesEvaluationSnapshot(state1.history, companyIds, 1);
  assert.equal(snapshots.length, companyIds.length);
  for (const companyId of companyIds) {
    assert.ok(snapshots.some((s) => s.companyId === companyId));
  }
});

test("EVAL-1: distressTurnCountはfinancialHealth.primaryが\"healthy\"以外だったTurn数を数える（新しいCrisis状態を導入しない）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures);

  const snapshot = computeCompanyKpiSnapshot(state1.history, targetCompanyId, 1);
  const financingEntry = state1.history[0].financingResults.find((f) => f.companyId === targetCompanyId)!;
  const expectedDistressCount = financingEntry.financialHealth.primary === "healthy" ? 0 : 1;
  assert.equal(snapshot.distressTurnCount, expectedDistressCount);
});
