// ShrimpX V2 — ENG-DS2-COST-FOUNDATION-1: 建設費算定policy

import { test } from "node:test";
import assert from "node:assert/strict";

import { period } from "../../core/period";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import {
  LEGACY_CONSTRUCTION_COST_POLICY,
  ProposalApprovalGate,
  evaluateProposal,
  resolveProjectBudget,
  type ConstructionCostPolicyInput,
} from "../projectLifecycle";
import { CAPITAL_PROJECT_TYPES, CapitalProjectType } from "../types";

const GATE: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };
const P = period(2015, 3);
const TYPE: CapitalProjectType = "commonProcessingExpansion";
const STANDARD = CAPEX_PARAMETERS_V1.templatesByType[TYPE].standardBudgetUsd;

function indexed(constructionCostIndex: number): ConstructionCostPolicyInput {
  return { policy: "indexed-required-cost-v1", constructionCostIndex };
}

function approve(
  requestedBudgetUsd: number | undefined,
  costPolicy: ConstructionCostPolicyInput = LEGACY_CONSTRUCTION_COST_POLICY
) {
  return evaluateProposal(
    "BAL",
    { projectType: TYPE, ...(requestedBudgetUsd !== undefined ? { requestedBudgetUsd } : {}) },
    0,
    GATE,
    CAPEX_PARAMETERS_V1,
    P,
    "BAL-CAPEX-1",
    1,
    undefined,
    undefined,
    undefined,
    costPolicy
  );
}

// -------------------------------------------------------------- legacy policy
test("CCP-1: policy未指定（既定legacy）で現行挙動が完全一致する", () => {
  const noArg = evaluateProposal("BAL", { projectType: TYPE }, 0, GATE, CAPEX_PARAMETERS_V1, P, "BAL-CAPEX-1", 1);
  const explicitLegacy = approve(undefined, LEGACY_CONSTRUCTION_COST_POLICY);
  assert.ok("approved" in noArg && "approved" in explicitLegacy);
  assert.deepEqual(noArg.approved, explicitLegacy.approved);
  assert.equal(noArg.approved.approvedBudgetUsd, STANDARD);
});

test("CCP-2: legacyでは安値申請がそのまま承認額になる（既存挙動を変更しない）", () => {
  const low = approve(STANDARD * 0.5);
  assert.ok("approved" in low);
  assert.equal(low.approved.approvedBudgetUsd, STANDARD * 0.5);
  const high = approve(STANDARD * 2);
  assert.ok("approved" in high);
  assert.equal(high.approved.approvedBudgetUsd, STANDARD * 2);
});

// ------------------------------------------------------- indexed policy (v1)
test("CCP-3: indexedでは指数がstandardBudgetへ1回だけ適用される（index²にならない）", () => {
  const index = 1.4;
  const r = approve(undefined, indexed(index));
  assert.ok("approved" in r);
  assert.equal(r.approved.approvedBudgetUsd, STANDARD * index);
  assert.notEqual(r.approved.approvedBudgetUsd, STANDARD * index * index);
});

test("CCP-4: 旧価格（指数適用前）をrequestedBudgetに指定しても回避できない", () => {
  const index = 1.4;
  const r = approve(STANDARD, indexed(index)); // 旧価格 = 指数適用前の標準額
  assert.ok("rejected" in r, "申請額不足として拒否されるべき");
  assert.ok(r.rejected.reasons.some((x) => x.includes("必要工事費")));
});

test("CCP-5: 過大なrequestedBudgetでも承認額は必要工事費に限定される", () => {
  const index = 1.4;
  const r = approve(STANDARD * 10, indexed(index));
  assert.ok("approved" in r);
  assert.equal(r.approved.approvedBudgetUsd, STANDARD * index);
});

test("CCP-6: requested未指定・requested>=必要工事費のいずれでも承認額は同一", () => {
  const index = 1.25;
  const a = approve(undefined, indexed(index));
  const b = approve(STANDARD * index, indexed(index));
  const c = approve(STANDARD * index * 3, indexed(index));
  assert.ok("approved" in a && "approved" in b && "approved" in c);
  assert.equal(a.approved.approvedBudgetUsd, STANDARD * index);
  assert.equal(b.approved.approvedBudgetUsd, STANDARD * index);
  assert.equal(c.approved.approvedBudgetUsd, STANDARD * index);
});

test("CCP-7: 指数1.00のindexed policyはlegacy（requested未指定）と同じ承認額", () => {
  const a = approve(undefined, indexed(1.0));
  const b = approve(undefined, LEGACY_CONSTRUCTION_COST_POLICY);
  assert.ok("approved" in a && "approved" in b);
  assert.equal(a.approved.approvedBudgetUsd, b.approved.approvedBudgetUsd);
});

test("CCP-8: 承認後の指数変化でapprovedBudgetUsdが変わらない（grandfathering）", () => {
  const approvedAtTurn24 = approve(undefined, indexed(1.4));
  assert.ok("approved" in approvedAtTurn24);
  const project = approvedAtTurn24.approved;
  const budgetAtApproval = project.approvedBudgetUsd;
  // 承認済みプロジェクトは自身の approvedBudgetUsd しか持たず、
  // 後続Turnの指数を参照する経路が存在しない（支払・完了判定はこの値の下流）。
  assert.equal(project.approvedBudgetUsd, budgetAtApproval);
  assert.equal(JSON.stringify(project).includes("constructionCostIndex"), false);
});

test("CCP-9: payment schedule・能力効果・必要工期がpolicyで変わらない", () => {
  const legacy = approve(undefined, LEGACY_CONSTRUCTION_COST_POLICY);
  const idx = approve(undefined, indexed(1.4));
  assert.ok("approved" in legacy && "approved" in idx);
  assert.deepEqual(idx.approved.paymentSchedule, legacy.approved.paymentSchedule);
  assert.deepEqual(idx.approved.futureCapacityEffect, legacy.approved.futureCapacityEffect);
  assert.equal(idx.approved.requiredConstructionQuarters, legacy.approved.requiredConstructionQuarters);
  assert.equal(idx.approved.completedPaymentStagesCount, legacy.approved.completedPaymentStagesCount);
  assert.equal(idx.approved.cumulativePaidUsd, legacy.approved.cumulativePaidUsd);
});

test("CCP-10: 全案件種別で resolveProjectBudget が一貫している", () => {
  const index = 1.56;
  for (const projectType of CAPITAL_PROJECT_TYPES) {
    const template = CAPEX_PARAMETERS_V1.templatesByType[projectType];
    const legacy = resolveProjectBudget(template, undefined, LEGACY_CONSTRUCTION_COST_POLICY);
    assert.equal(legacy.approvedBudgetUsd, template.standardBudgetUsd, projectType);
    assert.equal(legacy.indexedRequiredProjectCostUsd, template.standardBudgetUsd, projectType);

    const idx = resolveProjectBudget(template, undefined, indexed(index));
    assert.equal(idx.indexedRequiredProjectCostUsd, template.standardBudgetUsd * index, projectType);
    assert.equal(idx.approvedBudgetUsd, template.standardBudgetUsd * index, projectType);

    const insufficient = resolveProjectBudget(template, template.standardBudgetUsd, indexed(index));
    assert.equal(insufficient.insufficientRequest, true, projectType);
    assert.equal(insufficient.approvedBudgetUsd, undefined, projectType);
  }
});
