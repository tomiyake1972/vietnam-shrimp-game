// Standard AI Investment Portfolio Calibration — Phase PC-2A Benchmark
//
// VAP Product Development tier選定を、affordability単独（旧方式、BEFORE）から
// Investment Intensity（headroom・VAP事業規模・affordabilityの単純平均、AFTER）へ
// 変更した効果をBEFORE/AFTER controlled benchmarkで検証する。
// vapDevelopmentTierIntensityDisabled=trueでBEFORE（PC-2A以前の挙動）を再現し、
// falseまたは省略がAFTER（現行の正しい挙動）。PROFILE ON固定。
// Vision defaults・Profile値・QI-I1・PD Mechanization効果・Quality parameters・
// Finance/Procurement/Market式・VAP Product Development効果本体（スコア更新式・
// 減価・SG&A会計処理）は一切変更していない。
//
// 出力:
//   docs/standard_ai/benchmarks/pc2_vap_tier_before_after.md
//   docs/standard_ai/benchmarks/pc2_vap_tier.csv
//
// 使い方: npx tsx scripts/pc2VapTierCalibration.ts

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
const TIERS = [0, 100_000, 250_000, 500_000] as const;
const VARIANTS = ["BEFORE", "AFTER"] as const;
type Variant = (typeof VARIANTS)[number];

function csvEscape(v: string | number | boolean): string {
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeCsv(filePath: string, headers: readonly string[], rows: readonly (readonly (string | number | boolean)[])[]): void {
  const lines = [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

interface CompanyAggregate {
  scenario: string;
  seed: string;
  variant: Variant;
  companyId: string;
  tierCounts: Record<string, number>;
  totalSpendUsd: number;
  endingDevelopmentScore: number;
  endingVapShare: number;
  endingRevenueUsd: number;
  endingOperatingProfitUsd: number;
  endingCashUsd: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
}

function newAggregate(scenario: string, seed: string, variant: Variant, companyId: string): CompanyAggregate {
  return {
    scenario,
    seed,
    variant,
    companyId,
    tierCounts: Object.fromEntries(TIERS.map((t) => [String(t), 0])),
    totalSpendUsd: 0,
    endingDevelopmentScore: 0,
    endingVapShare: 0,
    endingRevenueUsd: 0,
    endingOperatingProfitUsd: 0,
    endingCashUsd: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
  };
}

function runOne(scenario: string, seed: string, variant: Variant, companies: readonly CompanyId[]): Map<string, CompanyAggregate> {
  let session = createSimulationSession({
    simulationRunId: `pc2a-${scenario}-${seed}-${variant}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: "ON",
    vapDevelopmentTierIntensityDisabled: variant === "BEFORE",
  });

  const aggregates = new Map<string, CompanyAggregate>();
  for (const c of companies) aggregates.set(c, newAggregate(scenario, seed, variant, c));

  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed}/${variant} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];

    for (const companyId of companies) {
      const agg = aggregates.get(companyId)!;
      const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === record.turn);
      const vapDev = strategyTurn?.strategy.vapProductDevelopment;
      const spendUsd = vapDev?.proposedSpendUsd ?? 0;
      const nearestTier = TIERS.reduce((best, t) => (Math.abs(t - spendUsd) < Math.abs(best - spendUsd) ? t : best), TIERS[0]);
      agg.tierCounts[String(nearestTier)]++;
      agg.totalSpendUsd += spendUsd;
      if (vapDev?.currentDevelopmentScore !== null && vapDev?.currentDevelopmentScore !== undefined) {
        agg.endingDevelopmentScore = vapDev.currentDevelopmentScore;
      }

      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const totalProd = Number(summary?.hosoProduced ?? 0) + Number(summary?.pdProduced ?? 0) + Number(summary?.vapProduced ?? 0);
      agg.endingVapShare = totalProd > 1e-6 ? Number(summary?.vapProduced ?? 0) / totalProd : agg.endingVapShare;

      const financialResult = record.financialResults.find((f) => f.companyId === companyId);
      agg.endingRevenueUsd = financialResult ? Number(financialResult.profitAndLoss.netRevenue) : agg.endingRevenueUsd;
      agg.endingOperatingProfitUsd = financialResult ? Number(financialResult.profitAndLoss.operatingProfit) : agg.endingOperatingProfitUsd;
      agg.endingCashUsd = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCashUsd;

      const crisisState = strategyTurn?.strategy.crisis?.state ?? "NORMAL";
      if (crisisState === "SEVERE_DISTRESS") agg.severeDistressQuarters++;
      else if (crisisState === "LIQUIDITY_STRESS") agg.liquidityStressQuarters++;
    }
  }

  return aggregates;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const allAggregates: CompanyAggregate[] = [];
  console.log("Running 5 scenarios x 5 seeds x 5 companies x 32Q x (BEFORE, AFTER)...");
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const variant of VARIANTS) {
        console.log(`  Running ${scenario}/${seed}/${variant}...`);
        const aggregates = runOne(scenario, seed, variant, COMPANIES);
        for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
      }
    }
  }

  const headers = [
    "scenario", "seed", "variant", "companyId",
    "count_0", "count_100000", "count_250000", "count_500000",
    "totalSpendUsd", "endingDevelopmentScore", "endingVapShare",
    "endingRevenueUsd", "endingOperatingProfitUsd", "endingCashUsd",
    "liquidityStressQuarters", "severeDistressQuarters",
  ];
  writeCsv(
    path.join(outDir, "pc2_vap_tier.csv"),
    headers,
    allAggregates.map((a) => [
      a.scenario, a.seed, a.variant, a.companyId,
      a.tierCounts["0"], a.tierCounts["100000"], a.tierCounts["250000"], a.tierCounts["500000"],
      a.totalSpendUsd, a.endingDevelopmentScore, a.endingVapShare,
      a.endingRevenueUsd, a.endingOperatingProfitUsd, a.endingCashUsd,
      a.liquidityStressQuarters, a.severeDistressQuarters,
    ])
  );

  const lines: string[] = [];
  lines.push("# Standard AI Investment Portfolio Calibration — Phase PC-2A VAP Tier BEFORE/AFTER Benchmark");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 5 companies x 32Q x (BEFORE, AFTER). PROFILE ON固定. ${allAggregates.length} company-runs.`);
  lines.push("");
  lines.push("## Tier frequency distribution (share of 32 quarters, avg across 25 runs/company/variant)");
  lines.push("");
  lines.push("| Company | Variant | $0 | $100k | $250k | $500k |");
  lines.push("|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const variant of VARIANTS) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.variant === variant);
      const total = 32;
      const avgCount = (tier: string) => mean(rows.map((a) => a.tierCounts[tier])) / total;
      lines.push(
        `| ${companyId} | ${variant} | ${(avgCount("0") * 100).toFixed(1)}% | ${(avgCount("100000") * 100).toFixed(1)}% | ${(avgCount("250000") * 100).toFixed(1)}% | ${(avgCount("500000") * 100).toFixed(1)}% |`
      );
    }
  }
  lines.push("");
  lines.push("## Total spend / development score / VAP share / financial KPI (avg across 25 runs/company/variant)");
  lines.push("");
  lines.push("| Company | Variant | Total spend ($) | Ending dev score | Ending VAP share | Revenue ($) | OP ($) | Cash ($) | Crisis Q |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const variant of VARIANTS) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.variant === variant);
      lines.push(
        `| ${companyId} | ${variant} | $${(mean(rows.map((a) => a.totalSpendUsd)) / 1e6).toFixed(2)}M | ${mean(rows.map((a) => a.endingDevelopmentScore)).toFixed(1)} | ${(
          mean(rows.map((a) => a.endingVapShare)) * 100
        ).toFixed(1)}% | $${(mean(rows.map((a) => a.endingRevenueUsd)) / 1e6).toFixed(1)}M | $${(mean(rows.map((a) => a.endingOperatingProfitUsd)) / 1e6).toFixed(
          1
        )}M | $${(mean(rows.map((a) => a.endingCashUsd)) / 1e6).toFixed(1)}M | ${mean(rows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters)).toFixed(1)} |`
      );
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pc2_vap_tier_before_after.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${allAggregates.length} company rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
