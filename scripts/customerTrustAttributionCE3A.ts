// Standard AI CE-3A — Customer Trust Attribution / Quality Equipment Controlled Ablation Audit
//
// 監査専用スクリプト。Trust formula・Quality Need・Profile・parameterは一切
// 変更しない（decision/capex.tsに追加したqualityEquipmentCapabilityEnabled
// ablation switchは、省略時＝undefinedならCE-3までの挙動と完全に同一であり、
// このscriptがfalseを明示的に渡した場合だけ品質管理設備の候補生成を無効化する）。
//
// Part 1: Turn-by-turn Trust attribution（JPQ/VAP/MASS、PROFILE ON、代表seed）。
//   既存のcomputeMarketTrustObservations（quality/trustObservation.ts、変更なし）を
//   このscriptから再度呼び出し、会社レベルへ集計しただけの近似値である
//   （usage加重のdeliveredQualityScoreは正確に再現、observedDeliveryScoreは
//   永続化済みdeliveryObservationsから正確に再現。ただし複数market・複数商品を
//   会社レベルへ単純平均で丸めているため、実際のTrust更新式（会社×market単位の
//   非対称EWMA）と厳密に一致するとは限らない近似であることをsummary.mdに明記する）。
//
// Part 2: Controlled Ablation Benchmark（5 scenarios x 5 seeds x 5 companies x 32Q、
//   PROFILE ON固定、Quality Equipment capability ON vs DISABLED ONLY）。
//   DISABLED側はPD Mechanization・VAP Product Development・Line CAPEX・
//   New Factory・Sales・Production・Procurementのロジックを一切変更せず、
//   decision/capex.tsのQuality Equipment候補ブロックだけをスキップする。
//
// 出力:
//   docs/standard_ai/benchmarks/customer_trust_attribution_ce3a.md
//   docs/standard_ai/benchmarks/customer_trust_attribution_ce3a_turns.csv
//   docs/standard_ai/benchmarks/customer_trust_quality_equipment_ablation.csv
//   docs/standard_ai/benchmarks/customer_trust_quality_equipment_ablation_summary.md
//
// 使い方: npx tsx scripts/customerTrustAttributionCE3A.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { computeMarketTrustObservations } from "../app/lib/v2/quality/trustObservation";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { SalesContract } from "../app/lib/v2/sales/types";
import { FinishedGoodsLot } from "../app/lib/v2/production/types";
import { QUALITY_PARAMETERS_V1 } from "../app/lib/v2/quality/parameters";

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

// ---------------------------------------------------------------------
// Part 1: Turn-by-turn attribution
// ---------------------------------------------------------------------

interface TurnAttributionRow {
  readonly scenario: string;
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly trustBefore: number;
  readonly trustAfter: number;
  readonly trustDelta: number;
  readonly avgDeliveredQualityScore: number | null;
  readonly avgObservedDeliveryScore: number | null;
  readonly majorIncidentTrustPenaltyTotal: number;
  readonly marketsObservedCount: number;
  readonly dueQuantityTotal: number;
  readonly onTimeQuantityTotal: number;
  readonly newlyOverdueQuantityTotal: number;
  readonly continuingOverdueQuantityTotal: number;
  readonly openContractCount: number;
}

function runAttribution(scenario: string, seed: string, companyIds: readonly CompanyId[]): TurnAttributionRow[] {
  let session = createSimulationSession({
    simulationRunId: `ce3a-attr-${scenario}-${seed}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: "ON",
  });

  const rows: TurnAttributionRow[] = [];
  const prevTrustByCompany: Record<string, number> = Object.fromEntries(companyIds.map((c) => [c, 50]));

  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];

    // 【近似の根拠】このscript実行時点でのsession.state（当ターン処理後）から
    // contracts・finishedGoodsLotsを引く。record.fulfillmentPlan.usage
    // （このターンに実際に使われたlot×contractの組）は正確な永続化データであり、
    // 変わらないのはlot.qualityInfo・contract.marketの参照先だけである
    // （いずれも不変フィールド。ロット消費後もオブジェクト自体は残る）。
    const contractsById = new Map<string, SalesContract>(session.state.contracts.map((c) => [c.contractId, c]));
    const lotsById = new Map<string, FinishedGoodsLot>(session.state.productionState.finishedGoodsLots.map((l) => [l.lotId, l]));

    for (const companyId of companyIds) {
      const companyDeliveryObs = record.deliveryObservations.filter((d) => d.companyId === companyId);
      const companyUsage = record.fulfillmentPlan.usage.filter((u) => u.companyId === companyId);
      const trustObs = computeMarketTrustObservations(companyUsage, contractsById, lotsById, companyDeliveryObs, QUALITY_PARAMETERS_V1);

      const qualityByMarket = trustObs.map((t) => unwrapUnit(t.deliveredQualityScore));
      const deliveryByMarket = trustObs.map((t) => unwrapUnit(t.observedDeliveryScore));
      const penaltyTotal = trustObs.reduce((s, t) => s + Math.max(0, t.majorIncidentTrustPenalty), 0);

      const dueTotal = companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.dueQuantity), 0);
      const onTimeTotal = companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.onTimeQuantity), 0);
      const newlyOverdueTotal = companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.newlyOverdueQuantity), 0);
      const continuingOverdueTotal = companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.continuingOverdueQuantity), 0);

      const trustAfterEntries = record.qualityStateAfter.trustByCompanyMarket.filter((t) => t.companyId === companyId);
      const trustAfter = trustAfterEntries.length > 0 ? mean(trustAfterEntries.map((t) => unwrapUnit(t.customerTrustScore))) : prevTrustByCompany[companyId];

      const openContractCount = session.state.contracts.filter(
        (c) => c.companyId === companyId && (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
      ).length;

      rows.push({
        scenario,
        seed,
        companyId,
        turn: record.turn,
        trustBefore: prevTrustByCompany[companyId],
        trustAfter,
        trustDelta: trustAfter - prevTrustByCompany[companyId],
        avgDeliveredQualityScore: qualityByMarket.length > 0 ? mean(qualityByMarket) : null,
        avgObservedDeliveryScore: deliveryByMarket.length > 0 ? mean(deliveryByMarket) : null,
        majorIncidentTrustPenaltyTotal: penaltyTotal,
        marketsObservedCount: trustObs.length,
        dueQuantityTotal: dueTotal,
        onTimeQuantityTotal: onTimeTotal,
        newlyOverdueQuantityTotal: newlyOverdueTotal,
        continuingOverdueQuantityTotal: continuingOverdueTotal,
        openContractCount,
      });
      prevTrustByCompany[companyId] = trustAfter;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// Part 2: Controlled ablation benchmark
// ---------------------------------------------------------------------

interface AblationAggregate {
  scenario: string;
  seed: string;
  variant: "QUALITY_EQUIP_ON" | "QUALITY_EQUIP_DISABLED";
  companyId: string;
  qualityEquipProposedCount: number;
  qualityEquipCompletedCount: number;
  downgradeTonsCumulative: number;
  reworkTonsCumulative: number;
  disposalTonsCumulative: number;
  majorIncidentCount: number;
  endingQualityScoreAvg: number;
  endingCustomerTrustAvg: number;
  contractedCountCumulative: number;
  fulfilledCountCumulative: number;
  dueQuantityCumulative: number;
  onTimeQuantityCumulative: number;
  newlyOverdueQuantityCumulative: number;
  continuingOverdueQuantityCumulative: number;
  endingRevenueCumulative: number;
  endingOperatingProfitCumulative: number;
  endingCash: number;
}

function newAblationAggregate(scenario: string, seed: string, variant: AblationAggregate["variant"], companyId: string): AblationAggregate {
  return {
    scenario,
    seed,
    variant,
    companyId,
    qualityEquipProposedCount: 0,
    qualityEquipCompletedCount: 0,
    downgradeTonsCumulative: 0,
    reworkTonsCumulative: 0,
    disposalTonsCumulative: 0,
    majorIncidentCount: 0,
    endingQualityScoreAvg: 0,
    endingCustomerTrustAvg: 0,
    contractedCountCumulative: 0,
    fulfilledCountCumulative: 0,
    dueQuantityCumulative: 0,
    onTimeQuantityCumulative: 0,
    newlyOverdueQuantityCumulative: 0,
    continuingOverdueQuantityCumulative: 0,
    endingRevenueCumulative: 0,
    endingOperatingProfitCumulative: 0,
    endingCash: 0,
  };
}

function runAblation(scenario: string, seed: string, variant: AblationAggregate["variant"]): Map<string, AblationAggregate> {
  let session = createSimulationSession({
    simulationRunId: `ce3a-ablation-${scenario}-${seed}-${variant}`,
    scenarioId: scenario,
    seed,
    requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
    startedAt: AT,
    standardAiProfileMode: "ON",
    qualityEquipmentCapabilityDisabled: variant === "QUALITY_EQUIP_DISABLED",
  });

  const aggregates = new Map<string, AblationAggregate>();
  for (const c of COMPANIES) aggregates.set(c, newAblationAggregate(scenario, seed, variant, c));
  const revenueCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));
  const opCumulative: Record<string, number> = Object.fromEntries(COMPANIES.map((c) => [c, 0]));

  for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) {
      console.error(`  FAILED to advance ${scenario}/${seed}/${variant} at turn ${session.state.scenarioState.currentTurn}: ${outcome.error}`);
      break;
    }
    session = outcome.session;
    const record = session.state.history[session.state.history.length - 1];

    for (const companyId of COMPANIES) {
      const agg = aggregates.get(companyId)!;
      const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === record.turn);
      const qe = strategyTurn?.strategy.qualityEquipment;
      if (qe?.reasonCodes.includes("QUALITY_EQUIP_PROPOSED")) agg.qualityEquipProposedCount++;
      const capexResult = record.capexResults.find((c) => c.companyId === companyId);
      for (const e of capexResult?.events ?? []) {
        if (e.projectType === "qualityControlEquipment" && e.statusAfter === "completed" && e.statusBefore !== "completed") {
          agg.qualityEquipCompletedCount++;
        }
      }

      const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);
      for (const a of companyAdjustments) {
        agg.downgradeTonsCumulative += unwrapUnit(a.downgradeQuantity);
        agg.reworkTonsCumulative += unwrapUnit(a.reworkQuantity);
        agg.disposalTonsCumulative += unwrapUnit(a.discardQuantity);
        if (a.outcome.majorIncident.occurred) agg.majorIncidentCount++;
      }

      const qualityByProduct = record.qualityStateAfter.qualityByCompanyProduct.filter((q) => q.companyId === companyId);
      if (qualityByProduct.length > 0) {
        agg.endingQualityScoreAvg = qualityByProduct.reduce((s, q) => s + unwrapUnit(q.qualityScore), 0) / qualityByProduct.length;
      }
      const trustByMarket = record.qualityStateAfter.trustByCompanyMarket.filter((t) => t.companyId === companyId);
      if (trustByMarket.length > 0) {
        agg.endingCustomerTrustAvg = trustByMarket.reduce((s, t) => s + unwrapUnit(t.customerTrustScore), 0) / trustByMarket.length;
      }

      const companyDeliveryObs = record.deliveryObservations.filter((d) => d.companyId === companyId);
      agg.dueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.dueQuantity), 0);
      agg.onTimeQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.onTimeQuantity), 0);
      agg.newlyOverdueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.newlyOverdueQuantity), 0);
      agg.continuingOverdueQuantityCumulative += companyDeliveryObs.reduce((s, d) => s + unwrapUnit(d.continuingOverdueQuantity), 0);

      const contractsFormedThisTurn = session.state.contracts.filter((c) => c.companyId === companyId && c.contractedPeriod === record.period).length;
      agg.contractedCountCumulative += contractsFormedThisTurn;
      const fulfilledThisTurn = session.state.contracts.filter(
        (c) => c.companyId === companyId && c.dueDate === record.period && c.status === "fulfilled"
      ).length;
      agg.fulfilledCountCumulative += fulfilledThisTurn;

      const financialResult = record.financialResults.find((f) => f.companyId === companyId);
      const revenueThisQuarter = Number(financialResult?.profitAndLoss.netRevenue ?? 0);
      revenueCumulative[companyId] += revenueThisQuarter;
      const opThisQuarter = Number(financialResult?.profitAndLoss.operatingProfit ?? 0);
      opCumulative[companyId] += opThisQuarter;
      agg.endingRevenueCumulative = revenueCumulative[companyId];
      agg.endingOperatingProfitCumulative = opCumulative[companyId];
      agg.endingCash = financialResult ? Number(financialResult.balanceSheet.cash) : agg.endingCash;
    }
  }
  return aggregates;
}

async function main() {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  // --- Part 1: turn-by-turn attribution ---
  console.log("Part 1: turn-by-turn attribution (JPQ/VAP/MASS, ON, seed-1/seed-2, baseline)...");
  const attributionRows: TurnAttributionRow[] = [];
  for (const seed of ["seed-1", "seed-2"]) {
    console.log(`  Running baseline/${seed}...`);
    attributionRows.push(...runAttribution("baseline", seed, ["JPQ", "VAP", "MASS"]));
  }
  const turnHeaders = [
    "scenario",
    "seed",
    "companyId",
    "turn",
    "trustBefore",
    "trustAfter",
    "trustDelta",
    "avgDeliveredQualityScore",
    "avgObservedDeliveryScore",
    "majorIncidentTrustPenaltyTotal",
    "marketsObservedCount",
    "dueQuantityTotal",
    "onTimeQuantityTotal",
    "newlyOverdueQuantityTotal",
    "continuingOverdueQuantityTotal",
    "openContractCount",
  ];
  const turnRows = attributionRows.map((r) => [
    r.scenario,
    r.seed,
    r.companyId,
    r.turn,
    r.trustBefore,
    r.trustAfter,
    r.trustDelta,
    r.avgDeliveredQualityScore ?? -1,
    r.avgObservedDeliveryScore ?? -1,
    r.majorIncidentTrustPenaltyTotal,
    r.marketsObservedCount,
    r.dueQuantityTotal,
    r.onTimeQuantityTotal,
    r.newlyOverdueQuantityTotal,
    r.continuingOverdueQuantityTotal,
    r.openContractCount,
  ]);
  writeCsv(path.join(outDir, "customer_trust_attribution_ce3a_turns.csv"), turnHeaders, turnRows);

  // --- Part 2: controlled ablation benchmark ---
  console.log("Part 2: controlled ablation benchmark (5 scenarios x 5 seeds x 5 companies x 32Q, ON fixed)...");
  const allAblation: AblationAggregate[] = [];
  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      for (const variant of ["QUALITY_EQUIP_ON", "QUALITY_EQUIP_DISABLED"] as const) {
        console.log(`  Running ${scenario}/${seed}/${variant}...`);
        const aggregates = runAblation(scenario, seed, variant);
        for (const c of COMPANIES) allAblation.push(aggregates.get(c)!);
      }
    }
  }
  const ablationHeaders = [
    "scenario",
    "seed",
    "variant",
    "companyId",
    "qualityEquipProposedCount",
    "qualityEquipCompletedCount",
    "downgradeTonsCumulative",
    "reworkTonsCumulative",
    "disposalTonsCumulative",
    "majorIncidentCount",
    "endingQualityScoreAvg",
    "endingCustomerTrustAvg",
    "contractedCountCumulative",
    "fulfilledCountCumulative",
    "dueQuantityCumulative",
    "onTimeQuantityCumulative",
    "newlyOverdueQuantityCumulative",
    "continuingOverdueQuantityCumulative",
    "endingRevenueCumulative",
    "endingOperatingProfitCumulative",
    "endingCash",
  ];
  const ablationRows = allAblation.map((a) => [
    a.scenario,
    a.seed,
    a.variant,
    a.companyId,
    a.qualityEquipProposedCount,
    a.qualityEquipCompletedCount,
    a.downgradeTonsCumulative,
    a.reworkTonsCumulative,
    a.disposalTonsCumulative,
    a.majorIncidentCount,
    a.endingQualityScoreAvg,
    a.endingCustomerTrustAvg,
    a.contractedCountCumulative,
    a.fulfilledCountCumulative,
    a.dueQuantityCumulative,
    a.onTimeQuantityCumulative,
    a.newlyOverdueQuantityCumulative,
    a.continuingOverdueQuantityCumulative,
    a.endingRevenueCumulative,
    a.endingOperatingProfitCumulative,
    a.endingCash,
  ]);
  writeCsv(path.join(outDir, "customer_trust_quality_equipment_ablation.csv"), ablationHeaders, ablationRows);

  // --- ablation summary.md ---
  const ablationLines: string[] = [];
  ablationLines.push("# CE-3A — Quality Equipment Controlled Ablation Benchmark");
  ablationLines.push("");
  ablationLines.push(
    `5 scenarios x 5 seeds x 5 companies x 32Q x (QUALITY_EQUIP_ON, QUALITY_EQUIP_DISABLED). PROFILE ON固定。${allAblation.length} company-runs total.`
  );
  ablationLines.push("");
  ablationLines.push("## Δ attribution per company (ON - DISABLED, avg across 25 runs/variant)");
  ablationLines.push("");
  ablationLines.push(
    "| Company | ΔQuality Score | ΔTrust | Δdowngrade(t) | Δrework(t) | Δdisposal(t) | Δincident | ΔonTimeRatio | Δbacklog(newlyOverdue+continuing) |"
  );
  ablationLines.push("|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    const onRows = allAblation.filter((a) => a.companyId === companyId && a.variant === "QUALITY_EQUIP_ON");
    const offRows = allAblation.filter((a) => a.companyId === companyId && a.variant === "QUALITY_EQUIP_DISABLED");
    const onTimeRatio = (rows: AblationAggregate[]) => mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
    const backlog = (rows: AblationAggregate[]) => mean(rows.map((a) => a.newlyOverdueQuantityCumulative + a.continuingOverdueQuantityCumulative));
    const dQuality = mean(onRows.map((a) => a.endingQualityScoreAvg)) - mean(offRows.map((a) => a.endingQualityScoreAvg));
    const dTrust = mean(onRows.map((a) => a.endingCustomerTrustAvg)) - mean(offRows.map((a) => a.endingCustomerTrustAvg));
    const dDowngrade = mean(onRows.map((a) => a.downgradeTonsCumulative)) - mean(offRows.map((a) => a.downgradeTonsCumulative));
    const dRework = mean(onRows.map((a) => a.reworkTonsCumulative)) - mean(offRows.map((a) => a.reworkTonsCumulative));
    const dDisposal = mean(onRows.map((a) => a.disposalTonsCumulative)) - mean(offRows.map((a) => a.disposalTonsCumulative));
    const dIncident = mean(onRows.map((a) => a.majorIncidentCount)) - mean(offRows.map((a) => a.majorIncidentCount));
    const dOnTimeRatio = onTimeRatio(onRows) - onTimeRatio(offRows);
    const dBacklog = backlog(onRows) - backlog(offRows);
    ablationLines.push(
      `| ${companyId} | ${dQuality.toFixed(2)} | ${dTrust.toFixed(2)} | ${dDowngrade.toFixed(0)} | ${dRework.toFixed(0)} | ${dDisposal.toFixed(
        0
      )} | ${dIncident.toFixed(2)} | ${(dOnTimeRatio * 100).toFixed(2)}pp | ${dBacklog.toFixed(0)} |`
    );
  }
  ablationLines.push("");
  ablationLines.push("## Full KPI comparison per company (avg across 25 runs/variant)");
  ablationLines.push("");
  ablationLines.push(
    "| Company | Variant | Proposed | Completed | Quality Score | Trust | On-time ratio | Backlog(t) | Revenue($) | OP($) | Cash($) |"
  );
  ablationLines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const companyId of COMPANIES) {
    for (const variant of ["QUALITY_EQUIP_ON", "QUALITY_EQUIP_DISABLED"] as const) {
      const rows = allAblation.filter((a) => a.companyId === companyId && a.variant === variant);
      const onTimeRatio = mean(rows.map((a) => (a.dueQuantityCumulative > 0 ? a.onTimeQuantityCumulative / a.dueQuantityCumulative : 0)));
      const backlog = mean(rows.map((a) => a.newlyOverdueQuantityCumulative + a.continuingOverdueQuantityCumulative));
      ablationLines.push(
        `| ${companyId} | ${variant} | ${mean(rows.map((a) => a.qualityEquipProposedCount)).toFixed(2)} | ${mean(
          rows.map((a) => a.qualityEquipCompletedCount)
        ).toFixed(2)} | ${mean(rows.map((a) => a.endingQualityScoreAvg)).toFixed(1)} | ${mean(rows.map((a) => a.endingCustomerTrustAvg)).toFixed(
          1
        )} | ${(onTimeRatio * 100).toFixed(1)}% | ${backlog.toFixed(0)} | $${(mean(rows.map((a) => a.endingRevenueCumulative)) / 1e6).toFixed(
          1
        )}M | $${(mean(rows.map((a) => a.endingOperatingProfitCumulative)) / 1e6).toFixed(1)}M | $${(
          mean(rows.map((a) => a.endingCash)) / 1e6
        ).toFixed(1)}M |`
      );
    }
  }
  ablationLines.push("");
  fs.writeFileSync(path.join(outDir, "customer_trust_quality_equipment_ablation_summary.md"), ablationLines.join("\n") + "\n", "utf8");

  // --- turn-by-turn attribution summary.md ---
  const lines: string[] = [];
  lines.push("# CE-3A — Customer Trust Attribution Audit");
  lines.push("");
  lines.push(
    "Turn-by-turn Trust decomposition for representative cases (JPQ/VAP/MASS, PROFILE ON, seed-1/seed-2, baseline scenario). " +
      "avgDeliveredQualityScore/avgObservedDeliveryScore are company-level simple averages across markets observed that turn " +
      "(the actual Trust update happens per company x market with asymmetric EWMA; this table approximates by averaging, " +
      "see customer_trust_attribution_ce3a_turns.csv for the full per-turn data)."
  );
  lines.push("");
  lines.push("## Largest single-turn Trust drops per company (baseline/seed-1)");
  lines.push("");
  lines.push("| Company | Turn | Trust before | Trust after | Delta | Avg delivered quality | Avg on-time delivery | Incident penalty | Newly overdue (t) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const companyId of ["JPQ", "VAP", "MASS"]) {
    const rows = attributionRows.filter((r) => r.companyId === companyId && r.seed === "seed-1" && r.scenario === "baseline");
    const worst = [...rows].sort((a, b) => a.trustDelta - b.trustDelta)[0];
    if (!worst) continue;
    lines.push(
      `| ${companyId} | ${worst.turn} | ${worst.trustBefore.toFixed(1)} | ${worst.trustAfter.toFixed(1)} | ${worst.trustDelta.toFixed(2)} | ${
        worst.avgDeliveredQualityScore?.toFixed(1) ?? "n/a"
      } | ${worst.avgObservedDeliveryScore?.toFixed(1) ?? "n/a"} | ${worst.majorIncidentTrustPenaltyTotal.toFixed(1)} | ${worst.newlyOverdueQuantityTotal.toFixed(1)} |`
    );
  }
  lines.push("");
  lines.push("## Full-run summary per company (baseline, seed-1/seed-2 averaged)");
  lines.push("");
  lines.push(
    "| Company | Trust Q1 | Trust Q32 | Avg delivered quality | Avg on-time delivery | Total incident penalty | Total newly overdue (t) | Total continuing overdue (t) |"
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const companyId of ["JPQ", "VAP", "MASS"]) {
    const rows = attributionRows.filter((r) => r.companyId === companyId);
    const q1 = mean(rows.filter((r) => r.turn === 1).map((r) => r.trustBefore));
    const q32 = mean(rows.filter((r) => r.turn === MANAGEMENT_CONSOLE_STANDARD_TURNS).map((r) => r.trustAfter));
    const avgQuality = mean(rows.map((r) => r.avgDeliveredQualityScore).filter((v): v is number => v !== null));
    const avgDelivery = mean(rows.map((r) => r.avgObservedDeliveryScore).filter((v): v is number => v !== null));
    const totalPenalty = rows.reduce((s, r) => s + r.majorIncidentTrustPenaltyTotal, 0) / 2;
    const totalNewlyOverdue = rows.reduce((s, r) => s + r.newlyOverdueQuantityTotal, 0) / 2;
    const totalContinuingOverdue = rows.reduce((s, r) => s + r.continuingOverdueQuantityTotal, 0) / 2;
    lines.push(
      `| ${companyId} | ${q1.toFixed(1)} | ${q32.toFixed(1)} | ${avgQuality.toFixed(1)} | ${avgDelivery.toFixed(1)} | ${totalPenalty.toFixed(
        1
      )} | ${totalNewlyOverdue.toFixed(0)} | ${totalContinuingOverdue.toFixed(0)} |`
    );
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "customer_trust_attribution_ce3a.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${turnRows.length} turn-attribution rows, ${ablationRows.length} ablation rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
