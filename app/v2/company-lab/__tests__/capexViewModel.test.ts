// ShrimpX V2 — 会社経営統合テスト環境 設備投資UI 表示用データ層 単体テスト（Phase 8B-3）
//
// capexViewModel.ts（候補プレビュー・ポートフォリオ表示・ステータス判定）の
// 純粋関数を、companyLabランナーを経由せず直接検証する。実装指示§14の
// 「view-model/pure-function tests」に対応する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../lib/v2/core/period";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";
import { CAPITAL_PROJECT_TYPES, CapitalProject } from "../../../lib/v2/capex/types";
import {
  buildAllCapexCandidateViewModels,
  buildCapexCandidateViewModel,
  buildCapexPortfolioViewModel,
  computeCapexDisplayStatus,
  formatConstructionProgressLabel,
  isDuplicateProjectTypeInDraft,
} from "../capexViewModel";

const P0 = period(2016, 1);

test("VM-1: 全案件種別の候補が、正しい日本語表示名で得られる（Test15で新工場建設・PD省人化投資を追加し10種類）", () => {
  const candidates = buildAllCapexCandidateViewModels(P0);
  assert.equal(candidates.length, CAPITAL_PROJECT_TYPES.length);
  assert.equal(CAPITAL_PROJECT_TYPES.length, 10);
  for (const t of CAPITAL_PROJECT_TYPES) {
    const c = candidates.find((x) => x.projectType === t);
    assert.ok(c, `${t}の候補が存在する`);
    assert.equal(c!.displayName, CAPEX_PARAMETERS_V1.templatesByType[t].displayName);
  }
});

test("VM-2（実装指示§16の数値検証）: coldStorageExpansion候補の投資額・建物/機械配分・四半期減価償却がテンプレート値と厳密に一致する", () => {
  const c = buildCapexCandidateViewModel("coldStorageExpansion", P0);
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  assert.equal(template.standardBudgetUsd, 2_500_000, "テンプレートの標準投資額が2,500,000USDであることが前提");
  assert.equal(c.totalInvestmentUsd, 2_500_000);
  assert.equal(c.buildingRatio, 0.4);
  assert.equal(c.machineryRatio, 0.6);
  assert.equal(c.totalInvestmentUsd * c.buildingRatio, 1_000_000);
  assert.equal(c.totalInvestmentUsd * c.machineryRatio, 1_500_000);
  assert.ok(Math.abs(c.quarterlyBuildingDepreciationUsd - 10_000) < 1e-6, `建物四半期償却費が10,000USD（実際: ${c.quarterlyBuildingDepreciationUsd}）`);
  assert.ok(Math.abs(c.quarterlyMachineryDepreciationUsd - 37_500) < 1e-6, `機械四半期償却費が37,500USD（実際: ${c.quarterlyMachineryDepreciationUsd}）`);
  assert.ok(Math.abs(c.quarterlyTotalDepreciationUsd - 47_500) < 1e-6, `合計四半期償却費が47,500USD（実際: ${c.quarterlyTotalDepreciationUsd}）`);
});

test("VM-3: 案件種別ごとの支払スケジュールは、テンプレートのpaymentRatios×投資額に一致し、合計は投資総額に一致する", () => {
  for (const t of CAPITAL_PROJECT_TYPES) {
    const c = buildCapexCandidateViewModel(t, P0);
    const template = CAPEX_PARAMETERS_V1.templatesByType[t];
    assert.equal(c.paymentScheduleUsd.length, template.paymentRatios.length);
    template.paymentRatios.forEach((r, i) => {
      assert.ok(Math.abs(c.paymentScheduleUsd[i] - r * c.totalInvestmentUsd) < 1e-6);
    });
    const sum = c.paymentScheduleUsd.reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - c.totalInvestmentUsd) < 1e-6);
    assert.equal(c.thisQuarterExpectedPaymentUsd, c.paymentScheduleUsd[0]);
  }
});

test("VM-4: coldStorageExpansionの完成予定・稼働開始予定四半期が、標準工期(2四半期)・readiness(1四半期)から正しく導出される", () => {
  const c = buildCapexCandidateViewModel("coldStorageExpansion", P0);
  // 提出2016Q1、工期2四半期（1回目支払=2016Q1、2回目支払=2016Q2で完成） → 完成2016Q2。
  assert.equal(c.expectedCompletionPeriod, period(2016, 2));
  // 稼働開始 = 完成の翌四半期(2016Q3) + readiness(1) = 2016Q4。
  assert.equal(c.expectedOperationalStartPeriod, period(2016, 4));
});

test("VM-5: qualityControlEquipmentは機械100%・建物0%（能力増加なし）", () => {
  const c = buildCapexCandidateViewModel("qualityControlEquipment", P0);
  assert.equal(c.buildingRatio, 0);
  assert.equal(c.machineryRatio, 1);
  assert.equal(c.capacityIncreaseTonsPerQuarter, 0);
  assert.equal(c.targetProductLabel, undefined);
});

test("VM-6: requestedBudgetUsdを指定すると、その額を基準にプレビューが再計算される（テンプレート標準額を上書き）", () => {
  const standard = buildCapexCandidateViewModel("hosoLineExpansion", P0);
  const custom = buildCapexCandidateViewModel("hosoLineExpansion", P0, CAPEX_PARAMETERS_V1, 6_000_000);
  assert.equal(custom.totalInvestmentUsd, 6_000_000);
  assert.notEqual(custom.totalInvestmentUsd, standard.totalInvestmentUsd);
  assert.ok(Math.abs(custom.quarterlyBuildingDepreciationUsd - (6_000_000 * custom.buildingRatio) / custom.buildingUsefulLifeQuarters) < 1e-6);
});

function makeApprovedProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  const template = CAPEX_PARAMETERS_V1.templatesByType.environmentalEquipment;
  return {
    projectId: "TEST-1",
    companyId: "BAL",
    projectType: "environmentalEquipment",
    approvedBudgetUsd: template.standardBudgetUsd,
    paymentSchedule: template.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    completedPaymentStagesCount: 0,
    cumulativePaidUsd: 0,
    elapsedConstructionQuartersWithPayment: 0,
    requiredConstructionQuarters: template.standardConstructionQuarters,
    status: "approved",
    proposedPeriod: P0,
    approvedPeriod: P0,
    priority: 1,
    futureCapacityEffect: template.futureCapacityEffect,
    lastDiagnosticReasons: [],
    ...overrides,
  };
}

test("VM-7: ステータス表示 — approved/underConstruction/suspended/cancelledはCapitalProject.statusをそのまま反映する", () => {
  assert.equal(computeCapexDisplayStatus(makeApprovedProject({ status: "approved" }), P0), "planned");
  assert.equal(computeCapexDisplayStatus(makeApprovedProject({ status: "underConstruction" }), P0), "underConstruction");
  assert.equal(computeCapexDisplayStatus(makeApprovedProject({ status: "suspended" }), P0), "suspended");
  assert.equal(computeCapexDisplayStatus(makeApprovedProject({ status: "cancelled" }), P0), "cancelled");
});

test("VM-8: 完成済みだが稼働開始前は「完成・操業準備中」、稼働開始四半期以降は「稼働中」と、completedPeriodとoperationalStartPeriodを区別して表示する", () => {
  const completed = makeApprovedProject({
    status: "completed",
    completedPeriod: period(2016, 2),
    capitalizedAmountUsd: 1_800_000,
    cumulativePaidUsd: 1_800_000,
    completedPaymentStagesCount: 2,
    elapsedConstructionQuartersWithPayment: 2,
  });
  // environmentalEquipmentのreadiness=0 → operationalStartPeriod = 2016Q3。
  assert.equal(computeCapexDisplayStatus(completed, period(2016, 2)), "completedPreparing", "完成四半期そのものはまだ操業準備中");
  assert.equal(computeCapexDisplayStatus(completed, period(2016, 3)), "operating", "稼働開始四半期からは稼働中");
});

test("VM-9: 建設中案件の進捗率（constructionProgressRatio）が正しく計算される（例: 4四半期中2四半期経過で50%）", () => {
  const template = CAPEX_PARAMETERS_V1.templatesByType.vapLineExpansion; // 標準工期4四半期
  assert.equal(template.standardConstructionQuarters, 4);
  const project = makeApprovedProject({
    projectId: "VAP-PROJ-1",
    projectType: "vapLineExpansion",
    approvedBudgetUsd: template.standardBudgetUsd,
    paymentSchedule: template.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    requiredConstructionQuarters: template.standardConstructionQuarters,
    futureCapacityEffect: template.futureCapacityEffect,
    status: "underConstruction",
    completedPaymentStagesCount: 2,
    elapsedConstructionQuartersWithPayment: 2,
    cumulativePaidUsd: template.standardBudgetUsd * (template.paymentRatios[0] + template.paymentRatios[1]),
    constructionStartedPeriod: P0,
  });
  const rows = buildCapexPortfolioViewModel([project], CAPEX_PARAMETERS_V1, period(2016, 3));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].constructionProgressRatio !== undefined);
  assert.ok(Math.abs(rows[0].constructionProgressRatio! - 0.5) < 1e-9, `進捗率が0.5であるはず（実際: ${rows[0].constructionProgressRatio}）`);
  const label = formatConstructionProgressLabel(rows[0], project);
  assert.match(label, /4四半期の工期中 2四半期経過/);
  assert.match(label, /50/);
});

test("VM-10: cancellableはcumulativePaidUsd===0かつ完成/取消済みでない案件のみtrue（applyCancelRequestの実際の許可条件と同一）", () => {
  const cancellableProject = makeApprovedProject({ status: "approved", cumulativePaidUsd: 0 });
  const paidProject = makeApprovedProject({ projectId: "PAID-1", status: "underConstruction", cumulativePaidUsd: 900_000, completedPaymentStagesCount: 1, elapsedConstructionQuartersWithPayment: 1 });
  const completedProject = makeApprovedProject({
    projectId: "DONE-1",
    status: "completed",
    completedPeriod: period(2016, 1),
    capitalizedAmountUsd: 1_800_000,
    cumulativePaidUsd: 1_800_000,
    completedPaymentStagesCount: 2,
    elapsedConstructionQuartersWithPayment: 2,
  });
  const rows = buildCapexPortfolioViewModel([cancellableProject, paidProject, completedProject], CAPEX_PARAMETERS_V1, P0);
  const byId = new Map(rows.map((r) => [r.projectId, r]));
  assert.equal(byId.get("TEST-1")!.cancellable, true);
  assert.equal(byId.get("PAID-1")!.cancellable, false);
  assert.equal(byId.get("DONE-1")!.cancellable, false);
});

test("VM-11: 複数案件を渡しても、各案件の減価償却・保守費は独立して計算され、他案件の値と混線しない", () => {
  const coldTemplate = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const qcTemplate = CAPEX_PARAMETERS_V1.templatesByType.qualityControlEquipment;
  const coldProject = makeApprovedProject({
    projectId: "COLD-1",
    projectType: "coldStorageExpansion",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: coldTemplate.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    requiredConstructionQuarters: coldTemplate.standardConstructionQuarters,
    futureCapacityEffect: coldTemplate.futureCapacityEffect,
    status: "completed",
    completedPeriod: period(2016, 2),
    capitalizedAmountUsd: 2_500_000,
    cumulativePaidUsd: 2_500_000,
    completedPaymentStagesCount: 2,
    elapsedConstructionQuartersWithPayment: 2,
  });
  const qcProject = makeApprovedProject({
    projectId: "QC-1",
    projectType: "qualityControlEquipment",
    approvedBudgetUsd: 1_200_000,
    paymentSchedule: qcTemplate.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio })),
    requiredConstructionQuarters: qcTemplate.standardConstructionQuarters,
    futureCapacityEffect: qcTemplate.futureCapacityEffect,
    status: "completed",
    completedPeriod: period(2016, 1),
    capitalizedAmountUsd: 1_200_000,
    cumulativePaidUsd: 1_200_000,
    completedPaymentStagesCount: 2,
    elapsedConstructionQuartersWithPayment: 2,
  });
  const evalPeriod = period(2016, 4);
  const rows = buildCapexPortfolioViewModel([coldProject, qcProject], CAPEX_PARAMETERS_V1, evalPeriod);
  const cold = rows.find((r) => r.projectId === "COLD-1")!;
  const qc = rows.find((r) => r.projectId === "QC-1")!;
  assert.ok(Math.abs(cold.quarterlyDepreciationUsd - 47_500) < 1e-6, `coldStorageの減価償却が単独計算と一致（実際: ${cold.quarterlyDepreciationUsd}）`);
  assert.ok(Math.abs(qc.quarterlyDepreciationUsd - 1_200_000 / 40) < 1e-6, `qualityControlの減価償却が単独計算と一致（実際: ${qc.quarterlyDepreciationUsd}）`);
  assert.notEqual(cold.quarterlyDepreciationUsd, qc.quarterlyDepreciationUsd);
});

test("VM-12: 未知・欠損値（completedPeriod未定義など）でも画面表示関数が例外を投げない", () => {
  const proposedLikeProject = makeApprovedProject({ status: "approved", cumulativePaidUsd: 0 });
  assert.doesNotThrow(() => buildCapexPortfolioViewModel([proposedLikeProject], CAPEX_PARAMETERS_V1, P0));
  const rows = buildCapexPortfolioViewModel([proposedLikeProject], CAPEX_PARAMETERS_V1, P0);
  assert.equal(rows[0].operationalStartPeriod, undefined);
  assert.equal(rows[0].isCapacityReflected, false);
});

test("VM-13: isDuplicateProjectTypeInDraft（旧版・candidateViewModel向け）が同一projectTypeの重複を検出する", () => {
  const proposals = [{ projectType: "hosoLineExpansion" as const }];
  assert.equal(isDuplicateProjectTypeInDraft(proposals, "hosoLineExpansion"), true);
  assert.equal(isDuplicateProjectTypeInDraft(proposals, "pdLineExpansion"), false);
});

test("VM-14（回帰防止・不変性）: buildCapexPortfolioViewModelに渡した元のCapitalProject配列・オブジェクトはmutationされない", () => {
  const project = makeApprovedProject({ status: "underConstruction", cumulativePaidUsd: 300_000, completedPaymentStagesCount: 1, elapsedConstructionQuartersWithPayment: 1 });
  const snapshot = JSON.parse(JSON.stringify(project));
  buildCapexPortfolioViewModel([project], CAPEX_PARAMETERS_V1, period(2016, 2));
  assert.deepEqual(JSON.parse(JSON.stringify(project)), snapshot);
});
