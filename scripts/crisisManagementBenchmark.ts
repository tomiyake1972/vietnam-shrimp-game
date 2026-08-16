// Standard AI Crisis Management — Phase CM-1 benchmark
//
// MASS abnormal 2 cases（Vision Calibration benchmarkで発見した32Q生産ゼロ異常）と
// normal 3 cases（正常operating）を32Qで比較する。
// 出力: Turn / crisisState / scaleRatio / newContracts / backlog / production / cash / debt / CAPEX提案数 / sales hires

import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const AT = "2026-01-01T00:00:00.000Z";

const CASES: readonly { readonly label: string; readonly scenario: string; readonly seed: string }[] = [
  { label: "ABNORMAL-1 (demand-boom/seed-1)", scenario: "global-demand-boom", seed: "seed-1" },
  { label: "ABNORMAL-2 (disease-crisis/seed-1)", scenario: "global-disease-crisis", seed: "seed-1" },
  { label: "NORMAL-1 (baseline/management-console-32q)", scenario: "baseline", seed: "management-console-32q" },
  { label: "NORMAL-2 (demand-boom/seed-2)", scenario: "global-demand-boom", seed: "seed-2" },
  { label: "NORMAL-3 (disease-crisis/seed-2)", scenario: "global-disease-crisis", seed: "seed-2" },
];

function run(scenario: string, seed: string) {
  let session = createSimulationSession({
    simulationRunId: `crisis-benchmark-${scenario}-${seed}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
  });
  const rows: string[] = [];
  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      rows.push(`Turn ${session.state.scenarioState.currentTurn}: FAILED — ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];
    const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === "MASS" && c.turn === record.turn);
    const decision = record.decisions.find((d) => d.companyId === "MASS");
    const summary = record.companySummaries.find((c) => c.companyId === "MASS");
    const financialResult = record.financialResults.find((f) => f.companyId === "MASS");
    const crisis = strategyTurn?.strategy.crisis ?? null;
    const production = summary ? Number(summary.hosoProduced) + Number(summary.pdProduced) + Number(summary.vapProduced) : null;
    const cash = financialResult ? Number(financialResult.balanceSheet.cash) / 1e6 : null;
    const debt = financialResult ? (Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)) / 1e6 : null;
    const capexCount = decision?.capexDecision.newProjectProposals.length ?? 0;
    const salesHires = decision?.salesForceHireCount ?? 0;

    rows.push(
      `T${record.turn} | crisis=${crisis?.state ?? "n/a"} | scaleRatio=${crisis?.procurementScaleRatio?.toFixed(2) ?? "n/a"} | ` +
        `newContracts=${(summary ? Number(summary.newContractedQuantity) : 0).toFixed(0)}t | backlog=${(summary ? Number(summary.outstandingQuantity) + Number(summary.overdueQuantity) : 0).toFixed(0)}t | ` +
        `prod=${production?.toFixed(0) ?? "n/a"}t | cash=${cash?.toFixed(1) ?? "n/a"}M | debt=${debt?.toFixed(1) ?? "n/a"}M | ` +
        `capexProposals=${capexCount} | salesHires=${salesHires}`
    );
  }
  return rows;
}

for (const c of CASES) {
  console.log(`\n=== ${c.label} ===`);
  const rows = run(c.scenario, c.seed);
  for (const r of rows) console.log(r);
}
