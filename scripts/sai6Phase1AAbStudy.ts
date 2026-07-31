#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-6 Phase 1A: 資金見通し是正のON/OFF A/B比較（8Q・32Q）
//
// 【重要】比較対象はPhase 1A（fundingOutlookEnabled）単独のON/OFFのみ。
// 労務・価格等の他のSAI-6機能は一切変更しない（すべて未実装）。
// 比較の主軸は生存期間（最初のpaymentDefaultより前）とする（Phase 0-5と同じ理由）。

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase, AutoplayCaseConfig } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { unwrapUnit } from "../app/lib/v2/core/units";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const EXTRA_SEEDS = ["sai6-1a-extra-001", "sai6-1a-extra-002"]; // 可能な範囲での追加seed

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

interface Row {
  configId: "off" | "on";
  quarters: number;
  seed: string;
  companyId: string;
  turn: number;
  preDefault: boolean;
  paymentDefault: boolean;
  loanDrawUsd: number;
  interestPaidCashUsd: number;
  principalPaidCashUsd: number;
  endingShortTermLoansUsd: number;
  endingLongTermLoansUsd: number;
  availableAdditionalBorrowingCapacityUsd: number;
  usedFullCapacity: boolean;
  procurementCashConstrainedFired: boolean;
  procurementScaleRatio: number;
  desiredDomesticPurchaseTons: number;
  actualDomesticPurchaseTons: number;
  rawMaterialShortfallTons: number;
  totalProducedTons: number;
  netRevenueUsd: number;
  operatingProfitUsd: number;
  closingCashUsd: number;
}

function collect(configId: "off" | "on", quarters: number, seeds: readonly string[]): Row[] {
  const rows: Row[] = [];
  for (const seed of seeds) {
    const flags: Partial<AutoplayCaseConfig> = configId === "on" ? { fundingOutlookEnabled: true } : {};
    const result = runAutoplayCase({ scenarioId: "baseline", seed, quarters, companyIds: ALL_COMPANY_IDS, candidate, ...flags });
    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const summary = h.companySummaries.find((s) => s.companyId === companyId);
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        const fin = h.financialResults.find((f) => f.companyId === companyId);
        const diag = result.diagnostics.find((d) => d.turn === h.turn && d.companyId === companyId);
        if (!summary || !financing || !fin || !diag) continue;

        const pc = (financing as unknown as {
          procurementConstraint?: { originalDomesticPurchaseQuantityTons: number; constrainedDomesticPurchaseQuantityTons: number; scaleRatio: number };
        }).procurementConstraint;

        rows.push({
          configId,
          quarters,
          seed,
          companyId,
          turn: h.turn,
          preDefault: true,
          paymentDefault: financing.financialHealth.paymentDefault === true,
          loanDrawUsd: toNumber(financing.loanDrawUsd),
          interestPaidCashUsd: toNumber(financing.interestPaidCashUsd),
          principalPaidCashUsd: toNumber(financing.principalPaidCashUsd),
          endingShortTermLoansUsd: toNumber(financing.endingShortTermLoansUsd),
          endingLongTermLoansUsd: toNumber(financing.endingLongTermLoansUsd),
          availableAdditionalBorrowingCapacityUsd: toNumber(financing.borrowingCapacity.availableAdditionalCapacityUsd),
          usedFullCapacity: toNumber(financing.borrowingCapacity.availableAdditionalCapacityUsd) < 1000 && toNumber(financing.loanDrawUsd) > 0,
          procurementCashConstrainedFired: diag.entries.some((e) => e.code === "PROCUREMENT_CASH_CONSTRAINED"),
          procurementScaleRatio: pc ? pc.scaleRatio : 1,
          desiredDomesticPurchaseTons: pc ? pc.originalDomesticPurchaseQuantityTons : unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity),
          actualDomesticPurchaseTons: pc ? pc.constrainedDomesticPurchaseQuantityTons : unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity),
          rawMaterialShortfallTons: unwrapUnit(summary.rawMaterialShortfall),
          totalProducedTons: unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced),
          netRevenueUsd: toNumber(fin.profitAndLoss.netRevenue),
          operatingProfitUsd: toNumber(fin.profitAndLoss.operatingProfit),
          closingCashUsd: toNumber(fin.cashFlow.closingCash),
        });
      }
    }
  }
  // preDefault再計算
  const firstDefaultTurn = new Map<string, number>();
  for (const r of rows) {
    if (!r.paymentDefault) continue;
    const key = `${r.configId}::${r.quarters}::${r.seed}::${r.companyId}`;
    const prev = firstDefaultTurn.get(key);
    if (prev === undefined || r.turn < prev) firstDefaultTurn.set(key, r.turn);
  }
  return rows.map((r) => {
    const key = `${r.configId}::${r.quarters}::${r.seed}::${r.companyId}`;
    const first = firstDefaultTurn.get(key);
    return { ...r, preDefault: first === undefined || r.turn <= first };
  });
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length);

function summarize(rows: readonly Row[]) {
  const perCase = new Set(rows.map((r) => `${r.seed}::${r.companyId}`)).size;
  const defaultCases = new Set(rows.filter((r) => r.paymentDefault).map((r) => `${r.seed}::${r.companyId}`)).size;
  const pre = rows.filter((r) => r.preDefault);
  const firstDefaultTurnByCase = new Map<string, number>();
  for (const r of rows) {
    if (!r.paymentDefault) continue;
    const key = `${r.seed}::${r.companyId}`;
    const prev = firstDefaultTurnByCase.get(key);
    if (prev === undefined || r.turn < prev) firstDefaultTurnByCase.set(key, r.turn);
  }
  return {
    quarters: rows[0]?.quarters ?? 0,
    caseCount: perCase,
    defaultCaseCount: defaultCases,
    meanQuartersToFirstDefault: mean([...firstDefaultTurnByCase.values()]),
    defaultRate: perCase > 0 ? defaultCases / perCase : 0,
    survival: {
      meanLoanDrawUsd: mean(pre.map((r) => r.loanDrawUsd)),
      meanInterestPaidCashUsd: mean(pre.map((r) => r.interestPaidCashUsd)),
      meanEndingShortTermLoansUsd: mean(pre.map((r) => r.endingShortTermLoansUsd)),
      meanEndingLongTermLoansUsd: mean(pre.map((r) => r.endingLongTermLoansUsd)),
      quartersFullyUsedCapacity: pre.filter((r) => r.usedFullCapacity).length,
      quartersProcurementCashConstrained: pre.filter((r) => r.procurementCashConstrainedFired).length,
      meanProcurementScaleRatio: mean(pre.map((r) => r.procurementScaleRatio)),
      meanDesiredDomesticPurchaseTons: mean(pre.map((r) => r.desiredDomesticPurchaseTons)),
      meanActualDomesticPurchaseTons: mean(pre.map((r) => r.actualDomesticPurchaseTons)),
      meanRawMaterialShortfallTons: mean(pre.map((r) => r.rawMaterialShortfallTons)),
      meanTotalProducedTons: mean(pre.map((r) => r.totalProducedTons)),
      meanNetRevenueUsd: mean(pre.map((r) => r.netRevenueUsd)),
      meanOperatingProfitUsd: mean(pre.map((r) => r.operatingProfitUsd)),
      meanClosingCashUsd: mean(pre.map((r) => r.closingCashUsd)),
      quartersTotal: pre.length,
    },
  };
}

function fmtUsd(v: number): string {
  return `${(v / 1e6).toFixed(3)}M`;
}

function runAbForQuarters(quarters: number, seeds: readonly string[]) {
  console.log(`実測中: ${quarters}Q off ...`);
  const off = collect("off", quarters, seeds);
  console.log(`実測中: ${quarters}Q on ...`);
  const on = collect("on", quarters, seeds);
  return { off: summarize(off), on: summarize(on) };
}

function main(): void {
  const outDir = path.resolve(process.cwd(), "artifacts/sai6/phase1a");
  fs.mkdirSync(outDir, { recursive: true });

  const seedsForExtra = [...SEEDS, ...EXTRA_SEEDS];
  const q8 = runAbForQuarters(8, SEEDS);
  const q32 = runAbForQuarters(32, SEEDS);
  const q32Extra = runAbForQuarters(32, seedsForExtra);

  const result = { generator: "scripts/sai6Phase1AAbStudy.ts", seeds: SEEDS, extraSeeds: EXTRA_SEEDS, q8, q32, q32Extra };
  fs.writeFileSync(path.join(outDir, "ab_study.json"), JSON.stringify(result, null, 2));

  const L: string[] = [];
  L.push("# SAI-6 Phase 1A A/B比較（fundingOutlookEnabled ON/OFF、8Q・32Q）");
  L.push("");
  L.push("労務・価格等の他のSAI-6機能は一切変更していない（Phase 1Aのみを切り替え）。");
  L.push("生存期間（最初のpaymentDefaultより前）を主指標とする。");
  L.push("");
  for (const [label, r] of [
    [`8Q（seed${SEEDS.length}個）`, q8],
    [`32Q（seed${SEEDS.length}個）`, q32],
    [`32Q（seed${seedsForExtra.length}個、追加seed含む）`, q32Extra],
  ] as const) {
    L.push(`## ${label}`);
    L.push("");
    L.push("| 指標 | off | on |");
    L.push("|---|---:|---:|");
    L.push(`| 破綻会社ケース | ${r.off.defaultCaseCount}/${r.off.caseCount} | ${r.on.defaultCaseCount}/${r.on.caseCount} |`);
    L.push(`| 破綻率 | ${(r.off.defaultRate * 100).toFixed(1)}% | ${(r.on.defaultRate * 100).toFixed(1)}% |`);
    L.push(`| 最初の破綻までの平均四半期 | ${r.off.meanQuartersToFirstDefault.toFixed(1)}Q | ${r.on.meanQuartersToFirstDefault.toFixed(1)}Q |`);
    L.push(`| 生存期間の平均借入実行額/Q | ${fmtUsd(r.off.survival.meanLoanDrawUsd)} | ${fmtUsd(r.on.survival.meanLoanDrawUsd)} |`);
    L.push(`| 生存期間の平均支払利息/Q | ${fmtUsd(r.off.survival.meanInterestPaidCashUsd)} | ${fmtUsd(r.on.survival.meanInterestPaidCashUsd)} |`);
    L.push(`| 生存期間の平均短期借入残高 | ${fmtUsd(r.off.survival.meanEndingShortTermLoansUsd)} | ${fmtUsd(r.on.survival.meanEndingShortTermLoansUsd)} |`);
    L.push(`| 借入余力を使い切った四半期 | ${r.off.survival.quartersFullyUsedCapacity}/${r.off.survival.quartersTotal} | ${r.on.survival.quartersFullyUsedCapacity}/${r.on.survival.quartersTotal} |`);
    L.push(`| PROCUREMENT_CASH_CONSTRAINED発火四半期 | ${r.off.survival.quartersProcurementCashConstrained}/${r.off.survival.quartersTotal} | ${r.on.survival.quartersProcurementCashConstrained}/${r.on.survival.quartersTotal} |`);
    L.push(`| 平均調達スケール比（1.0=制約なし） | ${r.off.survival.meanProcurementScaleRatio.toFixed(4)} | ${r.on.survival.meanProcurementScaleRatio.toFixed(4)} |`);
    L.push(`| 平均国内買付希望量（t/Q） | ${r.off.survival.meanDesiredDomesticPurchaseTons.toFixed(1)} | ${r.on.survival.meanDesiredDomesticPurchaseTons.toFixed(1)} |`);
    L.push(`| 平均国内買付実行量（t/Q） | ${r.off.survival.meanActualDomesticPurchaseTons.toFixed(1)} | ${r.on.survival.meanActualDomesticPurchaseTons.toFixed(1)} |`);
    L.push(`| 平均原料不足（t/Q） | ${r.off.survival.meanRawMaterialShortfallTons.toFixed(1)} | ${r.on.survival.meanRawMaterialShortfallTons.toFixed(1)} |`);
    L.push(`| 平均生産量（t/Q） | ${r.off.survival.meanTotalProducedTons.toFixed(1)} | ${r.on.survival.meanTotalProducedTons.toFixed(1)} |`);
    L.push(`| 平均売上高（USD/Q） | ${fmtUsd(r.off.survival.meanNetRevenueUsd)} | ${fmtUsd(r.on.survival.meanNetRevenueUsd)} |`);
    L.push(`| 平均営業利益（USD/Q） | ${fmtUsd(r.off.survival.meanOperatingProfitUsd)} | ${fmtUsd(r.on.survival.meanOperatingProfitUsd)} |`);
    L.push(`| 平均期末現金（USD） | ${fmtUsd(r.off.survival.meanClosingCashUsd)} | ${fmtUsd(r.on.survival.meanClosingCashUsd)} |`);
    L.push("");
  }
  fs.writeFileSync(path.join(outDir, "ab_study.md"), L.join("\n"));
  console.log(`\n出力: ${outDir}/{ab_study.json, ab_study.md}`);
  console.log(L.join("\n"));
}

main();
