// ShrimpX V2 — Player工場操作Phase 1: Independent Player Flow経由でのFactory Lifecycle提出テスト
//
// 【実装指示§14/§17】Factory Decisionは別のSubmit APIを作らず、既存の
// submitPlayerDecision（server-authoritative）をそのまま利用する。ここでは
// factoryLifecycleDecisionsを含む提出が、既存の stale Turn / 二重提出 / FINISHED
// 保護をそのまま受けることを確認する（Factory Decisionだけ特別扱いしない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulationSession } from "../../companyLab/simulation/engine";
import { buildResumePayload } from "../../companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../companyLab/simulation/persistence/types";
import { createInMemorySimulationRunRepository, SimulationRunRepository } from "../../companyLab/simulation/persistence/repository";
import { buildDatasetFromSession } from "../../companyLab/simulation/analytics/dataset";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../../companyLab/standardAi/orientationProfile";
import { createInMemoryPlayerRepository } from "../repository";
import { submitPlayerDecision } from "../submit";
import { PlayerSubmitError } from "../types";

const AT = "2026-01-01T00:00:00.000Z";

function buildBalDecisionWithFactoryLifecycle(session: ReturnType<typeof createSimulationSession>) {
  const fixture = session.fixtures.find((f) => f.companyId === "BAL");
  if (!fixture) throw new Error("BAL fixture not found in baseline scenario");
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const params = resolveStandardAiProfileForMode(fixture.companyId, session.state.config.standardAiProfileMode).params;
  const decision = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    session.state.currentPeriod,
    session.state.scenarioState.currentTurn,
    params
  ).decision;
  return { ...decision, factoryLifecycleDecisions: [{ type: "MOTHBALL_FACTORY" as const, factoryId: fixture.factories[0].factoryId }] };
}

async function seedResumableRun(repository: SimulationRunRepository, simulationRunId: string, overrides: { readonly gameEndedAt?: string | null } = {}) {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: "player-factory-submit-test", requestedTurns: 32, startedAt: AT });
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

test("SUBMIT-FAC-1【実装指示§14】: factoryLifecycleDecisionsを含む提出が既存submitPlayerDecision経由でそのまま保存される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-fac-submit-1");
  const decision = buildBalDecisionWithFactoryLifecycle(session);

  const result = await submitPlayerDecision(simulationRunRepository, playerRepository, {
    runId: "run-fac-submit-1",
    companyId: "BAL",
    claimedTurn: session.state.scenarioState.currentTurn,
    decision,
  });
  assert.equal(result.companyId, "BAL");

  const stored = await simulationRunRepository.loadRun("run-fac-submit-1");
  assert.deepEqual(stored?.resumePayload?.confirmedPlayerDecisions.BAL?.factoryLifecycleDecisions, decision.factoryLifecycleDecisions);
});

test("SUBMIT-FAC-2【実装指示§17・二重提出】: factoryLifecycleDecisionsを含む提出も、同じTurnへの2回目はDUPLICATE_SUBMITで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-fac-submit-2");
  const decision = buildBalDecisionWithFactoryLifecycle(session);
  const turn = session.state.scenarioState.currentTurn;

  await submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-fac-submit-2", companyId: "BAL", claimedTurn: turn, decision });

  await assert.rejects(
    () => submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-fac-submit-2", companyId: "BAL", claimedTurn: turn, decision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "DUPLICATE_SUBMIT"
  );
});

test("SUBMIT-FAC-3【実装指示§17・stale Turn】: factoryLifecycleDecisionsを含む提出も、間違ったTurnを主張するとSTALE_TURNで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-fac-submit-3");
  const decision = buildBalDecisionWithFactoryLifecycle(session);
  const wrongTurn = session.state.scenarioState.currentTurn + 1;

  await assert.rejects(
    () => submitPlayerDecision(simulationRunRepository, playerRepository, { runId: "run-fac-submit-3", companyId: "BAL", claimedTurn: wrongTurn, decision }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "STALE_TURN"
  );
});

test("SUBMIT-FAC-4【実装指示§17・FINISHED】: factoryLifecycleDecisionsを含む提出も、gameEndedAt設定済みのRunへはRUN_FINISHEDで拒否される", async () => {
  const simulationRunRepository = createInMemorySimulationRunRepository();
  const playerRepository = createInMemoryPlayerRepository();
  const session = await seedResumableRun(simulationRunRepository, "run-fac-submit-4", { gameEndedAt: AT });
  const decision = buildBalDecisionWithFactoryLifecycle(session);

  await assert.rejects(
    () =>
      submitPlayerDecision(simulationRunRepository, playerRepository, {
        runId: "run-fac-submit-4",
        companyId: "BAL",
        claimedTurn: session.state.scenarioState.currentTurn,
        decision,
      }),
    (e: unknown) => e instanceof PlayerSubmitError && e.code === "RUN_FINISHED"
  );
});
