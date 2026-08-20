// ShrimpX V2 — Independent Player Flow: submitPlayerDecision（server authoritative）のテスト
//
// 実Redis・環境変数なしで検証する（simulationResume.test.tsと同じ、createSimulationSession
// で作った本物のSimulationSessionからresumePayload/datasetを組み立てる方針）。
// ここは指示で明示されたセキュリティテストの中核（stale Turn拒否・二重提出拒否・
// FINISHED後の変更拒否・PLAYER操作対象外の会社は拒否）を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulationSession } from "../../companyLab/simulation/engine";
import { buildResumePayload } from "../../companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../companyLab/simulation/persistence/types";
import { createInMemorySimulationRunRepository } from "../../companyLab/simulation/persistence/repository";
import { buildDatasetFromSession } from "../../companyLab/simulation/analytics/dataset";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../../companyLab/standardAi/orientationProfile";
import { createInMemoryPlayerRepository } from "../repository";
import { submitPlayerDecision } from "../submit";
import { PlayerSubmitError } from "../types";
import { SimulationRunRepository } from "../../companyLab/simulation/persistence/repository";

const AT = "2026-01-01T00:00:00.000Z";

/** BAL（既定シナリオのPLAYER想定会社）に十分な、実際にエンジンが要求する形のdecisionを1つ作る。 */
function buildBalDecision(session: ReturnType<typeof createSimulationSession>) {
  const fixture = session.fixtures.find((f) => f.companyId === "BAL");
  if (!fixture) throw new Error("BAL fixture not found in baseline scenario");
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const params = resolveStandardAiProfileForMode(fixture.companyId, session.state.config.standardAiProfileMode).params;
  return generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn, params)
    .decision;
}

/** simulationRunIdを1つ与えると、BALをPLAYERモードにしたresumable runをrepositoryへ保存して返す。 */
async function seedResumableRun(
  repository: SimulationRunRepository,
  simulationRunId: string,
  overrides: { readonly gameEndedAt?: string | null } = {}
) {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: "player-submit-test", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const dataset = buildDatasetFromSession(session);
  const resumePayload = buildResumePayload(session, controlModes, {});
  const run = overrides.gameEndedAt !== undefined ? { ...session.run, gameEndedAt: overrides.gameEndedAt, gameEndTurn: 1, finalEvaluationSnapshot: [] } : session.run;
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run,
    dataset,
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  });
  return session;
}

test("SUBMIT-1: 正常な提出はconfirmedPlayerDecisionsへ保存され、Seatにも提出記録が残る", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-submit-1");
  const decision = buildBalDecision(session);

  const result = await submitPlayerDecision(simulationRunRepository, playerRepository, {
    runId: "run-submit-1",
    companyId: "BAL",
    claimedTurn: session.state.scenarioState.currentTurn,
    decision,
  });
  assert.equal(result.companyId, "BAL");

  const stored = await simulationRunRepository.loadRun("run-submit-1");
  assert.deepEqual(stored?.resumePayload?.confirmedPlayerDecisions.BAL, decision);

  const seat = await playerRepository.loadSeat("run-submit-1", "BAL");
  assert.equal(seat?.lastSubmittedTurn, session.state.scenarioState.currentTurn);
});

test("SUBMIT-2【存在しないRun】: RUN_NOT_FOUNDで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  await assert.rejects(
    () => submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "missing-run", companyId: "BAL", claimedTurn: 1, decision: {} as never }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "RUN_NOT_FOUND"
  );
});

test("SUBMIT-3【FINISHED後の変更拒否】: gameEndedAt設定済みのRunへの提出はRUN_FINISHEDで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-submit-3", { gameEndedAt: AT });
  const decision = buildBalDecision(session);

  await assert.rejects(
    () =>
      submitPlayerDecision(simulationRunRepository, playerRepository, {
        runId: "run-submit-3",
        companyId: "BAL",
        claimedTurn: session.state.scenarioState.currentTurn,
        decision,
      }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "RUN_FINISHED"
  );
});

test("SUBMIT-4【PLAYER操作対象外】: companyControlModesがPLAYERでない会社の提出はNOT_PLAYER_CONTROLLEDで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-submit-4");
  const fixture = session.fixtures.find((f) => f.companyId === "MASS");
  if (!fixture) throw new Error("MASS fixture not found");
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const params = resolveStandardAiProfileForMode(fixture.companyId, session.state.config.standardAiProfileMode).params;
  const decision = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, session.state.currentPeriod, session.state.scenarioState.currentTurn, params).decision;

  await assert.rejects(
    () =>
      submitPlayerDecision(simulationRunRepository, playerRepository, {
        runId: "run-submit-4",
        companyId: "MASS",
        claimedTurn: session.state.scenarioState.currentTurn,
        decision,
      }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "NOT_PLAYER_CONTROLLED"
  );
});

test("SUBMIT-5【stale Turn拒否】: 既に進んだ/まだ到達していないTurnを主張する提出はSTALE_TURNで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-submit-5");
  const decision = buildBalDecision(session);
  const wrongTurn = session.state.scenarioState.currentTurn + 1;

  await assert.rejects(
    () =>
      submitPlayerDecision(simulationRunRepository, playerRepository, {
        runId: "run-submit-5",
        companyId: "BAL",
        claimedTurn: wrongTurn,
        decision,
      }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "STALE_TURN"
  );
});

test("SUBMIT-6【二重提出拒否】: 同じTurnへの2回目の提出はDUPLICATE_SUBMITで拒否され、1回目の内容が保たれる", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-submit-6");
  const decision = buildBalDecision(session);
  const turn = session.state.scenarioState.currentTurn;

  await submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-submit-6", companyId: "BAL", claimedTurn: turn, decision });

  const secondDecision = { ...decision };
  await assert.rejects(
    () => submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-submit-6", companyId: "BAL", claimedTurn: turn, decision: secondDecision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "DUPLICATE_SUBMIT"
  );

  const stored = await simulationRunRepository.loadRun("run-submit-6");
  assert.deepEqual(stored?.resumePayload?.confirmedPlayerDecisions.BAL, decision, "2回目の提出が1回目の内容を上書きしていない");
});

test("SUBMIT-7【続きからプレイできない旧形式Run】: resumePayloadが無いRunへの提出はINVALID_DECISIONで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = createSimulationSession({ simulationRunId: "run-submit-7", scenarioId: "baseline", seed: "s", requestedTurns: 32, startedAt: AT });
  await simulationRunRepository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    savedAt: AT,
    persistenceRevision: 1,
  });
  const decision = buildBalDecision(session);

  await assert.rejects(
    () => submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-submit-7", companyId: "BAL", claimedTurn: session.state.scenarioState.currentTurn, decision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "INVALID_DECISION"
  );
});

test("SUBMIT-8【Run isolation】: 同じcompanyId（BAL）でも別Runへの提出状態は混ざらない", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const sessionA = await seedResumableRun(simulationRunRepository, "run-A");
  const sessionB = await seedResumableRun(simulationRunRepository, "run-B");

  await submitPlayerDecision(simulationRunRepository, playerRepository, {
    runId: "run-A",
    companyId: "BAL",
    claimedTurn: sessionA.state.scenarioState.currentTurn,
    decision: buildBalDecision(sessionA),
  });

  // run-Bは未提出のまま。run-Aへの提出がrun-Bの状態を汚染していないことを確認する。
  const storedB = await simulationRunRepository.loadRun("run-B");
  assert.equal(storedB?.resumePayload?.confirmedPlayerDecisions.BAL, undefined);

  // run-Bへは問題なく提出できる（run-Aの「二重提出」判定と混同しない）。
  const resultB = await submitPlayerDecision(simulationRunRepository, playerRepository, {
    runId: "run-B",
    companyId: "BAL",
    claimedTurn: sessionB.state.scenarioState.currentTurn,
    decision: buildBalDecision(sessionB),
  });
  assert.equal(resultB.runId, "run-B");
});
