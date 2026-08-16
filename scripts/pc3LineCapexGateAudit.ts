// Standard AI Investment Portfolio Calibration — Phase PC-3 Audit
//
// 監査専用（parameter・game behavior変更なし）。JPQ VAPライン・CONSV PDライン・
// VAP社PDラインについて、decision/capex.tsのLine Expansion候補生成が実際に
// 使っているgate（shortfallGate・sustainedGate・inventoryGate・financialGate・
// spaceGate・ongoingProjectGate）をTurnごとにすべて記録し、どのgateで
// 最初に止まっているかを確定する。generateStandardAiDecisionWithDiagnostics
// （既存の純粋関数）をengine.tsと同じ入力でもう一度呼ぶだけ（PC-1.5/PC-2と同じ手法）。
//
// 出力:
//   docs/standard_ai/benchmarks/pc3_line_capex_gate_audit.md
//   docs/standard_ai/benchmarks/pc3_line_capex_gate_turns.csv
//   docs/standard_ai/benchmarks/pc3_line_capex_blockers.csv
//
// 使い方: npx tsx scripts/pc3LineCapexGateAudit.ts

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
/** 会社ごとの重点追跡ライン（指示§7）。 */
const FOCUS_PRODUCT_BY_COMPANY: Readonly<Record<string, "hoso" | "pd" | "vap">> = { JPQ: "vap", CONSV: "pd", VAP: "pd" };
const LINE_CODE_BY_PRODUCT = { hoso: "hosoLineExpansion", pd: "pdLineExpansion", vap: "vapLineExpansion" } as const;

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

interface GateRow {
  scenario: string;
  seed: string;
  companyId: string;
  turn: number;
  product: string;
  code: string; // CAPEX_PROPOSED / CAPEX_DEFERRED / CAPEX_DEFERRED_INSUFFICIENT_SPACE / CAPEX_DEFERRED_OVERSUPPLY / (none)
  shortfallRatio: number | null;
  effectiveShortfallThreshold: number | null;
  shortfallGate: number | null; // 1=pass, 0=fail, null=not evaluated (no entry this turn)
  relevantUtilization: number | null;
  sustainedThreshold: number | null;
  sustainedGate: number | null;
  hadPriorQuarter: number | null;
  inventoryGate: number | null;
  financialGateCashSafe: number | null;
  financialGateBorrowingSafe: number | null;
  ongoingProjectGate: number | null;
  finalDecision: number | null;
  overdueTons: number;
  healthyForwardTons: number;
  cashUsd: number;
}

function main2(): void {
  const outDir = path.join(__dirname, "..", "docs", "standard_ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });

  const gateRows: GateRow[] = [];
  const spaceInfeasibleCount: Record<string, number> = {};

  for (const scenario of SCENARIOS) {
    for (const seed of SEEDS) {
      console.log(`  Running ${scenario}/${seed}...`);
      let session = createSimulationSession({
        simulationRunId: `pc3-${scenario}-${seed}`,
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

          // --- backlog（PC-2Cと同じ手法、既存SalesContractだけから導出） ---
          const outstandingContracts = ownState.contracts.filter((c) => unwrapUnit(c.outstandingQuantity) > 1e-6);
          let overdueTons = 0;
          let outstandingTons = 0;
          for (const c of outstandingContracts) {
            const qty = unwrapUnit(c.outstandingQuantity);
            outstandingTons += qty;
            if (periodIndex(c.dueDate as unknown as string) < currentPeriodIdx) overdueTons += qty;
          }

          const lineEntries = diagnostics.entries.filter(
            (e) => ["CAPEX_PROPOSED", "CAPEX_DEFERRED", "CAPEX_DEFERRED_INSUFFICIENT_SPACE", "CAPEX_DEFERRED_OVERSUPPLY", "LIFECYCLE_GROWTH_PURSUED", "VAP_GROWTH_ENTRY"].includes(
              e.code
            )
          );

          for (const product of ["hoso", "pd", "vap"] as const) {
            // 既存コードのdiagnosticSummaryにproduct名を含む前提のmessage文字列パースはしない
            // （指示の「新しいSSoTを作らない」方針に従い、既存keyValuesだけを使う）。
            // CAPEX_DEFERRED_INSUFFICIENT_SPACEはprojectType別に別途出るためdecisionSummaryで判定する。
            const lineProjectType = LINE_CODE_BY_PRODUCT[product];
            const candidates = lineEntries.filter((e) => {
              if (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE") return e.decisionSummary?.startsWith(lineProjectType) ?? false;
              // CAPEX_PROPOSED/CAPEX_DEFERRED/OVERSUPPLY/GROWTH系は複数product分が同じcode名で
              // 積まれるため、message文字列のproduct表記（先頭のPRODUCT名大文字）で判別する。
              return e.message?.toUpperCase().startsWith(product.toUpperCase()) ?? false;
            });
            if (candidates.length === 0) {
              gateRows.push({
                scenario,
                seed,
                companyId,
                turn,
                product,
                code: "(none)",
                shortfallRatio: null,
                effectiveShortfallThreshold: null,
                shortfallGate: null,
                relevantUtilization: null,
                sustainedThreshold: null,
                sustainedGate: null,
                hadPriorQuarter: null,
                inventoryGate: null,
                financialGateCashSafe: null,
                financialGateBorrowingSafe: null,
                ongoingProjectGate: null,
                finalDecision: 0,
                overdueTons,
                healthyForwardTons: outstandingTons - overdueTons,
                cashUsd: Number(ownState.financeState.cash),
              });
              continue;
            }
            for (const e of candidates) {
              const kv = e.keyValues;
              if (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE") {
                const key = `${companyId}-${product}`;
                spaceInfeasibleCount[key] = (spaceInfeasibleCount[key] ?? 0) + 1;
              }
              gateRows.push({
                scenario,
                seed,
                companyId,
                turn,
                product,
                code: e.code,
                shortfallRatio: kv?.shortfallRatio ?? null,
                effectiveShortfallThreshold: kv?.effectiveShortfallThreshold ?? null,
                shortfallGate: kv?.shortfallGate ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                relevantUtilization: kv?.relevantUtilization ?? null,
                sustainedThreshold: kv?.sustainedThreshold ?? null,
                sustainedGate: kv?.sustainedGate ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                hadPriorQuarter: kv?.hadPriorQuarter ?? null,
                inventoryGate: kv?.inventoryGate ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                financialGateCashSafe: kv?.financialGateCashSafe ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                financialGateBorrowingSafe: kv?.financialGateBorrowingSafe ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                ongoingProjectGate: kv?.ongoingProjectGate ?? (e.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE" ? 1 : null),
                finalDecision: e.code === "CAPEX_PROPOSED" || e.code === "LIFECYCLE_GROWTH_PURSUED" || e.code === "VAP_GROWTH_ENTRY" ? 1 : 0,
                overdueTons,
                healthyForwardTons: outstandingTons - overdueTons,
                cashUsd: Number(ownState.financeState.cash),
              });
            }
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

  // --- CSV: full gate trace ---
  writeCsv(
    path.join(outDir, "pc3_line_capex_gate_turns.csv"),
    [
      "scenario", "seed", "companyId", "turn", "product", "code",
      "shortfallRatio", "effectiveShortfallThreshold", "shortfallGate",
      "relevantUtilization", "sustainedThreshold", "sustainedGate", "hadPriorQuarter",
      "inventoryGate", "financialGateCashSafe", "financialGateBorrowingSafe", "ongoingProjectGate",
      "finalDecision", "overdueTons", "healthyForwardTons", "cashUsd",
    ],
    gateRows.map((r) => [
      r.scenario, r.seed, r.companyId, r.turn, r.product, r.code,
      r.shortfallRatio ?? -1, r.effectiveShortfallThreshold ?? -1, r.shortfallGate ?? -1,
      r.relevantUtilization ?? -1, r.sustainedThreshold ?? -1, r.sustainedGate ?? -1, r.hadPriorQuarter ?? -1,
      r.inventoryGate ?? -1, r.financialGateCashSafe ?? -1, r.financialGateBorrowingSafe ?? -1, r.ongoingProjectGate ?? -1,
      r.finalDecision ?? -1, r.overdueTons, r.healthyForwardTons, r.cashUsd,
    ])
  );

  // --- First blocker classification for the 3 focus company/product pairs ---
  // 優先順位（コード上の逐次判定ではなく、報告のための規約）:
  // shortfall(検出されない=候補自体が無い"(none)") > sustained > inventory > finance(cash) > finance(borrowing) > space > ongoingProject
  function firstBlocker(r: GateRow): string {
    if (r.code === "(none)") return "SHORTFALL_NOT_DETECTED";
    if (r.code === "CAPEX_DEFERRED_OVERSUPPLY") return "OVERSUPPLY_RETREAT";
    if (r.code === "CAPEX_PROPOSED" || r.code === "LIFECYCLE_GROWTH_PURSUED" || r.code === "VAP_GROWTH_ENTRY") return "PROPOSED";
    if (r.code === "CAPEX_DEFERRED_INSUFFICIENT_SPACE") return "SPACE";
    if (r.ongoingProjectGate === 0) return "ONGOING_PROJECT";
    if (r.sustainedGate === 0) return "SUSTAINED_UTILIZATION";
    if (r.inventoryGate === 0) return "INVENTORY_EXCESS";
    if (r.financialGateCashSafe === 0) return "FINANCE_CASH";
    if (r.financialGateBorrowingSafe === 0) return "FINANCE_BORROWING";
    return "OTHER_DEFERRED";
  }

  const blockerRows: (readonly (string | number)[])[] = [];
  for (const companyId of TARGET_COMPANIES) {
    const product = FOCUS_PRODUCT_BY_COMPANY[companyId];
    const rows = gateRows.filter((r) => r.companyId === companyId && r.product === product);
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const b = firstBlocker(r);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    for (const [blocker, count] of Object.entries(counts)) {
      blockerRows.push([companyId, product, blocker, count, rows.length > 0 ? (count / rows.length) * 100 : 0]);
    }
  }
  writeCsv(path.join(outDir, "pc3_line_capex_blockers.csv"), ["companyId", "product", "blocker", "count", "sharePercent"], blockerRows);

  // --- Summary markdown ---
  const lines: string[] = [];
  lines.push("# Standard AI Investment Portfolio Calibration — Phase PC-3 Line CAPEX Gate Audit");
  lines.push("");
  lines.push(`5 scenarios x 5 seeds x 32Q x 3 companies (JPQ/CONSV/VAP) x 3 products, PROFILE ON. ${gateRows.length} turn-product observations. parameter変更なし（監査のみ）。`);
  lines.push("");
  lines.push("## Focus lines: JPQ=VAP line, CONSV=PD line, VAP company=PD line（指示§7）");
  lines.push("");
  lines.push("## First blocker distribution（重点ライン、規約上の優先順位で分類。コードは各gateを独立AND条件で評価しており、下記は報告用の便宜的順序であることに注意）");
  lines.push("");
  lines.push("| Company | Line | Blocker | Count | Share |");
  lines.push("|---|---|---|---|---|");
  for (const companyId of TARGET_COMPANIES) {
    const product = FOCUS_PRODUCT_BY_COMPANY[companyId];
    const rows = gateRows.filter((r) => r.companyId === companyId && r.product === product);
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const b = firstBlocker(r);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    for (const [blocker, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${companyId} | ${product.toUpperCase()} | ${blocker} | ${count} | ${rows.length > 0 ? ((count / rows.length) * 100).toFixed(1) : "n/a"}% |`);
    }
  }
  lines.push("");
  lines.push("## Utilization vs shortfall detail（重点ライン、CAPEX_DEFERRED/CAPEX_PROPOSED時点の平均）");
  lines.push("");
  lines.push("| Company | Line | avg shortfallRatio | avg effectiveShortfallThreshold | avg relevantUtilization | sustainedThreshold | avg overdue (t) | avg healthy forward (t) |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const companyId of TARGET_COMPANIES) {
    const product = FOCUS_PRODUCT_BY_COMPANY[companyId];
    const rows = gateRows.filter((r) => r.companyId === companyId && r.product === product && r.code !== "(none)");
    lines.push(
      `| ${companyId} | ${product.toUpperCase()} | ${mean(rows.map((r) => r.shortfallRatio ?? 0)).toFixed(2)} | ${mean(
        rows.map((r) => r.effectiveShortfallThreshold ?? 0)
      ).toFixed(2)} | ${(mean(rows.map((r) => r.relevantUtilization ?? 0)) * 100).toFixed(1)}% | ${(mean(rows.map((r) => r.sustainedThreshold ?? 0)) * 100).toFixed(
        0
      )}% | ${mean(rows.map((r) => r.overdueTons)).toFixed(0)} | ${mean(rows.map((r) => r.healthyForwardTons)).toFixed(0)} |`
    );
  }
  lines.push("");
  lines.push("## Space gate occurrence (CAPEX_DEFERRED_INSUFFICIENT_SPACE count, focus lines)");
  lines.push("");
  lines.push("| Company | Line | count |");
  lines.push("|---|---|---|");
  for (const companyId of TARGET_COMPANIES) {
    const product = FOCUS_PRODUCT_BY_COMPANY[companyId];
    const key = `${companyId}-${product}`;
    lines.push(`| ${companyId} | ${product.toUpperCase()} | ${spaceInfeasibleCount[key] ?? 0} |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(outDir, "pc3_line_capex_gate_audit.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nWrote ${gateRows.length} gate rows, ${blockerRows.length} blocker rows to ${outDir}`);
}

main2();
