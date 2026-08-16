// Standard AI Investment Portfolio Calibration — Phase PC-1 Benchmark
//
// 【指示§2】parameterは一切変更しない監査フェーズ。個々のCapability
// （Vision/Profile/Crisis/Factory Activation/PD Mechanization/VAP Product
// Development/Quality Equipment/Customer Trust）は完成・受入済みという前提のもと、
// それらを同時に実行した結果、会社全体として合理的な資本配分になっているかを
// 定量化する。新しいCapabilityは追加しない。
//
// データは既存SSoTのみから読む:
//   - session.state.history[].capexResults[].events （CAPEX支払・状態遷移の実測）
//   - session.packCompanyTurns[].strategy.{vapProductDevelopment,pdMechanization,
//     qualityEquipment,factoryActivation,crisis} （既存Analysis Pack、新規計算なし）
//   - session.state.history[].companySummaries / financialResults / decisions
//
// 出力:
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_summary.md
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_company.csv
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_timeline.csv
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_factory.csv
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_high_vision.csv
//   docs/standard_ai/benchmarks/investment_portfolio_pc1_anomalies.csv
//
// 使い方: npx tsx scripts/investmentPortfolioCalibrationPC1.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { CompanyLabVisionOverrides } from "../app/lib/v2/companyLab/vision/overrides";
import { StrategicPosture } from "../app/lib/v2/companyLab/vision/types";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../app/lib/v2/capex/types";
import { buildCompanyPortfolioTotals, computeInvestmentMixPercent } from "../app/lib/v2/companyLab/standardAi/investmentPortfolio";
import { computeUtilizationMilestones } from "../app/lib/v2/companyLab/standardAi/factoryUtilizationMilestones";

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
const VAP_DEV_TIERS = [0, 100_000, 250_000, 500_000] as const;
/** 【指示§32】稼働率がこの比率を下回る四半期を「アイドル」とみなす（factoryActivation.tsの既存utilization定義をそのまま使う）。 */
const IDLE_UTILIZATION_THRESHOLD = 0.1;
/** 【指示§30】完成後、これだけ連続でアイドルならOverinvestment候補として抽出する。 */
const OVERINVESTMENT_IDLE_QUARTERS_THRESHOLD = 8;
/** 【指示§31】これだけ連続で滞留したbacklogをsustainedとみなす。 */
const UNDERINVESTMENT_BACKLOG_QUARTERS_THRESHOLD = 6;

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
function nearestTier(spendUsd: number): number {
  return VAP_DEV_TIERS.reduce((best, t) => (Math.abs(t - spendUsd) < Math.abs(best - spendUsd) ? t : best), VAP_DEV_TIERS[0]);
}

interface CapexEventLogRow {
  readonly scenario: string;
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly projectId: string;
  readonly projectType: string;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly paidUsd: number;
  readonly targetFactoryId: string | null;
}

interface FactoryAggregate {
  factoryId: string;
  completionTurn: number | null;
  firstProductionTurn: number | null;
  utilizationSeries: { turn: number; utilization: number | null }[];
  cumulativeProductionTons: number;
  idleQuarters: number;
  observedQuarters: number;
}

interface CompanyAggregate {
  scenario: string;
  seed: string;
  companyId: string;
  // --- CAPEX (paid USD by projectType, cumulative) ---
  capexPaidByType: Record<CapitalProjectType, number>;
  capexCompletedCountByType: Record<CapitalProjectType, number>;
  capexFirstEventTurnByType: Partial<Record<CapitalProjectType, number>>;
  capexFirstUnderConstructionTurnByType: Partial<Record<CapitalProjectType, number>>;
  capexFirstCompletedTurnByType: Partial<Record<CapitalProjectType, number>>;
  capexRejectedCountByType: Partial<Record<CapitalProjectType, number>>;
  // --- VAP Product Development (OPEX) ---
  vapDevSpendCumulativeUsd: number;
  vapDevTierCounts: Record<string, number>;
  vapDevReasonCodeCounts: Record<string, number>;
  vapDevScoreLast: number | null;
  // --- PD Mechanization / Quality Equipment candidate tracking ---
  pdMechReasonCodeCounts: Record<string, number>;
  qualityEquipReasonCodeCounts: Record<string, number>;
  // --- Worker ---
  startingRegularWorkers: number | null;
  endingRegularWorkers: number;
  peakRegularWorkers: number;
  temporaryHeadcountSum: number;
  temporaryHeadcountSamples: number;
  overtimeRateSum: number;
  overtimeRateSamples: number;
  // --- Sales HC ---
  startingSalesHeadcount: number | null;
  endingSalesHeadcount: number;
  peakSalesHeadcount: number;
  // --- Commercial / production ---
  newContractedCumulative: number;
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapProductionCumulative: number;
  dueQuantityCumulative: number;
  onTimeQuantityCumulative: number;
  overdueQuantitySeries: { turn: number; overdueQuantity: number }[];
  // --- Financial ---
  startingRevenueUsd: number | null;
  endingRevenueUsd: number;
  cumulativeRevenueUsd: number;
  startingOperatingProfitUsd: number | null;
  endingOperatingProfitUsd: number;
  cumulativeOperatingProfitUsd: number;
  operatingProfitNegativeQuarters: number;
  endingCashUsd: number;
  endingDebtUsd: number;
  endingTrustAvg: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
  // --- Factories ---
  factories: Map<string, FactoryAggregate>;
}

function newAggregate(scenario: string, seed: string, companyId: string): CompanyAggregate {
  const capexPaidByType = Object.fromEntries(CAPITAL_PROJECT_TYPES.map((t) => [t, 0])) as Record<CapitalProjectType, number>;
  const capexCompletedCountByType = Object.fromEntries(CAPITAL_PROJECT_TYPES.map((t) => [t, 0])) as Record<CapitalProjectType, number>;
  return {
    scenario,
    seed,
    companyId,
    capexPaidByType,
    capexCompletedCountByType,
    capexFirstEventTurnByType: {},
    capexFirstUnderConstructionTurnByType: {},
    capexFirstCompletedTurnByType: {},
    capexRejectedCountByType: {},
    vapDevSpendCumulativeUsd: 0,
    vapDevTierCounts: Object.fromEntries(VAP_DEV_TIERS.map((t) => [String(t), 0])),
    vapDevReasonCodeCounts: {},
    vapDevScoreLast: null,
    pdMechReasonCodeCounts: {},
    qualityEquipReasonCodeCounts: {},
    startingRegularWorkers: null,
    endingRegularWorkers: 0,
    peakRegularWorkers: 0,
    temporaryHeadcountSum: 0,
    temporaryHeadcountSamples: 0,
    overtimeRateSum: 0,
    overtimeRateSamples: 0,
    startingSalesHeadcount: null,
    endingSalesHeadcount: 0,
    peakSalesHeadcount: 0,
    newContractedCumulative: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapProductionCumulative: 0,
    dueQuantityCumulative: 0,
    onTimeQuantityCumulative: 0,
    overdueQuantitySeries: [],
    startingRevenueUsd: null,
    endingRevenueUsd: 0,
    cumulativeRevenueUsd: 0,
    startingOperatingProfitUsd: null,
    endingOperatingProfitUsd: 0,
    cumulativeOperatingProfitUsd: 0,
    operatingProfitNegativeQuarters: 0,
    endingCashUsd: 0,
    endingDebtUsd: 0,
    endingTrustAvg: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
    factories: new Map(),
  };
}

function tally(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function runOne(
  scenario: string,
  seed: string,
  companies: readonly CompanyId[],
  turns: number,
  visionOverrides?: CompanyLabVisionOverrides
): { aggregates: Map<string, CompanyAggregate>; capexEventLog: CapexEventLogRow[] } {
  let session = createSimulationSession({
    simulationRunId: `pc1-${scenario}-${seed}-${visionOverrides ? "override" : "std"}`,
    scenarioId: scenario,
    seed,
    requestedTurns: turns,
    startedAt: AT,
    standardAiProfileMode: "ON",
    visionOverrides,
  });

  const aggregates = new Map<string, CompanyAggregate>();
  for (const c of companies) aggregates.set(c, newAggregate(scenario, seed, c));
  const capexEventLog: CapexEventLogRow[] = [];

  for (let i = 0; i < turns; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
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

      // --- Crisis ---
      const crisisState = strategyTurn?.strategy.crisis?.state ?? "NORMAL";
      if (crisisState === "SEVERE_DISTRESS") agg.severeDistressQuarters++;
      else if (crisisState === "LIQUIDITY_STRESS") agg.liquidityStressQuarters++;

      // --- CAPEX events (proposed/rejected + status transitions) ---
      for (const r of capexResult?.rejectedProposals ?? []) {
        agg.capexRejectedCountByType[r.projectType] = (agg.capexRejectedCountByType[r.projectType] ?? 0) + 1;
      }
      for (const e of capexResult?.events ?? []) {
        agg.capexPaidByType[e.projectType] += e.paymentSucceededUsd;
        if (agg.capexFirstEventTurnByType[e.projectType] === undefined) agg.capexFirstEventTurnByType[e.projectType] = record.turn;
        if (e.statusAfter === "underConstruction" && agg.capexFirstUnderConstructionTurnByType[e.projectType] === undefined) {
          agg.capexFirstUnderConstructionTurnByType[e.projectType] = record.turn;
        }
        if (e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.capexCompletedCountByType[e.projectType]++;
          if (agg.capexFirstCompletedTurnByType[e.projectType] === undefined) agg.capexFirstCompletedTurnByType[e.projectType] = record.turn;
        }
        const project = session.state.capexState.companies.find((c) => c.companyId === companyId)?.portfolio.projects.find((p) => p.projectId === e.projectId);
        capexEventLog.push({
          scenario,
          seed,
          companyId,
          turn: record.turn,
          projectId: e.projectId,
          projectType: e.projectType,
          statusBefore: e.statusBefore,
          statusAfter: e.statusAfter,
          paidUsd: e.paymentSucceededUsd,
          targetFactoryId: project?.targetFactoryId ?? null,
        });
      }

      // --- VAP Product Development ---
      const vapDev = strategyTurn?.strategy.vapProductDevelopment;
      const vapSpendThisTurn = vapDev?.proposedSpendUsd ?? 0;
      agg.vapDevSpendCumulativeUsd += vapSpendThisTurn;
      tally(agg.vapDevTierCounts, String(nearestTier(vapSpendThisTurn)));
      for (const code of vapDev?.reasonCodes ?? []) tally(agg.vapDevReasonCodeCounts, code);
      if (vapDev?.currentDevelopmentScore !== null && vapDev?.currentDevelopmentScore !== undefined) agg.vapDevScoreLast = vapDev.currentDevelopmentScore;

      // --- PD Mechanization / Quality Equipment candidate tracking ---
      for (const code of strategyTurn?.strategy.pdMechanization?.reasonCodes ?? []) tally(agg.pdMechReasonCodeCounts, code);
      for (const code of strategyTurn?.strategy.qualityEquipment?.reasonCodes ?? []) tally(agg.qualityEquipReasonCodeCounts, code);

      // --- Worker ---
      const workerAssignments = decision?.workerAssignments.filter((w) => w.companyId === companyId) ?? [];
      const regularTotal = workerAssignments.reduce((s, w) => s + Number(w.regularHeadcount), 0);
      if (agg.startingRegularWorkers === null) agg.startingRegularWorkers = regularTotal;
      agg.endingRegularWorkers = regularTotal;
      agg.peakRegularWorkers = Math.max(agg.peakRegularWorkers, regularTotal);
      for (const w of workerAssignments) {
        agg.temporaryHeadcountSum += Number(w.temporaryHeadcount ?? 0);
        agg.temporaryHeadcountSamples++;
        const r = Number(w.overtimeRate ?? 0);
        if (Number.isFinite(r)) {
          agg.overtimeRateSum += r;
          agg.overtimeRateSamples++;
        }
      }

      // --- Sales HC ---
      const salesHc = strategyTurn?.salesOrganization?.currentHeadcount ?? 0;
      if (agg.startingSalesHeadcount === null) agg.startingSalesHeadcount = salesHc;
      agg.endingSalesHeadcount = salesHc;
      agg.peakSalesHeadcount = Math.max(agg.peakSalesHeadcount, salesHc);

      // --- Commercial / production ---
      agg.newContractedCumulative += Number(summary?.newContractedQuantity ?? 0);
      agg.hosoProductionCumulative += Number(summary?.hosoProduced ?? 0);
      agg.pdProductionCumulative += Number(summary?.pdProduced ?? 0);
      agg.vapProductionCumulative += Number(summary?.vapProduced ?? 0);
      const companyDeliveryObs = record.deliveryObservations.filter((d) => d.companyId === companyId);
      agg.dueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.dueQuantity), 0);
      agg.onTimeQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.onTimeQuantity), 0);
      agg.overdueQuantitySeries.push({ turn: record.turn, overdueQuantity: Number(summary?.overdueQuantity ?? 0) });

      // --- Financial ---
      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      if (agg.startingRevenueUsd === null) agg.startingRevenueUsd = revenueThisQuarter;
      if (agg.startingOperatingProfitUsd === null) agg.startingOperatingProfitUsd = opThisQuarter;
      agg.endingRevenueUsd = revenueThisQuarter;
      agg.cumulativeRevenueUsd += revenueThisQuarter;
      agg.endingOperatingProfitUsd = opThisQuarter;
      agg.cumulativeOperatingProfitUsd += opThisQuarter;
      if (opThisQuarter < 0) agg.operatingProfitNegativeQuarters++;
      if (financialResult) {
        agg.endingCashUsd = Number(financialResult.balanceSheet.cash);
        agg.endingDebtUsd = Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans);
      }
      const trustByMarket = record.qualityStateAfter.trustByCompanyMarket.filter((t) => t.companyId === companyId);
      if (trustByMarket.length > 0) {
        agg.endingTrustAvg = trustByMarket.reduce((s, t) => s + unwrapUnit(t.customerTrustScore), 0) / trustByMarket.length;
      }

      // --- Factory-level utilization (all factories, not just new ones) ---
      for (const f of strategyTurn?.strategy.factoryActivation ?? []) {
        let fa = agg.factories.get(f.factoryId);
        if (!fa) {
          fa = { factoryId: f.factoryId, completionTurn: null, firstProductionTurn: null, utilizationSeries: [], cumulativeProductionTons: 0, idleQuarters: 0, observedQuarters: 0 };
          agg.factories.set(f.factoryId, fa);
        }
        fa.utilizationSeries.push({ turn: record.turn, utilization: f.utilization });
        fa.observedQuarters++;
        if (f.utilization !== null && f.utilization < IDLE_UTILIZATION_THRESHOLD) fa.idleQuarters++;
      }
      // 新設Factoryの完成ターン・初回生産ターンはCAPEXイベント＋qualityAdjustmentsから確認する（既存パターン踏襲）。
      const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);
      const productionByFactory = new Map<string, number>();
      for (const a of companyAdjustments) {
        productionByFactory.set(a.factoryId, (productionByFactory.get(a.factoryId) ?? 0) + unwrapUnit(a.originalFinishedGoodsQuantity));
      }
      for (const [factoryId, tons] of productionByFactory) {
        const fa = agg.factories.get(factoryId);
        if (fa) {
          fa.cumulativeProductionTons += tons;
          if (fa.firstProductionTurn === null && tons > 1e-6) fa.firstProductionTurn = record.turn;
        }
      }
      const companyCapexProjects = session.state.capexState.companies.find((c) => c.companyId === companyId)?.portfolio.projects ?? [];
      for (const p of companyCapexProjects) {
        if (p.projectType === "newFactoryConstruction" && p.status === "completed") {
          const factoryId = `${companyId}-NEWF-${p.projectId}`;
          const fa = agg.factories.get(factoryId);
          if (fa && fa.completionTurn === null) {
            // 【既存パターン踏襲・FA-1と同じ近似】completedPeriodはturn番号を直接持たないため、
            // このFactoryが最初にobservation.factoriesへ現れたターン（＝strategy.factoryActivationに
            // 初出したターン）をcompletionTurnの近似とする。
            const firstSeenTurn = fa.utilizationSeries[0]?.turn ?? record.turn;
            fa.completionTurn = firstSeenTurn;
          }
        }
      }
    }
  }

  return { aggregates, capexEventLog };
}

interface AnomalyRow {
  readonly scenario: string;
  readonly seed: string;
  readonly companyId: string;
  readonly anomalyType: string;
  readonly detail: string;
  readonly evidenceValue: number;
}

function detectAnomalies(agg: CompanyAggregate): AnomalyRow[] {
  const anomalies: AnomalyRow[] = [];

  // --- Overinvestment: factory idle for a long stretch after completion ---
  for (const fa of agg.factories.values()) {
    if (fa.completionTurn === null) continue;
    const postCompletion = fa.utilizationSeries.filter((s) => s.turn >= fa.completionTurn!);
    let maxConsecutiveIdle = 0;
    let current = 0;
    for (const s of postCompletion) {
      if (s.utilization !== null && s.utilization < IDLE_UTILIZATION_THRESHOLD) {
        current++;
        maxConsecutiveIdle = Math.max(maxConsecutiveIdle, current);
      } else {
        current = 0;
      }
    }
    if (maxConsecutiveIdle >= OVERINVESTMENT_IDLE_QUARTERS_THRESHOLD) {
      anomalies.push({
        scenario: agg.scenario,
        seed: agg.seed,
        companyId: agg.companyId,
        anomalyType: "OVERINVESTMENT_IDLE_FACTORY",
        detail: `factory=${fa.factoryId} completionTurn=${fa.completionTurn} maxConsecutiveIdleQuarters=${maxConsecutiveIdle}`,
        evidenceValue: maxConsecutiveIdle,
      });
    }
  }

  // --- VAP Development bang-bang (mostly $0 or $500k only) ---
  const totalTurns = Object.values(agg.vapDevTierCounts).reduce((a, b) => a + b, 0);
  if (totalTurns > 0) {
    const midTierCount = (agg.vapDevTierCounts["100000"] ?? 0) + (agg.vapDevTierCounts["250000"] ?? 0);
    const midTierRatio = midTierCount / totalTurns;
    if (midTierRatio < 0.05 && (agg.vapDevTierCounts["500000"] ?? 0) > 0) {
      anomalies.push({
        scenario: agg.scenario,
        seed: agg.seed,
        companyId: agg.companyId,
        anomalyType: "VAP_DEV_BANG_BANG",
        detail: `tierCounts=${JSON.stringify(agg.vapDevTierCounts)} midTierRatio=${midTierRatio.toFixed(3)}`,
        evidenceValue: midTierRatio,
      });
    }
  }

  // --- Underinvestment: sustained backlog + high utilization + strong finance ---
  let maxConsecutiveBacklog = 0;
  let currentBacklog = 0;
  for (const s of agg.overdueQuantitySeries) {
    if (s.overdueQuantity > 1e-6) {
      currentBacklog++;
      maxConsecutiveBacklog = Math.max(maxConsecutiveBacklog, currentBacklog);
    } else {
      currentBacklog = 0;
    }
  }
  const avgUtilization = mean(
    [...agg.factories.values()].flatMap((fa) => fa.utilizationSeries.map((s) => s.utilization).filter((v): v is number => v !== null))
  );
  if (
    maxConsecutiveBacklog >= UNDERINVESTMENT_BACKLOG_QUARTERS_THRESHOLD &&
    avgUtilization >= 0.85 &&
    agg.endingCashUsd > 0 &&
    agg.severeDistressQuarters === 0 &&
    agg.liquidityStressQuarters === 0
  ) {
    anomalies.push({
      scenario: agg.scenario,
      seed: agg.seed,
      companyId: agg.companyId,
      anomalyType: "UNDERINVESTMENT_SUSTAINED_BACKLOG",
      detail: `maxConsecutiveBacklogQuarters=${maxConsecutiveBacklog} avgUtilization=${avgUtilization.toFixed(3)} endingCashUsd=${agg.endingCashUsd.toFixed(0)}`,
      evidenceValue: maxConsecutiveBacklog,
    });
  }

  // --- Worker overactivation: regular workers grown a lot but production/worker far below others handled at cross-company level (see main()) ---

  return anomalies;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  // --- Part 1: baseline benchmark ---
  const allAggregates: CompanyAggregate[] = [];
  const allCapexEventLog: CapexEventLogRow[] = [];
  console.log("Part 1: baseline benchmark (5 scenarios x 5 seeds x 5 companies x 32Q, PROFILE ON)...");
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`  Running ${scenario}/${seed}...`);
      const { aggregates, capexEventLog } = runOne(scenario, seed, COMPANIES, MANAGEMENT_CONSOLE_STANDARD_TURNS);
      for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
      allCapexEventLog.push(...capexEventLog);
    }
  }

  // --- Part 2: high-Vision benchmark ---
  console.log("Part 2: high-Vision benchmark (MASS 80k, others 50k, baseline scenario, 5 seeds)...");
  const highVisionOverrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 80000, source: "MANUAL_OVERRIDE" }],
    BAL: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    JPQ: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    CONSV: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
    VAP: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, source: "MANUAL_OVERRIDE" }],
  };
  const highVisionAggregates: CompanyAggregate[] = [];
  for (const seed of SEEDS) {
    console.log(`  Running high-vision/baseline/${seed}...`);
    const { aggregates } = runOne("baseline", seed, COMPANIES, MANAGEMENT_CONSOLE_STANDARD_TURNS, highVisionOverrides);
    for (const c of COMPANIES) highVisionAggregates.push(aggregates.get(c)!);
  }

  // --- Part 3: Strategic Posture cases ---
  console.log("Part 3: Strategic Posture cases (AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 5 seeds)...");
  const postures: readonly StrategicPosture[] = ["AGGRESSIVE_EARLY_CAPACITY", "VALUE_FIRST"];
  const postureAggregates: (CompanyAggregate & { posture: string })[] = [];
  for (const posture of postures) {
    const postureOverrides: CompanyLabVisionOverrides = Object.fromEntries(
      COMPANIES.map((c) => [c, [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 50000, strategicPosture: posture, source: "MANUAL_OVERRIDE" as const }]])
    );
    for (const seed of SEEDS) {
      console.log(`  Running posture=${posture}/baseline/${seed}...`);
      const { aggregates } = runOne("baseline", seed, COMPANIES, MANAGEMENT_CONSOLE_STANDARD_TURNS, postureOverrides);
      for (const c of COMPANIES) postureAggregates.push({ ...aggregates.get(c)!, posture });
    }
  }

  // --- company.csv ---
  const companyHeaders = [
    "scenario", "seed", "companyId",
    ...CAPITAL_PROJECT_TYPES.map((t) => `capexPaid_${t}`),
    "growthCapexUsd", "productivityCapexUsd", "qualityCapexUsd", "totalCapexUsd",
    "vapDevSpendCumulativeUsd", "totalInvestmentUsd",
    "growthCapexPercent", "productivityCapexPercent", "qualityCapexPercent", "vapProductDevelopmentPercent",
    "capexRevenueRatio",
    "startingRegularWorkers", "endingRegularWorkers", "peakRegularWorkers", "avgTemporaryHeadcount", "avgOvertimeRate",
    "startingSalesHeadcount", "endingSalesHeadcount", "peakSalesHeadcount",
    "newContractedCumulative", "hosoProductionCumulative", "pdProductionCumulative", "vapProductionCumulative",
    "onTimeRatio", "avgFactoryUtilization",
    "startingRevenueUsd", "endingRevenueUsd", "cumulativeRevenueUsd",
    "startingOperatingProfitUsd", "endingOperatingProfitUsd", "cumulativeOperatingProfitUsd", "operatingProfitNegativeQuarters",
    "endingCashUsd", "endingDebtUsd", "endingTrustAvg",
    "liquidityStressQuarters", "severeDistressQuarters",
    "factoryCount",
  ];
  function companyRow(a: CompanyAggregate): (string | number)[] {
    const totals = buildCompanyPortfolioTotals(a.companyId, a.capexPaidByType, a.vapDevSpendCumulativeUsd);
    const mix = computeInvestmentMixPercent(totals);
    const avgUtilization = mean([...a.factories.values()].flatMap((fa) => fa.utilizationSeries.map((s) => s.utilization).filter((v): v is number => v !== null)));
    return [
      a.scenario, a.seed, a.companyId,
      ...CAPITAL_PROJECT_TYPES.map((t) => a.capexPaidByType[t]),
      totals.capex.growthCapexUsd, totals.capex.productivityCapexUsd, totals.capex.qualityCapexUsd, totals.capex.totalCapexUsd,
      a.vapDevSpendCumulativeUsd, totals.totalInvestmentUsd,
      mix.growthCapexPercent, mix.productivityCapexPercent, mix.qualityCapexPercent, mix.vapProductDevelopmentPercent,
      a.cumulativeRevenueUsd > 0 ? totals.capex.totalCapexUsd / a.cumulativeRevenueUsd : 0,
      a.startingRegularWorkers ?? 0, a.endingRegularWorkers, a.peakRegularWorkers,
      a.temporaryHeadcountSamples > 0 ? a.temporaryHeadcountSum / a.temporaryHeadcountSamples : 0,
      a.overtimeRateSamples > 0 ? a.overtimeRateSum / a.overtimeRateSamples : 0,
      a.startingSalesHeadcount ?? 0, a.endingSalesHeadcount, a.peakSalesHeadcount,
      a.newContractedCumulative, a.hosoProductionCumulative, a.pdProductionCumulative, a.vapProductionCumulative,
      a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0,
      avgUtilization,
      a.startingRevenueUsd ?? 0, a.endingRevenueUsd, a.cumulativeRevenueUsd,
      a.startingOperatingProfitUsd ?? 0, a.endingOperatingProfitUsd, a.cumulativeOperatingProfitUsd, a.operatingProfitNegativeQuarters,
      a.endingCashUsd, a.endingDebtUsd, a.endingTrustAvg,
      a.liquidityStressQuarters, a.severeDistressQuarters,
      a.factories.size,
    ];
  }
  writeCsv(path.join(outDir, "investment_portfolio_pc1_company.csv"), companyHeaders, allAggregates.map(companyRow));

  // --- timeline.csv (investment events, "growth story") ---
  const timelineHeaders = ["scenario", "seed", "companyId", "turn", "projectId", "projectType", "statusBefore", "statusAfter", "paidUsd", "targetFactoryId"];
  writeCsv(
    path.join(outDir, "investment_portfolio_pc1_timeline.csv"),
    timelineHeaders,
    allCapexEventLog.map((e) => [e.scenario, e.seed, e.companyId, e.turn, e.projectId, e.projectType, e.statusBefore, e.statusAfter, e.paidUsd, e.targetFactoryId ?? ""])
  );

  // --- factory.csv (utilization milestones, idle quarters) ---
  const factoryHeaders = [
    "scenario", "seed", "companyId", "factoryId", "completionTurn", "firstProductionTurn",
    "first50PctUtilizationTurn", "first70PctUtilizationTurn", "cumulativeProductionTons", "idleQuarters", "observedQuarters",
  ];
  const factoryRows: (string | number)[][] = [];
  for (const a of allAggregates) {
    for (const fa of a.factories.values()) {
      const milestones = computeUtilizationMilestones(fa.utilizationSeries);
      factoryRows.push([
        a.scenario, a.seed, a.companyId, fa.factoryId,
        fa.completionTurn ?? -1, fa.firstProductionTurn ?? -1,
        milestones.first50PctUtilizationTurn ?? -1, milestones.first70PctUtilizationTurn ?? -1,
        fa.cumulativeProductionTons, fa.idleQuarters, fa.observedQuarters,
      ]);
    }
  }
  writeCsv(path.join(outDir, "investment_portfolio_pc1_factory.csv"), factoryHeaders, factoryRows);

  // --- high_vision.csv (includes posture cases too, tagged) ---
  const hvHeaders = ["case", "scenario", "seed", "companyId", "totalCapexUsd", "vapDevSpendCumulativeUsd", "endingRegularWorkers", "endingSalesHeadcount", "onTimeRatio", "endingTrustAvg", "endingOperatingProfitUsd", "endingCashUsd", "endingDebtUsd", "factoryCount"];
  function hvRow(caseLabel: string, a: CompanyAggregate): (string | number)[] {
    const totals = buildCompanyPortfolioTotals(a.companyId, a.capexPaidByType, a.vapDevSpendCumulativeUsd);
    return [
      caseLabel, a.scenario, a.seed, a.companyId,
      totals.capex.totalCapexUsd, a.vapDevSpendCumulativeUsd,
      a.endingRegularWorkers, a.endingSalesHeadcount,
      a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0,
      a.endingTrustAvg, a.endingOperatingProfitUsd, a.endingCashUsd, a.endingDebtUsd,
      a.factories.size,
    ];
  }
  const hvRows: (string | number)[][] = [];
  for (const a of highVisionAggregates) hvRows.push(hvRow("HIGH_VISION", a));
  for (const a of postureAggregates) hvRows.push(hvRow(`POSTURE_${a.posture}`, a));
  writeCsv(path.join(outDir, "investment_portfolio_pc1_high_vision.csv"), hvHeaders, hvRows);

  // --- anomalies.csv ---
  const anomalyHeaders = ["scenario", "seed", "companyId", "anomalyType", "detail", "evidenceValue"];
  const allAnomalies: AnomalyRow[] = [];
  for (const a of allAggregates) allAnomalies.push(...detectAnomalies(a));
  writeCsv(
    path.join(outDir, "investment_portfolio_pc1_anomalies.csv"),
    anomalyHeaders,
    allAnomalies.map((r) => [r.scenario, r.seed, r.companyId, r.anomalyType, r.detail, r.evidenceValue])
  );

  // --- summary.md ---
  const lines: string[] = [];
  lines.push("# Standard AI Investment Portfolio Calibration — Phase PC-1 Benchmark");
  lines.push("");
  lines.push(`Part 1 baseline: 5 scenarios x 5 seeds x 5 companies x 32Q, PROFILE ON固定. ${allAggregates.length} company-runs. parameter変更なし（監査のみ）。`);
  lines.push(`Part 2 high-Vision: MASS 80k / others 50k (benchmark override only), baseline scenario, 5 seeds. ${highVisionAggregates.length} company-runs.`);
  lines.push(`Part 3 Strategic Posture: AGGRESSIVE_EARLY_CAPACITY / VALUE_FIRST, baseline scenario, 5 seeds. ${postureAggregates.length} company-runs.`);
  lines.push("");
  lines.push("## Company portfolio summary (avg across 25 baseline runs/company)");
  lines.push("");
  lines.push("| Company | Growth CAPEX % | Productivity CAPEX % | Quality CAPEX % | VAP Dev % | Total CAPEX ($) | CAPEX/Revenue | Regular Workers (end) | Sales HC (end) | On-time | Trust | OP ($) | Cash ($) | Debt ($) | Crisis Q |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const rows = allAggregates.filter((a) => a.companyId === companyId);
    const totalsList = rows.map((a) => buildCompanyPortfolioTotals(a.companyId, a.capexPaidByType, a.vapDevSpendCumulativeUsd));
    const mixList = totalsList.map((t) => computeInvestmentMixPercent(t));
    const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
    lines.push(
      `| ${companyId} | ${mean(mixList.map((m) => m.growthCapexPercent)).toFixed(1)}% | ${mean(mixList.map((m) => m.productivityCapexPercent)).toFixed(1)}% | ${mean(
        mixList.map((m) => m.qualityCapexPercent)
      ).toFixed(1)}% | ${mean(mixList.map((m) => m.vapProductDevelopmentPercent)).toFixed(1)}% | $${(mean(totalsList.map((t) => t.capex.totalCapexUsd)) / 1e6).toFixed(1)}M | ${(
        mean(rows.map((a) => (a.cumulativeRevenueUsd > 0 ? totalsList[rows.indexOf(a)].capex.totalCapexUsd / a.cumulativeRevenueUsd : 0))) * 100
      ).toFixed(2)}% | ${mean(rows.map((a) => a.endingRegularWorkers)).toFixed(0)} | ${mean(rows.map((a) => a.endingSalesHeadcount)).toFixed(0)} | ${(onTime * 100).toFixed(1)}% | ${mean(
        rows.map((a) => a.endingTrustAvg)
      ).toFixed(1)} | $${(mean(rows.map((a) => a.endingOperatingProfitUsd)) / 1e6).toFixed(1)}M | $${(mean(rows.map((a) => a.endingCashUsd)) / 1e6).toFixed(1)}M | $${(
        mean(rows.map((a) => a.endingDebtUsd)) / 1e6
      ).toFixed(1)}M | ${mean(rows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters)).toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## VAP Product Development tier distribution (share of turns, avg across baseline runs)");
  lines.push("");
  lines.push("| Company | $0 | $100k | $250k | $500k |");
  lines.push("|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const rows = allAggregates.filter((a) => a.companyId === companyId);
    const totalTurns = rows.reduce((s, a) => s + Object.values(a.vapDevTierCounts).reduce((x, y) => x + y, 0), 0);
    const tierSums = VAP_DEV_TIERS.map((t) => rows.reduce((s, a) => s + (a.vapDevTierCounts[String(t)] ?? 0), 0));
    lines.push(`| ${companyId} | ${((tierSums[0] / totalTurns) * 100).toFixed(1)}% | ${((tierSums[1] / totalTurns) * 100).toFixed(1)}% | ${((tierSums[2] / totalTurns) * 100).toFixed(1)}% | ${((tierSums[3] / totalTurns) * 100).toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("## Factory utilization milestones (all factories, baseline runs pooled)");
  lines.push("");
  lines.push("| Company | n (factories) | Avg completion→50% util (turns) | Avg completion→70% util (turns) | Never reached 50% | Never reached 70% | Avg idle quarters |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const facs = factoryRows.filter((r) => r[2] === companyId);
    const lag50 = facs.filter((r) => Number(r[6]) >= 0 && Number(r[4]) >= 0).map((r) => Number(r[6]) - Number(r[4]));
    const lag70 = facs.filter((r) => Number(r[7]) >= 0 && Number(r[4]) >= 0).map((r) => Number(r[7]) - Number(r[4]));
    const never50 = facs.filter((r) => Number(r[6]) === -1).length;
    const never70 = facs.filter((r) => Number(r[7]) === -1).length;
    lines.push(
      `| ${companyId} | ${facs.length} | ${lag50.length > 0 ? mean(lag50).toFixed(1) : "n/a"} | ${lag70.length > 0 ? mean(lag70).toFixed(1) : "n/a"} | ${never50} | ${never70} | ${mean(
        facs.map((r) => Number(r[9]))
      ).toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## High-Vision case (MASS 80k / others 50k)");
  lines.push("");
  lines.push("| Company | Total CAPEX ($) | Regular Workers | Sales HC | On-time | Trust | OP ($) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const rows = highVisionAggregates.filter((a) => a.companyId === companyId);
    const totalsList = rows.map((a) => buildCompanyPortfolioTotals(a.companyId, a.capexPaidByType, a.vapDevSpendCumulativeUsd));
    const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
    lines.push(
      `| ${companyId} | $${(mean(totalsList.map((t) => t.capex.totalCapexUsd)) / 1e6).toFixed(1)}M | ${mean(rows.map((a) => a.endingRegularWorkers)).toFixed(0)} | ${mean(
        rows.map((a) => a.endingSalesHeadcount)
      ).toFixed(0)} | ${(onTime * 100).toFixed(1)}% | ${mean(rows.map((a) => a.endingTrustAvg)).toFixed(1)} | $${(mean(rows.map((a) => a.endingOperatingProfitUsd)) / 1e6).toFixed(1)}M |`
    );
  }
  lines.push("");
  lines.push("## Strategic Posture cases");
  lines.push("");
  lines.push("| Posture | Company | Total CAPEX ($) | On-time | Trust | OP ($) |");
  lines.push("|---|---|---|---|---|---|");
  for (const posture of postures) {
    for (const companyId of COMPANIES) {
      const rows = postureAggregates.filter((a) => a.posture === posture && a.companyId === companyId);
      const totalsList = rows.map((a) => buildCompanyPortfolioTotals(a.companyId, a.capexPaidByType, a.vapDevSpendCumulativeUsd));
      const onTime = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
      lines.push(
        `| ${posture} | ${companyId} | $${(mean(totalsList.map((t) => t.capex.totalCapexUsd)) / 1e6).toFixed(1)}M | ${(onTime * 100).toFixed(1)}% | ${mean(rows.map((a) => a.endingTrustAvg)).toFixed(
          1
        )} | $${(mean(rows.map((a) => a.endingOperatingProfitUsd)) / 1e6).toFixed(1)}M |`
      );
    }
  }
  lines.push("");
  lines.push("## Anomaly counts by type (baseline benchmark, 125 company-runs)");
  lines.push("");
  lines.push("| Anomaly type | Count | Companies affected |");
  lines.push("|---|---|---|");
  const anomalyTypes = [...new Set(allAnomalies.map((a) => a.anomalyType))];
  for (const t of anomalyTypes) {
    const rows = allAnomalies.filter((a) => a.anomalyType === t);
    lines.push(`| ${t} | ${rows.length} | ${[...new Set(rows.map((r) => r.companyId))].join(", ")} |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "investment_portfolio_pc1_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(
    `\nWrote ${allAggregates.length} company rows, ${allCapexEventLog.length} timeline events, ${factoryRows.length} factory rows, ${hvRows.length} high-vision rows, ${allAnomalies.length} anomalies to ${outDir}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
