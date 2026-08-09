// ShrimpX V2 — 32Q Management Console Phase 2: 保存サイズと実行時間の実測
//
// 保存物（SimulationRun + analytics dataset）が、ブラウザ保存・Redis保存の
// どちらにとっても現実的な大きさに収まっているかを実測する。
// 「巨大な state を複製していない」ことを数字で確認するための道具。

import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { buildDatasetFromSession } from "../app/lib/v2/companyLab/simulation/analytics/dataset";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../app/lib/v2/companyLab/simulation/persistence/types";

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const startedAt = "2026-01-01T00:00:00.000Z";
let session = createSimulationSession({
  simulationRunId: "size-probe",
  scenarioId: "baseline",
  seed: "management-console-32q",
  requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
  startedAt,
});

const begin = process.hrtime.bigint();
for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
  if (session.state.isComplete) break;
  const outcome = advanceSimulationTurn(session, startedAt);
  session = outcome.session;
  if (!outcome.advanced) break;
}
const elapsedMs = Number(process.hrtime.bigint() - begin) / 1e6;

const dataset = buildDatasetFromSession(session);
const stored = { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run, dataset, savedAt: startedAt };

const storedBytes = Buffer.byteLength(JSON.stringify(stored), "utf8");
const fullStateBytes = Buffer.byteLength(JSON.stringify(session.state), "utf8");

console.log("=== ShrimpX 32Q Simulation Run 保存サイズ ===");
console.log(`完了ターン数            : ${session.state.history.length}`);
console.log(`32Q 実行時間（Node）    : ${elapsedMs.toFixed(0)} ms`);
console.log("");
console.log(`保存物（run + dataset） : ${kb(storedBytes)}`);
console.log(`  ├ companyMetrics      : ${dataset.companyMetrics.length} 行`);
console.log(`  ├ marketMetrics       : ${dataset.marketMetrics.length} 行`);
console.log(`  ├ producerCountry     : ${dataset.producerCountryMetrics.length} 行`);
console.log(`  ├ bottlenecks         : ${dataset.bottlenecks.length} 行`);
console.log(`  ├ aiTrace             : ${dataset.aiTrace.length} 行`);
console.log(`  ├ salesTrace          : ${dataset.salesTrace.length} 行`);
console.log(`  ├ hiringTrace         : ${dataset.hiringTrace.length} 行`);
console.log(`  └ investmentTrace     : ${dataset.investmentTrace.length} 行`);
console.log("");
console.log("--- 節ごとのサイズ ---");
for (const [key, value] of Object.entries(dataset)) {
  console.log(`  ${key.padEnd(24)}: ${kb(Buffer.byteLength(JSON.stringify(value), "utf8"))}`);
}
console.log("");
console.log(`参考: CompanyLabState 全体をそのまま保存した場合 : ${kb(fullStateBytes)}`);
console.log(`削減率 : ${(100 * (1 - storedBytes / fullStateBytes)).toFixed(1)}%`);
