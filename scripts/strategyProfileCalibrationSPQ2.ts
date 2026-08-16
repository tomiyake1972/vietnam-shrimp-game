// Standard AI Strategy Profile Calibration — Phase SP-Q2
//
// SP-Q1で発見した3件のroot causeを修正した後の、PROFILE OFF vs PROFILE ON再ベンチマーク。
// - MASS(growth): importRelianceRatioバイアスを撤去（procurement/finance boom-bust cycleとの
//   連鎖的崩壊を誘発していたため）
// - CONSV(conservative): capexHurdleBiasRatio(+5%)を新設・接続（CAPEX判断への財務保守性の
//   接続先が無かった構造的ギャップを埋める）
// - VAP/CONSVの「32x amplification」は、OFF基準がほぼゼロだったことによる統計的錯覚であり
//   duplicate proposal等のバグではないことを確認済み（値は変更していない）
//
// 出力:
//   docs/standard_ai/benchmarks/strategy_profile_spq2_summary.md
//   docs/standard_ai/benchmarks/strategy_profile_spq2_company.csv
//   docs/standard_ai/benchmarks/strategy_profile_spq2_investments.csv
//   docs/standard_ai/benchmarks/strategy_profile_spq2_product_mix.csv
//
// 使い方: npx tsx scripts/strategyProfileCalibrationSPQ2.ts

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
const MODES: readonly ("OFF" | "ON")[] = ["OFF", "ON"];
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

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  mode: "OFF" | "ON";
  companyId: string;
  managementProfileId: string;
  orientationProfileId: string;
  proposedByType: Record<string, number>;
  rejectedByType: Record<string, number>;
  completedByType: Record<string, number>;
  totalCapexPaidUsd: number;
  salesHiresTotal: number;
  normalQuarters: number;
  liquidityStressQuarters: number;
  severeDistressQuarters: number;
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapProductionCumulative: number;
  hosoSalesDesiredCumulative: number;
  pdSalesDesiredCumulative: number;
  vapSalesDesiredCumulative: number;
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
  endingDebt: number;
  endingProductionCumulative: number;
  endingContractsCumulative: number;
  endingBacklog: number;
  endingRegularWorkers: number;
}

function emptyCountRecord(): Record<string, number> {
  const r: Record<string, number> = {};
  for (const t of PROJECT_TYPES) r[t] = 0;
  return r;
}

function newAggregate(scenario: string, seed: string, mode: "OFF" | "ON", companyId: string): CompanyRunAggregate {
  return {
    scenario,
    seed,
    mode,
    companyId,
    managementProfileId: "OFF",
    orientationProfileId: "OFF",
    proposedByType: emptyCountRecord(),
    rejectedByType: emptyCountRecord(),
    completedByType: emptyCountRecord(),
    totalCapexPaidUsd: 0,
    salesHiresTotal: 0,
    normalQuarters: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapProductionCumulative: 0,
    hosoSalesDesiredCumulative: 0,
    pdSalesDesiredCumulative: 0,
    vapSalesDesiredCumulative: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    endingProductionCumulative: 0,
    endingContractsCumulative: 0,
    endingBacklog: 0,
    endingRegularWorkers: 0,
  };
}

function runOne(scenario: string, seed: string, mode: "OFF" | "ON"): Map<string, CompanyRunAggregate> {
  let session = createSimulationSession({
    simulationRunId: `spq2-${scenario}-${seed}-${mode}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: mode,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, mode, c));

  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const operatingProfitCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const productionCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const contractsCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));

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

      for (const p of decision?.capexDecision.newProjectProposals ?? []) {
        agg.proposedByType[p.projectType] = (agg.proposedByType[p.projectType] ?? 0) + 1;
      }
      for (const r of capexResult?.rejectedProposals ?? []) {
        agg.rejectedByType[r.projectType] = (agg.rejectedByType[r.projectType] ?? 0) + 1;
      }
      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.completedByType[e.projectType] = (agg.completedByType[e.projectType] ?? 0) + 1;
        }
      }

      const hires = Number(decision?.salesForceHireCount ?? 0);
      agg.salesHiresTotal += hires;

      agg.hosoProductionCumulative += Number(summary?.hosoProduced ?? 0);
      agg.pdProductionCumulative += Number(summary?.pdProduced ?? 0);
      agg.vapProductionCumulative += Number(summary?.vapProduced ?? 0);

      for (const plan of decision?.salesPlans ?? []) {
        if (plan.product === "hoso") agg.hosoSalesDesiredCumulative += Number(plan.desiredQuantity);
        else if (plan.product === "pd") agg.pdSalesDesiredCumulative += Number(plan.desiredQuantity);
        else if (plan.product === "vap") agg.vapSalesDesiredCumulative += Number(plan.desiredQuantity);
      }

      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      revenueCumulative[companyId] += revenueThisQuarter;
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      operatingProfitCumulative[companyId] += opThisQuarter;

      const productionThisQuarter = summary
        ? Number(summary.hosoProduced) + Number(summary.pdProduced) + Number(summary.vapProduced)
        : 0;
      productionCumulative[companyId] += productionThisQuarter;
      contractsCumulative[companyId] += Number(summary?.newContractedQuantity ?? 0);

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
    }
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

  // company.csv
  const companyHeaders = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "managementProfileId",
    "orientationProfileId",
    "totalCapexPaidUsd",
    "salesHiresTotal",
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
    "endingRegularWorkers",
    "capexIntensityPerTon",
  ];
  const companyRows = allAggregates.map((a) => [
    a.scenario,
    a.seed,
    a.mode,
    a.companyId,
    a.managementProfileId,
    a.orientationProfileId,
    a.totalCapexPaidUsd,
    a.salesHiresTotal,
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
    a.endingRegularWorkers,
    a.endingProductionCumulative > 0 ? a.totalCapexPaidUsd / a.endingProductionCumulative : 0,
  ]);
  writeCsv(path.join(outDir, "strategy_profile_spq2_company.csv"), companyHeaders, companyRows);

  // investments.csv — proposed/rejected/completed分離（指示§28）
  const investmentHeaders = ["scenario", "seed", "mode", "companyId", "projectType", "proposedCount", "rejectedCount", "completedCount"];
  const investmentRows: (string | number)[][] = [];
  for (const a of allAggregates) {
    for (const t of PROJECT_TYPES) {
      investmentRows.push([a.scenario, a.seed, a.mode, a.companyId, t, a.proposedByType[t] ?? 0, a.rejectedByType[t] ?? 0, a.completedByType[t] ?? 0]);
    }
  }
  writeCsv(path.join(outDir, "strategy_profile_spq2_investments.csv"), investmentHeaders, investmentRows);

  // product_mix.csv
  const mixHeaders = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "hosoProductionCumulative",
    "pdProductionCumulative",
    "vapProductionCumulative",
    "hosoProductionShare",
    "pdProductionShare",
    "vapProductionShare",
    "hosoSalesDesiredCumulative",
    "pdSalesDesiredCumulative",
    "vapSalesDesiredCumulative",
  ];
  const mixRows = allAggregates.map((a) => {
    const totalProd = a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    return [
      a.scenario,
      a.seed,
      a.mode,
      a.companyId,
      a.hosoProductionCumulative,
      a.pdProductionCumulative,
      a.vapProductionCumulative,
      totalProd > 0 ? a.hosoProductionCumulative / totalProd : 0,
      totalProd > 0 ? a.pdProductionCumulative / totalProd : 0,
      totalProd > 0 ? a.vapProductionCumulative / totalProd : 0,
      a.hosoSalesDesiredCumulative,
      a.pdSalesDesiredCumulative,
      a.vapSalesDesiredCumulative,
    ];
  });
  writeCsv(path.join(outDir, "strategy_profile_spq2_product_mix.csv"), mixHeaders, mixRows);

  // summary.md — OFF vs ON comparison per company, averaged across scenario x seed
  const lines: string[] = [];
  lines.push("# Strategy Profile Calibration SP-Q2 — OFF vs ON Summary (auto-generated, post-calibration)");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 5 companies x 32Q, mode=OFF vs mode=ON. ${allAggregates.length} company-runs total.`);
  lines.push("");
  for (const companyId of COMPANIES) {
    const offRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "OFF");
    const onRows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "ON");
    const totalProdOff = (a: CompanyRunAggregate) => a.hosoProductionCumulative + a.pdProductionCumulative + a.vapProductionCumulative;
    const hosoShareOff = mean(offRows.map((a) => (totalProdOff(a) > 0 ? a.hosoProductionCumulative / totalProdOff(a) : 0)));
    const pdShareOff = mean(offRows.map((a) => (totalProdOff(a) > 0 ? a.pdProductionCumulative / totalProdOff(a) : 0)));
    const vapShareOff = mean(offRows.map((a) => (totalProdOff(a) > 0 ? a.vapProductionCumulative / totalProdOff(a) : 0)));
    const hosoShareOn = mean(onRows.map((a) => (totalProdOff(a) > 0 ? a.hosoProductionCumulative / totalProdOff(a) : 0)));
    const pdShareOn = mean(onRows.map((a) => (totalProdOff(a) > 0 ? a.pdProductionCumulative / totalProdOff(a) : 0)));
    const vapShareOn = mean(onRows.map((a) => (totalProdOff(a) > 0 ? a.vapProductionCumulative / totalProdOff(a) : 0)));
    const capexOff = mean(offRows.map((a) => a.totalCapexPaidUsd));
    const capexOn = mean(onRows.map((a) => a.totalCapexPaidUsd));
    const salesHiresOff = mean(offRows.map((a) => a.salesHiresTotal));
    const salesHiresOn = mean(onRows.map((a) => a.salesHiresTotal));
    const opOff = mean(offRows.map((a) => a.endingOperatingProfitCumulative));
    const opOn = mean(onRows.map((a) => a.endingOperatingProfitCumulative));
    const cashOff = mean(offRows.map((a) => a.endingCash));
    const cashOn = mean(onRows.map((a) => a.endingCash));
    const debtOff = mean(offRows.map((a) => a.endingDebt));
    const debtOn = mean(onRows.map((a) => a.endingDebt));
    const crisisOff = mean(offRows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters));
    const crisisOn = mean(onRows.map((a) => a.liquidityStressQuarters + a.severeDistressQuarters));
    const mgmtProfile = onRows.find((a) => a.managementProfileId !== "OFF")?.managementProfileId ?? "?";
    const orientProfile = onRows.find((a) => a.orientationProfileId !== "OFF")?.orientationProfileId ?? "?";

    lines.push(`## ${companyId} (ManagementProfile=${mgmtProfile}, OrientationProfile=${orientProfile})`);
    lines.push("");
    lines.push("| KPI | OFF | ON | Change |");
    lines.push("|---|---|---|---|");
    lines.push(`| HOSO production share | ${(hosoShareOff * 100).toFixed(1)}% | ${(hosoShareOn * 100).toFixed(1)}% | ${((hosoShareOn - hosoShareOff) * 100).toFixed(1)}pt |`);
    lines.push(`| PD production share | ${(pdShareOff * 100).toFixed(1)}% | ${(pdShareOn * 100).toFixed(1)}% | ${((pdShareOn - pdShareOff) * 100).toFixed(1)}pt |`);
    lines.push(`| VAP production share | ${(vapShareOff * 100).toFixed(1)}% | ${(vapShareOn * 100).toFixed(1)}% | ${((vapShareOn - vapShareOff) * 100).toFixed(1)}pt |`);
    lines.push(`| CAPEX total (avg $) | $${(capexOff / 1e6).toFixed(1)}M | $${(capexOn / 1e6).toFixed(1)}M | ${(((capexOn - capexOff) / (capexOff || 1)) * 100).toFixed(1)}% |`);
    lines.push(`| Sales hires (avg) | ${salesHiresOff.toFixed(1)} | ${salesHiresOn.toFixed(1)} | ${(((salesHiresOn - salesHiresOff) / (salesHiresOff || 1)) * 100).toFixed(1)}% |`);
    lines.push(`| Cumulative OP (avg $) | $${(opOff / 1e6).toFixed(1)}M | $${(opOn / 1e6).toFixed(1)}M | ${(((opOn - opOff) / (Math.abs(opOff) || 1)) * 100).toFixed(1)}% |`);
    lines.push(`| Ending cash (avg $) | $${(cashOff / 1e6).toFixed(1)}M | $${(cashOn / 1e6).toFixed(1)}M | ${(((cashOn - cashOff) / (cashOff || 1)) * 100).toFixed(1)}% |`);
    lines.push(`| Ending debt (avg $) | $${(debtOff / 1e6).toFixed(1)}M | $${(debtOn / 1e6).toFixed(1)}M | ${(debtOn - debtOff).toFixed(1)}M abs |`);
    lines.push(`| Crisis quarters (avg /32) | ${crisisOff.toFixed(1)} | ${crisisOn.toFixed(1)} | ${(crisisOn - crisisOff).toFixed(1)} |`);
    lines.push("");
  }
  fs.writeFileSync(path.join(outDir, "strategy_profile_spq2_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${companyRows.length} company rows, ${investmentRows.length} investment rows, ${mixRows.length} mix rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
