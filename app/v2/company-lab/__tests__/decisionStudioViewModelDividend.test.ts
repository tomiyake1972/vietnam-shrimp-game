// ShrimpX V2 — Player配当意思決定 UI接続: decisionStudioViewModel.ts の配当関連フィールド
//
// 【新しい計算をしない】ここではretainedEarningsUsd/distributableEarningsUsd/
// maxDividendUsdが、ownState.financeStateの既存値と、finance/dividend.tsの
// 既存関数computeMaxDividendUsdの呼び出し結果に一致することだけを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyOwnState, initializeCompanyLab } from "../../../lib/v2/companyLab/runner";
import { buildInitialDraft } from "../decisionDraft";
import { buildDecisionStudioViewModel } from "../decisionStudioViewModel";
import { computeMaxDividendUsd } from "../../../lib/v2/finance/dividend";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "dividend-vm-001", turns: 4, ...overrides };
}

test("配当VM-1: retainedEarningsUsd/distributableEarningsUsdは、ownState.financeStateの値をそのまま返す（再計算しない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });

  assert.equal(vm.retainedEarningsUsd, ownState.financeState.retainedEarnings as number);
  assert.equal(vm.distributableEarningsUsd, ownState.financeState.distributableEarnings as number);
  assert.equal(vm.currentCashUsd, ownState.financeState.cash as number);
});

test("配当VM-2: maxDividendUsdは、既存computeMaxDividendUsd(ownState.financeState)の呼び出し結果と一致する（UI独自の計算式を持たない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });

  assert.equal(vm.maxDividendUsd, computeMaxDividendUsd(ownState.financeState));
});

test("配当VM-3: Turn1（当期営業結果が未確定）ではmaxDividendUsdは0", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  const vm = buildDecisionStudioViewModel({ fixture, ownState, draft, period: state.currentPeriod });

  assert.equal(vm.maxDividendUsd, 0, "Turn1時点ではdistributableEarnings=0（game-start distributable base=0）のためmaxDividendも0のはず");
});

test("配当VM-4: buildInitialDraftのdividendAmountUsdは常に0から始まる（前四半期の配当決定を引き継がない）", () => {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);

  assert.equal(draft.dividendAmountUsd, 0);
});
