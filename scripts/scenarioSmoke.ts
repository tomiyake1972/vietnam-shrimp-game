// 5シナリオすべてが 32Q を通しで走ることの実測（Management Console の選択肢の裏づけ）。
import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { listScenarioAliases } from "../app/lib/v2/industryLab/cli/scenarioAliases";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";
for (const { alias, definition } of listScenarioAliases()) {
  const t0 = process.hrtime.bigint();
  let session = createSimulationSession({
    simulationRunId: `smoke-${alias}`,
    scenarioId: alias,
    seed: "management-console-32q",
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
  });
  session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const last = session.packCompanyTurns.filter((c) => c.turn === session.run.completedTurns);
  console.log(
    `${alias.padEnd(28)} ${definition.title.padEnd(16)} ${session.run.completedTurns}/32Q ${session.run.stopReason.padEnd(10)} ${ms.toFixed(0)}ms  ` +
      `新工場提案=${last.filter((c) => c.strategy.newFactory?.status === "READY_TO_BUILD").length}  ` +
      `成長圧力=${last.map((c) => `${c.companyId}:${c.strategy.growthPressure}`).join(" ")}`
  );
}
