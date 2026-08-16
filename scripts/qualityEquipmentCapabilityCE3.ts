// Standard AI Capability Expansion — Phase CE-3 Benchmark
//
// 品質管理設備（qualityControlEquipment）をStandard AIの投資候補に接続した後の、
// 5シナリオ×5シード×5社×32Q×(PROFILE OFF, ON)ベンチマーク（250 company-runs）。
// QI-I1で完成した品質管理設備のゲーム効果（30%リスク低減・2Qランプ）・既存の
// Quality Score/Trust/Sales/VAP capability経路は一切変更しない
// （ベンチマークスクリプトの新規追加のみ）。
//
// 出力:
//   docs/standard_ai/benchmarks/quality_equipment_ce3_summary.md
//   docs/standard_ai/benchmarks/quality_equipment_ce3_company.csv
//   docs/standard_ai/benchmarks/quality_equipment_ce3_factory_timeline.csv
//   docs/standard_ai/benchmarks/quality_equipment_ce3_off_on.csv
//   docs/standard_ai/benchmarks/quality_equipment_ce3_portfolio.csv
//
// 使い方: npx tsx scripts/qualityEquipmentCapabilityCE3.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { BatchQualityAdjustment } from "../app/lib/v2/quality/types";
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
const MODES: readonly ("OFF" | "ON")[] = ["OFF", "ON"];
const COMPANIES: readonly CompanyId[] = ["MASS", "BAL", "JPQ", "CONSV", "VAP"];
const LINE_CAPEX_TYPES = new Set(["hosoLineExpansion", "pdLineExpansion", "vapLineExpansion", "commonProcessingExpansion"]);
const BEFORE_AFTER_WINDOW = 4;

interface FactoryQualitySnapshot {
  readonly operationalRisk: number;
  readonly downgradeTons: number;
  readonly reworkTons: number;
  readonly disposalTons: number;
  readonly majorIncidentOccurred: boolean;
  readonly observedQualityScore: number;
}

function aggregateFactorySnapshot(adjustments: readonly BatchQualityAdjustment[]): FactoryQualitySnapshot {
  let productionTons = 0;
  let riskWeighted = 0;
  let scoreWeighted = 0;
  let downgradeTons = 0;
  let reworkTons = 0;
  let disposalTons = 0;
  let majorIncidentOccurred = false;
  for (const a of adjustments) {
    const tons = unwrapUnit(a.originalFinishedGoodsQuantity);
    productionTons += tons;
    riskWeighted += a.risk.operationalRisk * tons;
    scoreWeighted += unwrapUnit(a.outcome.observedQualityScore) * tons;
    downgradeTons += unwrapUnit(a.downgradeQuantity);
    reworkTons += unwrapUnit(a.reworkQuantity);
    disposalTons += unwrapUnit(a.discardQuantity);
    if (a.outcome.majorIncident.occurred) majorIncidentOccurred = true;
  }
  return {
    operationalRisk: productionTons > 1e-6 ? riskWeighted / productionTons : 0,
    downgradeTons,
    reworkTons,
    disposalTons,
    majorIncidentOccurred,
    observedQualityScore: productionTons > 1e-6 ? scoreWeighted / productionTons : 0,
  };
}

interface CompanyRunAggregate {
  scenario: string;
  seed: string;
  mode: "OFF" | "ON";
  companyId: string;
  managementProfileId: string;
  orientationProfileId: string;
  qualityEquipConsideredCount: number;
  qualityEquipLowNeedCount: number;
  qualityEquipProposedCount: number;
  qualityEquipCompletedCount: number;
  qualityEquipRejectedCount: number;
  qualityEquipFinanceBlockedCount: number;
  targetFactories: Set<string>;
  totalInvestmentUsd: number;
  firstProposedTurn: number | null;
  firstCompletedTurn: number | null;
  qualityNeedScoreSum: number;
  qualityNeedScoreSamples: number;
  // ポートフォリオ（§43）
  pdMechanizationPaidUsd: number;
  vapProductDevelopmentSpendCumulativeUsd: number;
  qualityEquipmentPaidUsd: number;
  lineCapexPaidUsd: number;
  newFactoryPaidUsd: number;
  totalCapexPaidUsd: number;
  // 品質結果（§34）
  operationalRiskSum: number;
  operationalRiskSamples: number;
  downgradeTonsCumulative: number;
  reworkTonsCumulative: number;
  disposalTonsCumulative: number;
  majorIncidentCount: number;
  endingQualityScoreAvg: number;
  endingCustomerTrustAvg: number;
  // 商業結果
  hosoProductionCumulative: number;
  pdProductionCumulative: number;
  vapProductionCumulative: number;
  // 財務
  endingOperatingProfitCumulative: number;
  endingRevenueCumulative: number;
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
    qualityEquipConsideredCount: 0,
    qualityEquipLowNeedCount: 0,
    qualityEquipProposedCount: 0,
    qualityEquipCompletedCount: 0,
    qualityEquipRejectedCount: 0,
    qualityEquipFinanceBlockedCount: 0,
    targetFactories: new Set(),
    totalInvestmentUsd: 0,
    firstProposedTurn: null,
    firstCompletedTurn: null,
    qualityNeedScoreSum: 0,
    qualityNeedScoreSamples: 0,
    pdMechanizationPaidUsd: 0,
    vapProductDevelopmentSpendCumulativeUsd: 0,
    qualityEquipmentPaidUsd: 0,
    lineCapexPaidUsd: 0,
    newFactoryPaidUsd: 0,
    totalCapexPaidUsd: 0,
    operationalRiskSum: 0,
    operationalRiskSamples: 0,
    downgradeTonsCumulative: 0,
    reworkTonsCumulative: 0,
    disposalTonsCumulative: 0,
    majorIncidentCount: 0,
    endingQualityScoreAvg: 0,
    endingCustomerTrustAvg: 0,
    hosoProductionCumulative: 0,
    pdProductionCumulative: 0,
    vapProductionCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingRevenueCumulative: 0,
    endingCash: 0,
    endingDebt: 0,
    liquidityStressQuarters: 0,
    severeDistressQuarters: 0,
  };
}

interface FactoryTimelineRow {
  readonly scenario: string;
  readonly seed: string;
  readonly mode: "OFF" | "ON";
  readonly companyId: string;
  readonly factoryId: string;
  readonly turn: number;
  readonly relativeQuarter: number;
  readonly operationalRisk: number;
  readonly downgradeTons: number;
  readonly reworkTons: number;
  readonly disposalTons: number;
  readonly majorIncidentOccurred: boolean;
  readonly observedQualityScore: number;
}

function runOne(
  scenario: string,
  seed: string,
  mode: "OFF" | "ON"
): { aggregates: Map<string, CompanyRunAggregate>; factoryTimeline: FactoryTimelineRow[] } {
  let session = createSimulationSession({
    simulationRunId: `ce3-${scenario}-${seed}-${mode}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: mode,
  });

  const aggregates = new Map<string, CompanyRunAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAggregate(scenario, seed, mode, c));
  const operatingProfitCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  // companyId -> factoryId -> completion turn（複数完成した場合は最初の1件のみ、before/after分析用）
  const equipmentCompletionTurnByFactory = new Map<string, Map<string, number>>();
  // companyId -> factoryId -> turn -> snapshot（完成turnが判明してから±windowぶんだけ後で抽出する）
  const snapshotHistory = new Map<string, Map<string, Map<number, FactoryQualitySnapshot>>>();

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

      const qe = strategyTurn?.strategy.qualityEquipment;
      if (qe) {
        if (qe.reasonCodes.includes("QUALITY_EQUIP_CONSIDERED")) agg.qualityEquipConsideredCount++;
        if (qe.reasonCodes.includes("QUALITY_EQUIP_LOW_NEED")) agg.qualityEquipLowNeedCount++;
        if (qe.reasonCodes.includes("QUALITY_EQUIP_FINANCE_BLOCKED")) agg.qualityEquipFinanceBlockedCount++;
        if (qe.qualityNeedScore !== null) {
          agg.qualityNeedScoreSum += qe.qualityNeedScore;
          agg.qualityNeedScoreSamples++;
        }
        if (qe.reasonCodes.includes("QUALITY_EQUIP_PROPOSED") && qe.proposedTargetFactoryId) {
          agg.qualityEquipProposedCount++;
          agg.targetFactories.add(qe.proposedTargetFactoryId);
          agg.totalInvestmentUsd += qe.investmentCostUsd ?? 0;
          if (agg.firstProposedTurn === null) agg.firstProposedTurn = record.turn;
        }
      }

      for (const r of capexResult?.rejectedProposals ?? []) {
        if (r.projectType === "qualityControlEquipment") agg.qualityEquipRejectedCount++;
      }
      for (const e of capexResult?.events ?? []) {
        agg.totalCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "pdMechanization") agg.pdMechanizationPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "qualityControlEquipment") agg.qualityEquipmentPaidUsd += e.paymentSucceededUsd;
        if (LINE_CAPEX_TYPES.has(e.projectType)) agg.lineCapexPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "newFactoryConstruction") agg.newFactoryPaidUsd += e.paymentSucceededUsd;
        if (e.projectType === "qualityControlEquipment" && e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.qualityEquipCompletedCount++;
          if (agg.firstCompletedTurn === null) agg.firstCompletedTurn = record.turn;
          // CapexProjectQuarterEventにtargetFactoryIdは含まれないため、完成直後の
          // capexState（このターンの処理後）からprojectIdで案件を引いて対象Factoryを得る。
          const completedProject = session.state.capexState.companies
            .find((c) => c.companyId === companyId)
            ?.portfolio.projects.find((p) => p.projectId === e.projectId);
          const targetFactoryId = completedProject?.targetFactoryId;
          if (targetFactoryId) {
            const byFactory = equipmentCompletionTurnByFactory.get(companyId) ?? new Map<string, number>();
            if (!byFactory.has(targetFactoryId)) byFactory.set(targetFactoryId, record.turn);
            equipmentCompletionTurnByFactory.set(companyId, byFactory);
          }
        }
      }
      agg.vapProductDevelopmentSpendCumulativeUsd += strategyTurn?.strategy.vapProductDevelopment?.proposedSpendUsd ?? 0;

      // --- 品質結果集計（会社レベル、Factory横断） ---
      const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);
      if (companyAdjustments.length > 0) {
        const snap = aggregateFactorySnapshot(companyAdjustments);
        agg.operationalRiskSum += snap.operationalRisk;
        agg.operationalRiskSamples++;
        agg.downgradeTonsCumulative += snap.downgradeTons;
        agg.reworkTonsCumulative += snap.reworkTons;
        agg.disposalTonsCumulative += snap.disposalTons;
        if (snap.majorIncidentOccurred) agg.majorIncidentCount++;
      }
      const qualityByProduct = record.qualityStateAfter.qualityByCompanyProduct.filter((q) => q.companyId === companyId);
      if (qualityByProduct.length > 0) {
        agg.endingQualityScoreAvg = qualityByProduct.reduce((s, q) => s + unwrapUnit(q.qualityScore), 0) / qualityByProduct.length;
      }
      const trustByMarket = record.qualityStateAfter.trustByCompanyMarket.filter((t) => t.companyId === companyId);
      if (trustByMarket.length > 0) {
        agg.endingCustomerTrustAvg = trustByMarket.reduce((s, t) => s + unwrapUnit(t.customerTrustScore), 0) / trustByMarket.length;
      }

      // --- Factory単位のスナップショット履歴を保持（before/after分析用） ---
      const byFactoryAdjustments = new Map<string, BatchQualityAdjustment[]>();
      for (const a of companyAdjustments) {
        const list = byFactoryAdjustments.get(a.factoryId) ?? [];
        list.push(a);
        byFactoryAdjustments.set(a.factoryId, list);
      }
      const companyHistory = snapshotHistory.get(companyId) ?? new Map<string, Map<number, FactoryQualitySnapshot>>();
      for (const [factoryId, list] of byFactoryAdjustments) {
        const factoryHistory = companyHistory.get(factoryId) ?? new Map<number, FactoryQualitySnapshot>();
        factoryHistory.set(record.turn, aggregateFactorySnapshot(list));
        companyHistory.set(factoryId, factoryHistory);
      }
      snapshotHistory.set(companyId, companyHistory);

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
    if (agg.qualityNeedScoreSamples > 0) agg.qualityNeedScoreSum /= agg.qualityNeedScoreSamples;
    if (agg.operationalRiskSamples > 0) agg.operationalRiskSum /= agg.operationalRiskSamples;
  }

  // --- Factory単位before/after抽出（完成turnが判明した工場だけ、±BEFORE_AFTER_WINDOW四半期） ---
  const factoryTimeline: FactoryTimelineRow[] = [];
  for (const [companyId, byFactory] of equipmentCompletionTurnByFactory) {
    const companyHistory = snapshotHistory.get(companyId);
    if (!companyHistory) continue;
    for (const [factoryId, completionTurn] of byFactory) {
      const factoryHistory = companyHistory.get(factoryId);
      if (!factoryHistory) continue;
      for (let rel = -BEFORE_AFTER_WINDOW; rel <= BEFORE_AFTER_WINDOW; rel++) {
        const turn = completionTurn + rel;
        const snap = factoryHistory.get(turn);
        if (!snap) continue;
        factoryTimeline.push({
          scenario,
          seed,
          mode,
          companyId,
          factoryId,
          turn,
          relativeQuarter: rel,
          operationalRisk: snap.operationalRisk,
          downgradeTons: snap.downgradeTons,
          reworkTons: snap.reworkTons,
          disposalTons: snap.disposalTons,
          majorIncidentOccurred: snap.majorIncidentOccurred,
          observedQualityScore: snap.observedQualityScore,
        });
      }
    }
  }

  return { aggregates, factoryTimeline };
}

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

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const allAggregates: CompanyRunAggregate[] = [];
  const allFactoryTimeline: FactoryTimelineRow[] = [];

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const mode of MODES) {
        console.log(`Running ${scenario}/${seed}/${mode}...`);
        const { aggregates, factoryTimeline } = runOne(scenario, seed, mode);
        for (const c of COMPANIES) allAggregates.push(aggregates.get(c)!);
        allFactoryTimeline.push(...factoryTimeline);
      }
    }
  }

  // --- company.csv: 全指標を1社×1run×1modeぶんずつ ---
  const companyHeaders = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "managementProfileId",
    "orientationProfileId",
    "qualityEquipConsideredCount",
    "qualityEquipLowNeedCount",
    "qualityEquipProposedCount",
    "qualityEquipCompletedCount",
    "qualityEquipRejectedCount",
    "qualityEquipFinanceBlockedCount",
    "targetFactoryCount",
    "targetFactories",
    "totalInvestmentUsd",
    "firstProposedTurn",
    "firstCompletedTurn",
    "avgQualityNeedScore",
    "avgOperationalRisk",
    "downgradeTonsCumulative",
    "reworkTonsCumulative",
    "disposalTonsCumulative",
    "majorIncidentCount",
    "endingQualityScoreAvg",
    "endingCustomerTrustAvg",
    "vapProductionShare",
    "pdMechanizationPaidUsd",
    "vapProductDevelopmentSpendCumulativeUsd",
    "qualityEquipmentPaidUsd",
    "lineCapexPaidUsd",
    "newFactoryPaidUsd",
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
      a.qualityEquipConsideredCount,
      a.qualityEquipLowNeedCount,
      a.qualityEquipProposedCount,
      a.qualityEquipCompletedCount,
      a.qualityEquipRejectedCount,
      a.qualityEquipFinanceBlockedCount,
      a.targetFactories.size,
      [...a.targetFactories].join(";"),
      a.totalInvestmentUsd,
      a.firstProposedTurn ?? -1,
      a.firstCompletedTurn ?? -1,
      a.qualityNeedScoreSum,
      a.operationalRiskSum,
      a.downgradeTonsCumulative,
      a.reworkTonsCumulative,
      a.disposalTonsCumulative,
      a.majorIncidentCount,
      a.endingQualityScoreAvg,
      a.endingCustomerTrustAvg,
      totalProd > 0 ? a.vapProductionCumulative / totalProd : 0,
      a.pdMechanizationPaidUsd,
      a.vapProductDevelopmentSpendCumulativeUsd,
      a.qualityEquipmentPaidUsd,
      a.lineCapexPaidUsd,
      a.newFactoryPaidUsd,
      a.totalCapexPaidUsd,
      a.endingRevenueCumulative,
      a.endingOperatingProfitCumulative,
      a.endingCash,
      a.endingDebt,
      a.liquidityStressQuarters,
      a.severeDistressQuarters,
    ];
  });
  writeCsv(path.join(outDir, "quality_equipment_ce3_company.csv"), companyHeaders, companyRows);

  // --- factory_timeline.csv ---
  const timelineHeaders = [
    "scenario",
    "seed",
    "mode",
    "companyId",
    "factoryId",
    "turn",
    "relativeQuarter",
    "operationalRisk",
    "downgradeTons",
    "reworkTons",
    "disposalTons",
    "majorIncidentOccurred",
    "observedQualityScore",
  ];
  const timelineRows = allFactoryTimeline.map((t) => [
    t.scenario,
    t.seed,
    t.mode,
    t.companyId,
    t.factoryId,
    t.turn,
    t.relativeQuarter,
    t.operationalRisk,
    t.downgradeTons,
    t.reworkTons,
    t.disposalTons,
    t.majorIncidentOccurred,
    t.observedQualityScore,
  ]);
  writeCsv(path.join(outDir, "quality_equipment_ce3_factory_timeline.csv"), timelineHeaders, timelineRows);

  // --- off_on.csv: OFF vs ON比較（company.csvのサブセットを見やすく） ---
  const offOnHeaders = [
    "companyId",
    "mode",
    "proposalRate",
    "avgProposedTurn",
    "avgQualityNeedScoreAtProposal",
    "avgOperationalRisk",
    "downgradeTonsCumulative",
    "reworkTonsCumulative",
    "disposalTonsCumulative",
    "majorIncidentCount",
    "endingQualityScoreAvg",
    "endingCustomerTrustAvg",
    "qualityEquipmentPaidUsd",
    "totalCapexPaidUsd",
  ];
  const offOnRows: (readonly (string | number)[])[] = [];
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const proposalRate = mean(rows.map((a) => (a.qualityEquipProposedCount > 0 ? 1 : 0)));
      const proposedTurns = rows.map((a) => a.firstProposedTurn).filter((t): t is number => t !== null);
      offOnRows.push([
        companyId,
        mode,
        proposalRate,
        proposedTurns.length > 0 ? mean(proposedTurns) : -1,
        mean(rows.map((a) => a.qualityNeedScoreSum)),
        mean(rows.map((a) => a.operationalRiskSum)),
        mean(rows.map((a) => a.downgradeTonsCumulative)),
        mean(rows.map((a) => a.reworkTonsCumulative)),
        mean(rows.map((a) => a.disposalTonsCumulative)),
        mean(rows.map((a) => a.majorIncidentCount)),
        mean(rows.map((a) => a.endingQualityScoreAvg)),
        mean(rows.map((a) => a.endingCustomerTrustAvg)),
        mean(rows.map((a) => a.qualityEquipmentPaidUsd)),
        mean(rows.map((a) => a.totalCapexPaidUsd)),
      ]);
    }
  }
  writeCsv(path.join(outDir, "quality_equipment_ce3_off_on.csv"), offOnHeaders, offOnRows);

  // --- portfolio.csv: 会社ごとの投資配分（PD Mechanization / VAP Dev / Quality Equipment / Line CAPEX / New Factory） ---
  const portfolioHeaders = [
    "companyId",
    "mode",
    "pdMechanizationPaidUsd",
    "vapProductDevelopmentSpendCumulativeUsd",
    "qualityEquipmentPaidUsd",
    "lineCapexPaidUsd",
    "newFactoryPaidUsd",
    "totalCapexPaidUsd",
    "qualityEquipmentShareOfCapex",
  ];
  const portfolioRows: (readonly (string | number)[])[] = [];
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const pdMech = mean(rows.map((a) => a.pdMechanizationPaidUsd));
      const vapDev = mean(rows.map((a) => a.vapProductDevelopmentSpendCumulativeUsd));
      const qualityEquip = mean(rows.map((a) => a.qualityEquipmentPaidUsd));
      const lineCapex = mean(rows.map((a) => a.lineCapexPaidUsd));
      const newFactory = mean(rows.map((a) => a.newFactoryPaidUsd));
      const total = mean(rows.map((a) => a.totalCapexPaidUsd));
      portfolioRows.push([companyId, mode, pdMech, vapDev, qualityEquip, lineCapex, newFactory, total, total > 0 ? qualityEquip / total : 0]);
    }
  }
  writeCsv(path.join(outDir, "quality_equipment_ce3_portfolio.csv"), portfolioHeaders, portfolioRows);

  // --- summary.md ---
  const lines: string[] = [];
  lines.push("# Standard AI Capability Expansion CE-3 — Quality Control Equipment Benchmark");
  lines.push("");
  lines.push(
    `5 scenarios x 5 seeds x 5 companies x 32Q x (OFF, ON). ${allAggregates.length} company-runs total (${allAggregates.length / 2} per mode). QI-I1のQuality effect（30%/2Qランプ）は不変。`
  );
  lines.push("");
  lines.push("## OFF vs ON — proposal behavior per company (avg across 25 runs/mode)");
  lines.push("");
  lines.push("| Company | Mode | Proposal rate | Avg proposed Turn | Avg Quality Need at proposal | Avg operationalRisk | Quality Equip paid ($) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      const proposalRate = mean(rows.map((a) => (a.qualityEquipProposedCount > 0 ? 1 : 0)));
      const proposedTurns = rows.map((a) => a.firstProposedTurn).filter((t): t is number => t !== null);
      const avgTurn = proposedTurns.length > 0 ? mean(proposedTurns) : NaN;
      lines.push(
        `| ${companyId} | ${mode} | ${(proposalRate * 100).toFixed(0)}% | ${Number.isNaN(avgTurn) ? "n/a" : avgTurn.toFixed(1)} | ${mean(
          rows.map((a) => a.qualityNeedScoreSum)
        ).toFixed(3)} | ${mean(rows.map((a) => a.operationalRiskSum)).toFixed(3)} | $${(mean(rows.map((a) => a.qualityEquipmentPaidUsd)) / 1e6).toFixed(2)}M |`
      );
    }
  }
  lines.push("");
  lines.push("## Quality outcomes — OFF vs ON (avg across 25 runs/mode)");
  lines.push("");
  lines.push("| Company | Mode | Downgrade (t) | Rework (t) | Disposal (t) | Major incidents | Ending Quality Score | Ending Trust |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const mode of MODES) {
      const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === mode);
      lines.push(
        `| ${companyId} | ${mode} | ${mean(rows.map((a) => a.downgradeTonsCumulative)).toFixed(0)} | ${mean(
          rows.map((a) => a.reworkTonsCumulative)
        ).toFixed(0)} | ${mean(rows.map((a) => a.disposalTonsCumulative)).toFixed(0)} | ${mean(rows.map((a) => a.majorIncidentCount)).toFixed(
          1
        )} | ${mean(rows.map((a) => a.endingQualityScoreAvg)).toFixed(1)} | ${mean(rows.map((a) => a.endingCustomerTrustAvg)).toFixed(1)} |`
      );
    }
  }
  lines.push("");
  lines.push("## Investment portfolio — $ allocated per company, ON mode (avg across 25 runs)");
  lines.push("");
  lines.push("| Company | PD Mechanization | VAP Product Dev | Quality Equipment | Line CAPEX | New Factory | Total CAPEX | Quality Equip share |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const rows = allAggregates.filter((a) => a.companyId === companyId && a.mode === "ON");
    const pdMech = mean(rows.map((a) => a.pdMechanizationPaidUsd));
    const vapDev = mean(rows.map((a) => a.vapProductDevelopmentSpendCumulativeUsd));
    const qualityEquip = mean(rows.map((a) => a.qualityEquipmentPaidUsd));
    const lineCapex = mean(rows.map((a) => a.lineCapexPaidUsd));
    const newFactory = mean(rows.map((a) => a.newFactoryPaidUsd));
    const total = mean(rows.map((a) => a.totalCapexPaidUsd));
    lines.push(
      `| ${companyId} | $${(pdMech / 1e6).toFixed(1)}M | $${(vapDev / 1e6).toFixed(1)}M | $${(qualityEquip / 1e6).toFixed(1)}M | $${(
        lineCapex / 1e6
      ).toFixed(1)}M | $${(newFactory / 1e6).toFixed(1)}M | $${(total / 1e6).toFixed(1)}M | ${(total > 0 ? (qualityEquip / total) * 100 : 0).toFixed(1)}% |`
    );
  }
  lines.push("");
  lines.push(`## Factory-level before/after (${BEFORE_AFTER_WINDOW}Q window around equipment completion, all modes/companies pooled)`);
  lines.push("");
  lines.push(
    "Note: pools all scenarios/seeds/companies with an observed completion event. Scenario/seed confounding is present — treat as a directional reference, not a causal per-unit effect estimate (指示§35)."
  );
  lines.push("");
  lines.push("| Relative Q | n | Avg operationalRisk | Avg downgrade (t) | Avg rework (t) | Avg disposal (t) | Major incident rate |");
  lines.push("|---|---|---|---|---|---|---|");
  for (let rel = -BEFORE_AFTER_WINDOW; rel <= BEFORE_AFTER_WINDOW; rel++) {
    const rows = allFactoryTimeline.filter((t) => t.relativeQuarter === rel);
    if (rows.length === 0) {
      lines.push(`| ${rel >= 0 ? "+" + rel : rel} | 0 | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    lines.push(
      `| ${rel >= 0 ? "+" + rel : rel} | ${rows.length} | ${mean(rows.map((r) => r.operationalRisk)).toFixed(3)} | ${mean(
        rows.map((r) => r.downgradeTons)
      ).toFixed(2)} | ${mean(rows.map((r) => r.reworkTons)).toFixed(2)} | ${mean(rows.map((r) => r.disposalTons)).toFixed(2)} | ${(
        mean(rows.map((r) => (r.majorIncidentOccurred ? 1 : 0))) * 100
      ).toFixed(1)}% |`
    );
  }
  lines.push("");
  lines.push(`Total factory-completion events captured for before/after analysis: ${new Set(allFactoryTimeline.map((t) => `${t.scenario}|${t.seed}|${t.mode}|${t.companyId}|${t.factoryId}`)).size}.`);
  lines.push("");
  fs.writeFileSync(path.join(outDir, "quality_equipment_ce3_summary.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${companyRows.length} company rows, ${timelineRows.length} factory-timeline rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
