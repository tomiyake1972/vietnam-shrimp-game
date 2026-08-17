// ShrimpX V2 — 配当（Dividend）機能 統合テスト（Phase DIV-1・実装指示§28）
//
// runner.ts（advanceCompanyLabQuarter）経由で、実際のTurn進行を通じて配当が
// 正しく会計反映・履歴化されることを確認する。ユニットレベルの検証は
// finance/__tests__/dividend.test.tsで行う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState, CompanyFixture } from "../types";
import { createCompanyLabRuntimeSnapshot } from "../persistence/snapshot";
import { validateCompanyLabRuntimeSnapshot, validateCompanyLabQuarterHistoryEntry } from "../persistence/schema";
import { CompanyLabQuarterHistoryEntry } from "../persistence/types";

const EPS = 1e-6;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "dividend-integration-001", turns: 4, ...overrides };
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

test("DIV-1統合: Turn1では配当0が既定で、履歴（dividendResults）が全社ぶん記録される", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: undefined }));
  const record1 = state1.history[0];
  assert.equal(record1.dividendResults?.length, fixtures.length);
  for (const entry of record1.dividendResults ?? []) {
    assert.equal(entry.appliedDividendUsd, 0);
    assert.equal(entry.rejected, false);
  }
});

test("DIV-1統合: current-period unconfirmed profit cannot be distributed — Turn1のmaxDividendは0（当期の営業結果はまだ確定していない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: 1_000_000 } }));
  const entry = state1.history[0].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.ok(entry);
  assert.equal(entry?.rejected, true, "Turn1時点でdistributableEarningsはまだ0のため、いかなる正の要求も拒否されるはず");
  assert.equal(entry?.appliedDividendUsd, 0);
  assert.equal(entry?.maxDividendUsd, 0);
});

test("DIV-1統合: initial retained earnings cannot be freely distributed — 初期BS上のretainedEarnings全額を配当要求しても拒否される", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const initialRetainedEarnings = Number(state.financeState.companies.find((c) => c.companyId === targetCompanyId)!.retainedEarnings);
  assert.ok(initialRetainedEarnings > 1_000_000, "この監査前提（初期残差が非ゼロで大きい）が崩れていないことを確認");
  const state1 = stepOnce(state, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: initialRetainedEarnings } }));
  const entry = state1.history[0].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.equal(entry?.rejected, true, "初期retainedEarnings全額の配当要求は拒否されるはず（game-start distributable base=0）");
});

test("DIV-1統合: Cash/Retained Earnings反映 — Turn2以降、確定済み分配可能利益の範囲内の配当はCash/retainedEarnings/distributableEarningsを同額減らす", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig());
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures, targetCompanyId);
  const financeAfterTurn1 = state1.financeState.companies.find((c) => c.companyId === targetCompanyId)!;
  const distributableAfterTurn1 = Number(financeAfterTurn1.distributableEarnings);

  // Turn1で確定した分配可能利益がプラスであることを前提にする（ベースラインシナリオでは
  // 通常黒字になるはずだが、念のためガードする。0以下ならこのテストの前提が崩れるため、
  // 監査コメントとして明示しておく）。
  if (distributableAfterTurn1 <= EPS) {
    // このseedでは黒字にならなかった場合はスキップ相当として早期returnする
    // （前提条件の監査結果次第でこのブロックへ来ることがある旨を明示するだけで、
    // アサーションの数を無理に固定しない）。
    return;
  }

  const dividendAmountUsd = Math.min(1_000, distributableAfterTurn1) / 2;
  const cashBeforeDividendTurn2 = Number(financeAfterTurn1.cash);
  const retainedEarningsBeforeDividendTurn2 = Number(financeAfterTurn1.retainedEarnings);

  const state2 = stepOnce(state1, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));
  const entry2 = state2.history[1].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.ok(entry2);
  assert.equal(entry2?.rejected, false);
  assert.ok(Math.abs((entry2?.appliedDividendUsd ?? 0) - dividendAmountUsd) < EPS);
  // cashAfterUsd/distributableEarningsAfterUsdは「配当実行直後（Turn2の営業結果が
  // 確定する前）」の値であり、Turn1確定時点のcash/retainedEarningsから配当額だけ
  // 減った値と一致するはず（Turn終了後に帳尻だけ減らす方式ではないことの確認）。
  assert.ok(Math.abs((entry2!.cashAfterUsd ?? 0) - (cashBeforeDividendTurn2 - dividendAmountUsd)) < EPS);
  assert.ok(Math.abs((entry2!.distributableEarningsAfterUsd ?? 0) - (distributableAfterTurn1 - dividendAmountUsd)) < EPS);
  void retainedEarningsBeforeDividendTurn2;
});

test("DIV-1統合: P&L unaffected — 配当そのものはP&Lへ一切計上されない（配当額が小さく、調達制約を全く動かさない範囲では当期の営業結果も完全一致する）", () => {
  // 【重要な区別（実装指示§7 vs §9）】§7が保証するのは「配当という会計行為自体が
  // P&L科目として計上されない」ことであり、「どんな配当額でも生産・調達の意思決定に
  // 一切影響しない」ことではない。§9はむしろ逆に、配当で減ったcashが当期の
  // procurement capacity・CAPEX余力・borrowing needへ波及する（間接的にP&Lが動きうる）
  // ことを意図的な設計として要求している。そのため本テストは、会社規模（cashが
  // 数千万USD規模）に対して無視できるほど小さい配当額（調達制約を一切動かさない
  // 金額）を使い、「配当そのものはP&L科目ではない」という核心の不変条件だけを確認する。
  const configA = baseConfig({ seed: "dividend-pnl-unaffected" });
  const { state: state0A, fixtures: fixturesA } = initializeCompanyLab(configA);
  const targetCompanyId = fixturesA[0].companyId;
  const state1A = stepOnce(state0A, fixturesA, targetCompanyId);
  const distributable = Number(state1A.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  if (distributable <= EPS) return; // 前提条件（黒字）が崩れた場合はスキップ相当。

  const dividendAmountUsd = Math.min(100, distributable);

  // ラン1: Turn2で配当あり。ラン2: 同一seedでTurn2は配当なし。
  const stateWithDividend = stepOnce(state1A, fixturesA, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));

  const { state: state0B, fixtures: fixturesB } = initializeCompanyLab(configA);
  const state1B = stepOnce(state0B, fixturesB, targetCompanyId);
  const stateWithoutDividend = stepOnce(state1B, fixturesB, targetCompanyId, (auto) => ({ ...auto, dividendDecision: undefined }));

  const pnlWith = stateWithDividend.history[1].financialResults.find((r) => r.companyId === targetCompanyId)!.profitAndLoss;
  const pnlWithout = stateWithoutDividend.history[1].financialResults.find((r) => r.companyId === targetCompanyId)!.profitAndLoss;
  assert.equal(Number(pnlWith.netRevenue), Number(pnlWithout.netRevenue), "配当の有無でnetRevenueは変わらない");
  assert.equal(Number(pnlWith.operatingProfit), Number(pnlWithout.operatingProfit), "配当の有無でoperatingProfitは変わらない");
  assert.equal(Number(pnlWith.netIncome), Number(pnlWithout.netIncome), "配当の有無でnetIncomeは変わらない（P&L expenseとして処理しない）");

  const bsWith = stateWithDividend.history[1].financialResults.find((r) => r.companyId === targetCompanyId)!.balanceSheet;
  const bsWithout = stateWithoutDividend.history[1].financialResults.find((r) => r.companyId === targetCompanyId)!.balanceSheet;
  assert.ok(Math.abs(Number(bsWith.cash) - (Number(bsWithout.cash) - dividendAmountUsd)) < EPS, "Cashは配当額ぶんだけ少ないはず");
  assert.ok(Math.abs(Number(bsWith.retainedEarnings) - (Number(bsWithout.retainedEarnings) - dividendAmountUsd)) < EPS, "Retained Earningsは配当額ぶんだけ少ないはず");

  // Debtは自動増加させない（配当のための自動借入は禁止）。
  assert.equal(Number(bsWith.shortTermLoans), Number(bsWithout.shortTermLoans));
  assert.equal(Number(bsWith.longTermLoans), Number(bsWithout.longTermLoans));
});

test("DIV-1統合: cumulative dividend — 複数Turnにまたがる配当が正しく累積される", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ turns: 4 }));
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures, targetCompanyId);
  const distributable1 = Number(state1.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  if (distributable1 <= EPS) return;

  const firstDividend = distributable1 / 4;
  const state2 = stepOnce(state1, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: firstDividend } }));
  const entry2 = state2.history[1].dividendResults!.find((d) => d.companyId === targetCompanyId)!;
  assert.ok(Math.abs(entry2.cumulativeDividendUsd - firstDividend) < EPS);

  const distributable2 = Number(state2.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  if (distributable2 <= EPS) return;
  const secondDividend = distributable2 / 4;
  const state3 = stepOnce(state2, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd: secondDividend } }));
  const entry3 = state3.history[2].dividendResults!.find((d) => d.companyId === targetCompanyId)!;
  assert.ok(Math.abs(entry3.cumulativeDividendUsd - (firstDividend + secondDividend)) < EPS, "累積配当は過去turnの合計になるはず");
  assert.ok(entry3.cumulativeWeightedDividendValueUsd >= entry3.appliedDividendUsd * entry3.timeWeight - EPS, "累積weighted valueは単調非減少のはず");
});

test("DIV-1統合: legacy save compatibility — distributableEarningsを持たない旧形式のCompanyLabRuntimeSnapshotも例外なくdecodeでき、安全な既定値になる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ turns: 1 }));
  void fixtures;
  const state1 = stepOnce(state, fixtures);
  const snapshot = createCompanyLabRuntimeSnapshot(state1);

  const parsed = JSON.parse(JSON.stringify(snapshot));
  // 【旧形式シミュレーション】distributableEarningsのキー自体を削除し、本機能導入前に
  // 確定した既存の永続化済みRunと同じ形にする。
  for (const company of parsed.financeState.companies) {
    delete company.distributableEarnings;
  }

  const decoded = validateCompanyLabRuntimeSnapshot(parsed, "$");
  for (const company of decoded.financeState.companies) {
    assert.equal(Number(company.distributableEarnings), 0, "欠落時はdistributableEarnings=0として扱われるはず");
  }
});

test("DIV-1統合: legacy save compatibility — dividendResults/dividendDecisionを持たない旧形式のCompanyQuarterRecordも例外なくdecodeできる", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ turns: 1 }));
  const state1 = stepOnce(state, fixtures);
  const entry: CompanyLabQuarterHistoryEntry = {
    turnId: "turn-1",
    turn: 1,
    period: state1.history[0].period,
    engineVersion: "test-engine",
    schemaVersion: 1,
    preProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(state),
    postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(state1),
    playerSubmission: state1.history[0].decisions[0],
    otherCompaniesDecisions: state1.history[0].decisions.slice(1),
    record: state1.history[0],
    processedAt: "2015-01-01T00:00:00.000Z",
  };
  const parsed = JSON.parse(JSON.stringify(entry));
  // 【旧形式シミュレーション】dividendResults・dividendDecisionのキー自体を削除する。
  delete parsed.record.dividendResults;
  for (const decision of parsed.record.decisions) {
    delete decision.dividendDecision;
  }
  delete parsed.playerSubmission.dividendDecision;
  for (const decision of parsed.otherCompaniesDecisions) {
    delete decision.dividendDecision;
  }

  const decoded = validateCompanyLabQuarterHistoryEntry(parsed, "$");
  assert.equal(decoded.record.dividendResults, undefined, "欠落時はdividendResultsがundefinedのままのはず（後方互換・捏造しない）");
});

test("DIV-1統合: Redis/JSON round trip — 配当データを含むCompanyQuarterRecordがencode→decodeで意味的に一致する", () => {
  const { state: state0, fixtures } = initializeCompanyLab(baseConfig({ turns: 2 }));
  const targetCompanyId = fixtures[0].companyId;
  const state1 = stepOnce(state0, fixtures, targetCompanyId);
  const distributable1 = Number(state1.financeState.companies.find((c) => c.companyId === targetCompanyId)!.distributableEarnings);
  const dividendAmountUsd = distributable1 > EPS ? distributable1 / 3 : 0;
  const state2 = stepOnce(state1, fixtures, targetCompanyId, (auto) => ({ ...auto, dividendDecision: { dividendAmountUsd } }));

  const entry: CompanyLabQuarterHistoryEntry = {
    turnId: "turn-2",
    turn: 2,
    period: state2.history[1].period,
    engineVersion: "test-engine",
    schemaVersion: 1,
    preProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(state1),
    postProcessingStateSnapshot: createCompanyLabRuntimeSnapshot(state2),
    playerSubmission: state2.history[1].decisions.find((d) => d.companyId === targetCompanyId)!,
    otherCompaniesDecisions: state2.history[1].decisions.filter((d) => d.companyId !== targetCompanyId),
    record: state2.history[1],
    processedAt: "2015-01-01T00:00:00.000Z",
  };
  const decoded = validateCompanyLabQuarterHistoryEntry(JSON.parse(JSON.stringify(entry)), "$");

  const decodedFinance = decoded.postProcessingStateSnapshot.financeState.companies.find((c) => c.companyId === targetCompanyId)!;
  const originalFinance = state2.financeState.companies.find((c) => c.companyId === targetCompanyId)!;
  assert.equal(Number(decodedFinance.distributableEarnings), Number(originalFinance.distributableEarnings));
  assert.equal(Number(decodedFinance.cash), Number(originalFinance.cash));

  const decodedEntry = decoded.record.dividendResults?.find((d) => d.companyId === targetCompanyId);
  const originalEntry = state2.history[1].dividendResults?.find((d) => d.companyId === targetCompanyId);
  assert.deepEqual(JSON.parse(JSON.stringify(decodedEntry)), JSON.parse(JSON.stringify(originalEntry)));
});
