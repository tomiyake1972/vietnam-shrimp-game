// Standard AI Capability Expansion — Phase CE-2 Benchmark
//
// VAP商品開発費（vapProductDevelopmentSpendUsd、tier選択）をStandard AIの投資候補に
// 接続した後の、5シナリオ×5シード×5社×32Q ベンチマークを PROFILE OFF vs PROFILE ON
// で実行する（指示§27・§29「PROFILE OFFでもeconomicsが良ければ投資可能」を
// 明示的に検証する）。既存ゲームロジック・VAP商品開発の効果エンジン
// （companyLab/productDevelopmentState.ts・premiumPolicy.ts）は一切変更しない
// （ベンチマークスクリプトの新規追加のみ）。
//
// 出力:
//   docs/standard_ai/benchmarks/vap_product_development_ce2_summary.md
//   docs/standard_ai/benchmarks/vap_product_development_ce2_company.csv
//   docs/standard_ai/benchmarks/vap_product_development_ce2_timeline.csv
//   docs/standard_ai/benchmarks/vap_product_development_ce2_off_on.csv
//
// 使い方: npx tsx scripts/vapProductDevelopmentCapabilityCE2.ts

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

interface TimelineRow {
  readonly scenario: string;
  readonly seed: string;
  readonly mode: "OFF" | "ON";
  readonly companyId: string;
  readonly turn: number;
  readonly crisisState: string;
  readonly spendUsd: number;
  readonly paybackQuarters: number;
  readonly currentDevelopmentScore: number;
}

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  mode: "OFF" | "ON";
  companyId: string;
  managementProfileId: string;
  orientationProfileId: string;
  consideredCount: number;
  proposedCount: number;
  totalSpendUsd: number;
  firstProposedTurn: number | null;
  avgPaybackQuartersAtProposal: number;
  paybackSamples: number;
  endingDevelopmentScore: number;
  vapProductionCumulative: number;
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapLineExpansionPaidUsd: number;
  totalCapexPaidUsd: number;
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  normalQuarters: number;
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
    consideredCount: 0,
    proposedCount: 0,
    totalSpendUsd: 0,
    firstProposedTurn: null,
    avgPaybackQuartersAtProposal: 0,
    paybackSamples: 0,
    endingDevelopmentScore: 50,
    vapProductionCumulative: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapLineExpansionPaidUsd: 0,
    totalCapexPaidUsd: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    normalQuarters: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
  };
}

function runOne(scenario: string, seed: string, mode: "OFF" | "ON"): { aggregates: Map<string, CompanyRunAggregate>; timeline: TimelineRow[] } {
  let session = createSimulationSession({
    simulationRunId: `ce2-${scenario}-${seed}-${mode}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: mode,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, mode, c));
  const timeline: TimelineRow[] = [];
  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
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
      else agg.normalQuarters++;

      const vapDev = strategyTurn?.strategy.vapProductDevelopment;
      if (vapDev) {
        if (vapDev.considered) agg.consideredCount++;
        if (vapDev.reasonCodes.includes("VAP_DEV_PROPOSED") && vapDev.proposedSpendUsd) {
          agg.proposedCount++;
          agg.totalSpendUsd += vapDev.proposedSpendUsd;
          if (agg.firstProposedTurn === null) agg.firstProposedTurn = record.turn;
          if (vapDev.paybackQuarters !== null) {
            agg.avgPaybackQuartersAtProposal += vapDev.paybackQuarters;
            agg.paybackSamples++;
          }
          timeline.push({
            scenario,
            seed,
            mode,
            companyId,
            turn: record.turn,
            crisisState,
            spendUsd: vapDev.proposedSpendUsd,
            paybackQuarters: vapDev.paybackQuarters ?? -1,
            currentDevelopmentScore: vapDev.currentDevelopmentScore ?? -1,
          });
        }
        if (vapDev.currentDevelopmentScore !== null) agg.endingDevelopmentScore = vapDev.currentDevelopmentScore;
      }

      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "vapLineExpansion") agg.vapLineExpansionPaidUsd += e.paymentSucceededUsd;
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
    }
  }

  for (const agg of aggregates.values()) {
    if (agg.paybackSamples > 0) agg.avgPaybackQuartersAtProposal /= agg.paybackSamples;
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
      for (const mode of MODES) {
        console.log(`Running ${scenario}/${seed}/${mode}...`);
        const { aggregates, timeline } = runOne(scenario, seed, mode);
        for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
        allTimeline.push(...timeline);
      }
    }
  }

  // company.csv (both modes, full KPI set)
  const companyHeaders = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "managementProfileId",
    "orientationProfileId",
    "consideredCount",
    "proposedCount",
    "totalSpendUsd",
    "firstProposedTurn",
    "avgPaybackQuartersAtProposal",
    "endingDevelopmentScore",
    "vapProductionCumulative",
    "vapProductionShare",
    "vapLineExpansionPaidUsd",
    "totalCapexPaidUsd",
    "endingRevenueCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
    "endingDebt",
    "liquidityStressQuarters",
    "severeDistressQuarters",
  ];
  const companyRows = allAggregates.map((a) => {
    const totalProd = a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    return [
      a.scenario,
      a.seed,
      a.mode,
      a.companyId,
      a.managementProfileId,
      a.orientationProfileId,
      a.consideredCount,
      a.proposedCount,
      a.totalSpendUsd,
      a.firstProposedTurn ?? -1,
      a.avgPaybackQuartersAtProposal,
      a.endingDevelopmentScore,
      a.vapProductionCumulative,
      totalProd > 0 ? a.vapProductionCumulative / totalProd : 0,
      a.vapLineExpansionPaidUsd,
      a.totalCapexPaidUsd,
      a.endingRevenueCumulative,
      a.endingOperatingProfitCumulative,
      a.endingCash,
      a.endingDebt,
      a.liquidityStressQuarters,
      a.severeDistressQuarters,
    ];
  });
  writeCsv(path.join(outDir, "vap_product_development_ce2_company.csv"), companyHeaders, companyRows);

  // timeline.csv
  const timelineHeaders = ["scenario", "seed", "mode", "companyId", "turn", "crisisState", "spendUsd", "paybackQuarters", "currentDevelopmentScore"];
  const timelineRows = allTimeline.map((t) => [
    t.scenario,
    t.seed,
    t.mode,
    t.companyId,
    t.turn,
    t.crisisState,
    t.spendUsd,
    t.paybackQuarters,
    t.currentDevelopmentScore,
  ]);
  writeCsv(path.join(outDir, "vap_product_development_ce2_timeline.csv"), timelineHeaders, timelineRows);

  // off_on.csv — one row per company x mode, for direct OFF/ON diffing
  const offOnHeaders = [
    "companyId",
    "mode",
    "avgConsideredCount",
    "avgProposedCount",
    "proposalRatePct",
    "avgFirstProposedTurn",
    "avgPaybackQuartersAtProposal",
    "avgEndingDevelopmentScore",
    "avgVapProductionShare",
    "avgTotalCapexPaidUsd",
    "avgCumulativeOpUsd",
    "avgEndingCashUsd",
    "avgEndingDebtUsd",
    "avgCrisisQuarters",
  ];
  const offOnRows: (string | number)[][] = [];
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const totalProd = (a: CompanyRunAggregate) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
      const proposedTurns = rows.map((a) => a.firstProposedTurn).filter((t): t is number => t !== null);
      offOnRows.push([
        companyId,
        mode,
        mean(rows.map((a) => a.consideredCount)),
        mean(rows.map((a) => a.proposedCount)),
        (rows.filter((a) => a.proposedCount > 0).length / rows.length) * 100,
        proposedTurns.length > 0 ? mean(proposedTurns) : -1,
        mean(rows.filter((a) => a.proposedCount > 0).map((a) => a.avgPaybackQuartersAtProposal)),
        mean(rows.map((a) => a.endingDevelopmentScore)),
        mean(rows.map((a) => (totalProd(a) > 0 ? a.vapProductionCumulative / totalProd(a) : 0))),
        mean(rows.map((a) => a.totalCapexPaidUsd)),
        mean(rows.map((a) => a.endingOperatingProfitCumulative)),
        mean(rows.map((a) => a.endingCash)),
        mean(rows.map((a) => a.endingDebt)),
        mean(rows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters)),
      ]);
    }
  }
  writeCsv(path.join(outDir, "vap_product_development_ce2_off_on.csv"), offOnHeaders, offOnRows);

  // summary.md
  const lines: string[] = [];
  lines.push("# Standard AI Capability Expansion CE-2 — VAP Product Development Benchmark (PROFILE OFF vs ON)");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 5 companies x 32Q x (OFF, ON). ${allAggregates.length} company-runs total (${allAggregates.length / 2} per mode).`);
  lines.push("");
  lines.push("| Company | OFF proposal rate | ON proposal rate | OFF avg proposal Turn | ON avg proposal Turn | OFF ending score | ON ending score |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const offRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "OFF");
    const onRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "ON");
    const proposalRate = (rows: CompanyRunAggregate[]) => (rows.filter((a) => a.proposedCount > 0).length / rows.length) * 100;
    const avgProposalTurn = (rows: CompanyRunAggregate[]) => {
      const turns = rows.map((a) => a.firstProposedTurn).filter((t): t is number => t !== null);
      return turns.length > 0 ? mean(turns) : NaN;
    };
    lines.push(
      `| ${companyId} | ${proposalRate(offRows).toFixed(0)}% | ${proposalRate(onRows).toFixed(0)}% | ${
        Number.isNaN(avgProposalTurn(offRows)) ? "n/a" : avgProposalTurn(offRows).toFixed(1)
      } | ${Number.isNaN(avgProposalTurn(onRows)) ? "n/a" : avgProposalTurn(onRows).toFixed(1)} | ${mean(
        offRows.map((a) => a.endingDevelopmentScore)
      ).toFixed(1)} | ${mean(onRows.map((a) => a.endingDevelopmentScore)).toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## Full KPI comparison per company (avg across 25 runs/mode)");
  lines.push("");
  lines.push(
    "| Company | Mode | Considered | Proposed | Total spend ($) | VAP share | VAP Line paid ($) | Total CAPEX ($) | Cumulative OP ($) | Ending cash ($) | Ending debt ($) | Crisis Q |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const totalProd = (a: CompanyRunAggregate) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
      const vapShare = mean(rows.map((a) => (totalProd(a) > 0 ? a.vapProductionCumulative / totalProd(a) : 0)));
      lines.push(
        `| ${companyId} | ${mode} | ${mean(rows.map((a) => a.consideredCount)).toFixed(1)} | ${mean(rows.map((a) => a.proposedCount)).toFixed(
          2
        )} | $${(mean(rows.map((a) => a.totalSpendUsd)) / 1e6).toFixed(2)}M | ${(vapShare * 100).toFixed(1)}% | $${(
          mean(rows.map((a) => a.vapLineExpansionPaidUsd)) / 1e6
        ).toFixed(1)}M | $${(mean(rows.map((a) => a.totalCapexPaidUsd)) / 1e6).toFixed(1)}M | $${(
          mean(rows.map((a) => a.endingOperatingProfitCumulative)) / 1e6
        ).toFixed(1)}M | $${(mean(rows.map((a) => a.endingCash)) / 1e6).toFixed(1)}M | $${(mean(rows.map((a) => a.endingDebt)) / 1e6).toFixed(
          1
        )}M | ${mean(rows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters)).toFixed(1)} |`
      );
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "vap_product_development_ce2_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${companyRows.length} company rows, ${timelineRows.length} timeline rows, ${offOnRows.length} off/on rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
