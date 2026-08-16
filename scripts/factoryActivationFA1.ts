// Standard AI Factory Activation Strategy — Phase FA-1 Benchmark
//
// 監査で発見した既存バグ（companyLab/standardAi/decision/labor.tsが
// fixture.workerBaseline＝静的fixtureだけを走査しており、新設Factoryへは
// 常にWorkerAssignmentが一切生成されなかった＝「工場は建つが動かす人がいない」）
// を修正した効果を、controlled ablationで検証する。
// factoryActivationLaborFixDisabled=trueで修正前の挙動（EXISTING_AI）を再現し、
// falseまたは省略（FACTORY_ACTIVATION_ON）が現行の正しい挙動。
// PROFILE ON固定。Vision defaults・Profile値・QI-I1・PD Mechanization効果・
// VAP Product Development効果・Quality parameters・Finance/Procurement/Market式は
// 一切変更していない。
//
// 出力:
//   docs/standard_ai/benchmarks/factory_activation_fa1_summary.md
//   docs/standard_ai/benchmarks/factory_activation_fa1_company.csv
//   docs/standard_ai/benchmarks/factory_activation_fa1_factory_timeline.csv
//   docs/standard_ai/benchmarks/factory_activation_fa1_high_vision.csv
//   docs/standard_ai/benchmarks/factory_activation_fa1_portfolio.csv
//
// 使い方: npx tsx scripts/factoryActivationFA1.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { CompanyLabVisionOverrides } from "../app/lib/v2/companyLab/vision/overrides";
import { StrategicPosture } from "../app/lib/v2/companyLab/vision/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

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
const LINE_CAPEX_TYPES = new Set(["hosoLineExpansion", "pdLineExpansion", "vapLineExpansion", "commonProcessingExpansion"]);
const VARIANTS = ["EXISTING_AI", "FACTORY_ACTIVATION_ON"] as const;
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

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  variant: Variant;
  companyId: string;
  factoryConstructionTurn: number | null;
  factoryCompletionTurn: number | null;
  pdMechCompletedCount: number;
  qualityEquipCompletedCount: number;
  pdMechPaidUsd: number;
  vapDevSpendUsd: number;
  qualityEquipPaidUsd: number;
  lineCapexPaidUsd: number;
  newFactoryPaidUsd: number;
  totalCapexPaidUsd: number;
  dueQuantityCumulative: number;
  onTimeQuantityCumulative: number;
  newlyOverdueQuantityCumulative: number;
  continuingOverdueQuantityCumulative: number;
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapProductionCumulative: number;
  endingRegularWorkers: number;
  overtimeRateSum: number;
  overtimeRateSamples: number;
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  endingTrustAvg: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
}

function newAggregate(scenario: string, seed: string, variant: Variant, companyId: string): CompanyRunAggregate {
  return {
    scenario,
    seed,
    variant,
    companyId,
    factoryConstructionTurn: null,
    factoryCompletionTurn: null,
    pdMechCompletedCount: 0,
    qualityEquipCompletedCount: 0,
    pdMechPaidUsd: 0,
    vapDevSpendUsd: 0,
    qualityEquipPaidUsd: 0,
    lineCapexPaidUsd: 0,
    newFactoryPaidUsd: 0,
    totalCapexPaidUsd: 0,
    dueQuantityCumulative: 0,
    onTimeQuantityCumulative: 0,
    newlyOverdueQuantityCumulative: 0,
    continuingOverdueQuantityCumulative: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapProductionCumulative: 0,
    endingRegularWorkers: 0,
    overtimeRateSum: 0,
    overtimeRateSamples: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    endingTrustAvg: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
  };
}

interface FactoryTimelineRow {
  readonly scenario: string;
  readonly seed: string;
  readonly variant: string;
  readonly companyId: string;
  readonly factoryId: string;
  readonly completionTurn: number;
  readonly firstProductionTurn: number | null;
  readonly first50PctUtilizationTurn: number | null;
  readonly first70PctUtilizationTurn: number | null;
  readonly activationLagTurns: number | null;
}

function runOne(
  scenario: string,
  seed: string,
  variant: Variant,
  companies: readonly CompanyId[],
  visionOverrides?: CompanyLabVisionOverrides
): { aggregates: Map<string, CompanyRunAggregate>; factoryTimeline: FactoryTimelineRow[] } {
  let session = createSimulationSession({
    simulationRunId: `fa1-${scenario}-${seed}-${variant}-${visionOverrides ? "hv" : "std"}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: "ON",
    factoryActivationLaborFixDisabled: variant === "EXISTING_AI",
    visionOverrides,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of companies) aggregates.set(c, newAggregate(scenario, seed, variant, c));
  const revenueCumulative: Record<string, number> = Object.fromEntries(companies.map((c) => [c, 0]));
  const opCumulative: Record<string, number> = Object.fromEntries(companies.map((c) => [c, 0]));
  // companyId -> factoryId -> completionTurn
  const factoryCompletionTurn = new Map<string, Map<string, number>>();
  const factoryFirstProductionTurn = new Map<string, Map<string, number>>();
  const factoryFirst50Turn = new Map<string, Map<string, number>>();
  const factoryFirst70Turn = new Map<string, Map<string, number>>();

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
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const financialResult = record.financialResults.find((f) => f.companyId === companyId);
      const capexResult = record.capexResults.find((c) => c.companyId === companyId);
      const decision = record.decisions.find((d) => d.companyId === companyId);
      const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === record.turn);
      const crisis = strategyTurn?.strategy.crisis;
      const crisisState = crisis?.state ?? "NORMAL";
      if (crisisState === "SEVERE_DISTRESS") agg.severeDistressQuarters++;
      else if (crisisState === "LIQUIDITY_STRESS") agg.liquidityStressQuarters++;

      for (const p of decision?.capexDecision.newProjectProposals ?? []) {
        if (p.projectType === "newFactoryConstruction" && agg.factoryConstructionTurn === null) agg.factoryConstructionTurn = record.turn;
      }
      const vapDev = strategyTurn?.strategy.vapProductDevelopment;
      agg.vapDevSpendUsd += vapDev?.proposedSpendUsd ?? 0;

      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdMechanization") agg.pdMechPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "qualityControlEquipment") agg.qualityEquipPaidUsd += e.paymentSucceededUsd;
        if (LINE_CAPEX_TYPES.has(e.projectType)) agg.lineCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "newFactoryConstruction") agg.newFactoryPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdMechanization" && e.statusAfter === "completed" && e.statusBefore !== "completed") agg.pdMechCompletedCount++;
        if (e.projectType === "qualityControlEquipment" && e.statusAfter === "completed" && e.statusBefore !== "completed") agg.qualityEquipCompletedCount++;
        if (e.projectType === "newFactoryConstruction" && e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.factoryCompletionTurn = record.turn;
        }
      }

      const companyDeliveryObs = record.deliveryObservations.filter((d) => d.companyId === companyId);
      agg.dueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.dueQuantity), 0);
      agg.onTimeQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.onTimeQuantity), 0);
      agg.newlyOverdueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.newlyOverdueQuantity), 0);
      agg.continuingOverdueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.continuingOverdueQuantity), 0);

      agg.hosoProductionCumulative += Number(summary?.hosoProduced ?? 0);
      agg.pdProductionCumulative += Number(summary?.pdProduced ?? 0);
      agg.vapProductionCumulative += Number(summary?.vapProduced ?? 0);

      const workerAssignments = decision?.workerAssignments.filter((w) => w.companyId === companyId) ?? [];
      agg.endingRegularWorkers = workerAssignments.reduce((s, w) => s + Number(w.regularHeadcount), 0);
      for (const w of workerAssignments) {
        const r = Number(w.overtimeRate ?? 0);
        if (Number.isFinite(r)) {
          agg.overtimeRateSum += r;
          agg.overtimeRateSamples++;
        }
      }

      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      revenueCumulative[companyId] += revenueThisQuarter;
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      opCumulative[companyId] += opThisQuarter;
      agg.endingRevenueCumulative = revenueCumulative[companyId];
      agg.endingOperatingProfitCumulative = opCumulative[companyId];
      agg.endingCash = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCash;
      agg.endingDebt = financialResult
        ? Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans)
        : agg.endingDebt;
      const trustByMarket = record.qualityStateAfter.trustByCompanyMarket.filter((t) => t.companyId === companyId);
      if (trustByMarket.length > 0) {
        agg.endingTrustAvg = trustByMarket.reduce((s, t) => s + unwrapUnit(t.customerTrustScore), 0) / trustByMarket.length;
      }

      // --- Factory-level activation lag tracking (per new factory) ---
      const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);
      const byFactory = new Map<string, number>();
      for (const a of companyAdjustments) {
        byFactory.set(a.factoryId, (byFactory.get(a.factoryId) ?? 0) + unwrapUnit(a.originalFinishedGoodsQuantity));
      }
      const companyCapexProjects = session.state.capexState.companies.find((c) => c.companyId === companyId)?.portfolio.projects ?? [];
      for (const p of companyCapexProjects) {
        if (p.projectType === "newFactoryConstruction" && p.status === "completed" && p.completedPeriod) {
          const factoryId = `${companyId}-NEWF-${p.projectId}`;
          const compByCompany = factoryCompletionTurn.get(companyId) ?? new Map<string, number>();
          if (!compByCompany.has(factoryId)) {
            // completedPeriodのturn番号を直接持たないため、このFactoryが初めて
            // observation.factoriesへ現れたturn（＝今回のrecord.turn、この案件を
            // 稼働開始済みとして最初に検出したturn）を近似のcompletionTurnとする。
            compByCompany.set(factoryId, record.turn);
            factoryCompletionTurn.set(companyId, compByCompany);
          }
          const productionTons = byFactory.get(factoryId) ?? 0;
          if (productionTons > 1e-6) {
            const firstProdByCompany = factoryFirstProductionTurn.get(companyId) ?? new Map<string, number>();
            if (!firstProdByCompany.has(factoryId)) {
              firstProdByCompany.set(factoryId, record.turn);
              factoryFirstProductionTurn.set(companyId, firstProdByCompany);
            }
          }
        }
      }
    }
  }

  const factoryTimeline: FactoryTimelineRow[] = [];
  for (const [companyId, byFactory] of factoryCompletionTurn) {
    for (const [factoryId, completionTurn] of byFactory) {
      const firstProduction = factoryFirstProductionTurn.get(companyId)?.get(factoryId) ?? null;
      factoryTimeline.push({
        scenario,
        seed,
        variant,
        companyId,
        factoryId,
        completionTurn,
        firstProductionTurn: firstProduction,
        first50PctUtilizationTurn: factoryFirst50Turn.get(companyId)?.get(factoryId) ?? null,
        first70PctUtilizationTurn: factoryFirst70Turn.get(companyId)?.get(factoryId) ?? null,
        activationLagTurns: firstProduction !== null ? firstProduction - completionTurn : null,
      });
    }
  }

  return { aggregates, factoryTimeline };
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  // --- Part 1: baseline benchmark ---
  const allAggregates: CompanyRunAggregate[] = [];
  const allFactoryTimeline: FactoryTimelineRow[] = [];
  console.log("Part 1: baseline benchmark (5 scenarios x 5 seeds x 5 companies x 32Q x 2 variants)...");
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const variant of VARIANTS) {
        console.log(`  Running ${scenario}/${seed}/${variant}...`);
        const { aggregates, factoryTimeline } = runOne(scenario, seed, variant, COMPANIES);
        for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
        allFactoryTimeline.push(...factoryTimeline);
      }
    }
  }

  // --- Part 2: high-Vision benchmark ---
  console.log("Part 2: high-Vision benchmark (MASS 80k, others 50k, baseline scenario, 3 seeds x 2 variants)...");
  const highVisionOverrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 80000, source: "MANUAL_OVERRIDE" }],
    BAL: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    JPQ: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    CONSV: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    VAP: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
  };
  const highVisionAggregates: CompanyRunAggregate[] = [];
  for (const seed of ["seed-1", "seed-2", "seed-3"]) {
    for (const variant of VARIANTS) {
      console.log(`  Running high-vision/baseline/${seed}/${variant}...`);
      const { aggregates } = runOne("baseline", seed, variant, COMPANIES, highVisionOverrides);
      for (const c of COMPANIES) highVisionAggregates.push(aggregates.get(c)!);
    }
  }

  // --- Part 3: Strategic Posture cases ---
  console.log("Part 3: Strategic Posture cases (AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 3 seeds x 2 variants)...");
  const postures: readonly StrategicPosture[] = ["AGGRESSIVE_EARLY_CAPACITY", "VALUE_FIRST"];
  const postureAggregates: (CompanyRunAggregate & { posture: string })[] = [];
  for (const posture of postures) {
    const postureOverrides: CompanyLabVisionOverrides = Object.fromEntries(
      COMPANIES.map((c) => [c, [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, strategicPosture: posture, source: "MANUAL_OVERRIDE" as const }]])
    );
    for (const seed of ["seed-1", "seed-2", "seed-3"]) {
      for (const variant of VARIANTS) {
        console.log(`  Running posture=${posture}/baseline/${seed}/${variant}...`);
        const { aggregates } = runOne("baseline", seed, variant, COMPANIES, postureOverrides);
        for (const c of COMPANIES) postureAggregates.push({ ...aggregates.get(c)!, posture });
      }
    }
  }

  // --- company.csv ---
  const companyHeaders = [
    "scenario",
    "seed",
    "variant",
    "companyId",
    "factoryConstructionTurn",
    "factoryCompletionTurn",
    "pdMechCompletedCount",
    "qualityEquipCompletedCount",
    "dueQuantityCumulative",
    "onTimeQuantityCumulative",
    "onTimeRatio",
    "newlyOverdueQuantityCumulative",
    "continuingOverdueQuantityCumulative",
    "hosoProductionCumulative",
    "pdProductionCumulative",
    "vapProductionCumulative",
    "endingRegularWorkers",
    "avgOvertimeRate",
    "endingRevenueCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
    "endingDebt",
    "endingTrustAvg",
    "liquidityStressQuarters",
    "severeDistressQuarters",
  ];
  const companyRows = allAggregates.map((a) => [
    a.scenario,
    a.seed,
    a.variant,
    a.companyId,
    a.factoryConstructionTurn ?? -1,
    a.factoryCompletionTurn ?? -1,
    a.pdMechCompletedCount,
    a.qualityEquipCompletedCount,
    a.dueQuantityCumulative,
    a.onTimeQuantityCumulative,
    a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0,
    a.newlyOverdueQuantityCumulative,
    a.continuingOverdueQuantityCumulative,
    a.hosoProductionCumulative,
    a.pdProductionCumulative,
    a.vapProductionCumulative,
    a.endingRegularWorkers,
    a.overtimeRateSamples > 0 ? a.overtimeRateSum / a.overtimeRateSamples : 0,
    a.endingRevenueCumulative,
    a.endingOperatingProfitCumulative,
    a.endingCash,
    a.endingDebt,
    a.endingTrustAvg,
    a.liquidityStressQuarters,
    a.severeDistressQuarters,
  ]);
  writeCsv(path.join(outDir, "factory_activation_fa1_company.csv"), companyHeaders, companyRows);

  // --- factory_timeline.csv ---
  const timelineHeaders = [
    "scenario",
    "seed",
    "variant",
    "companyId",
    "factoryId",
    "completionTurn",
    "firstProductionTurn",
    "activationLagTurns",
  ];
  const timelineRows = allFactoryTimeline.map((t) => [
    t.scenario,
    t.seed,
    t.variant,
    t.companyId,
    t.factoryId,
    t.completionTurn,
    t.firstProductionTurn ?? -1,
    t.activationLagTurns ?? -1,
  ]);
  writeCsv(path.join(outDir, "factory_activation_fa1_factory_timeline.csv"), timelineHeaders, timelineRows);

  // --- high_vision.csv (includes posture cases too, tagged) ---
  const hvHeaders = [
    "case",
    "scenario",
    "seed",
    "variant",
    "companyId",
    "factoryCompletionTurn",
    "onTimeRatio",
    "endingTrustAvg",
    "hosoProductionCumulative",
    "pdProductionCumulative",
    "vapProductionCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
  ];
  const hvRows: (readonly (string | number)[])[] = [];
  for (const a of highVisionAggregates) {
    hvRows.push([
      "HIGH_VISION",
      a.scenario,
      a.seed,
      a.variant,
      a.companyId,
      a.factoryCompletionTurn ?? -1,
      a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0,
      a.endingTrustAvg,
      a.hosoProductionCumulative,
      a.pdProductionCumulative,
      a.vapProductionCumulative,
      a.endingOperatingProfitCumulative,
      a.endingCash,
    ]);
  }
  for (const a of postureAggregates) {
    hvRows.push([
      `POSTURE_${a.posture}`,
      a.scenario,
      a.seed,
      a.variant,
      a.companyId,
      a.factoryCompletionTurn ?? -1,
      a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0,
      a.endingTrustAvg,
      a.hosoProductionCumulative,
      a.pdProductionCumulative,
      a.vapProductionCumulative,
      a.endingOperatingProfitCumulative,
      a.endingCash,
    ]);
  }
  writeCsv(path.join(outDir, "factory_activation_fa1_high_vision.csv"), hvHeaders, hvRows);

  // --- portfolio.csv ---
  const portfolioHeaders = [
    "companyId",
    "variant",
    "pdMechanizationPaidUsd",
    "vapProductDevelopmentSpendUsd",
    "qualityEquipmentPaidUsd",
    "lineCapexPaidUsd",
    "newFactoryPaidUsd",
    "totalCapexPaidUsd",
  ];
  const portfolioRows: (readonly (string | number)[])[] = [];
  for (const companyId of COMPANIES) {
    for (const variant of VARIANTS) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.variant === variant);
      portfolioRows.push([
        companyId,
        variant,
        mean(rows.map((a) => a.pdMechPaidUsd)),
        mean(rows.map((a) => a.vapDevSpendUsd)),
        mean(rows.map((a) => a.qualityEquipPaidUsd)),
        mean(rows.map((a) => a.lineCapexPaidUsd)),
        mean(rows.map((a) => a.newFactoryPaidUsd)),
        mean(rows.map((a) => a.totalCapexPaidUsd)),
      ]);
    }
  }
  writeCsv(path.join(outDir, "factory_activation_fa1_portfolio.csv"), portfolioHeaders, portfolioRows);

  // --- summary.md ---
  const lines: string[] = [];
  lines.push("# Standard AI Factory Activation Strategy FA-1 — Benchmark");
  lines.push("");
  lines.push(
    `Part 1 baseline: 5 scenarios x 5 seeds x 5 companies x 32Q x (EXISTING_AI, FACTORY_ACTIVATION_ON), PROFILE ON固定. ${allAggregates.length} company-runs.`
  );
  lines.push(`Part 2 high-Vision: MASS 80k / others 50k (benchmark override only), baseline scenario, 3 seeds x 2 variants. ${highVisionAggregates.length} company-runs.`);
  lines.push(`Part 3 Strategic Posture: AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 3 seeds x 2 variants. ${postureAggregates.length} company-runs.`);
  lines.push("");
  lines.push("## EXISTING_AI vs FACTORY_ACTIVATION_ON per company (avg across 25 runs/variant, baseline benchmark)");
  lines.push("");
  lines.push("| Company | Variant | On-time ratio | Ending Trust | HOSO+PD+VAP production (t) | Regular workers | Avg overtime | OP ($) | Cash ($) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const variant of VARIANTS) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.variant === variant);
      const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
      const totalProd = mean(rows.map((a) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative));
      lines.push(
        `| ${companyId} | ${variant} | ${(onTime * 100).toFixed(1)}% | ${mean(rows.map((a) => a.endingTrustAvg)).toFixed(1)} | ${totalProd.toFixed(
          0
        )} | ${mean(rows.map((a) => a.endingRegularWorkers)).toFixed(0)} | ${(mean(rows.map((a) => (a.overtimeRateSamples > 0 ? a.overtimeRateSum / a.overtimeRateSamples : 0))) * 100).toFixed(
          1
        )}% | $${(mean(rows.map((a) => a.endingOperatingProfitCumulative)) / 1e6).toFixed(1)}M | $${(mean(rows.map((a) => a.endingCash)) / 1e6).toFixed(1)}M |`
      );
    }
  }
  lines.push("");
  lines.push("## Factory Activation Lag (turns from factory completion to first meaningful production, all scenarios/seeds pooled)");
  lines.push("");
  lines.push("| Variant | n (factory-completion events) | Avg activation lag (turns) | Median lag | Never produced (n) |");
  lines.push("|---|---|---|---|---|");
  for (const variant of VARIANTS) {
    const rows = allFactoryTimeline.filter((t) => t.variant === variant);
    const withLag = rows.map((t) => t.activationLagTurns).filter((v): v is number => v !== null);
    const neverProduced = rows.length - withLag.length;
    const sorted = [...withLag].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : NaN;
    lines.push(`| ${variant} | ${rows.length} | ${withLag.length > 0 ? mean(withLag).toFixed(1) : "n/a"} | ${Number.isNaN(median) ? "n/a" : median} | ${neverProduced} |`);
  }
  lines.push("");
  lines.push("## High-Vision case (MASS 80k / others 50k)");
  lines.push("");
  lines.push("| Company | Variant | On-time ratio | Ending Trust | OP ($) |");
  lines.push("|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const variant of VARIANTS) {
      const rows = highVisionAggregates.filter((a) => a.companyId === companyId && a.variant === variant);
      const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
      lines.push(
        `| ${companyId} | ${variant} | ${(onTime * 100).toFixed(1)}% | ${mean(rows.map((a) => a.endingTrustAvg)).toFixed(1)} | $${(
          mean(rows.map((a) => a.endingOperatingProfitCumulative)) / 1e6
        ).toFixed(1)}M |`
      );
    }
  }
  lines.push("");
  lines.push("## Strategic Posture cases");
  lines.push("");
  lines.push("| Posture | Company | Variant | On-time ratio | Ending Trust | OP ($) |");
  lines.push("|---|---|---|---|---|---|");
  for (const posture of postures) {
    for (const companyId of COMPANIES) {
      for (const variant of VARIANTS) {
        const rows = postureAggregates.filter((a) => a.posture === posture && a.companyId === companyId && a.variant === variant);
        const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
        lines.push(
          `| ${posture} | ${companyId} | ${variant} | ${(onTime * 100).toFixed(1)}% | ${mean(rows.map((a) => a.endingTrustAvg)).toFixed(1)} | $${(
            mean(rows.map((a) => a.endingOperatingProfitCumulative)) / 1e6
          ).toFixed(1)}M |`
        );
      }
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "factory_activation_fa1_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${companyRows.length} company rows, ${timelineRows.length} factory-timeline rows, ${hvRows.length} high-vision rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
