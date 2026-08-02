// ShrimpX V2 — Test15前 標準AI統合自動プレイ（Phase8・診断専用スクリプト）
//
// 【本スクリプトの位置づけ（重要）】
//   これは観測専用スクリプトであり、意思決定への一切の上書き・後処理を行わない
//   （コーディネーター指示「Do not post-process or override any decision values
//   in the comparison script」）。5社・標準AI（companyLab/standardAi/policy.ts の
//   generateStandardAiDecision、既存のSAI-3A実行基盤 runAutoplayCase をそのまま
//   呼び出す）が、本ブランチの現行パラメータ一式（管理性格・志向プロファイル・
//   異質初期条件・拡張AI設備投資判断などのSAI-4/5フラグは全てOFF＝既定）の下で
//   実際に何をするかを、そのまま観測・集計するだけである。
//
// 【期待される所見（コーディネーターが事前に明示）】
//   generateStandardAiDecision（companyLab/standardAi/decision/capex.ts の
//   buildStandardAiCapexDecision）は、コード読解で確認済みのとおり
//   newFactoryConstruction・pdMechanizationを一切提案しない（提案するのは
//   hosoLineExpansion/pdLineExpansion/vapLineExpansion/commonProcessingExpansion
//   のみ）。また、decision.vapProductDevelopmentSpendUsdも一切設定しない
//   （常にundefined＝実質0）。したがって本スクリプトは、これら3つの新規投資
//   種別の採用件数が実測でも常に0であることを確認・報告する（回避しようとせず、
//   ありのまま報告する）。これは#04のスコープ外・#05の今後の課題であり、
//   本スクリプトはAIの投資判断ロジックを新設・変更しない。

import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const HORIZON_QUARTERS = 16;

export const SEEDS: readonly string[] = ["test15-sai-autoplay-seed-1", "test15-sai-autoplay-seed-2", "test15-sai-autoplay-seed-3"];

const CANDIDATE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

// ---------------------------------------------------------------------
// 1. 投資採用件数の走査（newFactoryConstruction・pdMechanization・VAP開発費）
// ---------------------------------------------------------------------

export interface InvestmentAdoptionEvent {
  readonly seed: string;
  readonly companyId: string;
  readonly quarter: number;
  readonly period: string;
  readonly kind: "newFactoryConstructionProposed" | "pdMechanizationProposed" | "vapProductDevelopmentSpendPositive";
  readonly detail: string;
}

export interface CompanyQuarterMetricsRow {
  readonly seed: string;
  readonly companyId: string;
  readonly quarter: number;
  readonly period: string;
  readonly regularHeadcountTotal: number;
  readonly temporaryHeadcountTotal: number;
  readonly overtimeRateAvg: number;
  readonly finishedGoodsInventoryTons: number;
  readonly rawMaterialInventoryTons: number;
  readonly newContractedQuantityTons: number;
  readonly overdueQuantityTons: number;
  readonly rawMaterialShortfallTons: number;
  readonly equipmentShortfallTons: number;
  readonly laborShortfallTons: number;
  readonly netIncomeUsd: number;
  readonly cashUsd: number;
  readonly borrowingUsd: number;
  readonly insolvent: boolean;
  readonly paymentDefault: boolean;
  readonly usedEmergencyLoanThisPeriod: boolean;
  readonly capexNewProjectProposalTypes: string; // カンマ区切り
  readonly vapProductDevelopmentSpendUsd: number;
}

export interface SeedRunResult {
  readonly seed: string;
  readonly rows: readonly CompanyQuarterMetricsRow[];
  readonly investmentAdoptionEvents: readonly InvestmentAdoptionEvent[];
  readonly completedTurns: number;
}

export function runSeed(seed: string): SeedRunResult {
  const result = runAutoplayCase({
    scenarioId: "baseline",
    seed,
    quarters: HORIZON_QUARTERS,
    companyIds: ALL_COMPANY_IDS,
    candidate: CANDIDATE,
    // 【意図的に全てのオプションを未指定のまま】本ブランチの現行パラメータ一式を
    // 一切上書きしない、という指示に従う（SAI-4/5フラグ・headcount/aquaculture
    // 上書きのいずれも指定しない＝候補の既定値のみで走らせる）。
  });

  const rows: CompanyQuarterMetricsRow[] = [];
  const events: InvestmentAdoptionEvent[] = [];

  for (const record of result.history) {
    for (const companyId of result.companyIds) {
      const decision = record.decisions.find((d) => d.companyId === companyId);
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const financial = record.financialResults.find((f) => f.companyId === companyId);
      const financing = record.financingResults.find((f) => f.companyId === companyId);
      const capexResult = record.capexResults.find((c) => c.companyId === companyId);
      if (!summary || !financial || !financing) continue;

      const proposalTypes = decision?.capexDecision.newProjectProposals.map((p) => p.projectType) ?? [];
      for (const p of proposalTypes) {
        if (p === "newFactoryConstruction") {
          events.push({ seed, companyId, quarter: record.turn, period: record.period, kind: "newFactoryConstructionProposed", detail: "newFactoryConstruction提案あり" });
        }
        if (p === "pdMechanization") {
          events.push({ seed, companyId, quarter: record.turn, period: record.period, kind: "pdMechanizationProposed", detail: "pdMechanization提案あり" });
        }
      }
      const vapSpend = decision?.vapProductDevelopmentSpendUsd ?? 0;
      if (vapSpend > 0) {
        events.push({ seed, companyId, quarter: record.turn, period: record.period, kind: "vapProductDevelopmentSpendPositive", detail: `spend=${vapSpend}` });
      }

      const workerAssignments = decision?.workerAssignments ?? [];
      const regularHeadcountTotal = workerAssignments.reduce((s, w) => s + w.regularHeadcount, 0);
      const temporaryHeadcountTotal = workerAssignments.reduce((s, w) => s + w.temporaryHeadcount, 0);
      const overtimeRateAvg =
        workerAssignments.length > 0 ? workerAssignments.reduce((s, w) => s + unwrapUnit(w.overtimeRate), 0) / workerAssignments.length : 0;

      rows.push({
        seed,
        companyId,
        quarter: record.turn,
        period: record.period,
        regularHeadcountTotal,
        temporaryHeadcountTotal,
        overtimeRateAvg,
        finishedGoodsInventoryTons: unwrapUnit(summary.finishedGoodsInventory),
        rawMaterialInventoryTons: unwrapUnit(summary.rawMaterialInventory),
        newContractedQuantityTons: unwrapUnit(summary.newContractedQuantity),
        overdueQuantityTons: unwrapUnit(summary.overdueQuantity),
        rawMaterialShortfallTons: unwrapUnit(summary.rawMaterialShortfall),
        equipmentShortfallTons: unwrapUnit(summary.equipmentShortfall),
        laborShortfallTons: unwrapUnit(summary.laborShortfall),
        netIncomeUsd: financial.profitAndLoss.netIncome as unknown as number,
        cashUsd: financial.balanceSheet.cash as unknown as number,
        borrowingUsd: financing.endingShortTermLoansUsd + financing.endingLongTermLoansUsd,
        insolvent: financing.financialHealth.insolvent,
        paymentDefault: financing.financialHealth.paymentDefault,
        usedEmergencyLoanThisPeriod: financing.financialHealth.usedEmergencyLoanThisPeriod,
        capexNewProjectProposalTypes: proposalTypes.join("|"),
        vapProductDevelopmentSpendUsd: vapSpend,
      });
      void capexResult;
    }
  }

  return { seed, rows, investmentAdoptionEvents: events, completedTurns: result.completedTurns };
}

export function runFullStudy(): readonly SeedRunResult[] {
  return SEEDS.map((seed) => runSeed(seed));
}

// ---------------------------------------------------------------------
// 2. 集計・出力
// ---------------------------------------------------------------------

function cumulativeNetIncome(rows: readonly CompanyQuarterMetricsRow[]): number {
  return rows.reduce((s, r) => s + r.netIncomeUsd, 0);
}

const CSV_COLUMNS: readonly (keyof CompanyQuarterMetricsRow)[] = [
  "seed",
  "companyId",
  "quarter",
  "period",
  "regularHeadcountTotal",
  "temporaryHeadcountTotal",
  "overtimeRateAvg",
  "finishedGoodsInventoryTons",
  "rawMaterialInventoryTons",
  "newContractedQuantityTons",
  "overdueQuantityTons",
  "rawMaterialShortfallTons",
  "equipmentShortfallTons",
  "laborShortfallTons",
  "netIncomeUsd",
  "cashUsd",
  "borrowingUsd",
  "insolvent",
  "paymentDefault",
  "usedEmergencyLoanThisPeriod",
  "capexNewProjectProposalTypes",
  "vapProductDevelopmentSpendUsd",
];

export function toCsv(rows: readonly CompanyQuarterMetricsRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(","));
  return [header, ...lines].join("\n");
}

export function writeStudyOutputs(results: readonly SeedRunResult[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const allRows = results.flatMap((r) => r.rows);
  writeFileSync(join(outDir, "test15-standard-ai-autoplay.csv"), toCsv(allRows), "utf8");

  const allEvents = results.flatMap((r) => r.investmentAdoptionEvents);
  writeFileSync(
    join(outDir, "test15-standard-ai-autoplay.json"),
    JSON.stringify(
      {
        seeds: SEEDS,
        horizonQuarters: HORIZON_QUARTERS,
        totalInvestmentAdoptionEvents: allEvents.length,
        investmentAdoptionEvents: allEvents,
        finalQuarterByCompanyBySeed: results.map((r) => ({
          seed: r.seed,
          companies: [...new Set(r.rows.map((row) => row.companyId))].map((companyId) => {
            const companyRows = r.rows.filter((row) => row.companyId === companyId);
            const final = companyRows[companyRows.length - 1];
            return {
              companyId,
              finalCashUsd: final?.cashUsd ?? null,
              cumulativeNetIncomeUsd: cumulativeNetIncome(companyRows),
              finalInsolvent: final?.insolvent ?? null,
              finalPaymentDefault: final?.paymentDefault ?? null,
              anyEmergencyLoanUsed: companyRows.some((row) => row.usedEmergencyLoanThisPeriod),
            };
          }),
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

// ---------------------------------------------------------------------
// 3. CLIエントリポイント
// ---------------------------------------------------------------------

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function printStudySummary(results: readonly SeedRunResult[]): void {
  console.log("\n=== Test15前 標準AI統合自動プレイ（Phase8） ===\n");
  const allEvents = results.flatMap((r) => r.investmentAdoptionEvents);
  console.log(`新規投資種別（newFactoryConstruction/pdMechanization/VAP開発費>0）の採用件数合計: ${allEvents.length}`);
  if (allEvents.length > 0) {
    for (const e of allEvents.slice(0, 20)) {
      console.log(`  ${e.seed} ${e.companyId} turn${e.quarter}(${e.period}): ${e.kind} — ${e.detail}`);
    }
  }

  for (const r of results) {
    console.log(`\n--- seed=${r.seed}（完了ターン数=${r.completedTurns}）---`);
    const companyIds = [...new Set(r.rows.map((row) => row.companyId))].sort();
    const finalByCompany = companyIds.map((companyId) => {
      const companyRows = r.rows.filter((row) => row.companyId === companyId);
      const final = companyRows[companyRows.length - 1];
      return { companyId, cumNet: cumulativeNetIncome(companyRows), finalCash: final?.cashUsd ?? 0, insolvent: final?.insolvent ?? false, defaultFlag: final?.paymentDefault ?? false };
    });
    for (const c of finalByCompany) {
      console.log(`  ${c.companyId}: 累計純利益=${fmtUsd(c.cumNet)} 最終現金=${fmtUsd(c.finalCash)} insolvent=${c.insolvent} paymentDefault=${c.defaultFlag}`);
    }
    const sorted = [...finalByCompany].sort((a, b) => b.cumNet - a.cumNet);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    console.log(`  最良/最悪スプレッド（累計純利益）: ${best.companyId}=${fmtUsd(best.cumNet)} 〜 ${worst.companyId}=${fmtUsd(worst.cumNet)}（差=${fmtUsd(best.cumNet - worst.cumNet)}）`);
  }
}

if (require.main === module) {
  const results = runFullStudy();
  printStudySummary(results);
  const outDir = join(__dirname, "..", "artifacts", "test15", "preflight-calibration");
  writeStudyOutputs(results, outDir);
  console.log(`\nCSV/JSON出力: ${outDir}/test15-standard-ai-autoplay.csv / .json`);
}
