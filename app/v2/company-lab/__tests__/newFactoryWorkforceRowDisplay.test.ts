// ShrimpX V2 — staging再現バグ: 新設Factory Worker増減欄が入力不能に見える問題
//
// 【根本原因】investmentPlanningViewModel.tsのworkforceRows組み立てで、
// headcountBefore を「workforceStateに記録が無ければ assignment.regularHeadcount
// （＝今まさに編集中の現在値）」にfallbackしていた。稼働開始したばかりで一度も
// Worker決定が確定していない新設Factoryはworkforcestateに記録が無いため、
// headcountBefore が常に headcountAfter と同じ値になり、
// headcountChange = headcountAfter - headcountBefore が常に0になっていた
// （＝「増員／減員」inputの表示値が、何人入力しても0に戻って見える）。
//
// draft側のbinding・onChange経路は元々壊れておらず、表示計算だけが誤っていた
// ことをこのテストで固定する（実ブラウザでのPlaywright再現・修正確認は
// 別途 __e2e__ ディレクトリのPlaywrightスクリプトで実施）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { buildCompanyInvestmentPlanningViewModel } from "../investmentPlanningViewModel";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * MASSの2つ目の工場（MASS-NEWF-MASS-CAPEX-4）がこのseedでTurn25に稼働開始する。
 *
 * 【Standard AI Crisis Management・Phase CM-1】この定数は元々Turn20だったが、
 * Crisis Management導入（既存Finance診断シグナルからのCrisis State判定・
 * SEVERE_DISTRESS/LIQUIDITY_STRESS時の新規commitment/CAPEX抑制）により、
 * MASSの投資判断（Standard AIの既存reactiveな新工場評価ロジック自体は
 * 無変更）の実際のタイミングが後ろへずれ、対象の新設Factory IDも
 * MASS-NEWF-MASS-CAPEX-3からMASS-NEWF-MASS-CAPEX-4へ変わった（実測で確認）。
 * このテストの目的はWorker入力欄の表示バグ固定であり、新工場が実際に建つ
 * ターン自体を固定する意図はないため、実測値へ更新した。
 */
function sessionAtNewFactoryFirstTurn() {
  const session = createSimulationSession({
    simulationRunId: "newf-vm-test",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  return advanceSimulationTurns({ session, turns: 25, timestamp: AT });
}

function buildPlanningForCompany(session: ReturnType<typeof sessionAtNewFactoryFirstTurn>, companyId: string, headcountOverrides?: Readonly<Record<string, number>>) {
  const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  let draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  if (headcountOverrides) {
    draft = {
      ...draft,
      workerAssignments: draft.workerAssignments.map((w) => {
        const override = headcountOverrides[w.factoryId];
        if (override === undefined) return w;
        const before = w.regularHeadcountBefore ?? w.regularHeadcount;
        return { ...w, regularHeadcount: override, regularHeadcountBefore: before, regularHeadcountChange: override - before };
      }),
    };
  }
  const decisionInput = buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
  const planning = buildCompanyInvestmentPlanningViewModel({
    companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period: session.state.currentPeriod,
    productionPlans: decisionInput.productionPlans,
    workerAssignments: decisionInput.workerAssignments,
    workforceState: ownState.workforceState,
    rawMaterialLots: ownState.rawMaterialLots,
    finishedGoodsLots: ownState.finishedGoodsLots,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  return { fixture, ownState, draft, planning };
}

// NEWF-VM-1: 稼働開始したばかりの新設Factoryは、workforceStateに記録が無い
// （＝headcountBefore=0が正しい前提）ことを確認する前提条件チェック。
test("NEWF-VM-1: 稼働開始した直後の新設Factoryは、workforceStateにまだ記録が無い", () => {
  const session = sessionAtNewFactoryFirstTurn();
  const { ownState } = buildPlanningForCompany(session, "MASS");
  const newFactoryId = "MASS-NEWF-MASS-CAPEX-4";
  assert.ok(
    ownState.effectiveFactories.some((f) => f.factoryId === newFactoryId),
    "このseed/turn前提が崩れている（新設Factoryがまだ稼働していない）"
  );
  const persisted = ownState.workforceState.factories.find((f) => f.factoryId === newFactoryId);
  assert.equal(persisted, undefined, "テスト前提: 新設FactoryはまだworkforceStateに記録が無いはず");
});

// NEWF-VM-2: 新設Factoryの常用人数を編集すると、headcountChange（＝増員／減員欄の表示値）が
// 正しく変化する（0に固定されない）。
test("NEWF-VM-2: 新設Factoryのregularheadcountを編集すると、headcountChangeが入力どおりに変化する（常に0に戻らない）", () => {
  const session = sessionAtNewFactoryFirstTurn();
  const newFactoryId = "MASS-NEWF-MASS-CAPEX-4";

  const { planning: beforeEdit } = buildPlanningForCompany(session, "MASS");
  const rowBefore = beforeEdit.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.ok(rowBefore, "新設Factoryのworkforce行が見つからない");
  assert.equal(rowBefore.headcountChange, 0, "編集前はheadcountChange=0であるべき");

  const { planning: afterEdit } = buildPlanningForCompany(session, "MASS", { [newFactoryId]: 500 });
  const rowAfter = afterEdit.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.equal(rowAfter.headcountAfter, 500, "変更後人数が編集値と一致しない");
  assert.equal(rowAfter.headcountBefore, 0, "新設FactoryのheadcountBeforeは0であるべき（編集値へ追従してはいけない）");
  assert.equal(rowAfter.headcountChange, 500, "headcountChangeが編集した増員数（500）を反映していない（バグ再発）");
});

// NEWF-VM-3: 既存Factory（workforceStateに記録あり）は、修正の前後で挙動が変わらない（回帰防止）。
test("NEWF-VM-3: 既存Factory（workforceStateに記録あり）のheadcountChangeは引き続き正しく計算される", () => {
  const session = sessionAtNewFactoryFirstTurn();
  const oldFactoryId = "MASS-F1";

  const { ownState, planning: beforeEdit } = buildPlanningForCompany(session, "MASS");
  const persisted = ownState.workforceState.factories.find((f) => f.factoryId === oldFactoryId);
  assert.ok(persisted, "テスト前提: 既存Factoryはworkforcestateに記録があるはず");
  const rowBefore = beforeEdit.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  assert.equal(rowBefore.headcountBefore, persisted!.regularHeadcount);

  const { planning: afterEdit } = buildPlanningForCompany(session, "MASS", { [oldFactoryId]: persisted!.regularHeadcount + 100 });
  const rowAfter = afterEdit.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  assert.equal(rowAfter.headcountBefore, persisted!.regularHeadcount, "既存Factoryのheadcountbeforeが編集で変わってしまっている");
  assert.equal(rowAfter.headcountChange, 100, "既存Factoryの増員が正しく反映されていない");
});

// NEWF-VM-4: 複数Factory（既存＋新設）を同時に編集しても、互いに独立して正しく計算される。
test("NEWF-VM-4: 既存Factoryと新設Factoryを同時に編集しても、互いのheadcountChangeが独立して正しい", () => {
  const session = sessionAtNewFactoryFirstTurn();
  const oldFactoryId = "MASS-F1";
  const newFactoryId = "MASS-NEWF-MASS-CAPEX-4";

  const baseline = buildPlanningForCompany(session, "MASS");
  const oldFactoryPersistedHeadcount = baseline.ownState.workforceState.factories.find((f) => f.factoryId === oldFactoryId)!.regularHeadcount;

  const { planning } = buildPlanningForCompany(session, "MASS", {
    [oldFactoryId]: oldFactoryPersistedHeadcount + 100,
    [newFactoryId]: 500,
  });
  const oldRow = planning.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  const newRow = planning.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.equal(oldRow.headcountChange, 100);
  assert.equal(newRow.headcountChange, 500);
});
