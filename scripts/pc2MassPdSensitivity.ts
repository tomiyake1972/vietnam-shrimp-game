// Standard AI Investment Portfolio Calibration — Phase PC-2B Audit
//
// 監査専用スクリプト。parameter・game behaviorは一切変更しない。
// generateStandardAiDecisionWithDiagnostics（既存の純粋関数）を、engine.tsの内部
// 呼び出しと同じ入力でもう一度呼ぶだけ（PC-1.5と同じ手法）。decision/capex.tsの
// PD Mechanization候補生成が計算するpaybackQuarters（RAW payback、
// investmentCostUsd/expectedQuarterlySavingUsd。strategyFitMultiplier・
// financialConservatismRatioの影響を受けない）と、effectiveMaxPaybackQuarters
// （=pdMechanizationMaxPaybackQuarters×strategyFitMultiplier/financialConservatismRatio、
// profile-adjustedしきい値）を分離して記録する（指示§18）。
// MASSのneutral-profile shadow計算（strategyFitMultiplier=1.0と仮定した場合の
// eligibility）と、strategyFit 0.8/0.9/1.0/1.1のsensitivity sweepは、監査
// スクリプト側で同じ式を独立に再計算するだけであり（CE-3A/PC-1.5と同じ手法）、
// production側のロジックは一切変更しない。
//
// 出力:
//   docs/standard_ai/benchmarks/pc2_mass_pd_sensitivity.md
//   docs/standard_ai/benchmarks/pc2_mass_pd_sensitivity.csv
//
// 使い方: npx tsx scripts/pc2MassPdSensitivity.ts

import * as fs from "fs";
import * as path from "path";
import { advanceSimulationTurn, createSimulationSession } from "../app/lib/v2/companyLab/simulation/engine";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { resolveStandardAiProfileForMode } from "../app/lib/v2/companyLab/standardAi/orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";

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
const SENSITIVITY_STRATEGY_FITS = [0.8, 0.9, 1.0, 1.1] as const;

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

interface CandidateRow {
  scenario: string;
  seed: string;
  companyId: string;
  turn: number;
  factoryId: string;
  code: string;
  factoryPdUtilization: number | null;
  pdProductionTonsEstimate: number | null;
  laborSavingsHeadcount: number | null;
  expectedQuarterlySavingUsd: number | null;
  investmentCostUsd: number | null;
  rawPaybackQuarters: number | null;
  strategyFitMultiplier: number | null;
  financialConservatismRatio: number | null;
  effectiveMaxPaybackQuarters: number | null;
  eligibleAtRawVsEffective: boolean;
}

function main2(): void {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const rows: CandidateRow[] = [];

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`  Running ${scenario}/${seed}...`);
      let session = createSimulationSession({
        simulationRunId: `pc2b-${scenario}-${seed}`,
        scenarioId: scenario,
        seed,
        requestedTurns: MANAGEMENT_CONSOLE_STANDARD_TURNS,
        startedAt: AT,
        standardAiProfileMode: "ON",
      });

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

          const pdMechEntries = diagnostics.entries.filter((e) => e.code.startsWith("PD_MECH_") && e.code !== "PD_MECH_ALREADY_ACTIVE");
          for (const e of pdMechEntries) {
            const kv = e.keyValues;
            const rawPaybackQuarters = kv?.paybackQuarters !== undefined && kv.paybackQuarters >= 0 ? kv.paybackQuarters : null;
            const effectiveMaxPaybackQuarters = kv?.effectiveMaxPaybackQuarters ?? null;
            rows.push({
              scenario,
              seed,
              companyId,
              turn,
              factoryId: e.targetFactoryId ?? "",
              code: e.code,
              factoryPdUtilization: kv?.factoryPdUtilization ?? null,
              pdProductionTonsEstimate: kv?.pdProductionTonsEstimate ?? null,
              laborSavingsHeadcount: kv?.laborSavingsHeadcount ?? null,
              expectedQuarterlySavingUsd: kv?.expectedQuarterlySavingUsd ?? null,
              investmentCostUsd: kv?.investmentCostUsd ?? null,
              rawPaybackQuarters,
              strategyFitMultiplier: kv?.strategyFitMultiplier ?? null,
              financialConservatismRatio: kv?.financialConservatismRatio ?? null,
              effectiveMaxPaybackQuarters,
              eligibleAtRawVsEffective: rawPaybackQuarters !== null && effectiveMaxPaybackQuarters !== null && rawPaybackQuarters <= effectiveMaxPaybackQuarters,
            });
          }
        }

        const outcome = advanceSimulationTurn(session, AT);
        if (!outcome.advanced) {
          console.error(`  FAILED to advance ${scenario}/${seed} at turn ${turn}: ${outcome.error}`);
          break;
        }
        session = outcome.session;
      }
    }
  }

  // --- CSV ---
  writeCsv(
    path.join(outDir, "pc2_mass_pd_sensitivity.csv"),
    [
      "scenario", "seed", "companyId", "turn", "factoryId", "code", "factoryPdUtilization", "pdProductionTonsEstimate",
      "laborSavingsHeadcount", "expectedQuarterlySavingUsd", "investmentCostUsd", "rawPaybackQuarters",
      "strategyFitMultiplier", "financialConservatismRatio", "effectiveMaxPaybackQuarters", "eligibleAtRawVsEffective",
    ],
    rows.map((r) => [
      r.scenario, r.seed, r.companyId, r.turn, r.factoryId, r.code,
      r.factoryPdUtilization ?? -1, r.pdProductionTonsEstimate ?? -1, r.laborSavingsHeadcount ?? -1,
      r.expectedQuarterlySavingUsd ?? -1, r.investmentCostUsd ?? -1, r.rawPaybackQuarters ?? -1,
      r.strategyFitMultiplier ?? -1, r.financialConservatismRatio ?? -1, r.effectiveMaxPaybackQuarters ?? -1, r.eligibleAtRawVsEffective,
    ])
  );

  // --- Company comparison ---
  const lines: string[] = [];
  lines.push("# Standard AI Investment Portfolio Calibration — Phase PC-2B MASS PD Mechanization Sensitivity Audit");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 32Q x 5 companies, PROFILE ON. ${rows.length} candidate-quarter observations. parameter変更なし（監査のみ）。`);
  lines.push("");
  lines.push("## Company comparison (PD_MECH_CONSIDERED以降の候補観測のみ、rows with keyValues)");
  lines.push("");
  lines.push("| Company | n candidates | avg PD utilization | avg PD tons est. | avg labor savings HC | avg quarterly saving ($) | avg raw payback (Q) | avg strategyFitMultiplier | avg financialConservatismRatio | avg effectiveMaxPayback (Q) | eligible (raw<=effective) rate |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of COMPANIES) {
    // PD_MECH_CONSIDERED/PD_MECH_LOW_UTILIZATIONだけがfactoryPdUtilizationを持つ
    // （PAYBACK_UNATTRACTIVE/PROPOSEDはpaybackQuarters系のkeyValuesを持つ、別集合）。
    // 2つの集合を別々に平均する（cRowsだけで平均すると常に0%になる誤りを避ける）。
    const utilizationRows = rows.filter((r) => r.companyId === c && r.factoryPdUtilization !== null);
    const cRows = rows.filter((r) => r.companyId === c && r.rawPaybackQuarters !== null);
    const eligibleRows = rows.filter((r) => r.companyId === c && r.code !== "PD_MECH_LOW_UTILIZATION");
    const eligibleRate = eligibleRows.length > 0 ? eligibleRows.filter((r) => r.eligibleAtRawVsEffective).length / eligibleRows.length : 0;
    lines.push(
      `| ${c} | ${cRows.length} | ${(mean(utilizationRows.map((r) => r.factoryPdUtilization ?? 0)) * 100).toFixed(1)}% | ${mean(cRows.map((r) => r.pdProductionTonsEstimate ?? 0)).toFixed(
        0
      )} | ${mean(cRows.map((r) => r.laborSavingsHeadcount ?? 0)).toFixed(1)} | $${mean(cRows.map((r) => r.expectedQuarterlySavingUsd ?? 0)).toFixed(0)} | ${mean(
        cRows.map((r) => r.rawPaybackQuarters ?? 0)
      ).toFixed(1)} | ${mean(cRows.map((r) => r.strategyFitMultiplier ?? 0)).toFixed(3)} | ${mean(cRows.map((r) => r.financialConservatismRatio ?? 0)).toFixed(3)} | ${mean(
        cRows.map((r) => r.effectiveMaxPaybackQuarters ?? 0)
      ).toFixed(1)} | ${(eligibleRate * 100).toFixed(1)}% |`
    );
  }
  lines.push("");

  // --- MASS neutral-profile shadow calc (strategyFitMultiplier=1.0) ---
  const massRows = rows.filter((r) => r.companyId === "MASS" && r.code === "PD_MECH_PAYBACK_UNATTRACTIVE" && r.rawPaybackQuarters !== null && r.financialConservatismRatio !== null);
  const baseMaxPayback = STANDARD_AI_PARAMETERS_V1.pdMechanizationMaxPaybackQuarters;
  function neutralEffectiveMaxPayback(financialConservatismRatio: number, strategyFit: number): number {
    return financialConservatismRatio > 1e-9 ? (baseMaxPayback * strategyFit) / financialConservatismRatio : baseMaxPayback;
  }
  const actualEligibleCount = rows.filter((r) => r.companyId === "MASS" && r.eligibleAtRawVsEffective).length;
  const actualCandidateCount = rows.filter((r) => r.companyId === "MASS" && r.rawPaybackQuarters !== null).length;
  const neutralEligibleCount = massRows.filter((r) => r.rawPaybackQuarters! <= neutralEffectiveMaxPayback(r.financialConservatismRatio!, 1.0)).length;

  lines.push("## MASS neutral-profile shadow calculation (strategyFitMultiplier=1.0と仮定、audit-only、production behaviorは変更しない)");
  lines.push("");
  lines.push(`- 実際のeligible件数（raw payback <= 実際のeffectiveMaxPaybackQuarters）: ${actualEligibleCount} / ${actualCandidateCount}`);
  lines.push(
    `- PD_MECH_PAYBACK_UNATTRACTIVEだった${massRows.length}件のうち、strategyFitMultiplier=1.0（neutral）と仮定した場合にeligibleになる件数: ${neutralEligibleCount} / ${massRows.length}`
  );
  lines.push("");

  // --- Sensitivity sweep ---
  lines.push("## MASS sensitivity sweep (strategyFitMultiplier 0.8/0.9/1.0/1.1, audit-only shadow calc)");
  lines.push("");
  lines.push("| strategyFitMultiplier | eligible rate (among PD_MECH_PAYBACK_UNATTRACTIVE observations) |");
  lines.push("|---|---|");
  for (const fit of SENSITIVITY_STRATEGY_FITS) {
    const eligibleCount = massRows.filter((r) => r.rawPaybackQuarters! <= neutralEffectiveMaxPayback(r.financialConservatismRatio!, fit)).length;
    lines.push(`| ${fit.toFixed(1)} | ${massRows.length > 0 ? ((eligibleCount / massRows.length) * 100).toFixed(1) : "n/a"}% (${eligibleCount}/${massRows.length}) |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pc2_mass_pd_sensitivity.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${rows.length} candidate rows to ${outDir}`);
}

main2();
