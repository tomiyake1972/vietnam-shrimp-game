// 検証専用: lifecycle未使用のsimulation runで、capacity snapshot / series / AI Pack /
// 主要財務が修正前後で一致することを比較するためのダンプ。
import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { buildCompanyInspectorSnapshot } from "../app/lib/v2/companyLab/simulation/series";
import { captureCompanyStateSnapshot } from "../app/lib/v2/companyLab/simulation/aiPack/capture";

const scenarioId = process.argv[2] ?? "dynamic-scenario-1";
const seed = process.argv[3] ?? "reg-a";
const turns = Number(process.argv[4] ?? 32);

let session = createSimulationSession({
  simulationRunId: "readpath-reg",
  scenarioId,
  seed,
  requestedTurns: turns,
  startedAt: "2026-01-01T00:00:00.000Z",
});
for (let t = 1; t <= turns; t++) {
  const outcome = advanceSimulationTurn(session, "2026-01-01T00:00:00.000Z");
  if (outcome.error) throw new Error(`T${t}: ${String(outcome.error)}`);
  if (!outcome.advanced) break;
  session = outcome.session;
}
const R = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : Math.round(v).toString());
for (const c of session.capacityByTurn) {
  console.log(
    `CAP\t${c.turn}\t${c.companyId}\t${R(c.hoso)}\t${R(c.pd)}\t${R(c.vap)}\t${R(c.commonProcessing)}\t${R(c.freezingPackaging)}`
  );
}
for (const fixture of session.fixtures) {
  const ins = buildCompanyInspectorSnapshot(session.state, fixture.companyId, session.fixtures);
  const pack = captureCompanyStateSnapshot(session.state, fixture);
  console.log(
    `SER\t${fixture.companyId}\t${R(ins?.revenue)}\t${R(ins?.operatingProfit)}\t${R(ins?.cash)}\t${R(ins?.debt)}\t${R(ins?.hosoCapacity)}\t${R(ins?.commonCapacity)}\t${R(ins?.hosoProduced)}\t${R(ins?.pdProduced)}\t${R(ins?.vapProduced)}`
  );
  console.log(
    `PACK\t${fixture.companyId}\t${R(pack.capacityTonsByProduct.hoso)}\t${R(pack.capacityTonsByProduct.pd)}\t${R(pack.capacityTonsByProduct.vap)}\t${R(pack.commonProcessingCapacityTons)}`
  );
}
