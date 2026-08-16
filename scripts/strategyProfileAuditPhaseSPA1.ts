// Standard AI Strategy Profile Audit — Phase SP-A1
//
// CM-1後（HEAD ce030f0）における、5社×5シナリオ×5シードの32Qベンチマークを実行し、
// 会社ごとの投資行動（Turn単位）を抽出する。既存ゲームロジックは一切変更しない
// （監査スクリプトの新規追加のみ）。
//
// 出力:
//   docs/standard_ai/benchmarks/strategy_profile_audit_spa1.csv       — 会社×シナリオ×シード 集計1行
//   docs/standard_ai/benchmarks/company_investment_timeline_spa1.csv  — 会社×シナリオ×シード×Turn の投資タイムライン
//
// 使い方: npx tsx scripts/strategyProfileAuditPhaseSPA1.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { CapitalProjectType } from "../app/lib/v2/capex/types";

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

const PROJECT_TYPES: readonly CapitalProjectType[] = [
  "hosoLineExpansion",
  "pdLineExpansion",
  "vapLineExpansion",
  "commonProcessingExpansion",
  "freezingPackagingExpansion",
  "coldStorageExpansion",
  "qualityControlEquipment",
  "environmentalEquipment",
  "newFactoryConstruction",
  "pdMechanization",
];

interface TimelineRow {
  readonly scenario: string;
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly crisisState: string;
  readonly eventKind: "proposed" | "rejected" | "statusChange";
  readonly projectType: string;
  readonly detail: string;
  readonly amountUsd: number;
}

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  companyId: string;
  // counts by project type (proposed this run, across 32Q)
  proposedByType: Record<string, number>;
  approvedByType: Record<string, number>; // statusBefore=approved/underConstruction reached (i.e. actually funded, not just proposed-then-rejected)
  completedByType: Record<string, number>; // reached status "completed"
  rejectedByType: Record<string, number>;
  vapProductDevelopmentSpendTurns: number; // turns with spend > 0
  vapProductDevelopmentTotalUsd: number;
  totalCapexPaidUsd: number;
  salesHiresTotal: number;
  salesLayoffsTotal: number;
  workerHiresTotal: number; // sum of positive regularHeadcount deltas turn over turn (approx via workerAssignments end level, so instead track ending headcount)
  normalQuarters: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
  // ending KPIs (last turn)
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  endingProductionCumulative: number;
  endingContractsCumulative: number;
  endingBacklog: number;
  endingFactoryCount: number;
  endingSalesHeadcount: number;
  endingRegularWorkers: number;
}

function emptyCountRecord(): Record<string, number> {
  const r: Record<string, number> = {};
  for (const t of PROJECT_TYPES) r[t] = 0;
  return r;
}

function newAggregate(scenario: string, seed: string, companyId: string): CompanyRunAggregate {
  return {
    scenario,
    seed,
    companyId,
    proposedByType: emptyCountRecord(),
    approvedByType: emptyCountRecord(),
    completedByType: emptyCountRecord(),
    rejectedByType: emptyCountRecord(),
    vapProductDevelopmentSpendTurns: 0,
    vapProductDevelopmentTotalUsd: 0,
    totalCapexPaidUsd: 0,
    salesHiresTotal: 0,
    salesLayoffsTotal: 0,
    workerHiresTotal: 0,
    normalQuarters: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    endingProductionCumulative: 0,
    endingContractsCumulative: 0,
    endingBacklog: 0,
    endingFactoryCount: 0,
    endingSalesHeadcount: 0,
    endingRegularWorkers: 0,
  };
}

function runOne(scenario: string, seed: string): { readonly aggregates: Map<string, CompanyRunAggregate>; readonly timeline: TimelineRow[] } {
  let session = createSimulationSession({
    simulationRunId: `spa1-${scenario}-${seed}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, c));
  const timeline: TimelineRow[] = [];

  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const operatingProfitCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const productionCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const contractsCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));

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

      if (crisisState === "SEVERE_DISTRESS") agg.severeDistressQuarters++;
      else if (crisisState === "LIQUIDITY_STRESS") agg.liquidityStressQuarters++;
      else agg.normalQuarters++;

      // Proposals this turn
      for (const p of decision?.capexDecision.newProjectProposals ?? []) {
        agg.proposedByType[p.projectType] = (agg.proposedByType[p.projectType] ?? 0) + 1;
        timeline.push({
          scenario,
          seed,
          companyId,
          turn: record.turn,
          crisisState,
          eventKind: "proposed",
          projectType: p.projectType,
          detail: `targetFactoryId=${p.targetFactoryId ?? ""}`,
          amountUsd: 0,
        });
      }
      // Rejected proposals this turn
      for (const r of capexResult?.rejectedProposals ?? []) {
        agg.rejectedByType[r.projectType] = (agg.rejectedByType[r.projectType] ?? 0) + 1;
        timeline.push({
          scenario,
          seed,
          companyId,
          turn: record.turn,
          crisisState,
          eventKind: "rejected",
          projectType: r.projectType,
          detail: r.reasons.join(";"),
          amountUsd: r.requestedBudgetUsd,
        });
      }
      // Status-change events (approved/underConstruction/completed)
      for (const e of capexResult?.events ?? []) {
        if (e.statusBefore !== "approved" && e.statusAfter === "approved") {
          agg.approvedByType[e.projectType] = (agg.approvedByType[e.projectType] ?? 0) + 1;
        }
        if (e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.completedByType[e.projectType] = (agg.completedByType[e.projectType] ?? 0) + 1;
        }
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        timeline.push({
          scenario,
          seed,
          companyId,
          turn: record.turn,
          crisisState,
          eventKind: "statusChange",
          projectType: e.projectType,
          detail: `${e.statusBefore}->${e.statusAfter}`,
          amountUsd: e.paymentSucceededUsd,
        });
      }

      // VAP Product Development spend (not a CapitalProjectType — separate SG&A decision field)
      const vapSpend = Number(decision?.vapProductDevelopmentSpendUsd ?? 0);
      if (vapSpend > 0) {
        agg.vapProductDevelopmentSpendTurns++;
        agg.vapProductDevelopmentTotalUsd += vapSpend;
      }

      // Sales hiring / layoffs
      const hires = Number(decision?.salesForceHireCount ?? 0);
      const layoffs = Number(decision?.salesForceLayoffCount ?? 0);
      agg.salesHiresTotal += hires;
      agg.salesLayoffsTotal += layoffs;

      // Revenue / operating profit (from financial results P&L, if present)
      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      revenueCumulative[companyId] += revenueThisQuarter;
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      operatingProfitCumulative[companyId] += opThisQuarter;

      const productionThisQuarter = summary
        ? Number(summary.hosoProduced) + Number(summary.pdProduced) + Number(summary.vapProduced)
        : 0;
      productionCumulative[companyId] += productionThisQuarter;
      contractsCumulative[companyId] += Number(summary?.newContractedQuantity ?? 0);

      // Ending KPIs (overwritten each turn, so last write = final turn value)
      agg.endingRevenueCumulative = revenueCumulative[companyId];
      agg.endingOperatingProfitCumulative = operatingProfitCumulative[companyId];
      agg.endingProductionCumulative = productionCumulative[companyId];
      agg.endingContractsCumulative = contractsCumulative[companyId];
      agg.endingCash = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCash;
      agg.endingDebt = financialResult
        ? Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)
        : agg.endingDebt;
      agg.endingBacklog = summary ? Number(summary.outstandingQuantity) + Number(summary.overdueQuantity) : agg.endingBacklog;

      const workerAssignments = decision?.workerAssignments.filter((w) => w.companyId === companyId) ?? [];
      agg.endingRegularWorkers = workerAssignments.reduce((s, w) => s + Number(w.regularHeadcount), 0);

      const capexFactories = session.fixtures.find((f) => f.companyId === companyId)?.factories ?? [];
      agg.endingFactoryCount = capexFactories.length;
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

  // strategy_profile_audit_spa1.csv — one row per company x scenario x seed
  const summaryHeaders = [
    "scenario",
    "seed",
    "companyId",
    ...PROJECT_TYPES.map((t) => `proposed_${t}`),
    ...PROJECT_TYPES.map((t) => `approved_${t}`),
    ...PROJECT_TYPES.map((t) => `completed_${t}`),
    ...PROJECT_TYPES.map((t) => `rejected_${t}`),
    "vapDevSpendTurns",
    "vapDevTotalUsd",
    "totalCapexPaidUsd",
    "salesHiresTotal",
    "salesLayoffsTotal",
    "normalQuarters",
    "liquidityStressQuarters",
    "severeDistressQuarters",
    "endingRevenueCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
    "endingDebt",
    "endingProductionCumulative",
    "endingContractsCumulative",
    "endingBacklog",
    "endingFactoryCount",
    "endingRegularWorkers",
  ];
  const summaryRows = allAggregates.map((a) => [
    a.scenario,
    a.seed,
    a.companyId,
    ...PROJECT_TYPES.map((t) => a.proposedByType[t] ?? 0),
    ...PROJECT_TYPES.map((t) => a.approvedByType[t] ?? 0),
    ...PROJECT_TYPES.map((t) => a.completedByType[t] ?? 0),
    ...PROJECT_TYPES.map((t) => a.rejectedByType[t] ?? 0),
    a.vapProductDevelopmentSpendTurns,
    a.vapProductDevelopmentTotalUsd,
    a.totalCapexPaidUsd,
    a.salesHiresTotal,
    a.salesLayoffsTotal,
    a.normalQuarters,
    a.liquidityStressQuarters,
    a.severeDistressQuarters,
    a.endingRevenueCumulative,
    a.endingOperatingProfitCumulative,
    a.endingCash,
    a.endingDebt,
    a.endingProductionCumulative,
    a.endingContractsCumulative,
    a.endingBacklog,
    a.endingFactoryCount,
    a.endingRegularWorkers,
  ]);
  writeCsv(path.join(outDir, "strategy_profile_audit_spa1.csv"), summaryHeaders, summaryRows);

  // company_investment_timeline_spa1.csv — long format, one row per event
  const timelineHeaders = ["scenario", "seed", "companyId", "turn", "crisisState", "eventKind", "projectType", "detail", "amountUsd"];
  const timelineRows = allTimeline.map((t) => [
    t.scenario,
    t.seed,
    t.companyId,
    t.turn,
    t.crisisState,
    t.eventKind,
    t.projectType,
    t.detail,
    t.amountUsd,
  ]);
  writeCsv(path.join(outDir, "company_investment_timeline_spa1.csv"), timelineHeaders, timelineRows);

  console.log(`\nWrote ${summaryRows.length} summary rows and ${timelineRows.length} timeline rows to ${outDir}`);

  // Print a compact company x scenario aggregate (averaged over seeds) to stdout for quick review
  console.log("\n=== Quick summary: total proposals by company (summed across all scenario x seed) ===");
  const byCompanyTotals = new Map<string, Record<string, number>>();
  for (const c of COMPANIES) byCompanyTotals.set(c, emptyCountRecord());
  for (const a of allAggregates) {
    const totals = byCompanyTotals.get(a.companyId)!;
    for (const t of PROJECT_TYPES) totals[t] += a.proposedByType[t] ?? 0;
  }
  for (const c of COMPANIES) {
    const totals = byCompanyTotals.get(c)!;
    console.log(`${c}: ${PROJECT_TYPES.map((t) => `${t}=${totals[t]}`).join(" ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
