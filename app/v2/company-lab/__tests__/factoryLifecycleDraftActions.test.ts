// ShrimpX V2 — Player工場操作Phase 1: factoryLifecycleDraftActions.ts のテスト
//
// 単純な配列の置き換えヘルパーであることを確認する（計算ロジックを持たない）。
// 特に、Worker/Sales等の他のドラフト項目に一切触れないこと（実装指示§12・§13の
// 「自動変更禁止」の裏付け）を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { buildInitialDraft } from "../decisionDraft";
import { findFactoryLifecycleDecisionInDraft, setFactoryLifecycleDecisionInDraft } from "../factoryLifecycleDraftActions";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "factory-draft-actions-001", turns: 8, ...overrides };
}

function buildBaseDraft() {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return { draft: buildInitialDraft(fixture, autoDecision), fixture };
}

test("FAC-DRAFT-1: 未選択の工場へMOTHBALL_FACTORYを設定すると、その工場のdecisionが見つかる", () => {
  const { draft, fixture } = buildBaseDraft();
  const factoryId = fixture.factories[0].factoryId;
  const next = setFactoryLifecycleDecisionInDraft(draft, factoryId, "MOTHBALL_FACTORY");
  const found = findFactoryLifecycleDecisionInDraft(next, factoryId);
  assert.deepEqual(found, { factoryId, type: "MOTHBALL_FACTORY" });
});

test("FAC-DRAFT-2: 同一工場に別のtypeを設定すると、既存の選択を置き換える（同時に2件持たない）", () => {
  const { draft, fixture } = buildBaseDraft();
  const factoryId = fixture.factories[0].factoryId;
  const withMothball = setFactoryLifecycleDecisionInDraft(draft, factoryId, "MOTHBALL_FACTORY");
  const withSell = setFactoryLifecycleDecisionInDraft(withMothball, factoryId, "SELL_FACTORY");
  assert.equal(withSell.factoryLifecycleDecisions?.length, 1);
  assert.deepEqual(findFactoryLifecycleDecisionInDraft(withSell, factoryId), { factoryId, type: "SELL_FACTORY" });
});

test("FAC-DRAFT-3: typeにnullを渡すと未選択に戻る（「何もしない」）", () => {
  const { draft, fixture } = buildBaseDraft();
  const factoryId = fixture.factories[0].factoryId;
  const withMothball = setFactoryLifecycleDecisionInDraft(draft, factoryId, "MOTHBALL_FACTORY");
  const cleared = setFactoryLifecycleDecisionInDraft(withMothball, factoryId, null);
  assert.equal(findFactoryLifecycleDecisionInDraft(cleared, factoryId), undefined);
  assert.equal(cleared.factoryLifecycleDecisions?.length, 0);
});

test("FAC-DRAFT-4: ある工場への選択は、別工場の選択に影響しない", () => {
  const { draft, fixture } = buildBaseDraft();
  const factoryA = fixture.factories[0].factoryId;
  const withA = setFactoryLifecycleDecisionInDraft(draft, factoryA, "MOTHBALL_FACTORY");
  const withAAndB = setFactoryLifecycleDecisionInDraft(withA, "other-factory-not-owned", "SELL_FACTORY");
  assert.deepEqual(findFactoryLifecycleDecisionInDraft(withAAndB, factoryA), { factoryId: factoryA, type: "MOTHBALL_FACTORY" });
  assert.deepEqual(findFactoryLifecycleDecisionInDraft(withAAndB, "other-factory-not-owned"), { factoryId: "other-factory-not-owned", type: "SELL_FACTORY" });
});

test("FAC-DRAFT-5【実装指示§12・§13】: Factory Lifecycle選択はworkerAssignments/salesPlans/productionPlansを一切変更しない", () => {
  const { draft, fixture } = buildBaseDraft();
  const factoryId = fixture.factories[0].factoryId;
  const next = setFactoryLifecycleDecisionInDraft(draft, factoryId, "MOTHBALL_FACTORY");
  assert.deepEqual(next.workerAssignments, draft.workerAssignments, "Worker配置は自動変更されない");
  assert.deepEqual(next.salesPlans, draft.salesPlans, "販売計画（既存受注契約に相当する意思決定）は自動変更されない");
  assert.deepEqual(next.productionPlans, draft.productionPlans, "生産計画は自動変更されない");
});
