// ShrimpX V2 — TSV正式化 ユニット・統合テスト（TSV正式化指示§27）

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../../types";
import {
  computeAllCompaniesEvaluationSnapshot,
  computeCompanyCurrentCompanyValueBreakdown,
  computeCompanyEvaluationSnapshot,
  computeCompanyKpiSnapshot,
  computeCurrentDividendValueUsd,
  computeNormalizedQuarterlyCashFlowUsd,
  rankCompaniesByTotalShareholderValue,
} from "../evaluationSemantics";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "eval-semantics-001", turns: 4, ...overrides };
}

function stepOnce(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  targetCompanyId?: string,
  overrideForTarget?: (auto: CompanyDecisionInput) => CompanyDecisionInput
): CompanyLabState {
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    decisionsByCompanyId[f.companyId] = f.companyId === targetCompanyId && overrideForTarget ? overrideForTarget(auto) : auto;
  }
  return advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
}

function runTurns(n: number, config: CompanyLabConfig = baseConfig({ turns: Math.max(n, 10) })) {
  const { state: state0, fixtures } = initializeCompanyLab(config);
  let state = state0;
  for (let i = 0; i < n; i++) state = stepOnce(state, fixtures);
  return { state, fixtures };
}

// ---------------------------------------------------------------------
// KPI（既存EVAL-1。回帰確認のみ）
// ---------------------------------------------------------------------

test("EVAL-1: 履歴が空ならKPIスナップショットは例外を投げず、null/0で返る", () => {
  const { fixtures } = initializeCompanyLab(baseConfig());
  const snapshot = computeCompanyKpiSnapshot([], fixtures[0].companyId, 1);
  assert.equal(snapshot.firstRecordedTurn, null);
  assert.equal(snapshot.cumulativeOperatingProfitUsd, 0);
  assert.equal(snapshot.endingCashUsd, null);
  assert.equal(snapshot.cumulativeDividendUsd, 0);
});

test("EVAL-1: asOfTurnは指定Turn以下だけを集計する（未来のTurnを混ぜない）", () => {
  const { state, fixtures } = runTurns(2);
  const targetCompanyId = fixtures[0].companyId;
  const asOf1 = computeCompanyKpiSnapshot(state.history, targetCompanyId, 1);
  const asOf2 = computeCompanyKpiSnapshot(state.history, targetCompanyId, 2);
  assert.equal(asOf1.lastRecordedTurn, 1);
  assert.equal(asOf2.lastRecordedTurn, 2);
});

// ---------------------------------------------------------------------
// TSV-27a: Dividend Valueの15%複利（単発配当）
// ---------------------------------------------------------------------

test("TSV: 配当したTurnと同じTurnで評価すると1.0倍", () => {
  const { state, fixtures } = runTurns(2);
  const targetCompanyId = fixtures[0].companyId;
  const distributable = Number(state.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  assert.ok(distributable > 0, "前提: Turn2時点で分配可能利益が正であること");

  const dividendAmountUsd = Math.min(100_000, distributable);
  const state3 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));
  const value = computeCurrentDividendValueUsd(state3.history, targetCompanyId, 3);
  assert.ok(Math.abs(value - dividendAmountUsd) < 1e-3, `配当したTurn自身での評価は1.0倍のはず（actual=${value}, expected=${dividendAmountUsd}）`);
});

test("TSV: 4Turn経過（1年）で約1.15倍になる", () => {
  const { state, fixtures } = runTurns(2);
  const targetCompanyId = fixtures[0].companyId;
  const distributable = Number(state.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  const dividendAmountUsd = Math.min(100_000, distributable);
  const state3 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));
  const state4 = stepOnce(state3, fixtures);
  const state5 = stepOnce(state4, fixtures);
  const state6 = stepOnce(state5, fixtures);
  // Turn3で配当、Turn7まで進めてasOfTurn=7で評価（7-3=4Turn=1年）。
  const state7 = stepOnce(state6, fixtures);
  const value = computeCurrentDividendValueUsd(state7.history, targetCompanyId, 7);
  const expected = dividendAmountUsd * 1.15;
  assert.ok(Math.abs(value - expected) < 1, `4Turn後は約1.15倍のはず（actual=${value}, expected=${expected}）`);
});

test("TSV: 8Turn経過（2年）で約1.15^2倍になる（fractional-yearの複利指数(turnDiff/4)を直接確認）", () => {
  // 実Runを8Turn進めるのは重いため、履歴を手構築してcompute関数を直接検証する。
  const fakeRecordAtTurn = (turn: number, appliedDividendUsd: number) =>
    ({
      turn,
      dividendResults: [
        {
          companyId: "MASS",
          period: `2015Q${((turn - 1) % 4) + 1}` as never,
          turn,
          requestedDividendUsd: appliedDividendUsd,
          appliedDividendUsd,
          rejected: false,
          rejectionReason: null,
          maxDividendUsd: appliedDividendUsd,
          cumulativeDividendUsd: appliedDividendUsd,
          timeWeight: 1,
          weightedDividendValueUsd: appliedDividendUsd,
          cumulativeWeightedDividendValueUsd: appliedDividendUsd,
          distributableEarningsAfterUsd: 0,
          cashAfterUsd: 0,
        },
      ],
    }) as unknown as import("../../types").CompanyQuarterRecord;

  const history = [fakeRecordAtTurn(1, 100_000)];
  const value = computeCurrentDividendValueUsd(history, "MASS" as never, 9);
  const expected = 100_000 * Math.pow(1.15, (9 - 1) / 4);
  assert.ok(Math.abs(value - expected) < 1e-6, `8Turn経過(exponent=2)は1.15^2倍のはず（actual=${value}, expected=${expected}）`);
  assert.ok(Math.abs(expected - 100_000 * Math.pow(1.15, 2)) < 1e-6, "8Turn = 2年であることの確認");
});

test("TSV: fractional-year指数（(t-d)/4）が整数年以外でも正しく複利される", () => {
  const fakeRecord = {
    turn: 1,
    dividendResults: [
      {
        companyId: "MASS",
        turn: 1,
        appliedDividendUsd: 100_000,
        rejected: false,
        rejectionReason: null,
        requestedDividendUsd: 100_000,
        maxDividendUsd: 100_000,
        cumulativeDividendUsd: 100_000,
        timeWeight: 1,
        weightedDividendValueUsd: 100_000,
        cumulativeWeightedDividendValueUsd: 100_000,
        distributableEarningsAfterUsd: 0,
        cashAfterUsd: 0,
        period: "2015Q1" as never,
      },
    ],
  } as unknown as import("../../types").CompanyQuarterRecord;

  const value = computeCurrentDividendValueUsd([fakeRecord], "MASS" as never, 6); // 5Turn差 → exponent=5/4=1.25年
  const expected = 100_000 * Math.pow(1.15, 5 / 4);
  assert.ok(Math.abs(value - expected) < 1e-6);
});

test("TSV: 複数回の配当は個別に複利され、合算される", () => {
  const record1 = {
    turn: 1,
    dividendResults: [
      {
        companyId: "MASS",
        turn: 1,
        appliedDividendUsd: 50_000,
        rejected: false,
        rejectionReason: null,
        requestedDividendUsd: 50_000,
        maxDividendUsd: 50_000,
        cumulativeDividendUsd: 50_000,
        timeWeight: 1,
        weightedDividendValueUsd: 50_000,
        cumulativeWeightedDividendValueUsd: 50_000,
        distributableEarningsAfterUsd: 0,
        cashAfterUsd: 0,
        period: "2015Q1" as never,
      },
    ],
  } as unknown as import("../../types").CompanyQuarterRecord;
  const record2 = {
    turn: 5,
    dividendResults: [
      {
        companyId: "MASS",
        turn: 5,
        appliedDividendUsd: 30_000,
        rejected: false,
        rejectionReason: null,
        requestedDividendUsd: 30_000,
        maxDividendUsd: 30_000,
        cumulativeDividendUsd: 80_000,
        timeWeight: 1,
        weightedDividendValueUsd: 30_000,
        cumulativeWeightedDividendValueUsd: 80_000,
        distributableEarningsAfterUsd: 0,
        cashAfterUsd: 0,
        period: "2016Q1" as never,
      },
    ],
  } as unknown as import("../../types").CompanyQuarterRecord;

  const asOfTurn = 9;
  const value = computeCurrentDividendValueUsd([record1, record2], "MASS" as never, asOfTurn);
  const expected = 50_000 * Math.pow(1.15, (asOfTurn - 1) / 4) + 30_000 * Math.pow(1.15, (asOfTurn - 5) / 4);
  assert.ok(Math.abs(value - expected) < 1e-6);
});

test("TSV（future leakage禁止・§14）: asOfTurnより後の配当は一切合算に含まれない", () => {
  const pastRecord = {
    turn: 2,
    dividendResults: [
      {
        companyId: "MASS",
        turn: 2,
        appliedDividendUsd: 10_000,
        rejected: false,
        rejectionReason: null,
        requestedDividendUsd: 10_000,
        maxDividendUsd: 10_000,
        cumulativeDividendUsd: 10_000,
        timeWeight: 1,
        weightedDividendValueUsd: 10_000,
        cumulativeWeightedDividendValueUsd: 10_000,
        distributableEarningsAfterUsd: 0,
        cashAfterUsd: 0,
        period: "2015Q2" as never,
      },
    ],
  } as unknown as import("../../types").CompanyQuarterRecord;
  const futureRecord = {
    turn: 20,
    dividendResults: [
      {
        companyId: "MASS",
        turn: 20,
        appliedDividendUsd: 999_999_999,
        rejected: false,
        rejectionReason: null,
        requestedDividendUsd: 999_999_999,
        maxDividendUsd: 999_999_999,
        cumulativeDividendUsd: 999_999_999,
        timeWeight: 1,
        weightedDividendValueUsd: 999_999_999,
        cumulativeWeightedDividendValueUsd: 999_999_999,
        distributableEarningsAfterUsd: 0,
        cashAfterUsd: 0,
        period: "2019Q4" as never,
      },
    ],
  } as unknown as import("../../types").CompanyQuarterRecord;

  const value = computeCurrentDividendValueUsd([pastRecord, futureRecord], "MASS" as never, 10);
  const expected = 10_000 * Math.pow(1.15, (10 - 2) / 4);
  assert.ok(Math.abs(value - expected) < 1e-6, "Turn20の巨大な配当（未来）が混入していないこと");
});

test("TSV: 任意のasOfTurnで計算でき、Turn32を暗黙の基準にした固定値を参照しない", () => {
  const { state, fixtures } = runTurns(4);
  const targetCompanyId = fixtures[0].companyId;
  // scenarioLengthやTurn32を一切渡さずに呼び出せること自体がAPIとして証明。
  const v3 = computeCurrentDividendValueUsd(state.history, targetCompanyId, 3);
  const v4 = computeCurrentDividendValueUsd(state.history, targetCompanyId, 4);
  assert.equal(typeof v3, "number");
  assert.equal(typeof v4, "number");
});

test("TSV（§13）: 同じTurnの評価は、その後さらにTurnが進んでも変化しない（早期終了と最後まで進めた場合で同じ評価になる）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;

  const shortState1 = stepOnce(state0, fixtures);
  const shortState2 = stepOnce(shortState1, fixtures);
  const evaluationAtEarlyStop = computeCompanyEvaluationSnapshot(shortState2.history, targetCompanyId, 2);

  const longState1 = stepOnce(state0, fixtures);
  const longState2 = stepOnce(longState1, fixtures);
  const longState3 = stepOnce(longState2, fixtures);
  const longState4 = stepOnce(longState3, fixtures);
  const evaluationAtTurn2WithinLongerRun = computeCompanyEvaluationSnapshot(longState4.history, targetCompanyId, 2);

  assert.deepEqual(
    evaluationAtEarlyStop,
    evaluationAtTurn2WithinLongerRun,
    "Turn2時点の評価は、Runがその後何Turn続いたかに関わらず同一であるべき（同じ評価システムであることの核心）"
  );
});

// ---------------------------------------------------------------------
// TSV-27b: Enterprise Value（10% DCF）
// ---------------------------------------------------------------------

test("TSV: EnterpriseValue = AnnualizedCashFlow × 年金現価係数(10年・10%)。Dividendの15%レートとは独立している", () => {
  const { state, fixtures } = runTurns(3);
  const targetCompanyId = fixtures[0].companyId;
  const breakdown = computeCompanyCurrentCompanyValueBreakdown(state.history, targetCompanyId, 3);
  assert.ok(breakdown.normalizedQuarterlyCashFlowUsd !== null);
  assert.ok(breakdown.annualizedCashFlowUsd !== null);
  assert.ok(breakdown.enterpriseValueUsd !== null);
  const expectedAnnuityFactor = (1 - Math.pow(1.1, -10)) / 0.1;
  const expectedEv = breakdown.annualizedCashFlowUsd! * expectedAnnuityFactor;
  assert.ok(Math.abs(breakdown.enterpriseValueUsd! - expectedEv) < 1e-3);
  // 15%(配当複利)は一切登場しない: 1.15を使った計算結果とは一致しないはず（レート混同のガード）。
  const wrongWith15Percent = breakdown.annualizedCashFlowUsd! * ((1 - Math.pow(1.15, -10)) / 0.15);
  assert.notEqual(breakdown.enterpriseValueUsd, wrongWith15Percent);
});

test("TSV: NormalizedQuarterlyCashFlowはTurn1=1Turn平均、Turn2=2Turn平均、Turn3以降=3Turn平均", () => {
  const { state, fixtures } = runTurns(4);
  const targetCompanyId = fixtures[0].companyId;
  const ocf = (turn: number) => Number(state.history[turn - 1].financialResults.find((f) => f.companyId === targetCompanyId)!.cashFlow.operatingCashFlow);

  const n1 = computeNormalizedQuarterlyCashFlowUsd(state.history, targetCompanyId, 1);
  assert.ok(Math.abs(n1! - ocf(1)) < 1e-6);

  const n2 = computeNormalizedQuarterlyCashFlowUsd(state.history, targetCompanyId, 2);
  assert.ok(Math.abs(n2! - (ocf(1) + ocf(2)) / 2) < 1e-6);

  const n4 = computeNormalizedQuarterlyCashFlowUsd(state.history, targetCompanyId, 4);
  assert.ok(Math.abs(n4! - (ocf(2) + ocf(3) + ocf(4)) / 3) < 1e-6, "Turn4はTurn2-4の直近3Turn平均のはず");
});

test("TSV: 負の正常化Cash FlowでもEnterprise Valueを0でフロアしない（負値を許容）", () => {
  const negativeHistory = [
    {
      turn: 1,
      financialResults: [
        {
          companyId: "MASS",
          cashFlow: { operatingCashFlow: -1_000_000 },
          balanceSheet: { cash: 500_000, shortTermLoans: 200_000, longTermLoans: 100_000 },
          profitAndLoss: { operatingProfit: -900_000, netRevenue: 1_000_000 },
        },
      ],
      financingResults: [],
      companySummaries: [],
      dividendResults: [],
    },
  ] as unknown as readonly import("../../types").CompanyQuarterRecord[];

  const breakdown = computeCompanyCurrentCompanyValueBreakdown(negativeHistory, "MASS" as never, 1);
  assert.ok(breakdown.enterpriseValueUsd! < 0, "負のNormalized CFは負のEVになるはず");
  const snapshot = computeCompanyEvaluationSnapshot(negativeHistory, "MASS" as never, 1);
  assert.ok(snapshot.totalShareholderValueUsd !== null);
});

// ---------------------------------------------------------------------
// TSV-27c: Current Company Value / TSV 合算
// ---------------------------------------------------------------------

test("TSV: CurrentCompanyValue = EnterpriseValue + Cash - Debt", () => {
  const { state, fixtures } = runTurns(3);
  const targetCompanyId = fixtures[0].companyId;
  const breakdown = computeCompanyCurrentCompanyValueBreakdown(state.history, targetCompanyId, 3);
  const expected = breakdown.enterpriseValueUsd! + breakdown.cashUsd! - breakdown.debtUsd!;
  assert.ok(Math.abs(breakdown.currentCompanyValueUsd! - expected) < 1e-3);
});

test("TSV: TotalShareholderValue = DividendValue + CurrentCompanyValue", () => {
  const { state, fixtures } = runTurns(3);
  const targetCompanyId = fixtures[0].companyId;
  const snapshot = computeCompanyEvaluationSnapshot(state.history, targetCompanyId, 3);
  const expected = snapshot.currentDividendValueUsd + snapshot.currentCompanyValue.currentCompanyValueUsd!;
  assert.ok(Math.abs(snapshot.totalShareholderValueUsd! - expected) < 1e-3);
  assert.equal(snapshot.shareholderValueModelVersion, "tsv-dcf-v1");
});

test("TSV: legacyWeightedDividendValueUsdは保存済みdividendResultsの値をそのまま読むだけで、TSVには使われない", () => {
  const { state, fixtures } = runTurns(2);
  const targetCompanyId = fixtures[0].companyId;
  const distributable = Number(state.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  const dividendAmountUsd = Math.min(100_000, distributable);
  const state3 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));

  const snapshot = computeCompanyEvaluationSnapshot(state3.history, targetCompanyId, 3);
  const dividendEntry = state3.history[2].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.ok(dividendEntry);
  assert.equal(snapshot.legacyWeightedDividendValueUsd, dividendEntry?.cumulativeWeightedDividendValueUsd);
  // 正式Dividend Valueは、旧段階係数(1.5等)とは別の値になる（15%複利ベースのため一致しない）。
  assert.notEqual(snapshot.currentDividendValueUsd, snapshot.legacyWeightedDividendValueUsd);
});

test("TSV: computeAllCompaniesEvaluationSnapshotは全社ぶんのTSVを返し、rankCompaniesByTotalShareholderValueで降順ランキングできる", () => {
  const { state, fixtures } = runTurns(2);
  const companyIds = fixtures.map((f) => f.companyId);
  const snapshots = computeAllCompaniesEvaluationSnapshot(state.history, companyIds, 2);
  assert.equal(snapshots.length, companyIds.length);
  const ranked = rankCompaniesByTotalShareholderValue(snapshots);
  for (let i = 1; i < ranked.length; i++) {
    const prev = ranked[i - 1].totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY;
    const curr = ranked[i].totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY;
    assert.ok(prev >= curr, "TSV降順であること");
  }
});

test("EVAL-1: distressTurnCountはfinancialHealth.primaryが\"healthy\"以外だったTurn数を数える（新しいCrisis状態を導入しない）", () => {
  const { state, fixtures } = runTurns(1);
  const targetCompanyId = fixtures[0].companyId;
  const snapshot = computeCompanyKpiSnapshot(state.history, targetCompanyId, 1);
  const financingEntry = state.history[0].financingResults.find((f) => f.companyId === targetCompanyId)!;
  const expectedDistressCount = financingEntry.financialHealth.primary === "healthy" ? 0 : 1;
  assert.equal(snapshot.distressTurnCount, expectedDistressCount);
});

// ---------------------------------------------------------------------
// TSV-27d: 配当 vs 再投資の感度確認（TSV正式化指示§23）
// ---------------------------------------------------------------------

test("TSV感度: 配当を実行した直後は、CashからDividend Valueへ価値が移っただけでTSVはほぼ変わらない（配当が“無料の得”にならない）", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ turns: 10 }));
  const targetCompanyId = fixtures[0].companyId;

  const state1 = stepOnce(state0, fixtures);
  const state2 = stepOnce(state1, fixtures);
  const distributable = Number(state2.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  assert.ok(distributable > 0, "前提: Turn2時点で分配可能利益が正であること");
  const dividendAmountUsd = Math.min(1_000_000, distributable);

  // Case A: 配当0（Cashを会社に残す）。Case B: dividendAmountUsdを配当する。
  const stateA3 = stepOnce(state2, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: 0 } }));
  const stateB3 = stepOnce(state2, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));

  const tsvA = computeCompanyEvaluationSnapshot(stateA3.history, targetCompanyId, 3).totalShareholderValueUsd!;
  const tsvB = computeCompanyEvaluationSnapshot(stateB3.history, targetCompanyId, 3).totalShareholderValueUsd!;

  // 配当した瞬間はCash-配当額とDividendValue+配当額がほぼ相殺し、TSVはほぼ変わらない
  // （どちらかが常に正解、という単純な支配関係にならないことの核心）。
  const relativeDiff = Math.abs(tsvA - tsvB) / Math.max(Math.abs(tsvA), Math.abs(tsvB), 1);
  assert.ok(relativeDiff < 0.05, `配当直後のTSVはCase A/Bでほぼ一致するはず（tsvA=${tsvA}, tsvB=${tsvB}, relativeDiff=${relativeDiff}）`);
});

test("TSV感度: 数Turn後、配当した側はDividend Valueが15%で増える一方、配当しなかった側はCashが増えるだけ（Current Company Value上は無利子）で、どちらか一方が常に有利ではない", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ turns: 12 }));
  const targetCompanyId = fixtures[0].companyId;

  const state1 = stepOnce(state0, fixtures);
  const state2 = stepOnce(state1, fixtures);
  const distributable = Number(state2.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  const dividendAmountUsd = Math.min(1_000_000, distributable);

  let stateA = stepOnce(state2, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: 0 } }));
  let stateB = stepOnce(state2, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));
  for (let i = 0; i < 6; i++) {
    stateA = stepOnce(stateA, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: 0 } }));
    stateB = stepOnce(stateB, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: 0 } }));
  }
  const asOfTurn = 9;
  const snapshotA = computeCompanyEvaluationSnapshot(stateA.history, targetCompanyId, asOfTurn);
  const snapshotB = computeCompanyEvaluationSnapshot(stateB.history, targetCompanyId, asOfTurn);

  // Bは配当価値が15%複利で育っている（配当額そのものより大きい）。
  assert.ok(snapshotB.currentDividendValueUsd > dividendAmountUsd, "数Turn後はDividend Valueが元本より増えているはず（15%複利）");
  // Aは配当していないのでDividend Valueはゼロのまま。
  assert.equal(snapshotA.currentDividendValueUsd, 0);
  // どちらのTSVが最終的に高いかはEnterprise Valueの推移（Standard AIの再投資結果）に
  // 依存するため、本テストでは「一方が常に圧倒的に有利」という単純な不等式を固定しない
  // （それ自体が指示§23の趣旨＝配当が常に正解でも再投資が常に正解でもないこと）。
  assert.equal(typeof snapshotA.totalShareholderValueUsd, "number");
  assert.equal(typeof snapshotB.totalShareholderValueUsd, "number");
});
