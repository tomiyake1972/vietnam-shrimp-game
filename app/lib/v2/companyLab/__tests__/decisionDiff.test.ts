// ShrimpX V2 — feature/v2-persist-standard-ai-proposal（Phase A）
// computeDecisionDiffSummary（Standard AI原案 vs 実際の提出の差分計算）の単体テスト。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../sales/types";
import { hosoEqTons, ratio } from "../../core/units";
import { CompanyDecisionInput } from "../types";
import { computeDecisionDiffSummary } from "../decisionDiff";

const COMPANY_ID = "BAL" as CompanyId;

function baseDecision(overrides: Partial<CompanyDecisionInput> = {}): CompanyDecisionInput {
  return {
    companyId: COMPANY_ID,
    salesPlans: [
      {
        companyId: COMPANY_ID,
        market: "CN",
        product: "hoso",
        desiredQuantity: hosoEqTons(100),
        priceAdjustmentUsdPerHosoEqKg: 0,
        salesForceHeadcount: 2,
      },
    ],
    domesticPurchasePlan: {
      companyId: COMPANY_ID,
      desiredQuantity: hosoEqTons(500),
      priceAdjustmentUsdPerHosoEqKg: 0,
      procurementHeadcount: 3,
    },
    importOrders: [],
    aquacultureStockingPlans: [],
    productionPlans: [
      { companyId: COMPANY_ID, factoryId: "BAL-F1", product: "hoso", desiredQuantity: hosoEqTons(400), priority: 1 },
    ],
    workerAssignments: [
      {
        factoryId: "BAL-F1",
        companyId: COMPANY_ID,
        regularHeadcount: 6000,
        temporaryHeadcount: 0,
        skills: [],
        overtimeRate: ratio(0),
        attendanceRate: ratio(0.95),
      },
    ],
    financingRequest: {
      desiredAmountUsd: 0,
      desiredLoanType: "workingCapital",
      desiredTermQuarters: 1,
      desiredRepaymentMethod: "bulletAtMaturity",
      desiredPrepaymentUsd: 0,
      emergencyAcceptable: false,
    },
    capexDecision: { companyId: COMPANY_ID, newProjectProposals: [], cancelRequests: [], resumeRequests: [] },
    salesForceHireCount: 0,
    salesForceLayoffCount: 0,
    ...overrides,
  };
}

test("computeDecisionDiffSummary: 完全に同一の意思決定同士では差分なし（hasDifferences=false, changedFieldPaths=[]）", () => {
  const a = baseDecision();
  const b = baseDecision();
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, false);
  assert.deepEqual(result.changedFieldPaths, []);
});

test("computeDecisionDiffSummary: companyIdだけが異なる場合は比較対象外のため差分なし", () => {
  const a = baseDecision({ companyId: "BAL" as CompanyId });
  const b = baseDecision({ companyId: "SEA" as CompanyId });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, false, "companyIdは意思決定内容ではなく識別子のため、比較対象から除外されているべき");
});

test("computeDecisionDiffSummary: salesPlansの数量が異なる場合、salesPlansがchangedFieldPathsに含まれる", () => {
  const a = baseDecision();
  const b = baseDecision({
    salesPlans: [
      { companyId: COMPANY_ID, market: "CN", product: "hoso", desiredQuantity: hosoEqTons(999), priceAdjustmentUsdPerHosoEqKg: 0, salesForceHeadcount: 2 },
    ],
  });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, true);
  assert.ok(result.changedFieldPaths.includes("salesPlans"));
  assert.equal(result.changedFieldPaths.length, 1, "salesPlans以外は変更していないため、他のフィールドは差分に含まれないはず");
});

test("computeDecisionDiffSummary: salesForceHireCount省略（undefined）と明示的な0は同一視される（既存の後方互換規約）", () => {
  const a = baseDecision({ salesForceHireCount: undefined });
  const b = baseDecision({ salesForceHireCount: 0 });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, false);
});

test("computeDecisionDiffSummary: salesForceHireCountが異なる場合、salesForceHireCountがchangedFieldPathsに含まれる", () => {
  const a = baseDecision({ salesForceHireCount: 0 });
  const b = baseDecision({ salesForceHireCount: 5 });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, true);
  assert.deepEqual(result.changedFieldPaths, ["salesForceHireCount"]);
});

test("computeDecisionDiffSummary: 配列の要素順序だけが異なる場合でも、要素の集合が同一なら差分ありと誤検知しない（キー順序非依存の構造比較）", () => {
  const a = baseDecision({
    productionPlans: [
      { companyId: COMPANY_ID, factoryId: "BAL-F1", product: "hoso", desiredQuantity: hosoEqTons(400), priority: 1 },
      { companyId: COMPANY_ID, factoryId: "BAL-F1", product: "pd", desiredQuantity: hosoEqTons(200), priority: 1 },
    ],
  });
  // オブジェクトのキー順序だけを変えた同値の配列（値の並び自体は同じ順序で要素比較されるため、
  // ここではオブジェクト内部のキー順序のみを変える）。
  const b = baseDecision({
    productionPlans: [
      { priority: 1, product: "hoso", desiredQuantity: hosoEqTons(400), factoryId: "BAL-F1", companyId: COMPANY_ID },
      { priority: 1, product: "pd", desiredQuantity: hosoEqTons(200), factoryId: "BAL-F1", companyId: COMPANY_ID },
    ],
  });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, false, "オブジェクトのキー順序の違いだけで誤って差分ありと判定してはいけない");
});

test("computeDecisionDiffSummary: 複数フィールドが同時に変更された場合、そのすべてがchangedFieldPathsに含まれる", () => {
  const a = baseDecision();
  const b = baseDecision({
    salesForceHireCount: 3,
    workerAssignments: [
      { factoryId: "BAL-F1", companyId: COMPANY_ID, regularHeadcount: 5000, temporaryHeadcount: 0, skills: [], overtimeRate: ratio(0), attendanceRate: ratio(0.95) },
    ],
  });
  const result = computeDecisionDiffSummary(a, b);
  assert.equal(result.hasDifferences, true);
  assert.deepEqual([...result.changedFieldPaths].sort(), ["salesForceHireCount", "workerAssignments"]);
});
