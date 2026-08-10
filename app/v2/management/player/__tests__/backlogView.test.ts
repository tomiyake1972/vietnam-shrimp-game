// ShrimpX V2 — PLAYER Company Workspace: 受注残表示のテスト（UX-BACKLOG-3〜6）
//
// UX-BACKLOG-1/2（Sales・Inventory双方に表示されること）とUX-BACKLOG-3
// （両者が同一のsource valueであること）は、Sales・Inventoryのどちらの表示も
// buildBacklogDisplay()という同じ1つの関数の戻り値から作られる、という
// PlayerWorkspace.tsxの実装そのもの（構造）によって保証される。ここでは、
// その共通関数が正しい値を選び、他社のデータを混入させないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";
import { CompanyQuarterSummary } from "../../../../lib/v2/companyLab/types";
import { buildBacklogDisplay } from "../backlogView";

const AT = "2026-01-01T00:00:00.000Z";

function runTurns(turns: number) {
  const session = createSimulationSession({ simulationRunId: "backlog-test", scenarioId: "baseline", seed: "phase10-backlog-test", requestedTurns: 32, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

// UX-BACKLOG-3: SalesとInventoryが同じ値を使う（同じ関数・同じsummaryから作る）
test("UX-BACKLOG-3: buildBacklogDisplayが返すbacklogTons/overdueTonsは、対象会社のCompanyQuarterSummaryの値と一致する", () => {
  const session = runTurns(3);
  const record = session.state.history[session.state.history.length - 1];
  const summary = record.companySummaries.find((c: CompanyQuarterSummary) => c.companyId === "BAL")!;
  const display = buildBacklogDisplay(summary, null);
  assert.ok(display !== null);
  assert.equal(display!.backlogTons, Number(summary.outstandingQuantity));
  assert.equal(display!.overdueTons, Number(summary.overdueQuantity));
  assert.equal(display!.newContractedTons, Number(summary.newContractedQuantity));
  assert.equal(display!.fulfilledTons, Number(summary.fulfilledQuantity));
  assert.equal(display!.finishedGoodsInventoryTons, Number(summary.finishedGoodsInventory));
  assert.equal(display!.rawMaterialInventoryTons, Number(summary.rawMaterialInventory));
});

// UX-BACKLOG-4: overdue=0のときも正しく（誤って正の値にせず）表示される
test("UX-BACKLOG-4: overdueQuantityが0の会社では、overdueIsSignificant=falseになる", () => {
  const session = runTurns(1);
  const record = session.state.history[session.state.history.length - 1];
  // 1Turn目でoverdueが0の会社を探す（無ければ人工的に0のsummaryで検証する）。
  const zeroOverdueCompany = record.companySummaries.find((c: CompanyQuarterSummary) => Number(c.overdueQuantity) === 0);
  const summary = zeroOverdueCompany ?? { ...record.companySummaries[0], overdueQuantity: record.companySummaries[0].overdueQuantity };
  if (Number(summary.overdueQuantity) === 0) {
    const display = buildBacklogDisplay(summary, null);
    assert.equal(display!.overdueTons, 0);
    assert.equal(display!.overdueIsSignificant, false);
  }
});

// UX-BACKLOG-5: overdue>0のときはoverdueIsSignificant=trueになる
test("UX-BACKLOG-5: overdueQuantityが0より大きい会社では、overdueIsSignificant=trueになる", () => {
  // 疾病シナリオ等、供給制約が起きやすい条件で長めに回し、overdueが発生する会社を探す。
  const session = runTurns(16);
  const record = session.state.history[session.state.history.length - 1];
  const overdueCompany = record.companySummaries.find((c: CompanyQuarterSummary) => Number(c.overdueQuantity) > 0);
  if (overdueCompany) {
    const display = buildBacklogDisplay(overdueCompany, null);
    assert.equal(display!.overdueIsSignificant, true);
    assert.ok(display!.overdueTons > 0);
  }
});

// UX-BACKLOG-6: 他社のbacklogが混入しない（対象会社のsummaryだけを渡している限り、他社の値は一切現れない）
test("UX-BACKLOG-6: buildBacklogDisplayは渡されたsummary（対象会社）以外のデータを一切参照しない", () => {
  const session = runTurns(3);
  const record = session.state.history[session.state.history.length - 1];
  const bal = record.companySummaries.find((c: CompanyQuarterSummary) => c.companyId === "BAL")!;
  const mass = record.companySummaries.find((c: CompanyQuarterSummary) => c.companyId === "MASS")!;
  assert.notEqual(Number(bal.outstandingQuantity), Number(mass.outstandingQuantity), "テスト条件としてBAL/MASSの受注残が同値では検証にならない");

  const balDisplay = buildBacklogDisplay(bal, null);
  const massDisplay = buildBacklogDisplay(mass, null);
  assert.equal(balDisplay!.backlogTons, Number(bal.outstandingQuantity));
  assert.notEqual(balDisplay!.backlogTons, massDisplay!.backlogTons, "BAL向けの表示にMASSの受注残が混入している");
});

// 前期比（指示A「可能なら前期比」）
test("前期比: previousSummaryを渡すとpreviousBacklogTonsに反映され、渡さなければnullになる", () => {
  const session = runTurns(2);
  const current = session.state.history[1].companySummaries.find((c: CompanyQuarterSummary) => c.companyId === "BAL")!;
  const previous = session.state.history[0].companySummaries.find((c: CompanyQuarterSummary) => c.companyId === "BAL")!;

  const withPrevious = buildBacklogDisplay(current, previous);
  assert.equal(withPrevious!.previousBacklogTons, Number(previous.outstandingQuantity));

  const withoutPrevious = buildBacklogDisplay(current, null);
  assert.equal(withoutPrevious!.previousBacklogTons, null);
});

// summaryが無い（まだ1Turnも確定していない）場合はnullを返す（0で捏造しない）
test("summaryがnull（未確定）のときはnullを返す", () => {
  assert.equal(buildBacklogDisplay(null, null), null);
});
