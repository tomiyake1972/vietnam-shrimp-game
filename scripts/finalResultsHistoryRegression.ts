// ShrimpX V2 — Final Results履歴修正の実データ回帰確認（指示§20）
//
// 対象Run相当（scenario=dynamic-scenario-2 / seed=management-console-32q）を32Turn
// 完走させ、1度save/resumeを挟んだうえで（＝実際にFinal Resultsを開いた状態と同じ）、
// 5社のTurn1 / 8 / 16 / 24 / 32のTSVと、Turn32の履歴TSV・正式final snapshot TSVを出す。
//
// 新しい計算は一切しない。値はすべて evaluation/evaluationSemantics.ts と
// simulation/analytics/finalResultsSeries.ts が返すものをそのまま表示する。

import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../app/lib/v2/companyLab/simulation/persistence/resume";
import { buildDividendSeries, buildTsvSeries } from "../app/lib/v2/companyLab/simulation/analytics/finalResultsSeries";
import { resolveEvaluationHistory } from "../app/lib/v2/companyLab/evaluation/evaluationHistory";
import { computeCompanyEvaluationSnapshot } from "../app/lib/v2/companyLab/evaluation/evaluationSemantics";
import { computeFinalEvaluationSnapshot } from "../app/v2/management/lib/gameEnd";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";
const TOTAL = 32;
const CHECKPOINTS = [1, 8, 16, 24, 32];

function m(value: number | null): string {
  if (value === null) return "null".padStart(14);
  return `${(value / 1e6).toFixed(2)}M`.padStart(14);
}

let session: SimulationSession = createSimulationSession({
  simulationRunId: "run-dynamic-scenario-2-management-console-32q-regression",
  scenarioId: "dynamic-scenario-2",
  seed: "management-console-32q",
  requestedTurns: TOTAL,
  startedAt: AT,
});
for (let i = 0; i < TOTAL; i++) {
  const outcome = advanceSimulationTurn(session, AT);
  if (!outcome.advanced) {
    console.error(`Turn ${session.state.scenarioState.currentTurn} で停止: ${outcome.error}`);
    process.exit(1);
  }
  session = outcome.session;
}

// 実際のFinal Results画面と同じく、一度save/resumeを挟む。
const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {})));
session = restoreSessionFromResumePayload(session.run, payload);

const history = resolveEvaluationHistory({ evaluationHistory: session.evaluationHistory, stateHistory: session.state.history });
const tsvSeries = buildTsvSeries(history, session.fixtures, TOTAL);
const dividendSeries = buildDividendSeries(history, session.fixtures, TOTAL);
const finalSnapshots = computeFinalEvaluationSnapshot(session);

console.log(`state.history 保持Turn数        : ${session.state.history.length}（rolling windowで間引き済み）`);
console.log(`evaluationHistory 保持Turn数    : ${history.length}`);
console.log(`TSV history non-null点数（BAL） : ${tsvSeries.find((s) => s.companyId === "BAL")?.points.filter((p) => p.value !== null).length}`);
console.log("");
console.log("会社   " + CHECKPOINTS.map((t) => `T${t}`.padStart(14)).join("") + "   " + "T32 final snap".padStart(14) + "  一致");
for (const series of tsvSeries) {
  const row = CHECKPOINTS.map((t) => m(series.points.find((p) => p.turn === t)?.value ?? null)).join("");
  const finalTsv = finalSnapshots.find((s) => s.companyId === series.companyId)?.totalShareholderValueUsd ?? null;
  const historyTsv = series.points.find((p) => p.turn === TOTAL)?.value ?? null;
  const match = finalTsv !== null && historyTsv !== null && Math.abs(finalTsv - historyTsv) < 1e-6;
  console.log(`${series.companyId.padEnd(7)}${row}   ${m(finalTsv)}  ${match ? "OK" : "MISMATCH"}`);
}

console.log("");
console.log("Turn32時点のDividend Value（累積・15%複利）と、Turn32単独の実配当額:");
for (const series of tsvSeries) {
  const snapshot = computeCompanyEvaluationSnapshot(history, series.companyId, TOTAL);
  const lastTurnDividend = dividendSeries.find((s) => s.companyId === series.companyId)?.points.find((p) => p.turn === TOTAL)?.value ?? 0;
  const paidTurns = dividendSeries
    .find((s) => s.companyId === series.companyId)!
    .points.filter((p) => (p.value ?? 0) > 0)
    .map((p) => p.turn);
  console.log(
    `${series.companyId.padEnd(7)} DividendValue=${m(snapshot.currentDividendValueUsd)}  T32単独=${m(lastTurnDividend)}  配当Turn=[${paidTurns.join(",")}]`
  );
}
