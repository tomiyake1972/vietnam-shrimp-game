// ShrimpX V2 — PLAYER Company Workspace 受入: 新工場のWorker入力（Phase 9・§C）
//
// 【根本原因】実画面で確認された「新工場のWorker増減欄が操作不能」というバグは、
// buildInitialDraft・buildDecisionInputFromDraft・DecisionEditor・WorkforcePanelという
// 通常プレイと共有しているデータ層のロジックには存在しなかった（通常プレイでは
// 既に稼働開始済み新設Factoryを正しく扱える設計になっている）。
//
// 実際の原因は Management Console 側（app/v2/management/player/PlayerWorkspace.tsx）
// が DecisionEditor を <DecisionEditor key={revision} .../> という形で、下書きを
// 1文字編集するたびに revision をbumpしてremount させていたことだった。draftは
// controlled propとして渡しているためremountは不要であり、むしろ<input>のDOM
// ノードごと壊して作り直す結果、spinnerクリック・直接入力の連続操作が
// 「反応しない/戻る」ように見えていた（新工場のように数千人規模の増員を
// 連続入力する操作で特に顕著だった）。修正はkey={revision}の削除のみで、
// ゲームロジック・データ層は一切変更していない。
//
// このテストは、そのデータ層（buildInitialDraft→編集→buildDecisionInputFromDraft→
// advanceCompanyLabQuarter実行→次state反映）が新設Factoryについても既存Factoryと
// 同じに正しく機能することを、実際の32Qシミュレーションで生成した新設Factoryを
// 使って確認する（UIのremount問題自体は自動テストで再現しにくいため、
// Playwrightでの実ブラウザ確認と合わせて受入とする）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../../../../lib/v2/companyLab/runner";
import { advanceSimulationTurn, createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";
import { generateStandardAiDecision } from "../../../../lib/v2/companyLab/standardAi/policy";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../../../company-lab/decisionDraft";
import { unwrapUnit } from "../../../../lib/v2/core/units";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * baseline/management-console-32qのseedで、Q32までに新設Factory（NEWF）が稼働開始する。
 *
 * 【SAI-GROW-3B-1】どの会社が最初に新工場を建てるかはStandard AIの投資判断次第で
 * 変わる（このテストの過去の修正履歴も、その都度の会社・案件ID固定を追いかけていた）。
 * ここで確認したいのはUIデータ層が「稼働開始済みの新設Factory」を既存Factoryと
 * 同じに扱えることであって、どの会社がそれを持つかではないため、会社IDを固定せず
 * fixture順で最初に稼働済みNEWFを持つ会社を選ぶ。
 */
function runToQ32WithNewFactory(turns = 32) {
  let session = createSimulationSession({
    simulationRunId: "newf-worker-test",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  for (let i = 0; i < turns; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced, `turn ${i + 1} が進まなかった`);
    session = outcome.session;
  }
  return session;
}

/** 稼働開始済みの新設Factory（NEWF）を持つ会社を、fixture順（決定論的）で1社選ぶ。 */
function findFixtureWithOperatingNewFactory(session: ReturnType<typeof runToQ32WithNewFactory>) {
  for (const fixture of session.fixtures) {
    const ownState = buildCompanyOwnState(session.state, fixture);
    const newFactoryId = ownState.effectiveFactories.map((f) => f.factoryId).find((id) => id.includes("NEWF"));
    if (newFactoryId) return { fixture, ownState, newFactoryId };
  }
  throw new Error("稼働開始済みの新設Factoryを持つ会社が1社も見つからなかった（テスト前提の見直しが必要）");
}

test("NEWF-W-1/2: 稼働開始済み新設Factoryが、既存Factoryと同じくdraft.workerAssignmentsに含まれる", () => {
  const session = runToQ32WithNewFactory();
  const { fixture, ownState } = findFixtureWithOperatingNewFactory(session);

  const effectiveFactoryIds = ownState.effectiveFactories.map((f) => f.factoryId);
  assert.ok(effectiveFactoryIds.length >= 2, "この受入前提（対象会社が2工場以上）が崩れている");
  const newFactoryId = effectiveFactoryIds.find((id) => id.includes("NEWF"));
  assert.ok(newFactoryId, "新設Factoryが見つからない（テストの前提が崩れている）");

  const publicInfo = buildPublicMarketInfo(session.state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);

  const draftFactoryIds = draft.workerAssignments.map((w) => w.factoryId);
  assert.ok(draftFactoryIds.includes(newFactoryId!), "新設Factoryのworker行がdraftに無い");
  assert.equal(draftFactoryIds.length, effectiveFactoryIds.length, "draftのworker行数がeffectiveFactories数と一致しない");
});

test("NEWF-W-3/4: 新設Factoryの常用人数を増員・減員でき、既存Factoryと同じ計算式が使われる", () => {
  const session = runToQ32WithNewFactory();
  const { fixture, ownState } = findFixtureWithOperatingNewFactory(session);
  const publicInfo = buildPublicMarketInfo(session.state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  const newFactoryId = draft.workerAssignments.map((w) => w.factoryId).find((id) => id.includes("NEWF"))!;

  const idx = draft.workerAssignments.findIndex((w) => w.factoryId === newFactoryId);
  const before = draft.workerAssignments[idx].regularHeadcountBefore ?? draft.workerAssignments[idx].regularHeadcount;

  // 増員（DecisionEditorのonChangeHeadcountDeltaが行うのと同じ更新）。
  const increased = { ...draft, workerAssignments: [...draft.workerAssignments] };
  increased.workerAssignments[idx] = {
    ...draft.workerAssignments[idx],
    regularHeadcountBefore: before,
    regularHeadcountChange: 3000,
    regularHeadcount: Math.max(0, before + 3000),
  };
  const increasedInput = buildDecisionInputFromDraft(increased, fixture, session.state.currentPeriod);
  const increasedRow = increasedInput.workerAssignments.find((w) => w.factoryId === newFactoryId);
  assert.equal(increasedRow?.regularHeadcount, before + 3000);

  // 減員。
  const decreased = { ...draft, workerAssignments: [...draft.workerAssignments] };
  decreased.workerAssignments[idx] = {
    ...draft.workerAssignments[idx],
    regularHeadcountBefore: before + 3000,
    regularHeadcountChange: -500,
    regularHeadcount: Math.max(0, before + 3000 - 500),
  };
  const decreasedInput = buildDecisionInputFromDraft(decreased, fixture, session.state.currentPeriod);
  const decreasedRow = decreasedInput.workerAssignments.find((w) => w.factoryId === newFactoryId);
  assert.equal(decreasedRow?.regularHeadcount, before + 3000 - 500);
});

test("NEWF-W-5/6: 新設Factoryの臨時人数・残業率も編集でき、buildDecisionInputFromDraftへ反映される", () => {
  const session = runToQ32WithNewFactory();
  const { fixture, ownState } = findFixtureWithOperatingNewFactory(session);
  const publicInfo = buildPublicMarketInfo(session.state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  const newFactoryId = draft.workerAssignments.map((w) => w.factoryId).find((id) => id.includes("NEWF"))!;
  const idx = draft.workerAssignments.findIndex((w) => w.factoryId === newFactoryId);

  const edited = { ...draft, workerAssignments: [...draft.workerAssignments] };
  edited.workerAssignments[idx] = { ...draft.workerAssignments[idx], temporaryHeadcount: 40, overtimeRate: 0.25 };
  const input = buildDecisionInputFromDraft(edited, fixture, session.state.currentPeriod);
  const row = input.workerAssignments.find((w) => w.factoryId === newFactoryId);
  assert.equal(row?.temporaryHeadcount, 40);
  assert.equal(unwrapUnit(row!.overtimeRate), 0.25);
});

test("NEWF-W-7: 既存Factoryと新設Factoryを同時に編集しても、互いの入力が漏れない", () => {
  const session = runToQ32WithNewFactory();
  const { fixture, ownState } = findFixtureWithOperatingNewFactory(session);
  const publicInfo = buildPublicMarketInfo(session.state);
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  const existingFactoryId = draft.workerAssignments.map((w) => w.factoryId).find((id) => !id.includes("NEWF"))!;
  const newFactoryId = draft.workerAssignments.map((w) => w.factoryId).find((id) => id.includes("NEWF"))!;

  const edited = { ...draft, workerAssignments: [...draft.workerAssignments] };
  const existingIdx = edited.workerAssignments.findIndex((w) => w.factoryId === existingFactoryId);
  const newIdx = edited.workerAssignments.findIndex((w) => w.factoryId === newFactoryId);
  edited.workerAssignments[existingIdx] = { ...edited.workerAssignments[existingIdx], temporaryHeadcount: 15 };
  edited.workerAssignments[newIdx] = { ...edited.workerAssignments[newIdx], temporaryHeadcount: 40 };

  const input = buildDecisionInputFromDraft(edited, fixture, session.state.currentPeriod);
  assert.equal(input.workerAssignments.find((w) => w.factoryId === existingFactoryId)?.temporaryHeadcount, 15);
  assert.equal(input.workerAssignments.find((w) => w.factoryId === newFactoryId)?.temporaryHeadcount, 40);
});

test("NEWF-W-9: 新設Factoryへの増員意思決定が、実行後の次stateへ反映される", () => {
  // Q32は当シナリオの最終ターン（advanceCompanyLabQuarterをこれ以上呼べない）ため、
  // Q31時点から「次のターン（Q32）」を実行して確認する。
  const session = runToQ32WithNewFactory(31);
  const { fixture, ownState } = findFixtureWithOperatingNewFactory(session);
  const publicInfo = buildPublicMarketInfo(session.state);
  const turn = session.state.scenarioState.currentTurn;
  const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, turn);
  const draft = buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories);
  const newFactoryId = draft.workerAssignments.map((w) => w.factoryId).find((id) => id.includes("NEWF"))!;
  const idx = draft.workerAssignments.findIndex((w) => w.factoryId === newFactoryId);
  const before = draft.workerAssignments[idx].regularHeadcountBefore ?? draft.workerAssignments[idx].regularHeadcount;

  const edited = { ...draft, workerAssignments: [...draft.workerAssignments] };
  edited.workerAssignments[idx] = {
    ...draft.workerAssignments[idx],
    regularHeadcountBefore: before,
    regularHeadcountChange: 3000,
    regularHeadcount: before + 3000,
  };
  const decision = buildDecisionInputFromDraft(edited, fixture, session.state.currentPeriod);

  // 他社はAI決定のまま、対象会社だけこのPLAYER決定を使う（Manual Overrideと同じ経路）。
  const decisions: Record<string, ReturnType<typeof buildDecisionInputFromDraft>> = { [fixture.companyId]: decision };
  for (const f of session.fixtures) {
    if (f.companyId === fixture.companyId) continue;
    const os = buildCompanyOwnState(session.state, f);
    decisions[f.companyId] = generateStandardAiDecision(f, os, publicInfo, session.state.currentPeriod, turn);
  }
  const nextState = advanceCompanyLabQuarter(session.state, session.fixtures, decisions);
  const nextOwnState = buildCompanyOwnState(nextState, fixture);
  const nextFactoryState = nextOwnState.workforceState.factories.find((f) => f.factoryId === newFactoryId);
  assert.ok(nextFactoryState, "実行後、新設Factoryのworkforce状態が見つからない");
  assert.equal(nextFactoryState!.regularHeadcount, before + 3000, "実行後の新設Factory常用人数が意思決定どおりに反映されていない");
});

test("NEWF-W-10: 建設中（未稼働）のFactoryはWorker配置対象（effectiveFactories）に含まれない", () => {
  // Q17前後、MASSの新工場が「建設中」でまだ稼働していない時点を探す。
  let session = createSimulationSession({
    simulationRunId: "newf-under-construction-test",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  let foundUnderConstructionTurn: number | null = null;
  for (let i = 0; i < 32; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
    const fixture = session.fixtures.find((f) => f.companyId === "MASS")!;
    const ownState = buildCompanyOwnState(session.state, fixture);
    const hasPendingNewFactory = ownState.capexState.portfolio.projects.some(
      (p) => p.projectType === "newFactoryConstruction" && p.status !== "cancelled" && p.status !== "completed"
    );
    const effectiveCount = ownState.effectiveFactories.length;
    if (hasPendingNewFactory && effectiveCount === 1) {
      foundUnderConstructionTurn = session.state.scenarioState.currentTurn;
      break;
    }
  }
  assert.ok(foundUnderConstructionTurn !== null, "建設中・未稼働の新工場が観測できる四半期が見つからなかった（テスト前提の見直しが必要）");
});
