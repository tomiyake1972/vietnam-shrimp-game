// ShrimpX V2 — 会社経営統合テスト環境 設備投資ドラフト操作 単体テスト（Phase 8B-3）
//
// capexDraftActions.ts（案件候補の追加・削除・重複検出・取消要求の追加/取り下げ）と、
// 既存のdecisionDraft.ts（buildInitialDraft/buildDecisionInputFromDraft）との
// 組み合わせが、他の意思決定項目（販売計画等）を一切壊さないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import {
  addCapexCancelRequestToDraft,
  addCapexProposalToDraft,
  isCancelRequestedInDraft,
  isDuplicateProjectTypeInDraft,
  removeCapexCancelRequestFromDraft,
  removeCapexProposalFromDraft,
} from "../capexDraftActions";

function baseConfig(): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed: "capex-draft-actions-001", turns: 8 };
}

function buildPlayerDraft() {
  const { state, fixtures } = initializeCompanyLab(baseConfig());
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);
  return { draft, fixture, state };
}

test("DRAFT-1: 自動方針は常に空の設備投資意思決定を返す（前提確認）", () => {
  const { draft } = buildPlayerDraft();
  assert.equal(draft.capexDecision.newProjectProposals.length, 0);
  assert.equal(draft.capexDecision.cancelRequests.length, 0);
  assert.equal(draft.capexDecision.resumeRequests.length, 0);
});

test("DRAFT-2: addCapexProposalToDraftで新規案件候補をドラフトへ追加できる", () => {
  const { draft } = buildPlayerDraft();
  const next = addCapexProposalToDraft(draft, "coldStorageExpansion");
  assert.equal(next.capexDecision.newProjectProposals.length, 1);
  assert.equal(next.capexDecision.newProjectProposals[0].projectType, "coldStorageExpansion");
  // 元のdraftはmutationされない。
  assert.equal(draft.capexDecision.newProjectProposals.length, 0);
});

test("DRAFT-3: removeCapexProposalFromDraftで指定indexの候補だけを削除できる", () => {
  let draft = buildPlayerDraft().draft;
  draft = addCapexProposalToDraft(draft, "hosoLineExpansion");
  draft = addCapexProposalToDraft(draft, "coldStorageExpansion");
  assert.equal(draft.capexDecision.newProjectProposals.length, 2);
  const next = removeCapexProposalFromDraft(draft, 0);
  assert.equal(next.capexDecision.newProjectProposals.length, 1);
  assert.equal(next.capexDecision.newProjectProposals[0].projectType, "coldStorageExpansion");
});

test("DRAFT-4: isDuplicateProjectTypeInDraftが同一projectTypeの重複追加を検出する（エンジン側は拒否しないため警告専用）", () => {
  let draft = buildPlayerDraft().draft;
  assert.equal(isDuplicateProjectTypeInDraft(draft, "vapLineExpansion"), false);
  draft = addCapexProposalToDraft(draft, "vapLineExpansion");
  assert.equal(isDuplicateProjectTypeInDraft(draft, "vapLineExpansion"), true);
  // 重複していても追加自体は妨げない（実装指示§5「禁止ではなく警告」）。
  const next = addCapexProposalToDraft(draft, "vapLineExpansion");
  assert.equal(next.capexDecision.newProjectProposals.length, 2);
});

test("DRAFT-5: addCapexCancelRequestToDraftは同一projectIdを二重追加しない", () => {
  let draft = buildPlayerDraft().draft;
  draft = addCapexCancelRequestToDraft(draft, "BAL-CAPEX-1");
  assert.equal(draft.capexDecision.cancelRequests.length, 1);
  draft = addCapexCancelRequestToDraft(draft, "BAL-CAPEX-1");
  assert.equal(draft.capexDecision.cancelRequests.length, 1, "同一projectIdの取消要求は重複登録されない");
  assert.equal(isCancelRequestedInDraft(draft, "BAL-CAPEX-1"), true);
});

test("DRAFT-6: removeCapexCancelRequestFromDraftで取消要求を取り下げられる", () => {
  let draft = buildPlayerDraft().draft;
  draft = addCapexCancelRequestToDraft(draft, "BAL-CAPEX-1");
  draft = removeCapexCancelRequestFromDraft(draft, "BAL-CAPEX-1");
  assert.equal(draft.capexDecision.cancelRequests.length, 0);
  assert.equal(isCancelRequestedInDraft(draft, "BAL-CAPEX-1"), false);
});

test("DRAFT-7: 設備投資候補を追加しても、販売計画等の他の意思決定項目はドラフト→送信変換で変化しない", () => {
  const { draft, fixture, state } = buildPlayerDraft();
  const before = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  const draftWithCapex = addCapexProposalToDraft(draft, "coldStorageExpansion");
  const after = buildDecisionInputFromDraft(draftWithCapex, fixture, state.currentPeriod);
  assert.deepEqual(after.salesPlans, before.salesPlans);
  assert.deepEqual(after.productionPlans, before.productionPlans);
  assert.deepEqual(after.workerAssignments, before.workerAssignments);
  assert.deepEqual(after.financingRequest, before.financingRequest);
  assert.equal(after.capexDecision.newProjectProposals.length, 1);
  assert.equal(after.capexDecision.newProjectProposals[0].projectType, "coldStorageExpansion");
});

test("DRAFT-8: 設備投資に関する意思決定がゼロ件のままでも、これまでどおり送信できる（回帰防止）", () => {
  const { draft, fixture, state } = buildPlayerDraft();
  const input = buildDecisionInputFromDraft(draft, fixture, state.currentPeriod);
  assert.equal(input.capexDecision.newProjectProposals.length, 0);
  assert.equal(input.capexDecision.cancelRequests.length, 0);
  assert.equal(input.capexDecision.resumeRequests.length, 0);
});
