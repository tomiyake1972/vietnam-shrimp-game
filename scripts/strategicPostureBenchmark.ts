// Standard AI Strategic Posture — Phase F baseline観測（32Q・既定シナリオ）。
// AGGRESSIVE_EARLY_CAPACITY（MASS/BAL）でstrategic routeが実際に発火するか、
// 発火した場合のforward gap・完成予定ターン・財務状態を、実際の32Qシミュレーションで観測する。
import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";
const AGGRESSIVE_COMPANIES = new Set(["MASS", "BAL"]);

const scenarioId = process.argv[2] ?? "baseline";
let session = createSimulationSession({
  simulationRunId: "strategic-posture-benchmark",
  scenarioId,
  seed: "management-console-32q",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt: AT,
});
session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });

console.log(`run: ${session.run.completedTurns}/32Q, stopReason=${session.run.stopReason}\n`);

for (const companyId of ["MASS", "BAL", "JPQ", "CONSV", "VAP"]) {
  const turns = session.packCompanyTurns.filter((c) => c.companyId === companyId).sort((a, b) => a.turn - b.turn);
  console.log(`=== ${companyId}（strategicPosture=${turns[0]?.strategy.newFactory?.strategicPosture ?? "?"}） ===`);
  let builtCount = 0;
  for (const t of turns) {
    const nf = t.strategy.newFactory;
    if (!nf) continue;
    if (nf.status === "READY_TO_BUILD") {
      builtCount += 1;
      console.log(
        `  Turn ${t.turn}: READY_TO_BUILD route=${nf.decisionRoute} ${
          nf.forwardCapacityGap
            ? `完成予定Q${nf.forwardCapacityGap.forecastCompletionTurn} 想定規模${Math.round(
                nf.forwardCapacityGap.projectedCommercialScaleAtCompletion
              )}t 現能力${Math.round(nf.forwardCapacityGap.existingCapacityAtCompletion)}t gap${Math.round(nf.forwardCapacityGap.forwardCapacityGapTons)}t`
            : "(reactive)"
        }`
      );
    } else if (nf.decisionRoute === "STRATEGIC_FORWARD_CAPACITY" || (nf.forwardCapacityGap && nf.forwardCapacityGap.forwardCapacityGapTons > 0)) {
      console.log(
        `  Turn ${t.turn}: status=${nf.status} strategic route評価あり gap=${
          nf.forwardCapacityGap ? Math.round(nf.forwardCapacityGap.forwardCapacityGapTons) : 0
        }t reasonCodes=${nf.reasonCodes.slice(-1).join(",")}`
      );
    }
  }
  const last = turns[turns.length - 1];
  console.log(`  期末(Q${last?.turn}): factoryCount系ログは individual assessment には無いため省略。READY_TO_BUILD回数=${builtCount}`);
  console.log(`  postureがAGGRESSIVE想定=${AGGRESSIVE_COMPANIES.has(companyId)}`);
  console.log("");
}
