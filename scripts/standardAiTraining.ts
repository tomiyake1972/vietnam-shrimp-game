#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Standard AI Training Harness CLI
//
// 使い方:
//   npx tsx scripts/standardAiTraining.ts --profile quick   [--label baseline]
//   npx tsx scripts/standardAiTraining.ts --profile standard --label after-a01-fix
//
// ベンチマークを実行し、analysis_output/standard_ai_training/ へ
//   <label>_<profile>_records.json   … 全 company-quarter の decision/result
//   <label>_<profile>_findings.json  … audit findings
//   <label>_<profile>_summary.json   … scorecard用の集計
//   <label>_<profile>_findings.csv   … 表計算で見るための一覧
// を書き出す。ゲーム環境・Test15の保存データには一切触れない（in-memoryのみ）。

import * as fs from "node:fs";
import * as path from "node:path";
import { BENCHMARK_PROFILES, BenchmarkProfile, runBenchmark } from "../app/lib/v2/companyLab/standardAi/training/benchmark";
import { auditBenchmarkRows, summarizeFindings } from "../app/lib/v2/companyLab/standardAi/training/audit";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { FINANCE_PARAMETERS_V1 } from "../app/lib/v2/finance/parameters";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const profileName = arg("profile", "quick") as keyof typeof BENCHMARK_PROFILES;
const profile: BenchmarkProfile | undefined = BENCHMARK_PROFILES[profileName];
if (!profile) {
  console.error(`不明な profile: ${profileName}（quick / standard / deep のいずれか）`);
  process.exit(1);
}
const label = arg("label", "run");

const outDir = path.resolve(process.cwd(), "analysis_output/standard_ai_training");
fs.mkdirSync(outDir, { recursive: true });

const startedAt = Date.now();
console.log(`[training] profile=${profile.name} quarters=${profile.quarters} seeds=${profile.seedCount} label=${label}`);

const run = runBenchmark(profile, new Date().toISOString());
console.log(`[training] simulation完了: ${run.rows.length} company-quarter 行（${((Date.now() - startedAt) / 1000).toFixed(1)}秒）`);
console.log(`[training] environmentFingerprint=${run.fingerprint.environmentFingerprint} standardAiFingerprint=${run.fingerprint.standardAiFingerprint}`);

const findings = auditBenchmarkRows(run.rows, {
  maximumSupplierShare: SALES_PARAMETERS_V1.maximumSupplierShare,
  salesForceSalaryUsdPerQuarter: FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter,
});
const summary = summarizeFindings(findings);

console.log(`[training] findings: total=${summary.total} P0=${summary.bySeverity.P0} P1=${summary.bySeverity.P1} P2=${summary.bySeverity.P2} P3=${summary.bySeverity.P3}`);
for (const [rule, count] of Object.entries(summary.byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`           ${rule}: ${count}`);
}

// 集計指標（Before/After比較の土台）
const rows = run.rows;
const agg = {
  companyQuarters: rows.length,
  defaults: rows.filter((r) => r.result.paymentDefault).length,
  insolvencies: rows.filter((r) => r.result.insolvent).length,
  overdueQuarters: rows.filter((r) => r.result.overdueQuantity > 0).length,
  emergencyBorrowQuarters: rows.filter((r) => r.result.emergencyBorrowingUsd > 0).length,
  totalContracted: rows.reduce((s, r) => s + r.result.newContractedQuantity, 0),
  totalOperatingProfit: rows.reduce((s, r) => s + r.result.operatingProfit, 0),
  totalNetIncome: rows.reduce((s, r) => s + r.result.netIncome, 0),
  avgFinishedGoodsInventory: rows.reduce((s, r) => s + r.result.finishedGoodsInventory, 0) / Math.max(1, rows.length),
  avgRawMaterialInventory: rows.reduce((s, r) => s + r.result.rawMaterialInventory, 0) / Math.max(1, rows.length),
  totalRawShortfall: rows.reduce((s, r) => s + r.result.rawMaterialShortfall, 0),
  avgEquipmentUtilization: rows.reduce((s, r) => s + r.result.equipmentUtilizationRate, 0) / Math.max(1, rows.length),
  avgLaborUtilization: rows.reduce((s, r) => s + r.result.laborUtilizationRate, 0) / Math.max(1, rows.length),
  totalIdleLaborCost: rows.reduce((s, r) => s + r.result.idleLaborCost, 0),
  totalCapexProposals: rows.reduce((s, r) => s + r.decision.capexProposals.length, 0),
  minCash: Math.min(...rows.map((r) => r.result.cash)),
};
console.log(`[training] defaults=${agg.defaults} overdueQ=${agg.overdueQuarters} 成約計=${Math.round(agg.totalContracted)}t 営業利益計=${Math.round(agg.totalOperatingProfit)}`);

const base = path.join(outDir, `${label}_${profile.name}`);
fs.writeFileSync(`${base}_records.json`, JSON.stringify(run, null, 2), "utf8");
fs.writeFileSync(`${base}_findings.json`, JSON.stringify(findings, null, 2), "utf8");
fs.writeFileSync(
  `${base}_summary.json`,
  JSON.stringify({ label, profile, fingerprint: run.fingerprint, generatedAt: run.generatedAt, summary, aggregates: agg }, null, 2),
  "utf8"
);

const csvHeader = "findingId,severity,rule,seed,company,quarter,classification,confidence,observation";
const csvRows = findings.map((f) =>
  [f.findingId, f.severity, f.rule, f.seed, f.company, String(f.quarter), f.classification, String(f.confidence), `"${f.observation.replace(/"/g, '""')}"`].join(",")
);
fs.writeFileSync(`${base}_findings.csv`, [csvHeader, ...csvRows].join("\n"), "utf8");

console.log(`[training] 出力: ${base}_{records,findings,summary}.json / _findings.csv`);
