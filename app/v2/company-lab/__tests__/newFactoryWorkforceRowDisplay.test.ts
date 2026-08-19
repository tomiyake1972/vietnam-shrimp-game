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
import { advanceSimulationTurn, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { buildCompanyInvestmentPlanningViewModel } from "../investmentPlanningViewModel";
import { CAPEX_PARAMETERS_V1 } from "../../../lib/v2/capex";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * 「新設Factoryが稼働開始した直後で、まだworkforceStateに記録が無い」四半期を探す。
 *
 * 【SAI-GROW-3B-1】このfixtureは元々「MASSがTurn25に2工場目を稼働」と会社ID・
 * 案件連番・ターン数を直接固定していたが、Standard AIの投資判断が変わるたびに
 * （Crisis Management CM-1 / Capability Expansion CE-3 / Profile SAI-5B、そして
 * 今回のLiquidity SSoT）そのすべてを実測で貼り直す運用になっていた。
 * このテストの目的は「稼働直後（workforceState未記録）の新設Factoryで
 * headcountChangeが0に固定されない」という表示バグの固定であり、どの会社が
 * いつ建てるかを固定する意図はない。そのため会社ID・案件ID・ターン数を固定せず、
 * 条件を満たす最初の四半期をfixture順・ターン昇順（決定論的）に探索する。
 */
function sessionAtNewFactoryFirstTurn() {
  let session = createSimulationSession({
    simulationRunId: "newf-vm-test",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  for (let i = 0; i < 32; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced, `turn ${i + 1} が進まなかった`);
    session = outcome.session;
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      const newFactoryId = ownState.effectiveFactories
        .map((f) => f.factoryId)
        .find((id) => id.includes("NEWF") && !ownState.workforceState.factories.some((w) => w.factoryId === id));
      if (!newFactoryId) continue;
      const existingFactoryId = ownState.effectiveFactories.map((f) => f.factoryId).find((id) => !id.includes("NEWF"));
      assert.ok(existingFactoryId, "既存Factoryが見つからない（テスト前提の見直しが必要）");
      return { session, companyId: fixture.companyId, newFactoryId, existingFactoryId: existingFactoryId! };
    }
  }
  throw new Error("稼働開始直後（workforceState未記録）の新設Factoryが観測できる四半期が見つからなかった（テスト前提の見直しが必要）");
}

type NewFactoryFixture = ReturnType<typeof sessionAtNewFactoryFirstTurn>;

function buildPlanningForCompany(session: NewFactoryFixture["session"], companyId: string, headcountOverrides?: Readonly<Record<string, number>>) {
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
  const { session, companyId, newFactoryId } = sessionAtNewFactoryFirstTurn();
  const { ownState } = buildPlanningForCompany(session, companyId);
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
  const { session, companyId, newFactoryId } = sessionAtNewFactoryFirstTurn();

  const { draft, planning: beforeEdit } = buildPlanningForCompany(session, companyId);
  const rowBefore = beforeEdit.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.ok(rowBefore, "新設Factoryのworkforce行が見つからない");
  // 【Standard AI Factory Activation・Phase FA-1】以前はStandard AIが新設Factoryへ
  // 一切WorkerAssignmentを生成できなかったバグ（労務Activationデッドロック）があり、
  // このため編集前のheadcountChangeは常に0だった。FA-1でこのバグを修正した結果、
  // Standard AI自身が新設Factoryへ実際の必要人数を提案するようになり、編集前でも
  // その提案値（0ではない）がheadcountChangeとして表示されるのが正しい挙動になった。
  const aiProposedHeadcount = draft.workerAssignments.find((w) => w.factoryId === newFactoryId)?.regularHeadcount ?? 0;
  assert.ok(aiProposedHeadcount > 0, "FA-1修正後はStandard AIが新設Factoryへ0より大きい人数を提案するはず");
  assert.equal(rowBefore.headcountBefore, 0, "新設FactoryのheadcountBeforeは0であるべき（workforceStateに記録が無いため）");
  assert.equal(rowBefore.headcountChange, aiProposedHeadcount, "編集前のheadcountChangeはStandard AIの提案値と一致するべき");

  const { planning: afterEdit } = buildPlanningForCompany(session, companyId, { [newFactoryId]: 500 });
  const rowAfter = afterEdit.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.equal(rowAfter.headcountAfter, 500, "変更後人数が編集値と一致しない");
  assert.equal(rowAfter.headcountBefore, 0, "新設FactoryのheadcountBeforeは0であるべき（編集値へ追従してはいけない）");
  assert.equal(rowAfter.headcountChange, 500, "headcountChangeが編集した増員数（500）を反映していない（バグ再発）");
});

// NEWF-VM-3: 既存Factory（workforceStateに記録あり）は、修正の前後で挙動が変わらない（回帰防止）。
test("NEWF-VM-3: 既存Factory（workforceStateに記録あり）のheadcountChangeは引き続き正しく計算される", () => {
  const { session, companyId, existingFactoryId: oldFactoryId } = sessionAtNewFactoryFirstTurn();

  const { ownState, planning: beforeEdit } = buildPlanningForCompany(session, companyId);
  const persisted = ownState.workforceState.factories.find((f) => f.factoryId === oldFactoryId);
  assert.ok(persisted, "テスト前提: 既存Factoryはworkforcestateに記録があるはず");
  const rowBefore = beforeEdit.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  assert.equal(rowBefore.headcountBefore, persisted!.regularHeadcount);

  const { planning: afterEdit } = buildPlanningForCompany(session, companyId, { [oldFactoryId]: persisted!.regularHeadcount + 100 });
  const rowAfter = afterEdit.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  assert.equal(rowAfter.headcountBefore, persisted!.regularHeadcount, "既存Factoryのheadcountbeforeが編集で変わってしまっている");
  assert.equal(rowAfter.headcountChange, 100, "既存Factoryの増員が正しく反映されていない");
});

// NEWF-VM-4: 複数Factory（既存＋新設）を同時に編集しても、互いに独立して正しく計算される。
test("NEWF-VM-4: 既存Factoryと新設Factoryを同時に編集しても、互いのheadcountChangeが独立して正しい", () => {
  const { session, companyId, newFactoryId, existingFactoryId: oldFactoryId } = sessionAtNewFactoryFirstTurn();

  const baseline = buildPlanningForCompany(session, companyId);
  const oldFactoryPersistedHeadcount = baseline.ownState.workforceState.factories.find((f) => f.factoryId === oldFactoryId)!.regularHeadcount;

  const { planning } = buildPlanningForCompany(session, companyId, {
    [oldFactoryId]: oldFactoryPersistedHeadcount + 100,
    [newFactoryId]: 500,
  });
  const oldRow = planning.workforceRows.find((r) => r.factoryId === oldFactoryId)!;
  const newRow = planning.workforceRows.find((r) => r.factoryId === newFactoryId)!;
  assert.equal(oldRow.headcountChange, 100);
  assert.equal(newRow.headcountChange, 500);
});
