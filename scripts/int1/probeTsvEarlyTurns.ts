// TSV が序盤にどう振れるかの実測（表示開始Turnの根拠を得るためだけのスクリプト）。
import { advanceSimulationTurns, createSimulationSession } from "../../app/lib/v2/companyLab/simulation/engine";
import { computeAllCompaniesEvaluationSnapshot } from "../../app/lib/v2/companyLab/evaluation/evaluationSemantics";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const session0 = createSimulationSession({
  simulationRunId: "probe-tsv", scenarioId: "baseline", seed: "management-console-32q", requestedTurns: 32, startedAt: "2026-10-12T00:00:00.000Z",
});
const session = advanceSimulationTurns({ session: session0, turns: 16, timestamp: "2026-10-12T00:00:00.000Z" });
console.log("Turn |      BAL      MASS       JPQ       VAP     CONSV | 負の社数 | 最大/最小(百万USD)");
for (let turn = 1; turn <= 16; turn++) {
  const snaps = computeAllCompaniesEvaluationSnapshot(session.state.history, [...COMPANIES], turn);
  const vals = COMPANIES.map((c) => snaps.find((s) => s.companyId === c)?.totalShareholderValueUsd ?? null);
  const nums = vals.filter((v): v is number => v !== null);
  const neg = nums.filter((v) => v < 0).length;
  const fmt = (v: number | null) => (v === null ? "    －" : (v / 1e6).toFixed(0).padStart(9));
  console.log(
    `${String(turn).padStart(4)} |${vals.map(fmt).join("")} | ${neg}/5 | ${nums.length ? (Math.max(...nums)/1e6).toFixed(0) : "-"} / ${nums.length ? (Math.min(...nums)/1e6).toFixed(0) : "-"}`
  );
}
