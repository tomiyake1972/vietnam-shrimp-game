// Standard AI Investment Portfolio Calibration — Phase PC-2C Audit
//
// 監査専用（parameter・game behavior変更なし）。JPQ/CONSV/VAPの長期backlogについて、
// 「工場が足りない」のか「特定ラインが足りない」のか「労務なのか」「戦略的に
// 捨てているのか」を、product別（HOSO/PD/VAP）・Common Processing・labor・
// New Factory評価・Line CAPEX判断のturn-by-turnデータで区別する。
//
// 【PC-2C補正指示への対応】「長期Backlog=Underinvestment」という前提は使わない。
// Backlogを (a) Healthy Forward（納期未到来、outstandingQuantityのうちoverdue
// でない分）と (b) Problematic Overdue（納期超過、overdueQuantity）に分離する
// （既存のSalesContract.dueDate・outstandingQuantity、CompanyQuarterSummary.
// overdueQuantityだけから導出、新しい観測は作らない）。設備投資判断の中心は
// 現在のbacklogではなく、newFactoryAssessment.forwardCapacityGap（既存SSoT、
// 完成時点の予測需要−予測実効能力）に置く。
//
// 出力:
//   docs/standard_ai/benchmarks/pc2_backlog_product_diagnosis.md
//   docs/standard_ai/benchmarks/pc2_backlog_product_turns.csv
//
// 使い方: npx tsx scripts/pc2BacklogProductDiagnosis.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../app/lib/v2/companyLab/standardAi/orientationProfile";
import { toYearQuarter } from "../app/lib/v2/core/period";
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
const TARGET_COMPANIES: readonly CompanyId[] = ["JPQ", "CONSV", "VAP"];
const PRODUCTS = ["hoso", "pd", "vap"] as const;

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
function periodIndex(p: string): number {
  const yq = toYearQuarter(p as never);
  return yq.year * 4 + yq.quarter;
}

interface TurnRow {
  scenario: string;
  seed: string;
  companyId: string;
  turn: number;
  outstandingTotalTons: number;
  overdueTotalTons: number;
  healthyForwardTotalTons: number;
  outstandingByProduct: Record<string, number>;
  overdueByProduct: Record<string, number>;
  avgUnitPriceOverdue: number | null;
  avgUnitPriceForward: number | null;
  onTimeDeliveryRate: number | null;
  productionRequirementByProduct: Record<string, number>;
  actualProductionByProduct: Record<string, number>;
  effectiveCapacityByProduct: Record<string, number>;
  utilizationByProduct: Record<string, number>;
  commonProcessingCapacity: number;
  commonProcessingUtilization: number;
  regularWorkers: number;
  laborShortfall: number;
  forwardCapacityGapTons: number | null;
  forwardCapacityGapRatio: number | null;
  forecastCompletionTurn: number | null;
  newFactoryStatus: string | null;
  lineCapexCodes: string;
  cashUsd: number;
  severeDistress: boolean;
}

function main2(): void {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const rows: TurnRow[] = [];

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`  Running ${scenario}/${seed}...`);
      let session = createSimulationSession({
        simulationRunId: `pc2c-${scenario}-${seed}`,
        scenarioId: scenario,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt: AT,
        standardAiProfileMode: "ON",
      });

      for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
        const turn = session.state.scenarioState.currentTurn;
        const currentPeriodIdx = periodIndex(session.state.currentPeriod as unknown as string);
        const publicInfo = buildPublicMarketInfo(session.state);

        for (const companyId of TARGET_COMPANIES) {
          const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
          const ownState = buildCompanyOwnState(session.state, fixture);
          const profileResolution = resolveStandardAiProfileForMode(companyId, session.state.config.standardAiProfileMode);
          const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
            fixture,
            ownState,
            publicInfo,
            session.state.currentPeriod,
            turn,
            profileResolution.params,
            undefined,
            session.state.config.visionOverrides
          );

          // --- Backlog: Healthy Forward vs Overdue（既存SalesContract.dueDate/outstandingQuantityだけから導出） ---
          const outstandingContracts = ownState.contracts.filter((c) => unwrapUnit(c.outstandingQuantity) > 1e-6);
          let outstandingTotalTons = 0;
          let overdueTotalTons = 0;
          const outstandingByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
          const overdueByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
          let overdueValueSum = 0;
          let overdueTonsSum = 0;
          let forwardValueSum = 0;
          let forwardTonsSum = 0;
          for (const c of outstandingContracts) {
            const qty = unwrapUnit(c.outstandingQuantity);
            outstandingTotalTons += qty;
            outstandingByProduct[c.product] += qty;
            const isOverdue = periodIndex(c.dueDate as unknown as string) < currentPeriodIdx;
            if (isOverdue) {
              overdueTotalTons += qty;
              overdueByProduct[c.product] += qty;
              overdueValueSum += qty * unwrapUnit(c.unitPrice);
              overdueTonsSum += qty;
            } else {
              forwardValueSum += qty * unwrapUnit(c.unitPrice);
              forwardTonsSum += qty;
            }
          }

          // --- Product-level production requirement / actual / capacity / utilization ---
          const productionRequirementByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
          for (const p of PRODUCTS) {
            productionRequirementByProduct[p] = diagnostics.currentPeriodDeliveryDemand?.byProduct[p] ?? 0;
          }
          const effectiveCapacityByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
          const observationInternal = (diagnostics as unknown as { observation?: never }).observation;
          void observationInternal;
          for (const f of ownState.effectiveFactories) {
            effectiveCapacityByProduct.hoso += unwrapUnit(f.hosoCapacity);
            effectiveCapacityByProduct.pd += unwrapUnit(f.pdCapacity);
            effectiveCapacityByProduct.vap += unwrapUnit(f.vapCapacity);
          }
          const commonProcessingCapacity = ownState.effectiveFactories.reduce((s, f) => s + unwrapUnit(f.commonProcessingCapacity), 0);

          // --- Forward Capacity Gap（既存newFactoryAssessment、新規計算しない） ---
          const assessment = (diagnostics as unknown as {
            newFactoryAssessment?: {
              status: string;
              forwardCapacityGap: { forwardCapacityGapTons: number; forwardCapacityGapRatio: number; forecastCompletionTurn: number } | null;
            };
          }).newFactoryAssessment;
          const lineCapexCodes = diagnostics.entries
            .filter((e) => ["CAPEX_PROPOSED", "CAPEX_DEFERRED", "CAPEX_DEFERRED_OVERSUPPLY", "LIFECYCLE_GROWTH_PURSUED", "VAP_GROWTH_ENTRY"].includes(e.code))
            .map((e) => e.code)
            .join("|");

          rows.push({
            scenario,
            seed,
            companyId,
            turn,
            outstandingTotalTons,
            overdueTotalTons,
            healthyForwardTotalTons: outstandingTotalTons - overdueTotalTons,
            outstandingByProduct,
            overdueByProduct,
            avgUnitPriceOverdue: overdueTonsSum > 1e-6 ? overdueValueSum / overdueTonsSum : null,
            avgUnitPriceForward: forwardTonsSum > 1e-6 ? forwardValueSum / forwardTonsSum : null,
            onTimeDeliveryRate: null, // filled after advance
            productionRequirementByProduct,
            actualProductionByProduct: { hoso: 0, pd: 0, vap: 0 }, // filled after advance
            effectiveCapacityByProduct,
            utilizationByProduct: { hoso: 0, pd: 0, vap: 0 }, // filled after advance
            commonProcessingCapacity,
            commonProcessingUtilization: 0, // filled after advance
            regularWorkers: (decision.workerAssignments ?? []).filter((w) => w.companyId === companyId).reduce((s, w) => s + Number(w.regularHeadcount), 0),
            laborShortfall: 0, // filled after advance
            forwardCapacityGapTons: assessment?.forwardCapacityGap?.forwardCapacityGapTons ?? null,
            forwardCapacityGapRatio: assessment?.forwardCapacityGap?.forwardCapacityGapRatio ?? null,
            forecastCompletionTurn: assessment?.forwardCapacityGap?.forecastCompletionTurn ?? null,
            newFactoryStatus: assessment?.status ?? null,
            lineCapexCodes,
            cashUsd: Number(ownState.financeState.cash),
            severeDistress: false, // filled after advance
          });
        }

        const outcome = advanceSimulationTurn(session, AT);
        if (!outcome.advanced) {
          console.error(`  FAILED to advance ${scenario}/${seed} at turn ${turn}: ${outcome.error}`);
          break;
        }
        session = outcome.session;
        const record = session.state.history[session.state.history.length - 1];

        for (const companyId of TARGET_COMPANIES) {
          // このturnでTARGET_COMPANIES順に3行pushした直後なので、末尾3行の中から該当会社のindexを引く。
          const row = rows[rows.length - TARGET_COMPANIES.length + TARGET_COMPANIES.indexOf(companyId)];
          if (!row || row.turn !== turn || row.companyId !== companyId) continue;
          const summary = record.companySummaries.find((s) => s.companyId === companyId);
          row.onTimeDeliveryRate = summary?.onTimeDeliveryRate ?? null;
          row.actualProductionByProduct = {
            hoso: Number(summary?.hosoProduced ?? 0),
            pd: Number(summary?.pdProduced ?? 0),
            vap: Number(summary?.vapProduced ?? 0),
          };
          for (const p of PRODUCTS) {
            const cap = row.effectiveCapacityByProduct[p];
            row.utilizationByProduct[p] = cap > 1e-6 ? row.actualProductionByProduct[p] / cap : 0;
          }
          const totalActual = row.actualProductionByProduct.hoso + row.actualProductionByProduct.pd + row.actualProductionByProduct.vap;
          row.commonProcessingUtilization = row.commonProcessingCapacity > 1e-6 ? totalActual / row.commonProcessingCapacity : 0;
          row.laborShortfall = Number(summary?.laborShortfall ?? 0);
          const strategyTurn = session.packCompanyTurns.find((c) => c.companyId === companyId && c.turn === turn);
          row.severeDistress = strategyTurn?.strategy.crisis?.state === "SEVERE_DISTRESS";
        }
      }
    }
  }

  // --- CSV ---
  writeCsv(
    path.join(outDir, "pc2_backlog_product_turns.csv"),
    [
      "scenario", "seed", "companyId", "turn",
      "outstandingTotalTons", "overdueTotalTons", "healthyForwardTotalTons",
      "outstanding_hoso", "outstanding_pd", "outstanding_vap",
      "overdue_hoso", "overdue_pd", "overdue_vap",
      "avgUnitPriceOverdue", "avgUnitPriceForward", "onTimeDeliveryRate",
      "productionRequirement_hoso", "productionRequirement_pd", "productionRequirement_vap",
      "actualProduction_hoso", "actualProduction_pd", "actualProduction_vap",
      "effectiveCapacity_hoso", "effectiveCapacity_pd", "effectiveCapacity_vap",
      "utilization_hoso", "utilization_pd", "utilization_vap",
      "commonProcessingCapacity", "commonProcessingUtilization",
      "regularWorkers", "laborShortfall",
      "forwardCapacityGapTons", "forwardCapacityGapRatio", "forecastCompletionTurn",
      "newFactoryStatus", "lineCapexCodes", "cashUsd", "severeDistress",
    ],
    rows.map((r) => [
      r.scenario, r.seed, r.companyId, r.turn,
      r.outstandingTotalTons, r.overdueTotalTons, r.healthyForwardTotalTons,
      r.outstandingByProduct.hoso, r.outstandingByProduct.pd, r.outstandingByProduct.vap,
      r.overdueByProduct.hoso, r.overdueByProduct.pd, r.overdueByProduct.vap,
      r.avgUnitPriceOverdue ?? -1, r.avgUnitPriceForward ?? -1, r.onTimeDeliveryRate ?? -1,
      r.productionRequirementByProduct.hoso, r.productionRequirementByProduct.pd, r.productionRequirementByProduct.vap,
      r.actualProductionByProduct.hoso, r.actualProductionByProduct.pd, r.actualProductionByProduct.vap,
      r.effectiveCapacityByProduct.hoso, r.effectiveCapacityByProduct.pd, r.effectiveCapacityByProduct.vap,
      r.utilizationByProduct.hoso, r.utilizationByProduct.pd, r.utilizationByProduct.vap,
      r.commonProcessingCapacity, r.commonProcessingUtilization,
      r.regularWorkers, r.laborShortfall,
      r.forwardCapacityGapTons ?? -1, r.forwardCapacityGapRatio ?? -1, r.forecastCompletionTurn ?? -1,
      r.newFactoryStatus ?? "", r.lineCapexCodes, r.cashUsd, r.severeDistress,
    ])
  );

  // --- Summary markdown ---
  const lines: string[] = [];
  lines.push("# Standard AI Investment Portfolio Calibration — Phase PC-2C Product-Level Backlog Diagnosis");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 32Q x 3 companies (JPQ/CONSV/VAP), PROFILE ON. ${rows.length} turn observations. parameter変更なし（監査のみ）。`);
  lines.push("");
  lines.push("## Healthy Forward vs Overdue Backlog（全期間平均、指示補正への対応）");
  lines.push("");
  lines.push("| Company | avg outstanding (t) | avg overdue (t) | avg healthy forward (t) | overdue share | avg on-time delivery |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c);
    const avgOutstanding = mean(cRows.map((r) => r.outstandingTotalTons));
    const avgOverdue = mean(cRows.map((r) => r.overdueTotalTons));
    const avgForward = mean(cRows.map((r) => r.healthyForwardTotalTons));
    const onTimeRows = cRows.filter((r) => r.onTimeDeliveryRate !== null);
    lines.push(
      `| ${c} | ${avgOutstanding.toFixed(0)} | ${avgOverdue.toFixed(0)} | ${avgForward.toFixed(0)} | ${avgOutstanding > 1e-6 ? ((avgOverdue / avgOutstanding) * 100).toFixed(1) : "n/a"}% | ${
        onTimeRows.length > 0 ? mean(onTimeRows.map((r) => r.onTimeDeliveryRate ?? 0)).toFixed(1) : "n/a"
      }% |`
    );
  }
  lines.push("");
  lines.push("## Product-level utilization & requirement/capacity ratio（全期間平均）");
  lines.push("");
  lines.push("| Company | Product | avg utilization | avg requirement/capacity | avg overdue backlog by product (t) |");
  lines.push("|---|---|---|---|---|");
  for (const c of TARGET_COMPANIES) {
    for (const p of PRODUCTS) {
      const cRows = rows.filter((r) => r.companyId === c);
      const avgUtil = mean(cRows.map((r) => r.utilizationByProduct[p]));
      const avgReqCapRatio = mean(
        cRows.filter((r) => r.effectiveCapacityByProduct[p] > 1e-6).map((r) => r.productionRequirementByProduct[p] / r.effectiveCapacityByProduct[p])
      );
      const avgOverdueProduct = mean(cRows.map((r) => r.overdueByProduct[p]));
      lines.push(`| ${c} | ${p.toUpperCase()} | ${(avgUtil * 100).toFixed(1)}% | ${avgReqCapRatio.toFixed(2)} | ${avgOverdueProduct.toFixed(0)} |`);
    }
  }
  lines.push("");
  lines.push("## Common Processing role（全期間平均）");
  lines.push("");
  lines.push("| Company | avg Common Processing utilization |");
  lines.push("|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c);
    lines.push(`| ${c} | ${(mean(cRows.map((r) => r.commonProcessingUtilization)) * 100).toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("## Labor role（全期間平均）");
  lines.push("");
  lines.push("| Company | avg regular workers | avg labor shortfall |");
  lines.push("|---|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c);
    lines.push(`| ${c} | ${mean(cRows.map((r) => r.regularWorkers)).toFixed(0)} | ${mean(cRows.map((r) => r.laborShortfall)).toFixed(1)} |`);
  }
  lines.push("");
  lines.push("## Forward Capacity Gap at completion horizon（既存newFactoryAssessment.forwardCapacityGap、全期間平均・評価対象四半期のみ）");
  lines.push("");
  lines.push(
    "【重要・監査で確認した既存アーキテクチャ上の制約】decision/newFactory.tsのforwardCapacityGapは、" +
      "strategicPosture===\"AGGRESSIVE_EARLY_CAPACITY\"の会社に対してのみ計算される（既存コード仕様、" +
      "本フェーズでは変更禁止）。JPQ/CONSV/VAPは既定のPostureで稼働しているため、以下の集計は" +
      "「評価対象四半期0件」になる（バグではなく、既存設計どおりの結果）。したがって本フェーズでは" +
      "completion-horizonの真のForward Capacity Gapではなく、上記の「Product-level requirement/capacity比」を" +
      "代替のproxyシグナルとして用いる（新しい効果値は作らず、既存の観測値の比率として提示するのみ）。"
  );
  lines.push("");
  lines.push("| Company | n turns evaluated | avg forwardCapacityGapTons | avg forwardCapacityGapRatio | newFactoryStatus distribution |");
  lines.push("|---|---|---|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c && r.forwardCapacityGapTons !== null);
    const allRows = rows.filter((r) => r.companyId === c);
    const dist: Record<string, number> = {};
    for (const r of allRows) {
      const k = r.newFactoryStatus ?? "(none)";
      dist[k] = (dist[k] ?? 0) + 1;
    }
    const distStr = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    lines.push(
      `| ${c} | ${cRows.length} | ${mean(cRows.map((r) => r.forwardCapacityGapTons ?? 0)).toFixed(0)} | ${mean(cRows.map((r) => r.forwardCapacityGapRatio ?? 0)).toFixed(
        2
      )} | ${distStr} |`
    );
  }
  lines.push("");
  lines.push("## Line CAPEX role（全期間、code出現数）");
  lines.push("");
  lines.push("| Company | code distribution |");
  lines.push("|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c);
    const dist: Record<string, number> = {};
    for (const r of cRows) {
      for (const code of r.lineCapexCodes.split("|").filter(Boolean)) dist[code] = (dist[code] ?? 0) + 1;
    }
    lines.push(`| ${c} | ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")} |`);
  }
  lines.push("");
  lines.push("## Delivery economics: overdue vs forward backlog unit price（既存SalesContract.unitPriceのみ使用、架空計算なし）");
  lines.push("");
  lines.push("| Company | avg unit price (overdue backlog) | avg unit price (forward backlog) |");
  lines.push("|---|---|---|");
  for (const c of TARGET_COMPANIES) {
    const cRows = rows.filter((r) => r.companyId === c);
    const overdueRows = cRows.filter((r) => r.avgUnitPriceOverdue !== null);
    const forwardRows = cRows.filter((r) => r.avgUnitPriceForward !== null);
    lines.push(
      `| ${c} | ${overdueRows.length > 0 ? mean(overdueRows.map((r) => r.avgUnitPriceOverdue ?? 0)).toFixed(3) : "n/a"} | ${
        forwardRows.length > 0 ? mean(forwardRows.map((r) => r.avgUnitPriceForward ?? 0)).toFixed(3) : "n/a"
      } |`
    );
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pc2_backlog_product_diagnosis.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${rows.length} turn rows to ${outDir}`);
}

main2();
