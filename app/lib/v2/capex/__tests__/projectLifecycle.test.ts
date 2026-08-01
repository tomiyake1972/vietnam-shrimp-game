// ShrimpX V2 — 設備投資モジュール 案件ライフサイクル テスト（Phase 8B-2A）
//
// 対応する実装指示の必須テスト項目:
//   1. 状態遷移（proposed→approved→underConstruction→completed、suspended往復、cancelled）
//   2. 分割払い（all-or-nothing）
//   3. 建設期間の算出（支払成功四半期数ベース、suspendedは進まない）
//   4. 複数案件（同時進行上限・優先順位付け）
//   5. 資金制約（不足時の見送り・再開要求）
//   7. Phase 8B-2Bとの境界（futureCapacityEffectはテンプレートから機械的にコピー
//      されるのみで、本モジュールのどのロジックからも参照されないことを
//      コメントで明記。参照していないことはコード全体のgrep調査で確認済み
//      （完了報告参照）。ここでは値がテンプレートと一致することだけを検証する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { CAPEX_PARAMETERS_V1 } from "../parameters";
import {
  applyCancelRequest,
  attemptPayment,
  buildPaymentQueue,
  evaluateProposal,
  isActiveStatus,
  ProposalApprovalGate,
  validateResumeRequest,
} from "../projectLifecycle";
import { CapexProjectProposalInput, CapexValidationError, CapitalProject } from "../types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const HEALTHY_GATE: ProposalApprovalGate = { borrowingCapacityFrozen: false, severelyDistressed: false };

function proposal(overrides: Partial<CapexProjectProposalInput> = {}): CapexProjectProposalInput {
  return { projectType: "coldStorageExpansion", ...overrides };
}

function approve(
  index = 0,
  activeCount = 0,
  gate: ProposalApprovalGate = HEALTHY_GATE,
  p: CapexProjectProposalInput = proposal()
): CapitalProject {
  const outcome = evaluateProposal("TEST", p, activeCount, gate, CAPEX_PARAMETERS_V1, P1, `TEST-CAPEX-${index + 1}`, index + 1);
  assert.ok("approved" in outcome, "承認されるはずの提案が拒否された");
  return (outcome as { approved: CapitalProject }).approved;
}

// ---------------------------------------------------------------------
// 1. 状態遷移
// ---------------------------------------------------------------------

test("受入確認CX-1: 承認された提案はstatus=approved・cumulativePaidUsd=0・completedPaymentStagesCount=0で登録される", () => {
  const project = approve();
  assert.equal(project.status, "approved");
  assert.equal(project.cumulativePaidUsd, 0);
  assert.equal(project.completedPaymentStagesCount, 0);
  assert.equal(project.approvedPeriod, P1);
});

test("受入確認CX-2: 初回の分割払いが成功するとstatus=approved→underConstructionへ遷移し、constructionStartedPeriodが記録される", () => {
  const project = approve();
  const result = attemptPayment(project, project.approvedBudgetUsd, P1, CAPEX_PARAMETERS_V1);
  assert.equal(result.updatedProject.status, "underConstruction");
  assert.equal(result.updatedProject.constructionStartedPeriod, P1);
  assert.equal(result.updatedProject.completedPaymentStagesCount, 1);
});

test("受入確認CX-3: 最終分割払いが成功するとstatus=completedへ遷移し、capitalizedAmountUsd=cumulativePaidUsd=approvedBudgetUsdとなる", () => {
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion; // paymentRatios.length=2
  let project = approve();
  let p = period(2015, 1);
  for (let i = 0; i < template.paymentRatios.length; i++) {
    const attempt = attemptPayment(project, project.approvedBudgetUsd, p, CAPEX_PARAMETERS_V1);
    project = attempt.updatedProject;
    p = period(2015, i + 2);
  }
  assert.equal(project.status, "completed");
  assert.equal(project.completedPaymentStagesCount, template.paymentRatios.length);
  assert.ok(project.completedPeriod !== undefined);
  assert.ok(project.capitalizedAmountUsd !== undefined);
  assert.ok(Math.abs((project.capitalizedAmountUsd as number) - project.cumulativePaidUsd) < 1e-6);
  assert.ok(Math.abs(project.cumulativePaidUsd - project.approvedBudgetUsd) < 1e-6);
});

test("受入確認CX-4: 着工後に資金不足になるとstatus=underConstruction→suspendedへ遷移する", () => {
  const project = approve();
  const started = attemptPayment(project, project.approvedBudgetUsd, P1, CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(started.status, "underConstruction");
  const suspended = attemptPayment(started, 0, P2, CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(suspended.status, "suspended");
  // suspended中はcompletedPaymentStagesCount・cumulativePaidUsdが変化しない。
  assert.equal(suspended.completedPaymentStagesCount, started.completedPaymentStagesCount);
  assert.equal(suspended.cumulativePaidUsd, started.cumulativePaidUsd);
});

test("受入確認CX-5: 支払実績なし（cumulativePaidUsd=0）の案件は取消できる（status=cancelled、cancelledPeriod記録）", () => {
  const project = approve();
  const [cancelled] = applyCancelRequest([project], { projectId: project.projectId }, P2);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledPeriod, P2);
});

test("受入確認CX-6: 支払済み（cumulativePaidUsd>0）の案件を取消しようとするとCapexValidationErrorを投げる", () => {
  const project = approve();
  const started = attemptPayment(project, project.approvedBudgetUsd, P1, CAPEX_PARAMETERS_V1).updatedProject;
  assert.ok(started.cumulativePaidUsd > 0);
  assert.throws(() => applyCancelRequest([started], { projectId: started.projectId }, P2), CapexValidationError);
});

test("受入確認CX-7: 存在しない案件IDへの取消/再開要求はいずれもCapexValidationErrorを投げる", () => {
  assert.throws(() => applyCancelRequest([], { projectId: "NOPE" }, P1), CapexValidationError);
  assert.throws(() => validateResumeRequest([], { projectId: "NOPE" }), CapexValidationError);
});

test("受入確認CX-8: suspended以外の案件への再開要求はCapexValidationErrorを投げる（approved状態で試す）", () => {
  const project = approve();
  assert.throws(() => validateResumeRequest([project], { projectId: project.projectId }), CapexValidationError);
});

test("受入確認CX-9: 完成済み・取消済みの案件への取消要求はCapexValidationErrorを投げる", () => {
  const approved = approve();
  const [cancelled] = applyCancelRequest([approved], { projectId: approved.projectId }, P1);
  assert.throws(() => applyCancelRequest([cancelled], { projectId: cancelled.projectId }, P2), CapexValidationError);
});

// ---------------------------------------------------------------------
// 2. 分割払い（all-or-nothing）
// ---------------------------------------------------------------------

test("受入確認CX-10: 分割払いは全額でなければ一切支払われない（1ドル不足でも0が支払われ、進捗は進まない）", () => {
  const project = approve();
  const stageAmount = project.approvedBudgetUsd * project.paymentSchedule[0].plannedRatio;
  const result = attemptPayment(project, stageAmount - 1, P1, CAPEX_PARAMETERS_V1);
  assert.equal(result.cashSpentUsd, 0);
  assert.equal(result.updatedProject.completedPaymentStagesCount, 0);
  assert.equal(result.updatedProject.cumulativePaidUsd, 0);
  assert.equal(result.event.paymentSucceededUsd, 0);
});

test("受入確認CX-11: 分割払いが成功すると、支払額は必ずapprovedBudgetUsd×そのstageのplannedRatioと厳密に一致する", () => {
  const project = approve();
  const expected = project.approvedBudgetUsd * project.paymentSchedule[0].plannedRatio;
  const result = attemptPayment(project, project.approvedBudgetUsd, P1, CAPEX_PARAMETERS_V1);
  assert.ok(Math.abs(result.cashSpentUsd - expected) < 1e-6);
  assert.ok(Math.abs(result.updatedProject.cumulativePaidUsd - expected) < 1e-6);
});

test("受入確認CX-12: 全案件種別で、テンプレートの予定支払比率の合計は1.0（提案評価が例外を投げない）", () => {
  for (const projectType of Object.keys(CAPEX_PARAMETERS_V1.templatesByType) as (keyof typeof CAPEX_PARAMETERS_V1.templatesByType)[]) {
    // 【Test15】pdMechanizationはtargetFactoryId必須（projectLifecycle.tsのバリデーション）。
    const extra = projectType === "pdMechanization" ? { targetFactoryId: "F-TEST" } : {};
    const project = approve(0, 0, HEALTHY_GATE, proposal({ projectType, ...extra }));
    const sum = project.paymentSchedule.reduce((s, st) => s + st.plannedRatio, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `${projectType}: 予定支払比率合計 ${sum}`);
  }
});

// ---------------------------------------------------------------------
// 3. 建設期間の算出
// ---------------------------------------------------------------------

test("受入確認CX-13: elapsedConstructionQuartersWithPaymentは支払成功四半期数だけを数え、suspended（支払見送り）の四半期は増えない", () => {
  let project = approve(0, 0, HEALTHY_GATE, proposal({ projectType: "vapLineExpansion" })); // 4段階
  // Q1: 成功 → elapsed=1
  project = attemptPayment(project, project.approvedBudgetUsd, period(2015, 1), CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(project.elapsedConstructionQuartersWithPayment, 1);
  // Q2: 資金不足 → suspended、elapsedは増えない
  project = attemptPayment(project, 0, period(2015, 2), CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(project.status, "suspended");
  assert.equal(project.elapsedConstructionQuartersWithPayment, 1);
  // Q3: 再開成功 → elapsed=2（suspendedだった四半期はカウントされない）
  project = attemptPayment(project, project.approvedBudgetUsd, period(2015, 3), CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(project.status, "underConstruction");
  assert.equal(project.elapsedConstructionQuartersWithPayment, 2);
});

test("受入確認CX-14: 完成は「暦上の完成予定期」ではなく「全stage支払完了かつ必要四半期数到達」で決まる（中断があれば完成が遅れる）", () => {
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion; // 2段階、標準2四半期
  let project = approve();
  // Q1成功、Q2見送り（suspended）、Q3再開成功で完成（暦上は2四半期だが実際は3四半期かかる）
  project = attemptPayment(project, project.approvedBudgetUsd, period(2015, 1), CAPEX_PARAMETERS_V1).updatedProject;
  assert.notEqual(project.status, "completed");
  project = attemptPayment(project, 0, period(2015, 2), CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(project.status, "suspended");
  project = attemptPayment(project, project.approvedBudgetUsd, period(2015, 3), CAPEX_PARAMETERS_V1).updatedProject;
  assert.equal(project.status, "completed");
  assert.equal(project.completedPeriod, period(2015, 3));
  assert.equal(project.elapsedConstructionQuartersWithPayment, template.paymentRatios.length);
});

// ---------------------------------------------------------------------
// 4. 複数案件（同時進行上限・優先順位付け）
// ---------------------------------------------------------------------

test("受入確認CX-15: 同時進行中案件数が上限に達すると、以降の新規提案は承認拒否される（会社ID非依存）", () => {
  const cap = CAPEX_PARAMETERS_V1.maxConcurrentActiveProjectsPerCompany;
  const outcome = evaluateProposal("ANY_COMPANY", proposal(), cap, HEALTHY_GATE, CAPEX_PARAMETERS_V1, P1, "X-1", 1);
  assert.ok("rejected" in outcome);
  if ("rejected" in outcome) {
    assert.ok(outcome.rejected.reasons.some((r) => r.includes("上限")));
  }
});

test("受入確認CX-16: 銀行引受停止・重大資金繰り状態のいずれかがtrueなら新規承認は拒否される（会社ID非依存の一様な規則）", () => {
  for (const gate of [
    { borrowingCapacityFrozen: true, severelyDistressed: false },
    { borrowingCapacityFrozen: false, severelyDistressed: true },
  ]) {
    const outcome = evaluateProposal("ANY_COMPANY", proposal(), 0, gate, CAPEX_PARAMETERS_V1, P1, "X-1", 1);
    assert.ok("rejected" in outcome, JSON.stringify(gate));
  }
});

test("受入確認CX-17: 支払優先順位付けはunderConstruction→再開要求ありのsuspended→approved（承認四半期の古い順）の順になる", () => {
  const older = { ...approve(0, 0, HEALTHY_GATE, proposal()), approvedPeriod: period(2015, 1), projectId: "P-OLD" };
  const newer = { ...approve(1, 0, HEALTHY_GATE, proposal()), approvedPeriod: period(2015, 2), projectId: "P-NEW" };
  const underConstruction: CapitalProject = { ...approve(2, 0, HEALTHY_GATE, proposal()), projectId: "P-UC", status: "underConstruction" };
  const suspendedWithResume: CapitalProject = { ...approve(3, 0, HEALTHY_GATE, proposal()), projectId: "P-SUS", status: "suspended" };
  const suspendedNoResume: CapitalProject = { ...approve(4, 0, HEALTHY_GATE, proposal()), projectId: "P-SUS-NO", status: "suspended" };

  const queue = buildPaymentQueue([newer, older, suspendedNoResume, suspendedWithResume, underConstruction], new Set(["P-SUS"]));
  assert.deepEqual(queue.map((p) => p.projectId), ["P-UC", "P-SUS", "P-OLD", "P-NEW"]);
});

test("受入確認CX-18: isActiveStatusはapproved/underConstruction/suspendedのみtrue（completed/cancelledはfalse）", () => {
  assert.equal(isActiveStatus("approved"), true);
  assert.equal(isActiveStatus("underConstruction"), true);
  assert.equal(isActiveStatus("suspended"), true);
  assert.equal(isActiveStatus("completed"), false);
  assert.equal(isActiveStatus("cancelled"), false);
  assert.equal(isActiveStatus("proposed"), false);
});

// ---------------------------------------------------------------------
// 5. 資金制約
// ---------------------------------------------------------------------

test("受入確認CX-19: 要求予算が0以下・非有限の提案は拒否される（NaNやInfinityが承認されない）", () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    const outcome = evaluateProposal("TEST", proposal({ requestedBudgetUsd: bad }), 0, HEALTHY_GATE, CAPEX_PARAMETERS_V1, P1, "X-1", 1);
    assert.ok("rejected" in outcome, `requestedBudgetUsd=${bad}`);
  }
});

test("受入確認CX-20: 未知の投資案件種別を提案するとCapexValidationErrorを投げる（構造的誤用）", () => {
  assert.throws(
    () => evaluateProposal("TEST", { projectType: "unknownType" as unknown as CapexProjectProposalInput["projectType"] }, 0, HEALTHY_GATE, CAPEX_PARAMETERS_V1, P1, "X-1", 1),
    CapexValidationError
  );
});

// ---------------------------------------------------------------------
// 7. Phase 8B-2Bとの境界（futureCapacityEffectは機械的にコピーされるだけ）
// ---------------------------------------------------------------------

test("受入確認CX-21: 承認された案件のfutureCapacityEffectはテンプレートの値と一致する（Phase 8B-2A中は一切参照・使用しない予約フィールド）", () => {
  const project = approve(0, 0, HEALTHY_GATE, proposal({ projectType: "vapLineExpansion" }));
  const template = CAPEX_PARAMETERS_V1.templatesByType.vapLineExpansion;
  assert.deepEqual(project.futureCapacityEffect, template.futureCapacityEffect);
});

// ---------------------------------------------------------------------
// 8. PD省人化投資（pdMechanization、Test15新設）— targetFactoryId必須・
//    Factory単位で高々1件までの制約
// ---------------------------------------------------------------------

test("受入確認CX-22: pdMechanization提案はtargetFactoryId未指定だと拒否される", () => {
  const outcome = evaluateProposal("TEST", proposal({ projectType: "pdMechanization" }), 0, HEALTHY_GATE, CAPEX_PARAMETERS_V1, P1, "X-1", 1);
  assert.ok("rejected" in outcome);
  if ("rejected" in outcome) {
    assert.ok(outcome.rejected.reasons.some((r) => r.includes("targetFactoryId")));
  }
});

test("受入確認CX-23: pdMechanization提案はtargetFactoryIdを指定すれば承認され、承認後のCapitalProject.targetFactoryIdへスナップショットされる", () => {
  const project = approve(0, 0, HEALTHY_GATE, proposal({ projectType: "pdMechanization", targetFactoryId: "F1" }));
  assert.equal(project.targetFactoryId, "F1");
  assert.equal(project.approvedBudgetUsd, 2_500_000);
});

test("受入確認CX-24: 同一Factoryを対象とする進行中のpdMechanization案件があるときは、新規提案がmechanizationGate経由で拒否される", () => {
  const outcome = evaluateProposal(
    "TEST",
    proposal({ projectType: "pdMechanization", targetFactoryId: "F1" }),
    0,
    HEALTHY_GATE,
    CAPEX_PARAMETERS_V1,
    P1,
    "X-2",
    2,
    undefined,
    undefined,
    { hasActiveProjectForSameFactory: true }
  );
  assert.ok("rejected" in outcome);
  if ("rejected" in outcome) {
    assert.ok(outcome.rejected.reasons.some((r) => r.includes("F1")));
  }
});

test("受入確認CX-25: 別のFactoryを対象とするpdMechanization提案は、他Factoryの進行中案件の有無に影響されず承認される", () => {
  const outcome = evaluateProposal(
    "TEST",
    proposal({ projectType: "pdMechanization", targetFactoryId: "F2" }),
    0,
    HEALTHY_GATE,
    CAPEX_PARAMETERS_V1,
    P1,
    "X-3",
    3,
    undefined,
    undefined,
    { hasActiveProjectForSameFactory: false }
  );
  assert.ok("approved" in outcome);
});
