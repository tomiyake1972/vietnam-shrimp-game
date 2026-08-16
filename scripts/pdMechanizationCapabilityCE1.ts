// Standard AI Capability Expansion — Phase CE-1 Benchmark
//
// PD省人化投資（pdMechanization）をStandard AIの投資候補に接続した後の、
// 5シナリオ×5シード×5社×32QベンチマークをPROFILE ON（主要ベンチマーク、指示§26）
// で実行する。既存ゲームロジック・PD機械化の効果エンジンは一切変更しない
// （ベンチマークスクリプトの新規追加のみ）。
//
// 出力:
//   docs/standard_ai/benchmarks/pd_mechanization_ce1_summary.md
//   docs/standard_ai/benchmarks/pd_mechanization_ce1_company.csv
//   docs/standard_ai/benchmarks/pd_mechanization_ce1_timeline.csv
//
// 使い方: npx tsx scripts/pdMechanizationCapabilityCE1.ts

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
const COMPANIES: readonly CompanyId[] = ["MASS", "BAL", "JPQ", "CONSV", "VAP"];

interface TimelineRow {
  readonly scenario: string;
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly crisisState: string;
  readonly eventKind: "considered" | "proposed" | "deferred" | "financeBlocked" | "alreadyActive" | "lowUtilization" | "completed" | "rejected";
  readonly targetFactoryId: string;
  readonly investmentCostUsd: number;
  readonly paybackQuarters: number;
  readonly laborSavingsHeadcount: number;
}

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  companyId: string;
  managementProfileId: string;
  orientationProfileId: string;
  pdMechConsideredCount: number;
  pdMechProposedCount: number;
  pdMechCompletedCount: number;
  pdMechRejectedCount: number;
  pdMechTargetFactories: Set<string>;
  pdMechTotalInvestmentUsd: number;
  pdLineExpansionProposedCount: number;
  pdLineExpansionPaidUsd: number;
  totalCapexPaidUsd: number;
  normalQuarters: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapProductionCumulative: number;
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  endingRegularWorkers: number;
  endingOvertimeRateSum: number;
  endingOvertimeRateSamples: number;
  endingWorkerShortageQuartersCount: number;
  endingLaborCostCumulative: number;
  // 【指示§29】機械化された工場の前後比較用: pdMechanization完了イベントが
  // 最初に発生したturn（未発生ならnull）。
  firstPdMechCompletedTurn: number | null;
}

function newAggregate(scenario: string, seed: string, companyId: string): CompanyRunAggregate {
  return {
    scenario,
    seed,
    companyId,
    managementProfileId: "OFF",
    orientationProfileId: "OFF",
    pdMechConsideredCount: 0,
    pdMechProposedCount: 0,
    pdMechCompletedCount: 0,
    pdMechRejectedCount: 0,
    pdMechTargetFactories: new Set(),
    pdMechTotalInvestmentUsd: 0,
    pdLineExpansionProposedCount: 0,
    pdLineExpansionPaidUsd: 0,
    totalCapexPaidUsd: 0,
    normalQuarters: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapProductionCumulative: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    endingRegularWorkers: 0,
    endingOvertimeRateSum: 0,
    endingOvertimeRateSamples: 0,
    endingWorkerShortageQuartersCount: 0,
    endingLaborCostCumulative: 0,
    firstPdMechCompletedTurn: null,
  };
}

function runOne(scenario: string, seed: string): { aggregates: Map<string, CompanyRunAggregate>; timeline: TimelineRow[] } {
  let session = createSimulationSession({
    simulationRunId: `ce1-${scenario}-${seed}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, c));
  const timeline: TimelineRow[] = [];

  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const operatingProfitCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));

  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];

    for (const companyId of COMPANIES) {
      const agg = aggregates.get(companyId)!;
      const decision = record.decisions.find((d) => d.companyId === companyId);
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
      else agg.normalQuarters++;

      const pdMech = strategyTurn?.strategy.pdMechanization;
      if (pdMech) {
        if (pdMech.reasonCodes.includes("PD_MECH_CONSIDERED")) agg.pdMechConsideredCount++;
        if (pdMech.reasonCodes.includes("PD_MECH_PROPOSED") && pdMech.proposedTargetFactoryId) {
          agg.pdMechProposedCount++;
          agg.pdMechTargetFactories.add(pdMech.proposedTargetFactoryId);
          agg.pdMechTotalInvestmentUsd += pdMech.investmentCostUsd ?? 0;
          timeline.push({
            scenario,
            seed,
            companyId,
            turn: record.turn,
            crisisState,
            eventKind: "proposed",
            targetFactoryId: pdMech.proposedTargetFactoryId,
            investmentCostUsd: pdMech.investmentCostUsd ?? 0,
            paybackQuarters: pdMech.paybackQuarters ?? 0,
            laborSavingsHeadcount: pdMech.laborSavingsHeadcount ?? 0,
          });
        }
      }

      for (const p of decision?.capexDecision.newProjectProposals ?? []) {
        if (p.projectType === "pdLineExpansion") agg.pdLineExpansionProposedCount++;
      }
      for (const r of capexResult?.rejectedProposals ?? []) {
        if (r.projectType === "pdMechanization") agg.pdMechRejectedCount++;
      }
      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdLineExpansion") agg.pdLineExpansionPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdMechanization" && e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.pdMechCompletedCount++;
          if (agg.firstPdMechCompletedTurn === null) agg.firstPdMechCompletedTurn = record.turn;
        }
      }

      agg.hosoProductionCumulative += Number(summary?.hosoProduced ?? 0);
      agg.pdProductionCumulative += Number(summary?.pdProduced ?? 0);
      agg.vapProductionCumulative += Number(summary?.vapProduced ?? 0);

      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      revenueCumulative[companyId] += revenueThisQuarter;
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      operatingProfitCumulative[companyId] += opThisQuarter;
      agg.endingRevenueCumulative = revenueCumulative[companyId];
      agg.endingOperatingProfitCumulative = operatingProfitCumulative[companyId];
      agg.endingCash = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCash;
      agg.endingDebt = financialResult
        ? Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)
        : agg.endingDebt;

      const workerAssignments = decision?.workerAssignments.filter((w) => w.companyId === companyId) ?? [];
      agg.endingRegularWorkers = workerAssignments.reduce((s, w) => s + Number(w.regularHeadcount), 0);
      const overtimeRates = workerAssignments.map((w) => Number(w.overtimeRate ?? 0)).filter((r) => Number.isFinite(r));
      for (const r of overtimeRates) {
        agg.endingOvertimeRateSum += r;
        agg.endingOvertimeRateSamples++;
      }
      const laborCostThisQuarter = Number(financialResult?.profitAndLoss.costOfSales.laborCost ?? 0);
      agg.endingLaborCostCumulative += laborCostThisQuarter;
    }
  }

  return { aggregates, timeline };
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
  const allTimeline: TimelineRow[] = [];

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`Running ${scenario}/${seed}...`);
      const { aggregates, timeline } = runOne(scenario, seed);
      for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
      allTimeline.push(...timeline);
    }
  }

  const companyHeaders = [
    "scenario",
    "seed",
    "companyId",
    "managementProfileId",
    "orientationProfileId",
    "pdMechConsideredCount",
    "pdMechProposedCount",
    "pdMechCompletedCount",
    "pdMechRejectedCount",
    "pdMechTargetFactoryCount",
    "pdMechTargetFactories",
    "pdMechTotalInvestmentUsd",
    "pdLineExpansionProposedCount",
    "pdLineExpansionPaidUsd",
    "totalCapexPaidUsd",
    "normalQuarters",
    "liquidityStressQuarters",
    "severeDistressQuarters",
    "hosoProductionCumulative",
    "pdProductionCumulative",
    "vapProductionCumulative",
    "pdProductionShare",
    "endingRevenueCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
    "endingDebt",
    "endingRegularWorkers",
    "avgOvertimeRate",
    "endingLaborCostCumulative",
    "firstPdMechCompletedTurn",
  ];
  const companyRows = allAggregates.map((a) => {
    const totalProd = a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    return [
      a.scenario,
      a.seed,
      a.companyId,
      a.managementProfileId,
      a.orientationProfileId,
      a.pdMechConsideredCount,
      a.pdMechProposedCount,
      a.pdMechCompletedCount,
      a.pdMechRejectedCount,
      a.pdMechTargetFactories.size,
      [...a.pdMechTargetFactories].join(";"),
      a.pdMechTotalInvestmentUsd,
      a.pdLineExpansionProposedCount,
      a.pdLineExpansionPaidUsd,
      a.totalCapexPaidUsd,
      a.normalQuarters,
      a.liquidityStressQuarters,
      a.severeDistressQuarters,
      a.hosoProductionCumulative,
      a.pdProductionCumulative,
      a.vapProductionCumulative,
      totalProd > 0 ? a.pdProductionCumulative / totalProd : 0,
      a.endingRevenueCumulative,
      a.endingOperatingProfitCumulative,
      a.endingCash,
      a.endingDebt,
      a.endingRegularWorkers,
      a.endingOvertimeRateSamples > 0 ? a.endingOvertimeRateSum / a.endingOvertimeRateSamples : 0,
      a.endingLaborCostCumulative,
      a.firstPdMechCompletedTurn ?? -1,
    ];
  });
  writeCsv(path.join(outDir, "pd_mechanization_ce1_company.csv"), companyHeaders, companyRows);

  const timelineHeaders = ["scenario", "seed", "companyId", "turn", "crisisState", "eventKind", "targetFactoryId", "investmentCostUsd", "paybackQuarters", "laborSavingsHeadcount"];
  const timelineRows = allTimeline.map((t) => [
    t.scenario,
    t.seed,
    t.companyId,
    t.turn,
    t.crisisState,
    t.eventKind,
    t.targetFactoryId,
    t.investmentCostUsd,
    t.paybackQuarters,
    t.laborSavingsHeadcount,
  ]);
  writeCsv(path.join(outDir, "pd_mechanization_ce1_timeline.csv"), timelineHeaders, timelineRows);

  const lines: string[] = [];
  lines.push("# Standard AI Capability Expansion CE-1 — PD Mechanization Benchmark (PROFILE ON)");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 5 companies x 32Q, mode=ON only (指示§26: PROFILE ONが主要ベンチマーク). ${allAggregates.length} company-runs total.`);
  lines.push("");
  lines.push("| Company | Profile | Considered | Proposed | Completed | Target factories | Investment ($) | PD share | PD Line paid ($) | Total CAPEX ($) | Cumulative OP ($) | Ending cash ($) | Ending debt ($) | Crisis Q (/32) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const rows = allAggregates.filter((a) => a.companyId === companyId);
    const considered = mean(rows.map((a) => a.pdMechConsideredCount));
    const proposed = mean(rows.map((a) => a.pdMechProposedCount));
    const completed = mean(rows.map((a) => a.pdMechCompletedCount));
    const targetFactoryCounts = mean(rows.map((a) => a.pdMechTargetFactories.size));
    const investment = mean(rows.map((a) => a.pdMechTotalInvestmentUsd));
    const totalProd = (a: CompanyRunAggregate) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    const pdShare = mean(rows.map((a) => (totalProd(a) > 0 ? a.pdProductionCumulative / totalProd(a) : 0)));
    const pdLinePaid = mean(rows.map((a) => a.pdLineExpansionPaidUsd));
    const capexTotal = mean(rows.map((a) => a.totalCapexPaidUsd));
    const op = mean(rows.map((a) => a.endingOperatingProfitCumulative));
    const cash = mean(rows.map((a) => a.endingCash));
    const debt = mean(rows.map((a) => a.endingDebt));
    const crisis = mean(rows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters));
    const mgmtProfile = rows.find((a) => a.managementProfileId !== "OFF")?.managementProfileId ?? "?";
    lines.push(
      `| ${companyId} | ${mgmtProfile} | ${considered.toFixed(1)} | ${proposed.toFixed(2)} | ${completed.toFixed(2)} | ${targetFactoryCounts.toFixed(1)} | $${(investment / 1e6).toFixed(2)}M | ${(pdShare * 100).toFixed(1)}% | $${(pdLinePaid / 1e6).toFixed(1)}M | $${(capexTotal / 1e6).toFixed(1)}M | $${(op / 1e6).toFixed(1)}M | $${(cash / 1e6).toFixed(1)}M | $${(debt / 1e6).toFixed(1)}M | ${crisis.toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## Scenario breakdown (PD Mechanization proposed count, averaged across seeds x companies)");
  lines.push("");
  lines.push("| Scenario | Avg proposed | Avg completed |");
  lines.push("|---|---|---|");
  for (const scenario of SCENARIOS) {
    const rows = allAggregates.filter((a) => a.scenario === scenario);
    lines.push(`| ${scenario} | ${mean(rows.map((a) => a.pdMechProposedCount)).toFixed(2)} | ${mean(rows.map((a) => a.pdMechCompletedCount)).toFixed(2)} |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pd_mechanization_ce1_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${companyRows.length} company rows, ${timelineRows.length} timeline rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
