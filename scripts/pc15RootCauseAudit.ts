// Standard AI Investment Portfolio Calibration — Phase PC-1.5 Root Cause Audit
//
// 【指示§2】audit専用スクリプト。parameter・game behaviorは一切変更しない。
// generateStandardAiDecisionWithDiagnostics（既存の純粋関数）を、engine.ts
// advanceSimulationTurnの内部呼び出しと全く同じ入力（fixture/ownState/publicInfo/
// period/turn/effectiveParams/visionOverrides）で「もう一度」呼ぶだけであり
// （SP-Q1のbaselineDecision二重評価と同じ既存パターン）、ゲーム状態・他四半期への
// 影響はゼロ。VAP Development tierの「各tier個別pass/fail」（指示§3-4）は、
// decision/vapProductDevelopment.tsのformulaをコード上一切変更せず、監査
// スクリプト側でのみ同じ式を再現して計算する（CE-3AのTrust attribution監査と
// 同じ手法）。
//
// 出力:
//   docs/standard_ai/benchmarks/pc15_vap_tier_audit.md
//   docs/standard_ai/benchmarks/pc15_vap_tier.csv
//   docs/standard_ai/benchmarks/pc15_mass_pd_mech_audit.md
//   docs/standard_ai/benchmarks/pc15_mass_pd_mech.csv
//   docs/standard_ai/benchmarks/pc15_sustained_backlog_audit.md
//   docs/standard_ai/benchmarks/pc15_sustained_backlog_turns.csv
//   docs/standard_ai/benchmarks/pc15_root_cause_summary.md
//
// 使い方: npx tsx scripts/pc15RootCauseAudit.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../app/lib/v2/companyLab/standardAi/orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../app/lib/v2/companyLab/productDevelopmentState";
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
const BACKLOG_SUSTAINED_THRESHOLD_QUARTERS = 8;

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
const EPSILON = 1e-6;

interface VapTierRow {
  scenario: string;
  seed: string;
  companyId: string;
  turn: number;
  currentScore: number;
  vapProductionTons: number;
  vapUtilization: number;
  vapContributionMarginUsdPerHosoEqKg: number;
  currentQuarterlyVapContributionUsd: number;
  strategyFitMultiplier: number;
  financialConservatismRatio: number;
  effectiveMaxAffordabilityQuarters: number;
  pass100k: boolean;
  pass250k: boolean;
  pass500k: boolean;
  cashUsd: number;
  requiredCash500k: number;
  financeSafe500k: boolean;
  selectedTierActual: number;
  selectedTierReproduced: number;
  reproductionMatches: boolean;
}

interface MassPdMechRow {
  scenario: string;
  seed: string;
  turn: number;
  factoryId: string;
  code: string;
  factoryPdUtilization: number | null;
  paybackQuarters: number | null;
  effectiveMaxPaybackQuarters: number | null;
  financeGateCashSafe: number | null;
  proposedThisTurn: boolean;
  completedEventThisTurn: boolean;
}

interface BacklogTurnRow {
  scenario: string;
  seed: string;
  companyId: string;
  periodId: string;
  turn: number;
  newContractedQuantity: number;
  productionRequirement: number | null;
  actualProduction: number;
  effectiveCapacityTotal: number;
  avgFactoryUtilization: number;
  regularWorkers: number;
  laborShortfall: number;
  rawMaterialShortfall: number;
  overdueQuantity: number;
  onTimeDeliveryRate: number | null;
  cashUsd: number;
  debtUsd: number;
  forwardCapacityGapTons: number | null;
  forwardCapacityGapRatio: number | null;
  newFactoryStatus: string | null;
  lineCapexCodes: string;
}

function main2(): void {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const vapRows: VapTierRow[] = [];
  const massPdRows: MassPdMechRow[] = [];
  // companyId -> scenario/seed key -> turn -> overdueQuantity (for backlog period detection)
  const backlogTracking: Record<string, Map<string, { turn: number; overdue: number }[]>> = { JPQ: new Map(), CONSV: new Map(), VAP: new Map() };
  const backlogFullTrace: Record<string, Map<string, BacklogTurnRow[]>> = { JPQ: new Map(), CONSV: new Map(), VAP: new Map() };

  let massConsideredCount = 0;
  let massCandidateCount = 0;
  let massFinancePassCount = 0;
  let massCompletedCount = 0;
  const massFirstBlockerCounts: Record<string, number> = {};

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`  Running ${scenario}/${seed}...`);
      let session = createSimulationSession({
        simulationRunId: `pc15-${scenario}-${seed}`,
        scenarioId: scenario,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt: AT,
        standardAiProfileMode: "ON",
      });
      const runKey = `${scenario}/${seed}`;
      for (const c of COMPANIES) {
        if (backlogTracking[c]) backlogTracking[c].set(runKey, []);
        if (backlogFullTrace[c]) backlogFullTrace[c].set(runKey, []);
      }

      for (let i = 0; i < MANAGEMENT_CONSOLE_STANDARD_TURNS; i++) {
        const turn = session.state.scenarioState.currentTurn;
        const publicInfo = buildPublicMarketInfo(session.state);

        for (const companyId of COMPANIES) {
          const fixture = session.fixtures.find((f) => f.companyId === companyId)!;
          const ownState = buildCompanyOwnState(session.state, fixture);
          const profileResolution = resolveStandardAiProfileForMode(companyId, session.state.config.standardAiProfileMode);
          const { diagnostics } = generateStandardAiDecisionWithDiagnostics(
            fixture,
            ownState,
            publicInfo,
            session.state.currentPeriod,
            turn,
            profileResolution.params,
            undefined,
            session.state.config.visionOverrides
          );
          const params = profileResolution.params;

          // --- Part A: VAP Development tier reproduction (all companies) ---
          const vapDevEntries = diagnostics.entries.filter((e) => e.code.startsWith("VAP_DEV_"));
          if (vapDevEntries.length > 0) {
            const considered = vapDevEntries.find((e) => e.code === "VAP_DEV_CONSIDERED");
            const proposed = vapDevEntries.find((e) => e.code === "VAP_DEV_PROPOSED");
            if (considered?.keyValues) {
              const vapProductionTons = considered.keyValues.vapProductionTons ?? 0;
              const vapUtilization = considered.keyValues.vapUtilization ?? 0;
              const currentScore = considered.keyValues.currentDevelopmentScore ?? 0;
              // 【監査専用の再現計算・decision/vapProductDevelopment.tsのformulaを一切変更せず、
              // 同じ式をここで独立に評価する】
              const vapContributionMarginUsdPerHosoEqKg = fixture.productEconomics.premiumEconomics.vap.targetMarginUsdPerHosoEqKg;
              const currentQuarterlyVapContributionUsd = vapProductionTons * 1000 * vapContributionMarginUsdPerHosoEqKg;
              const financialConservatismRatio = params.capexCurrentShortfallRatioThreshold / STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;
              const productOrientationHoso = params.productOrientationMultipliers.hoso ?? 1;
              const productOrientationVap = params.productOrientationMultipliers.vap ?? 1;
              const strategyFitMultiplier = productOrientationHoso > EPSILON ? productOrientationVap / productOrientationHoso : 1;
              const effectiveMaxAffordabilityQuarters =
                financialConservatismRatio > EPSILON
                  ? (params.vapProductDevelopmentMaxAffordabilityQuarters * strategyFitMultiplier) / financialConservatismRatio
                  : params.vapProductDevelopmentMaxAffordabilityQuarters;
              const passAffordability = (tierUsd: number) =>
                currentQuarterlyVapContributionUsd > EPSILON ? tierUsd / currentQuarterlyVapContributionUsd <= effectiveMaxAffordabilityQuarters : false;
              const cashUsd = Number(ownState.financeState.cash);
              const targetMinimumCashUsd = 0; // pressuresから取得できないためcash比較は500kのみ概算で出す
              const requiredCash500k = VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD[3] * (1 + params.capexCostSafetyRatio);
              const financeSafe500k = cashUsd > requiredCash500k;

              const pass100k = passAffordability(100_000);
              const pass250k = passAffordability(250_000);
              const pass500k = passAffordability(500_000);
              const reproducedTier = pass500k ? 500_000 : pass250k ? 250_000 : pass100k ? 100_000 : 0;
              const actualTier = proposed?.keyValues?.investmentCostUsd ?? 0;

              vapRows.push({
                scenario,
                seed,
                companyId,
                turn,
                currentScore,
                vapProductionTons,
                vapUtilization,
                vapContributionMarginUsdPerHosoEqKg,
                currentQuarterlyVapContributionUsd,
                strategyFitMultiplier,
                financialConservatismRatio,
                effectiveMaxAffordabilityQuarters,
                pass100k,
                pass250k,
                pass500k,
                cashUsd,
                requiredCash500k,
                financeSafe500k,
                selectedTierActual: actualTier,
                selectedTierReproduced: reproducedTier,
                // financeSafeForSpendの実際の判定はborrowingPressure等も見るため、affordabilityのみ一致すれば十分な近似一致とみなす
                reproductionMatches: Math.abs(actualTier - reproducedTier) < 1 || (actualTier > 0 && reproducedTier > 0 && actualTier <= reproducedTier),
              });
              void targetMinimumCashUsd;
            }
          }

          // --- Part B: MASS PD Mechanization ---
          if (companyId === "MASS") {
            const pdMechEntries = diagnostics.entries.filter((e) => e.code.startsWith("PD_MECH_"));
            const proposedThisTurn = pdMechEntries.some((e) => e.code === "PD_MECH_PROPOSED");
            for (const e of pdMechEntries) {
              if (e.code === "PD_MECH_CONSIDERED") massConsideredCount++;
              if (e.code === "PD_MECH_PROPOSED") massCandidateCount++;
              if (e.code === "PD_MECH_PAYBACK_UNATTRACTIVE") {
                massFirstBlockerCounts["PAYBACK"] = (massFirstBlockerCounts["PAYBACK"] ?? 0) + 1;
              }
              if (e.code === "PD_MECH_LOW_UTILIZATION") {
                massFirstBlockerCounts["LOW_UTILIZATION"] = (massFirstBlockerCounts["LOW_UTILIZATION"] ?? 0) + 1;
              }
              if (e.code === "PD_MECH_FINANCE_BLOCKED") {
                massFirstBlockerCounts["FINANCE"] = (massFirstBlockerCounts["FINANCE"] ?? 0) + 1;
                massFinancePassCount++; // financeブロックされた=candidateまでは到達(economics通過)
              }
              if (e.code === "PD_MECH_ALREADY_ACTIVE") {
                massFirstBlockerCounts["DUPLICATE"] = (massFirstBlockerCounts["DUPLICATE"] ?? 0) + 1;
              }
              if (e.code === "PD_MECH_PROPOSED") massFinancePassCount++;
              massPdRows.push({
                scenario,
                seed,
                turn,
                factoryId: e.targetFactoryId ?? "",
                code: e.code,
                factoryPdUtilization: e.keyValues?.factoryPdUtilization ?? null,
                paybackQuarters: e.keyValues?.paybackQuarters ?? null,
                effectiveMaxPaybackQuarters: e.keyValues?.effectiveMaxPaybackQuarters ?? null,
                financeGateCashSafe: e.keyValues?.financialGateCashSafe ?? null,
                proposedThisTurn,
                completedEventThisTurn: false,
              });
            }
            if (pdMechEntries.length === 0) {
              massFirstBlockerCounts["NO_FACTORY_OBSERVED"] = (massFirstBlockerCounts["NO_FACTORY_OBSERVED"] ?? 0) + 1;
            }
          }

          // --- Part C: backlog tracking for JPQ/CONSV/VAP ---
          if (backlogTracking[companyId]) {
            // このターンのcompanySummary等は、まだadvanceしていないため前ターンの確定値のみ
            // （後段でrecord.companySummariesから確定値を追加する。ここではCAPEX/NewFactory
            // 診断だけをターンごとに保持しておく）。
            const capexAssessment = (diagnostics as unknown as { newFactoryAssessment?: unknown }).newFactoryAssessment as
              | {
                  status: string;
                  forwardCapacityGap: { forwardCapacityGapTons: number; forwardCapacityGapRatio: number } | null;
                }
              | undefined;
            const lineCapexCodes = diagnostics.entries
              .filter((e) => ["CAPEX_PROPOSED", "CAPEX_DEFERRED", "CAPEX_DEFERRED_OVERSUPPLY", "LIFECYCLE_GROWTH_PURSUED", "VAP_GROWTH_ENTRY"].includes(e.code))
              .map((e) => e.code)
              .join("|");
            const trace = backlogFullTrace[companyId].get(runKey)!;
            trace.push({
              scenario,
              seed,
              companyId,
              periodId: "",
              turn,
              newContractedQuantity: 0,
              productionRequirement: diagnostics.currentPeriodDeliveryDemand
                ? diagnostics.currentPeriodDeliveryDemand.byProduct.hoso +
                  diagnostics.currentPeriodDeliveryDemand.byProduct.pd +
                  diagnostics.currentPeriodDeliveryDemand.byProduct.vap
                : null,
              actualProduction: 0,
              effectiveCapacityTotal: ownState.effectiveFactories.reduce(
                (s: number, f) => s + unwrapUnit(f.hosoCapacity) + unwrapUnit(f.pdCapacity) + unwrapUnit(f.vapCapacity),
                0
              ),
              avgFactoryUtilization: 0,
              regularWorkers: 0,
              laborShortfall: 0,
              rawMaterialShortfall: 0,
              overdueQuantity: 0,
              onTimeDeliveryRate: null,
              cashUsd: Number(ownState.financeState.cash),
              debtUsd: 0,
              forwardCapacityGapTons: capexAssessment?.forwardCapacityGap?.forwardCapacityGapTons ?? null,
              forwardCapacityGapRatio: capexAssessment?.forwardCapacityGap?.forwardCapacityGapRatio ?? null,
              newFactoryStatus: capexAssessment?.status ?? null,
              lineCapexCodes,
            });
          }
        }

        const outcome = advanceSimulationTurn(session, AT);
        if (!outcome.advanced) {
          console.error(`  FAILED to advance ${scenario}/${seed} at turn ${turn}: ${outcome.error}`);
          break;
        }
        session = outcome.session;
        const record = session.state.history[session.state.history.length - 1];

        for (const companyId of Object.keys(backlogTracking)) {
          const summary = record.companySummaries.find((s) => s.companyId === companyId);
          const financialResult = record.financialResults.find((f) => f.companyId === companyId);
          const decision = record.decisions.find((d) => d.companyId === companyId);
          const overdue = Number(summary?.overdueQuantity ?? 0);
          backlogTracking[companyId].get(runKey)!.push({ turn, overdue });
          const trace = backlogFullTrace[companyId].get(runKey)!;
          const row = trace[trace.length - 1];
          if (row && row.turn === turn) {
            row.newContractedQuantity = Number(summary?.newContractedQuantity ?? 0);
            row.actualProduction = Number(summary?.hosoProduced ?? 0) + Number(summary?.pdProduced ?? 0) + Number(summary?.vapProduced ?? 0);
            row.avgFactoryUtilization = Number(summary?.equipmentUtilizationRate ?? 0);
            row.regularWorkers = (decision?.workerAssignments ?? []).filter((w) => w.companyId === companyId).reduce((s, w) => s + Number(w.regularHeadcount), 0);
            row.laborShortfall = Number(summary?.laborShortfall ?? 0);
            row.rawMaterialShortfall = Number(summary?.rawMaterialShortfall ?? 0);
            row.overdueQuantity = overdue;
            row.onTimeDeliveryRate = summary?.onTimeDeliveryRate ?? null;
            row.cashUsd = financialResult ? Number(financialResult.balanceSheet.cash) : row.cashUsd;
            row.debtUsd = financialResult ? Number(financialResult.balanceSheet.shortTermLoans) + Number(financialResult.balanceSheet.longTermLoans) : 0;
          }
        }
        for (const e of record.capexResults.find((c) => c.companyId === "MASS")?.events ?? []) {
          if (e.projectType === "pdMechanization") {
            massCompletedCount += e.statusAfter === "completed" && e.statusBefore !== "completed" ? 1 : 0;
            const last = massPdRows[massPdRows.length - 1];
            if (last && last.turn === turn) last.completedEventThisTurn = true;
          }
        }
      }
    }
  }

  // --- Identify sustained backlog periods (>=8 consecutive quarters with overdue > 0) ---
  interface BacklogPeriod {
    companyId: string;
    scenario: string;
    seed: string;
    startTurn: number;
    endTurn: number;
    lengthQuarters: number;
  }
  const periods: BacklogPeriod[] = [];
  for (const companyId of Object.keys(backlogTracking)) {
    for (const [runKey, series] of backlogTracking[companyId]) {
      const [scenario, seed] = runKey.split("/");
      let start: number | null = null;
      let prevTurn: number | null = null;
      for (const point of series) {
        if (point.overdue > EPSILON) {
          if (start === null) start = point.turn;
          prevTurn = point.turn;
        } else {
          if (start !== null && prevTurn !== null && prevTurn - start + 1 >= BACKLOG_SUSTAINED_THRESHOLD_QUARTERS) {
            periods.push({ companyId, scenario, seed, startTurn: start, endTurn: prevTurn, lengthQuarters: prevTurn - start + 1 });
          }
          start = null;
          prevTurn = null;
        }
      }
      if (start !== null && prevTurn !== null && prevTurn - start + 1 >= BACKLOG_SUSTAINED_THRESHOLD_QUARTERS) {
        periods.push({ companyId, scenario, seed, startTurn: start, endTurn: prevTurn, lengthQuarters: prevTurn - start + 1 });
      }
    }
  }

  // --- Build backlog turn CSV rows: only turns within an identified period (bounded output) ---
  const backlogTurnRows: BacklogTurnRow[] = [];
  for (const period of periods) {
    const runKey = `${period.scenario}/${period.seed}`;
    const trace = backlogFullTrace[period.companyId]?.get(runKey) ?? [];
    for (const row of trace) {
      if (row.turn >= period.startTurn && row.turn <= period.endTurn) {
        backlogTurnRows.push({ ...row, periodId: `${period.companyId}-${period.scenario}-${period.seed}-${period.startTurn}-${period.endTurn}` });
      }
    }
  }

  // --- Write CSVs ---
  writeCsv(
    path.join(outDir, "pc15_vap_tier.csv"),
    [
      "scenario", "seed", "companyId", "turn", "currentScore", "vapProductionTons", "vapUtilization",
      "vapContributionMarginUsdPerHosoEqKg", "currentQuarterlyVapContributionUsd", "strategyFitMultiplier",
      "financialConservatismRatio", "effectiveMaxAffordabilityQuarters", "pass100k", "pass250k", "pass500k",
      "cashUsd", "requiredCash500k", "financeSafe500k", "selectedTierActual", "selectedTierReproduced", "reproductionMatches",
    ],
    vapRows.map((r) => [
      r.scenario, r.seed, r.companyId, r.turn, r.currentScore, r.vapProductionTons, r.vapUtilization,
      r.vapContributionMarginUsdPerHosoEqKg, r.currentQuarterlyVapContributionUsd, r.strategyFitMultiplier,
      r.financialConservatismRatio, r.effectiveMaxAffordabilityQuarters, r.pass100k, r.pass250k, r.pass500k,
      r.cashUsd, r.requiredCash500k, r.financeSafe500k, r.selectedTierActual, r.selectedTierReproduced, r.reproductionMatches,
    ])
  );
  writeCsv(
    path.join(outDir, "pc15_mass_pd_mech.csv"),
    ["scenario", "seed", "turn", "factoryId", "code", "factoryPdUtilization", "paybackQuarters", "effectiveMaxPaybackQuarters", "financeGateCashSafe", "proposedThisTurn", "completedEventThisTurn"],
    massPdRows.map((r) => [
      r.scenario, r.seed, r.turn, r.factoryId, r.code, r.factoryPdUtilization ?? -1, r.paybackQuarters ?? -1, r.effectiveMaxPaybackQuarters ?? -1,
      r.financeGateCashSafe ?? -1, r.proposedThisTurn, r.completedEventThisTurn,
    ])
  );
  writeCsv(
    path.join(outDir, "pc15_sustained_backlog_turns.csv"),
    [
      "periodId", "scenario", "seed", "companyId", "turn", "newContractedQuantity", "productionRequirement", "actualProduction",
      "effectiveCapacityTotal", "avgFactoryUtilization", "regularWorkers", "laborShortfall", "rawMaterialShortfall",
      "overdueQuantity", "onTimeDeliveryRate", "cashUsd", "debtUsd", "forwardCapacityGapTons", "forwardCapacityGapRatio", "newFactoryStatus", "lineCapexCodes",
    ],
    backlogTurnRows.map((r) => [
      r.periodId, r.scenario, r.seed, r.companyId, r.turn, r.newContractedQuantity, r.productionRequirement ?? -1, r.actualProduction,
      r.effectiveCapacityTotal, r.avgFactoryUtilization, r.regularWorkers, r.laborShortfall, r.rawMaterialShortfall,
      r.overdueQuantity, r.onTimeDeliveryRate ?? -1, r.cashUsd, r.debtUsd, r.forwardCapacityGapTons ?? -1, r.forwardCapacityGapRatio ?? -1, r.newFactoryStatus ?? "", r.lineCapexCodes,
    ])
  );

  // --- Summary markdowns ---
  const vapLines: string[] = [];
  vapLines.push("# PC-1.5 — VAP Product Development Tier Audit");
  vapLines.push("");
  vapLines.push(`5 scenarios x 5 seeds x 5 companies x 32Q, PROFILE ON. ${vapRows.length} quarter-observations (VAP_DEV_CONSIDERED発火時のみ)。`);
  vapLines.push("");
  vapLines.push("## Tier pass/fail distribution by company (affordability gate only, finance gate separate)");
  vapLines.push("");
  vapLines.push("| Company | n | pass500k% | pass250k-only% | pass100k-only% | pass none % |");
  vapLines.push("|---|---|---|---|---|---|");
  for (const c of COMPANIES) {
    const rows = vapRows.filter((r) => r.companyId === c);
    const n = rows.length;
    const p500 = rows.filter((r) => r.pass500k).length;
    const p250only = rows.filter((r) => !r.pass500k && r.pass250k).length;
    const p100only = rows.filter((r) => !r.pass500k && !r.pass250k && r.pass100k).length;
    const pnone = rows.filter((r) => !r.pass100k).length;
    vapLines.push(`| ${c} | ${n} | ${n > 0 ? ((p500 / n) * 100).toFixed(1) : "n/a"}% | ${n > 0 ? ((p250only / n) * 100).toFixed(1) : "n/a"}% | ${n > 0 ? ((p100only / n) * 100).toFixed(1) : "n/a"}% | ${n > 0 ? ((pnone / n) * 100).toFixed(1) : "n/a"}% |`);
  }
  vapLines.push("");
  vapLines.push("## Reproduction fidelity (audit formula vs actual selected tier)");
  vapLines.push("");
  const matchCount = vapRows.filter((r) => r.reproductionMatches).length;
  vapLines.push(`${matchCount} / ${vapRows.length} (${vapRows.length > 0 ? ((matchCount / vapRows.length) * 100).toFixed(1) : "n/a"}%) 一致（affordability再現式のみで再構成、financeSafeForSpendのborrowingPressure項は近似のため完全一致ではない）。`);
  vapLines.push("");
  fs.writeFileSync(path.join(outDir, "pc15_vap_tier_audit.md"), vapLines.join("\n") + "\n", "utf8");

  const massLines: string[] = [];
  massLines.push("# PC-1.5 — MASS PD Mechanization Audit");
  massLines.push("");
  massLines.push(`5 scenarios x 5 seeds x 32Q, PROFILE ON. MASSの全PD_MECH_*診断エントリ ${massPdRows.length}件を集計。`);
  massLines.push("");
  massLines.push(`- considered count (PD_MECH_CONSIDERED発火数): ${massConsideredCount}`);
  massLines.push(`- candidate/proposed count (PD_MECH_PROPOSED発火数): ${massCandidateCount}`);
  massLines.push(`- finance-pass or proposed count: ${massFinancePassCount}`);
  massLines.push(`- completed count (実際にCAPEX engineでcompleted遷移): ${massCompletedCount}`);
  massLines.push("");
  massLines.push("## First blocker distribution");
  massLines.push("");
  massLines.push("| Blocker | Count | Share |");
  massLines.push("|---|---|---|");
  const totalBlockers = Object.values(massFirstBlockerCounts).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(massFirstBlockerCounts).sort((a, b) => b[1] - a[1])) {
    massLines.push(`| ${k} | ${v} | ${totalBlockers > 0 ? ((v / totalBlockers) * 100).toFixed(1) : "n/a"}% |`);
  }
  massLines.push("");
  fs.writeFileSync(path.join(outDir, "pc15_mass_pd_mech_audit.md"), massLines.join("\n") + "\n", "utf8");

  const backlogLines: string[] = [];
  backlogLines.push("# PC-1.5 — Sustained Backlog Root Cause Audit (JPQ/CONSV/VAP)");
  backlogLines.push("");
  backlogLines.push(`8四半期以上連続でoverdueQuantity>0だった期間を抽出: ${periods.length}件（5 scenarios x 5 seeds x 3 companies対象）。`);
  backlogLines.push("");
  backlogLines.push("## Periods found");
  backlogLines.push("");
  backlogLines.push("| Company | Scenario | Seed | Start | End | Length (Q) |");
  backlogLines.push("|---|---|---|---|---|---|");
  for (const p of periods.sort((a, b) => b.lengthQuarters - a.lengthQuarters)) {
    backlogLines.push(`| ${p.companyId} | ${p.scenario} | ${p.seed} | ${p.startTurn} | ${p.endTurn} | ${p.lengthQuarters} |`);
  }
  backlogLines.push("");
  backlogLines.push("## New Factory status during backlog periods (by company)");
  backlogLines.push("");
  backlogLines.push("| Company | n turns | newFactoryStatus distribution |");
  backlogLines.push("|---|---|---|");
  for (const c of ["JPQ", "CONSV", "VAP"]) {
    const rows = backlogTurnRows.filter((r) => r.companyId === c);
    const dist: Record<string, number> = {};
    for (const r of rows) {
      const k = r.newFactoryStatus ?? "(none)";
      dist[k] = (dist[k] ?? 0) + 1;
    }
    const distStr = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    backlogLines.push(`| ${c} | ${rows.length} | ${distStr} |`);
  }
  backlogLines.push("");
  backlogLines.push("## Line CAPEX diagnostic codes during backlog periods (by company)");
  backlogLines.push("");
  backlogLines.push("| Company | code distribution |");
  backlogLines.push("|---|---|");
  for (const c of ["JPQ", "CONSV", "VAP"]) {
    const rows = backlogTurnRows.filter((r) => r.companyId === c);
    const dist: Record<string, number> = {};
    for (const r of rows) {
      for (const code of r.lineCapexCodes.split("|").filter(Boolean)) dist[code] = (dist[code] ?? 0) + 1;
      if (!r.lineCapexCodes) dist["(no line capex diagnostic this turn)"] = (dist["(no line capex diagnostic this turn)"] ?? 0) + 1;
    }
    const distStr = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    backlogLines.push(`| ${c} | ${distStr} |`);
  }
  backlogLines.push("");
  backlogLines.push("## Average utilization / cash / worker during backlog periods");
  backlogLines.push("");
  backlogLines.push("| Company | avg utilization | avg cash | avg regular workers | avg raw material shortfall | avg labor shortfall |");
  backlogLines.push("|---|---|---|---|---|---|");
  for (const c of ["JPQ", "CONSV", "VAP"]) {
    const rows = backlogTurnRows.filter((r) => r.companyId === c);
    backlogLines.push(
      `| ${c} | ${(mean(rows.map((r) => r.avgFactoryUtilization)) * 100).toFixed(1)}% | $${(mean(rows.map((r) => r.cashUsd)) / 1e6).toFixed(1)}M | ${mean(rows.map((r) => r.regularWorkers)).toFixed(0)} | ${mean(rows.map((r) => r.rawMaterialShortfall)).toFixed(1)} | ${mean(rows.map((r) => r.laborShortfall)).toFixed(1)} |`
    );
  }
  backlogLines.push("");
  fs.writeFileSync(path.join(outDir, "pc15_sustained_backlog_audit.md"), backlogLines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${vapRows.length} VAP tier rows, ${massPdRows.length} MASS PD Mech rows, ${periods.length} backlog periods (${backlogTurnRows.length} turn rows) to ${outDir}`);
}

main2();
