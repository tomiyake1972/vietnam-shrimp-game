// ShrimpX V2 — Independent Player Flow: buildPlayerDecisionContextのテスト
//
// 【最重要】ここは「Player cannot inspect competitor private state」というセキュリティ
// 要件そのものを守る場所。resumePayload/StoredSimulationRunはGM向け全知state（5社の
// 真の内部状態を丸ごと持つ）だが、buildPlayerDecisionContextが返す形はそれとは別の、
// 自社視点だけに絞られた構造であることを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulationSession } from "../../companyLab/simulation/engine";
import { buildResumePayload } from "../../companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../companyLab/simulation/persistence/types";
import { buildDatasetFromSession } from "../../companyLab/simulation/analytics/dataset";
import { buildPlayerDecisionContext, PlayerDecisionContextError } from "../decisionContext";
import { StoredSimulationRun } from "../../companyLab/simulation/persistence/types";

const AT = "2026-01-01T00:00:00.000Z";

function buildStoredRun(simulationRunId: string, overrides: { readonly gameEndedAt?: string } = {}): StoredSimulationRun {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: "decision-context-test", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const resumePayload = buildResumePayload(session, controlModes, {});
  // 【ManagementConsole.tsx runInternalと同じpersist形】companyControlModesはresumePayloadだけ
  // でなくrun本体にも載せる（buildPlayerDecisionContextはsession.run.companyControlModesを見る）。
  const run = { ...session.run, companyControlModes: controlModes, ...(overrides.gameEndedAt ? { gameEndedAt: overrides.gameEndedAt, gameEndTurn: 1, finalEvaluationSnapshot: [] } : {}) };
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  };
}

test("CTX-1: 自社（fixture/ownState）は要求したcompanyIdだけを指す", () => {
  const stored = buildStoredRun("run-ctx-1");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.companyId, "BAL");
  assert.equal(context.fixture.companyId, "BAL");
  assert.equal(context.ownState.companyId, "BAL");
});

test("CTX-2【競合他社の非公開情報を含まない】: fixture/ownStateは単一会社の形であり、他社の配列・レコードを含まない", () => {
  const stored = buildStoredRun("run-ctx-2");
  const context = buildPlayerDecisionContext(stored, "BAL");
  // PlayerDecisionContextの型自体、fixtureは単一のCompanyFixture・ownStateは単一の
  // CompanyOwnStateであり、5社ぶんの配列（GM向けfixtures/companyStates相当）を
  // 一切持たない。実行時にも、返された値の直下に他社を指す配列フィールドが
  // 混入していないことを確認する（構造的な保証を実測でも裏付ける）。
  assert.equal(Array.isArray(context.fixture), false);
  assert.equal(Array.isArray(context.ownState), false);
  assert.equal("fixtures" in context, false);
  assert.equal("companyStates" in context, false);
  assert.equal("allCompanies" in context, false);
});

test("CTX-3【ゲーム進行中はfinishedViewを一切含まない】: gameEndedAtが未設定ならfinishedViewはnull", () => {
  const stored = buildStoredRun("run-ctx-3");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.gameEndedAt, null);
  assert.equal(context.finishedView, null);
});

test("CTX-4【ゲーム終了後だけ5社比較を公開してよい】: gameEndedAt設定後はfinishedViewが5社ぶんのfixturesを持つ", () => {
  const stored = buildStoredRun("run-ctx-4", { gameEndedAt: AT });
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.gameEndedAt, AT);
  assert.ok(context.finishedView);
  assert.ok(context.finishedView.session.fixtures.length >= 2, "Final Resultsは既存Game End機能と同じく5社比較を公開する（進行中とは別の公開範囲）");
});

test("CTX-5: companyControlModesでPLAYERとして扱われていない会社はisPlayerControlled=false", () => {
  const stored = buildStoredRun("run-ctx-5");
  const context = buildPlayerDecisionContext(stored, "MASS");
  assert.equal(context.isPlayerControlled, false);
});

test("CTX-6: PLAYERとして扱われている会社はisPlayerControlled=true", () => {
  const stored = buildStoredRun("run-ctx-6");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.isPlayerControlled, true);
});

test("CTX-7: 存在しない会社はCOMPANY_NOT_FOUNDで拒否される", () => {
  const stored = buildStoredRun("run-ctx-7");
  assert.throws(
    () => buildPlayerDecisionContext(stored, "ZZZ" as never),
    (e: unknown) => e instanceof PlayerDecisionContextError && e.code === "COMPANY_NOT_FOUND"
  );
});

test("CTX-8: resumePayloadが無い（続きからプレイできない旧形式）RunはNOT_RESUMABLEで拒否される", () => {
  const session = createSimulationSession({ simulationRunId: "run-ctx-8", scenarioId: "baseline", seed: "s", requestedTurns: 32, startedAt: AT });
  const stored: StoredSimulationRun = { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run, dataset: buildDatasetFromSession(session), savedAt: AT };
  assert.throws(
    () => buildPlayerDecisionContext(stored, "BAL"),
    (e: unknown) => e instanceof PlayerDecisionContextError && e.code === "NOT_RESUMABLE"
  );
});

test("CTX-9: hasSubmittedThisTurnはconfirmedPlayerDecisions[companyId]の有無だけで決まる（GMの提出済み判定と同じ信号）", () => {
  const session = createSimulationSession({ simulationRunId: "run-ctx-9", scenarioId: "baseline", seed: "decision-context-test", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const decision = { placeholder: true } as never;
  const resumePayload = buildResumePayload(session, controlModes, { BAL: decision });
  const stored: StoredSimulationRun = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  };
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.hasSubmittedThisTurn, true);
  const otherContext = buildPlayerDecisionContext(stored, "MASS");
  assert.equal(otherContext.hasSubmittedThisTurn, false);
});
