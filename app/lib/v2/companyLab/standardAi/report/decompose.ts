// ShrimpX V2 — Phase SAI-1.5: 会社間格差の原因分解テスト（Test A/B/C/D・複数seed）
//
// ゲームバランス自体は変更しない。あくまで「同一seedで条件を1つずつ揃えたときに
// 会社間の結果差がどう変わるか」を観測し、原因（初期条件／ゲームルール／AI判断／
// 処理順序等の構造）を切り分けるための比較専用モジュール。

import { unwrapUnit } from "../../../core/units";
import { unwrapUsd } from "../../../finance/types";
import { CompanyId } from "../../../sales/types";
import { CompanyLabConfig, CompanyLabResult } from "../../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { generateStandardAiDecision } from "../policy";
import { collectRun } from "./collect";
import { initializeUnifiedCompanyLab, runFromInit, fixedMinimalDecisionProvider } from "./decomposeHarness";
import { DecompositionRunSummary, MultiSeedDistributionEntry, MultiSeedSummary } from "./types";

const ALL_COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

function summarizeResult(testId: "A" | "B" | "C" | "D", testLabel: string, seed: string, turns: number, result: CompanyLabResult): DecompositionRunSummary {
  const finalByCompany: Record<string, DecompositionRunSummary["finalByCompany"][CompanyId]> = {};
  for (const companyId of ALL_COMPANY_IDS) {
    let cumulativeRevenue = 0;
    let cumulativeOperatingProfit = 0;
    let paymentDefaultQuarter: number | null = null;
    let finalCash = 0;
    let finalEquity = 0;
    let outstandingContractTons = 0;
    for (const record of result.history) {
      const fin = record.financialResults.find((f) => f.companyId === companyId);
      const fcg = record.financingResults.find((f) => f.companyId === companyId);
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      if (!fin || !fcg || !summary) continue;
      cumulativeRevenue += unwrapUsd(fin.profitAndLoss.netRevenue);
      cumulativeOperatingProfit += unwrapUsd(fin.profitAndLoss.operatingProfit);
      if (paymentDefaultQuarter === null && fcg.financialHealth.paymentDefault) paymentDefaultQuarter = record.turn;
      if (record.turn === turns) {
        finalCash = unwrapUsd(fin.balanceSheet.cash);
        finalEquity = unwrapUsd(fin.balanceSheet.totalEquity);
        outstandingContractTons = unwrapUnit(summary.outstandingQuantity);
      }
    }
    finalByCompany[companyId] = {
      finalCashUsd: finalCash,
      finalEquityUsd: finalEquity,
      cumulativeRevenueUsd: cumulativeRevenue,
      cumulativeOperatingProfitUsd: cumulativeOperatingProfit,
      outstandingContractTons,
      paymentDefaultQuarter,
    };
  }
  return { testId, testLabel, seed, turns, finalByCompany: finalByCompany as DecompositionRunSummary["finalByCompany"] };
}

export function runTestA(seed: string, turns: number): DecompositionRunSummary {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns };
  const { result } = collectRun(`testA-${seed}`, config, "standardAi");
  return summarizeResult("A", "現行5社の初期条件＋standard AI", seed, turns, result);
}

export function runTestB(seed: string, turns: number, templateCompanyId: CompanyId): DecompositionRunSummary {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns };
  const initResult = initializeUnifiedCompanyLab(config, templateCompanyId);
  const result = runFromInit(initResult, generateStandardAiDecision);
  return summarizeResult("B", `5社の初期条件をテンプレート会社(${templateCompanyId})へ統一＋standard AI（同一情報・同一seed）`, seed, turns, result);
}

export function runTestC(seed: string, turns: number): DecompositionRunSummary {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns };
  const result = runCompanyLabWithAutoPolicyForAllCompanies(config, fixedMinimalDecisionProvider);
  return summarizeResult("C", "現行5社の初期条件＋全社同一の固定意思決定（新規契約なし・生産0・最小限調達のみ）", seed, turns, result);
}

export function runTestD(seed: string, turns: number): { standardAi: DecompositionRunSummary; autoPolicy: DecompositionRunSummary } {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed, turns };
  const std = collectRun(`testD-std-${seed}`, config, "standardAi");
  const auto = collectRun(`testD-auto-${seed}`, config, "autoPolicy");
  return {
    standardAi: summarizeResult("D", "standard AI（同一seed・同一初期条件）", seed, turns, std.result),
    autoPolicy: summarizeResult("D", "autoPolicy（同一seed・同一初期条件、比較対象）", seed, turns, auto.result),
  };
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** 複数seedにわたりTest A・Test D(standardAi)を反復し、会社別の分布を集計する。
 *  実行負荷を抑えるため既定は8ターン・seed数はoptsで指定（採用seed数はレポート側で明記する）。 */
export function runMultiSeed(testId: "A" | "D", seeds: readonly string[], turns: number): MultiSeedSummary {
  const perSeed = seeds.map((seed) => (testId === "A" ? runTestA(seed, turns) : runTestD(seed, turns).standardAi));
  const metrics: readonly ["finalCashUsd", "finalEquityUsd", "cumulativeRevenueUsd", "cumulativeOperatingProfitUsd", "outstandingContractTons"] = [
    "finalCashUsd",
    "finalEquityUsd",
    "cumulativeRevenueUsd",
    "cumulativeOperatingProfitUsd",
    "outstandingContractTons",
  ];
  const distributions: MultiSeedDistributionEntry[] = [];
  const paymentDefaultRateByCompany: Record<string, number> = {};
  for (const companyId of ALL_COMPANY_IDS) {
    const defaultCount = perSeed.filter((r) => r.finalByCompany[companyId].paymentDefaultQuarter !== null).length;
    paymentDefaultRateByCompany[companyId] = defaultCount / seeds.length;
    for (const metric of metrics) {
      const values = perSeed.map((r) => r.finalByCompany[companyId][metric]);
      distributions.push({ companyId, metric, seedCount: seeds.length, values, mean: mean(values), stdev: stdev(values), min: Math.min(...values), max: Math.max(...values) });
    }
  }
  return { testId, seeds, turns, paymentDefaultRateByCompany: paymentDefaultRateByCompany as Record<CompanyId, number>, distributions };
}
