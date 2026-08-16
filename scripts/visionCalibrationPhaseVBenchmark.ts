// Management Console Vision Calibration — Phase V benchmark
//
// MASS Vision target 40,000 t/Q（override、旧値相当）と 80,000 t/Q（新default）を、
// 同じ5 scenario × 5 seedで比較する。strategicPostureはどちらもAGGRESSIVE_EARLY_CAPACITY
// のまま（変えているのはVision target quantityだけ）。
//
// 「Visionを上げたら閾値も一緒に変える」をしない（指示§34「Threshold調整は一旦禁止」）ため、
// New Factory gate・activation・commercial ambition等のパラメータは一切変更していない。

import { advanceSimulationTurns, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyLabVisionOverrides } from "../app/lib/v2/companyLab/vision/overrides";

const AT = "2026-01-01T00:00:00.000Z";
const SCENARIOS = ["baseline", "ecuador-early-expansion", "ecuador-delayed-expansion", "global-demand-boom", "global-disease-crisis"];
const SEEDS = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];

const MASS_40K_OVERRIDE: CompanyLabVisionOverrides = {
  MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 40000, source: "MANUAL_OVERRIDE" }],
};

interface RunResult {
  readonly scenario: string;
  readonly seed: string;
  readonly variant: "40k" | "80k";
  readonly stopReason: string;
  readonly completedTurns: number;
  readonly finalFactoryCount: number | null;
  readonly factory2ProposalTurn: number | null;
  readonly factory2CompletionTurn: number | null;
  readonly factory3ProposalTurn: number | null;
  readonly factory3CompletionTurn: number | null;
  readonly reactiveRouteCount: number;
  readonly strategicRouteCount: number;
  readonly finalCapacityTons: number | null;
  readonly finalProductionTons: number | null;
  readonly finalContractsCount: number;
  readonly finalBacklogTons: number | null;
  readonly cumulativeOperatingProfitUsd: number | null;
  readonly finalCashUsd: number | null;
  readonly finalDebtUsd: number | null;
  readonly finalUtilizationRatio: number | null;
}

function run(scenario: string, seed: string, variant: "40k" | "80k"): RunResult {
  const runId = `phase-v-${scenario}-${seed}-${variant}`;
  let session = createSimulationSession({
    simulationRunId: runId,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    visionOverrides: variant === "40k" ? MASS_40K_OVERRIDE : undefined,
  });
  session = advanceSimulationTurns({ session, turns: MANAGEMENT_CONSOLE_STANDARD_TURNS, timestamp: AT });

  const turns = session.packCompanyTurns.filter((c) => c.companyId === "MASS").sort((a, b) => a.turn - b.turn);
  const last = turns[turns.length - 1];

  let factory2ProposalTurn: number | null = null;
  let factory2CompletionTurn: number | null = null;
  let factory3ProposalTurn: number | null = null;
  let factory3CompletionTurn: number | null = null;
  let reactiveRouteCount = 0;
  let strategicRouteCount = 0;
  let priorFactoryCount: number | null = null;
  let proposalsSeen = 0;

  for (const t of turns) {
    const nf = t.strategy.newFactory;
    const factoryCount = t.endingState.factoryCount;
    if (factoryCount !== null && priorFactoryCount !== null && factoryCount > priorFactoryCount) {
      // 完成（Turn末時点でfactoryCountが増えた瞬間）。
      if (priorFactoryCount === 1) factory2CompletionTurn = t.turn;
      if (priorFactoryCount === 2) factory3CompletionTurn = t.turn;
    }
    priorFactoryCount = factoryCount ?? priorFactoryCount;

    if (nf) {
      if (nf.decisionRoute === "REACTIVE") reactiveRouteCount += 1;
      if (nf.decisionRoute === "STRATEGIC_FORWARD_CAPACITY") strategicRouteCount += 1;
      if (nf.status === "READY_TO_BUILD") {
        proposalsSeen += 1;
        if (proposalsSeen === 1) factory2ProposalTurn = t.turn;
        if (proposalsSeen === 2) factory3ProposalTurn = t.turn;
      }
    }
  }

  const finalCapacity = last
    ? (last.endingState.capacityTonsByProduct.hoso ?? 0) + (last.endingState.capacityTonsByProduct.pd ?? 0) + (last.endingState.capacityTonsByProduct.vap ?? 0)
    : null;

  const massContracts = session.state.contracts.filter((c) => c.companyId === "MASS");
  const cumulativeOp = session.state.history.reduce((sum, record) => {
    const fr = record.financialResults.find((f) => f.companyId === "MASS");
    return sum + Number(fr?.profitAndLoss.operatingProfit ?? 0);
  }, 0);
  const lastRecord = session.state.history[session.state.history.length - 1];
  const lastSummary = lastRecord?.companySummaries.find((s) => s.companyId === "MASS");
  const finalProduction = lastSummary ? Number(lastSummary.hosoProduced) + Number(lastSummary.pdProduced) + Number(lastSummary.vapProduced) : null;

  return {
    scenario,
    seed,
    variant,
    stopReason: session.run.stopReason,
    completedTurns: session.run.completedTurns,
    finalFactoryCount: last?.endingState.factoryCount ?? null,
    factory2ProposalTurn,
    factory2CompletionTurn,
    factory3ProposalTurn,
    factory3CompletionTurn,
    reactiveRouteCount,
    strategicRouteCount,
    finalCapacityTons: finalCapacity,
    finalProductionTons: finalProduction,
    finalContractsCount: massContracts.length,
    finalBacklogTons: last?.endingState.backlogTons ?? null,
    cumulativeOperatingProfitUsd: cumulativeOp,
    finalCashUsd: last?.endingState.cashUsd ?? null,
    finalDebtUsd: last?.endingState.debtUsd ?? null,
    finalUtilizationRatio: finalCapacity && finalCapacity > 0 && finalProduction !== null ? finalProduction / finalCapacity : null,
  };
}

function fmt(v: number | null, digits = 0): string {
  return v === null ? "n/a" : v.toFixed(digits);
}

const results: RunResult[] = [];
for (const scenario of SCENARIOS) {
  for (const seed of SEEDS) {
    for (const variant of ["40k", "80k"] as const) {
      const r = run(scenario, seed, variant);
      results.push(r);
      console.log(
        `${scenario} / ${seed} / ${variant}: turns=${r.completedTurns} stop=${r.stopReason} ` +
          `factories=${r.finalFactoryCount} f2Proposal=${r.factory2ProposalTurn ?? "-"} f2Done=${r.factory2CompletionTurn ?? "-"} ` +
          `f3Proposal=${r.factory3ProposalTurn ?? "-"} f3Done=${r.factory3CompletionTurn ?? "-"} route(R/S)=${r.reactiveRouteCount}/${r.strategicRouteCount} ` +
          `cap=${fmt(r.finalCapacityTons)}t prod=${fmt(r.finalProductionTons)}t util=${fmt(r.finalUtilizationRatio, 2)} ` +
          `contracts=${r.finalContractsCount} backlog=${fmt(r.finalBacklogTons)}t cumOP=${fmt((r.cumulativeOperatingProfitUsd ?? 0) / 1e6, 1)}M ` +
          `cash=${fmt((r.finalCashUsd ?? 0) / 1e6, 1)}M debt=${fmt((r.finalDebtUsd ?? 0) / 1e6, 1)}M`
      );
    }
  }
}

console.log("\n=== Summary by scenario × variant (avg over 5 seeds) ===");
for (const scenario of SCENARIOS) {
  for (const variant of ["40k", "80k"] as const) {
    const rows = results.filter((r) => r.scenario === scenario && r.variant === variant);
    const avgFactories = rows.reduce((s, r) => s + (r.finalFactoryCount ?? 0), 0) / rows.length;
    const factory3Count = rows.filter((r) => r.finalFactoryCount !== null && r.finalFactoryCount >= 3).length;
    const avgCumOp = rows.reduce((s, r) => s + (r.cumulativeOperatingProfitUsd ?? 0), 0) / rows.length / 1e6;
    const avgUtil = rows.reduce((s, r) => s + (r.finalUtilizationRatio ?? 0), 0) / rows.length;
    console.log(
      `${scenario} / ${variant}: avgFactories=${avgFactories.toFixed(2)} seeds-with-3rd-factory=${factory3Count}/5 avgCumOP=${avgCumOp.toFixed(1)}M avgUtil=${avgUtil.toFixed(2)}`
    );
  }
}
