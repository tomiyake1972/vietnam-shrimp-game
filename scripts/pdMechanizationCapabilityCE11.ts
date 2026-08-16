// Standard AI Capability Expansion — Phase CE-1.1 Benchmark
//
// PD省人化投資（pdMechanization）の「capability」（Operational Need・Economics・
// Payback・Finance・Crisis Gate）と「Strategy Profile」（会社ごとの選好の強さ）を
// 分離した設計を、PROFILE OFF vs PROFILE ONの明示的なA/Bベンチマークで検証する。
// 既存ゲームロジック・PD機械化の効果エンジンは一切変更しない
// （ベンチマークスクリプトの新規追加のみ）。
//
// 出力:
//   docs/standard_ai/benchmarks/pd_mechanization_ce11_off_on_summary.md
//   docs/standard_ai/benchmarks/pd_mechanization_ce11_off_on.csv
//
// 使い方: npx tsx scripts/pdMechanizationCapabilityCE11.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";

const AT = "2026-01-01T00:00:00.000Z";

const SCENARIOS: readonly string[] = [
  "baseline",
  "ecuador-early-expansion",
  "ecuador-delayed-expansion",
  "global-demand-boom",
  "global-disease-crisis",
];

const SEEDS: readonly string[] = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];
const MODES: readonly ("OFF" | "ON")[] = ["OFF", "ON"];
const COMPANIES: readonly CompanyId[] = ["MASS", "BAL", "JPQ", "CONSV", "VAP"];

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  mode: "OFF" | "ON";
  companyId: string;
  managementProfileId: string;
  orientationProfileId: string;
  pdMechConsideredCount: number;
  pdMechCandidateCount: number; // considered AND cleared the utilization gate (payback evaluated)
  pdMechProposedCount: number;
  pdMechCompletedCount: number;
  firstProposedTurn: number | null;
  firstCompletedTurn: number | null;
  avgPaybackQuartersAtProposal: number;
  paybackSamples: number;
  totalLaborSavingsHeadcountAtProposal: number;
  pdProductionCumulative: number;
  hosoProductionCumulative: number;
  vapProductionCumulative: number;
  totalCapexPaidUsd: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
}

function newAggregate(scenario: string, seed: string, mode: "OFF" | "ON", companyId: string): CompanyRunAggregate {
  return {
    scenario,
    seed,
    mode,
    companyId,
    managementProfileId: "OFF",
    orientationProfileId: "OFF",
    pdMechConsideredCount: 0,
    pdMechCandidateCount: 0,
    pdMechProposedCount: 0,
    pdMechCompletedCount: 0,
    firstProposedTurn: null,
    firstCompletedTurn: null,
    avgPaybackQuartersAtProposal: 0,
    paybackSamples: 0,
    totalLaborSavingsHeadcountAtProposal: 0,
    pdProductionCumulative: 0,
    hosoProductionCumulative: 0,
    vapProductionCumulative: 0,
    totalCapexPaidUsd: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
  };
}

function runOne(scenario: string, seed: string, mode: "OFF" | "ON"): Map<string, CompanyRunAggregate> {
  let session = createSimulationSession({
    simulationRunId: `ce11-${scenario}-${seed}-${mode}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: mode,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, mode, c));
  const operatingProfitCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));

  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed}/${mode} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];

    for (const companyId of COMPANIES) {
      const agg = aggregates.get(companyId)!;
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const financialResult = record.financialResults.find((f) => f.companyId === companyId);
      const capexResult = record.capexResults.find((c) => c.companyId === companyId);
      const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === record.turn);
      const crisis = strategyTurn?.strategy.crisis;
      const crisisState = crisis?.state ?? "NORMAL";
      const profile = strategyTurn?.strategy.profile;
      if (profile && profile.mode === "ON") {
        agg.managementProfileId = profile.managementProfileId;
        agg.orientationProfileId = profile.orientationProfileId;
      }
      if (crisisState === "SEVERE_DISTRESS") agg.severeDistressQuarters++;
      else if (crisisState === "LIQUIDITY_STRESS") agg.liquidityStressQuarters++;

      const pdMech = strategyTurn?.strategy.pdMechanization;
      if (pdMech) {
        if (pdMech.reasonCodes.includes("PD_MECH_CONSIDERED")) agg.pdMechConsideredCount++;
        if (pdMech.reasonCodes.includes("PD_MECH_PAYBACK_UNATTRACTIVE") || pdMech.reasonCodes.includes("PD_MECH_PROPOSED")) {
          agg.pdMechCandidateCount++;
        }
        if (pdMech.reasonCodes.includes("PD_MECH_PROPOSED") && pdMech.proposedTargetFactoryId) {
          agg.pdMechProposedCount++;
          if (agg.firstProposedTurn === null) agg.firstProposedTurn = record.turn;
          if (pdMech.paybackQuarters !== null) {
            agg.avgPaybackQuartersAtProposal += pdMech.paybackQuarters;
            agg.paybackSamples++;
          }
          if (pdMech.laborSavingsHeadcount !== null) agg.totalLaborSavingsHeadcountAtProposal += pdMech.laborSavingsHeadcount;
        }
      }

      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdMechanization" && e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.pdMechCompletedCount++;
          if (agg.firstCompletedTurn === null) agg.firstCompletedTurn = record.turn;
        }
      }

      agg.hosoProductionCumulative += Number(summary?.hosoProduced ?? 0);
      agg.pdProductionCumulative += Number(summary?.pdProduced ?? 0);
      agg.vapProductionCumulative += Number(summary?.vapProduced ?? 0);

      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      operatingProfitCumulative[companyId] += opThisQuarter;
      agg.endingOperatingProfitCumulative = operatingProfitCumulative[companyId];
      agg.endingCash = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCash;
      agg.endingDebt = financialResult
        ? Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)
        : agg.endingDebt;
    }
  }

  for (const agg of aggregates.values()) {
    if (agg.paybackSamples > 0) agg.avgPaybackQuartersAtProposal /= agg.paybackSamples;
  }
  return aggregates;
}

function csvEscape(v: string | number): string {
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: readonly string[], rows: readonly (readonly (string | number)[])[]): void {
  const lines = [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const allAggregates: CompanyRunAggregate[] = [];
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const mode of MODES) {
        console.log(`Running ${scenario}/${seed}/${mode}...`);
        const aggregates = runOne(scenario, seed, mode);
        for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
      }
    }
  }

  const headers = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "managementProfileId",
    "orientationProfileId",
    "pdMechConsideredCount",
    "pdMechCandidateCount",
    "pdMechProposedCount",
    "pdMechCompletedCount",
    "firstProposedTurn",
    "firstCompletedTurn",
    "avgPaybackQuartersAtProposal",
    "totalLaborSavingsHeadcountAtProposal",
    "pdProductionCumulative",
    "pdProductionShare",
    "totalCapexPaidUsd",
    "endingOperatingProfitCumulative",
    "endingCash",
    "endingDebt",
    "liquidityStressQuarters",
    "severeDistressQuarters",
  ];
  const rows = allAggregates.map((a) => {
    const totalProd = a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    return [
      a.scenario,
      a.seed,
      a.mode,
      a.companyId,
      a.managementProfileId,
      a.orientationProfileId,
      a.pdMechConsideredCount,
      a.pdMechCandidateCount,
      a.pdMechProposedCount,
      a.pdMechCompletedCount,
      a.firstProposedTurn ?? -1,
      a.firstCompletedTurn ?? -1,
      a.avgPaybackQuartersAtProposal,
      a.totalLaborSavingsHeadcountAtProposal,
      a.pdProductionCumulative,
      totalProd > 0 ? a.pdProductionCumulative / totalProd : 0,
      a.totalCapexPaidUsd,
      a.endingOperatingProfitCumulative,
      a.endingCash,
      a.endingDebt,
      a.liquidityStressQuarters,
      a.severeDistressQuarters,
    ];
  });
  writeCsv(path.join(outDir, "pd_mechanization_ce11_off_on.csv"), headers, rows);

  const lines: string[] = [];
  lines.push("# Standard AI Capability Expansion CE-1.1 — PD Mechanization PROFILE OFF vs ON A/B Benchmark");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 5 companies x 32Q x (OFF, ON). ${allAggregates.length} company-runs total (${allAggregates.length / 2} per mode).`);
  lines.push("");
  lines.push("| Company | OFF proposal rate | ON proposal rate | OFF avg proposal Turn | ON avg proposal Turn | OFF avg payback | ON avg payback |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const offRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "OFF");
    const onRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "ON");
    const proposalRate = (rows_: CompanyRunAggregate[]) => mean(rows_.map((a) => (a.pdMechProposedCount > 0 ? 1 : 0)));
    const avgProposalTurn = (rows_: CompanyRunAggregate[]) => {
      const turns = rows_.map((a) => a.firstProposedTurn).filter((t): t is number => t !== null);
      return turns.length > 0 ? mean(turns) : NaN;
    };
    const avgPayback = (rows_: CompanyRunAggregate[]) => {
      const withSamples = rows_.filter((a) => a.pdMechProposedCount > 0);
      return withSamples.length > 0 ? mean(withSamples.map((a) => a.avgPaybackQuartersAtProposal)) : NaN;
    };
    lines.push(
      `| ${companyId} | ${(proposalRate(offRows) * 100).toFixed(0)}% | ${(proposalRate(onRows) * 100).toFixed(0)}% | ${
        Number.isNaN(avgProposalTurn(offRows)) ? "n/a" : avgProposalTurn(offRows).toFixed(1)
      } | ${Number.isNaN(avgProposalTurn(onRows)) ? "n/a" : avgProposalTurn(onRows).toFixed(1)} | ${
        Number.isNaN(avgPayback(offRows)) ? "n/a" : avgPayback(offRows).toFixed(2)
      } | ${Number.isNaN(avgPayback(onRows)) ? "n/a" : avgPayback(onRows).toFixed(2)} |`
    );
  }
  lines.push("");
  lines.push("## Full KPI comparison per company (avg across 25 runs/mode)");
  lines.push("");
  lines.push(
    "| Company | Mode | Considered | Candidate | Proposed | Completed | Labor saving (hd) | PD share | Total CAPEX ($) | Cumulative OP ($) | Ending cash ($) | Ending debt ($) | Crisis Q |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const modeRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const totalProd = (a: CompanyRunAggregate) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
      const pdShare = mean(modeRows.map((a) => (totalProd(a) > 0 ? a.pdProductionCumulative / totalProd(a) : 0)));
      lines.push(
        `| ${companyId} | ${mode} | ${mean(modeRows.map((a) => a.pdMechConsideredCount)).toFixed(1)} | ${mean(
          modeRows.map((a) => a.pdMechCandidateCount)
        ).toFixed(1)} | ${mean(modeRows.map((a) => a.pdMechProposedCount)).toFixed(2)} | ${mean(
          modeRows.map((a) => a.pdMechCompletedCount)
        ).toFixed(2)} | ${mean(modeRows.map((a) => a.totalLaborSavingsHeadcountAtProposal)).toFixed(2)} | ${(pdShare * 100).toFixed(
          1
        )}% | $${(mean(modeRows.map((a) => a.totalCapexPaidUsd)) / 1e6).toFixed(1)}M | $${(
          mean(modeRows.map((a) => a.endingOperatingProfitCumulative)) / 1e6
        ).toFixed(1)}M | $${(mean(modeRows.map((a) => a.endingCash)) / 1e6).toFixed(1)}M | $${(
          mean(modeRows.map((a) => a.endingDebt)) / 1e6
        ).toFixed(1)}M | ${mean(modeRows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters)).toFixed(1)} |`
      );
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pd_mechanization_ce11_off_on_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${rows.length} company rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
