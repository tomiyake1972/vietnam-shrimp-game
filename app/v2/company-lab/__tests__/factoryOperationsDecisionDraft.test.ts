// ShrimpX V2 — Player工場操作Phase 1: factoryLifecycleDecisions のdraft往復テスト
//
// buildInitialDraft（種まき）→ setFactoryLifecycleDecisionInDraft（Player選択）→
// buildDecisionInputFromDraft（既存Engine契約への変換）の往復を確認する。
// ここでは一切の新しい計算・新しい検証を行わない（既存の型をそのまま往復させるだけ）
// ことをテストで裏付ける。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { setFactoryLifecycleDecisionInDraft } from "../factoryLifecycleDraftActions";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "factory-draft-roundtrip-001", turns: 8, ...overrides };
}

function buildScenario() {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return { state, fixture, autoDecision };
}

test("FAC-RT-1【実装指示§8「未選択なら提出しない」】: buildInitialDraftは常にfactoryLifecycleDecisions=[]から始まる", () => {
  const { fixture, autoDecision } = buildScenario();
  const draft = buildInitialDraft(fixture, autoDecision);
  assert.deepEqual(draft.factoryLifecycleDecisions, []);
});

test("FAC-RT-2: MOTHBALL_FACTORYを選択したdraftは、buildDecisionInputFromDraftでそのままCompanyDecisionInputへ渡る", () => {
  const { state, fixture, autoDecision } = buildScenario();
  const factoryId = fixture.factories[0].factoryId;
  const draft = setFactoryLifecycleDecisionInDraft(buildInitialDraft(fixture, autoDecision), factoryId, "MOTHBALL_FACTORY");
  const decision = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  assert.deepEqual(decision.factoryLifecycleDecisions, [{ factoryId, type: "MOTHBALL_FACTORY" }]);
});

test("FAC-RT-3: REACTIVATE_FACTORYを選択したdraftも同様に渡る", () => {
  const { state, fixture, autoDecision } = buildScenario();
  const factoryId = fixture.factories[0].factoryId;
  const draft = setFactoryLifecycleDecisionInDraft(buildInitialDraft(fixture, autoDecision), factoryId, "REACTIVATE_FACTORY");
  const decision = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  assert.deepEqual(decision.factoryLifecycleDecisions, [{ factoryId, type: "REACTIVATE_FACTORY" }]);
});

test("FAC-RT-4: SELL_FACTORYを選択したdraftも同様に渡る", () => {
  const { state, fixture, autoDecision } = buildScenario();
  const factoryId = fixture.factories[0].factoryId;
  const draft = setFactoryLifecycleDecisionInDraft(buildInitialDraft(fixture, autoDecision), factoryId, "SELL_FACTORY");
  const decision = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  assert.deepEqual(decision.factoryLifecycleDecisions, [{ factoryId, type: "SELL_FACTORY" }]);
});

test("FAC-RT-5【工場操作なしの完全回帰】: 選択なしのdraftは、factoryLifecycleDecisionsフィールドが無い旧形式のCompanyDecisionInputと意味的に同じ（空）になる", () => {
  const { state, fixture, autoDecision } = buildScenario();
  const draft = buildInitialDraft(fixture, autoDecision);
  const decision = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  assert.deepEqual(decision.factoryLifecycleDecisions, [], "工場操作なしでは空配列（undefinedのfactoryLifecycleDecisionsと同じ意味）");

  // 【後方互換】この機能導入前に保存されたdraft（フィールド自体が存在しない）を模して
  // 変換しても、生成されるCompanyDecisionInputのfactoryLifecycleDecisionsはundefinedになる
  // （エンジン側は ?? [] で吸収する。runner.ts参照）。
  const legacyDraft = { ...draft } as { factoryLifecycleDecisions?: unknown };
  delete legacyDraft.factoryLifecycleDecisions;
  const legacyDecision = buildDecisionInputFromDraft(legacyDraft as typeof draft, fixture, state.currentPeriod);
  assert.equal(legacyDecision.factoryLifecycleDecisions, undefined);
});
