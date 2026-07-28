#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Phase SAI-1.5: マージ前補完レポート生成CLI
//
// `npx tsx scripts/generateSai1Report.ts [outDir]` から実行する。
// app/lib/v2/companyLab/standardAi/report/* （副作用なしの純粋関数群）を
// 呼び出し、JSON・CSV・Markdown・HTMLをこのスクリプトだけがファイルへ
// 書き出す（ゲームエンジン本体・standardAi本体にはfs依存を一切追加しない）。

import * as fs from "node:fs";
import * as path from "node:path";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { collectRun, CollectedRun } from "../app/lib/v2/companyLab/standardAi/report/collect";
import { extractScenarioRows, SCENARIO_UNIMPLEMENTED_NOTES } from "../app/lib/v2/companyLab/standardAi/report/scenario";
import { buildInitialConditionRows } from "../app/lib/v2/companyLab/standardAi/report/initialConditions";
import { runTestA, runTestB, runTestC, runTestD, runMultiSeed } from "../app/lib/v2/companyLab/standardAi/report/decompose";
import { buildConfigSettingRows, CONFIG_LOCATIONS_SUMMARY } from "../app/lib/v2/companyLab/standardAi/report/configSnapshot";
import { CompanyQuarterReportRow } from "../app/lib/v2/companyLab/standardAi/report/types";

const OUT_DIR = process.argv[2] ?? path.join(process.cwd(), "tmp-sai1-report-output");
const SEED_8Q = "sai15-final-8q-001";
const SEED_32Q = "sai15-final-32q-001";
const MULTI_SEEDS = Array.from({ length: 12 }, (_, i) => `sai15-multiseed-${String(i + 1).padStart(3, "0")}`);
const COMPANY_IDS = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

function config(seed: string, turns: number): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns };
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function csvEscape(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, headers: readonly string[], rows: readonly (readonly unknown[])[]) {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function kpiCsvRows(rows: readonly CompanyQuarterReportRow[]) {
  const headers = [
    "runLabel", "companyId", "turn", "period",
    "domesticPurchaseDesiredTons", "domesticPurchaseActualTons", "domesticPurchasePriceUsdPerKg",
    "importOrderDesiredTons", "importArrivedTons", "aquacultureHarvestedTons",
    "rawMaterialInventoryTons", "rawMaterialInventoryMonths",
    "productionDesiredHoso", "productionDesiredPd", "productionDesiredVap",
    "productionActualHoso", "productionActualPd", "productionActualVap",
    "finishedGoodsHoso", "finishedGoodsPd", "finishedGoodsVap",
    "regularHeadcount", "temporaryHeadcountShareActual", "overtimeRateActual",
    "laborUtilizationRateActual", "equipmentUtilizationRateActual",
    "grossRevenueUsd", "netRevenueUsd",
    "outstandingContractTons", "overdueContractTons", "contractFulfillmentRate",
    "domesticRawMaterialCostUsd", "importedRawMaterialCostUsd", "aquacultureRawMaterialCostUsd",
    "grossProfitUsd", "grossProfitMarginRatio", "operatingProfitUsd", "operatingProfitMarginRatio", "netIncomeUsd",
    "cashUsd", "accountsReceivableUsd", "accountsPayableUsd", "shortTermLoansUsd", "longTermLoansUsd",
    "emergencyLoanUsd", "totalEquityUsd", "operatingCashFlowUsd", "financialHealthPrimary", "paymentDefault",
    "covenantBreach", "procurementScaleRatio",
    "qualityHoso", "qualityPd", "qualityVap", "onTimeDeliveryRate",
    "downgradeQuantityTons", "reworkQuantityTons", "discardQuantityTons", "majorIncidentCount",
    "cashPressure", "borrowingPressure", "contractFulfillmentPressure", "rawMaterialInventoryPosition",
    "financingDesiredAmountUsd", "financingDesiredPrepaymentUsd", "capexProposalCount",
    "firedReasonCodes",
  ];
  const body = rows.map((r) => [
    r.runLabel, r.companyId, r.turn, r.period,
    r.domesticPurchaseDesiredTons, r.domesticPurchaseActualTons, r.domesticPurchasePriceUsdPerKg,
    r.importOrderDesiredTons, r.importArrivedTons, r.aquacultureHarvestedTons,
    r.rawMaterialInventoryTons, r.rawMaterialInventoryMonths,
    r.productionDesiredTonsByProduct.hoso, r.productionDesiredTonsByProduct.pd, r.productionDesiredTonsByProduct.vap,
    r.productionActualTonsByProduct.hoso, r.productionActualTonsByProduct.pd, r.productionActualTonsByProduct.vap,
    r.finishedGoodsInventoryTonsByProduct.hoso, r.finishedGoodsInventoryTonsByProduct.pd, r.finishedGoodsInventoryTonsByProduct.vap,
    r.regularHeadcount, r.temporaryHeadcountShareActual, r.overtimeRateActual,
    r.laborUtilizationRateActual, r.equipmentUtilizationRateActual,
    r.grossRevenueUsd, r.netRevenueUsd,
    r.outstandingContractTons, r.overdueContractTons, r.contractFulfillmentRate,
    r.domesticRawMaterialCostUsd, r.importedRawMaterialCostUsd, r.aquacultureRawMaterialCostUsd,
    r.grossProfitUsd, r.grossProfitMarginRatio, r.operatingProfitUsd, r.operatingProfitMarginRatio, r.netIncomeUsd,
    r.cashUsd, r.accountsReceivableUsd, r.accountsPayableUsd, r.shortTermLoansUsd, r.longTermLoansUsd,
    r.emergencyLoanUsd, r.totalEquityUsd, r.operatingCashFlowUsd, r.financialHealthPrimary, r.paymentDefault,
    r.covenantBreach, r.procurementScaleRatio,
    r.qualityScoreByProduct.hoso, r.qualityScoreByProduct.pd, r.qualityScoreByProduct.vap, r.onTimeDeliveryRate,
    r.downgradeQuantityTons, r.reworkQuantityTons, r.discardQuantityTons, r.majorIncidentCount,
    r.pressures?.cashPressure, r.pressures?.borrowingPressure, r.pressures?.contractFulfillmentPressure, r.pressures?.rawMaterialInventoryPosition,
    r.financingDesiredAmountUsd, r.financingDesiredPrepaymentUsd, r.capexProposalCount,
    r.firedReasonCodes?.map((e) => e.code).join("|"),
  ]);
  return { headers, body };
}

function reasonCodeCsvRows(rows: readonly CompanyQuarterReportRow[]) {
  const headers = ["runLabel", "companyId", "turn", "period", "domain", "code", "severity", "threshold", "message", "keyValues"];
  const body: (readonly unknown[])[] = [];
  for (const r of rows) {
    for (const e of r.firedReasonCodes ?? []) {
      body.push([r.runLabel, r.companyId, r.turn, r.period, e.domain, e.code, e.severity, e.threshold, e.message, e.keyValues]);
    }
  }
  return { headers, body };
}

// --- 簡易canvas折れ線グラフ（外部ライブラリ非依存、単独で開けるHTML用） ---
const COMPANY_COLORS: Record<string, string> = { BAL: "#2563eb", MASS: "#dc2626", JPQ: "#16a34a", VAP: "#9333ea", CONSV: "#ea580c" };

function buildChartHtml(title: string, seriesByCompany: Record<string, { turn: number; value: number }[]>, unit: string): string {
  const id = `c${Math.random().toString(36).slice(2, 10)}`;
  return `
<div class="chart-block">
  <h3>${title}<span class="unit">（${unit}）</span></h3>
  <canvas id="${id}" width="820" height="260"></canvas>
</div>
<script>
(function(){
  const data = ${JSON.stringify(seriesByCompany)};
  const colors = ${JSON.stringify(COMPANY_COLORS)};
  const canvas = document.getElementById(${JSON.stringify(id)});
  const ctx = canvas.getContext("2d");
  const pad = 50;
  const allVals = Object.values(data).flat().map(p => p.value);
  const allTurns = Object.values(data).flat().map(p => p.turn);
  const minV = Math.min(0, ...allVals), maxV = Math.max(...allVals, 1);
  const minT = Math.min(...allTurns), maxT = Math.max(...allTurns);
  const W = canvas.width - pad * 2, H = canvas.height - pad * 2;
  function x(t){ return pad + (maxT===minT?0:(t-minT)/(maxT-minT))*W; }
  function y(v){ return pad + H - (maxV===minV?0:(v-minV)/(maxV-minV))*H; }
  ctx.strokeStyle = "#999"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, pad+H); ctx.lineTo(pad+W, pad+H); ctx.stroke();
  ctx.fillStyle = "#333"; ctx.font = "11px sans-serif";
  ctx.fillText(maxV.toLocaleString(undefined,{maximumFractionDigits:1}), 2, pad+4);
  ctx.fillText(minV.toLocaleString(undefined,{maximumFractionDigits:1}), 2, pad+H+4);
  for (const [company, points] of Object.entries(data)) {
    ctx.strokeStyle = colors[company] || "#000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.slice().sort((a,b)=>a.turn-b.turn).forEach((p, i) => {
      const px = x(p.turn), py = y(p.value);
      if (i===0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  let lx = pad + 4, ly = 14;
  for (const [company, color] of Object.entries(colors)) {
    ctx.fillStyle = color; ctx.fillRect(lx, ly-8, 10, 10);
    ctx.fillStyle = "#333"; ctx.fillText(company, lx+14, ly);
    lx += 70;
  }
})();
</script>`;
}

function seriesFor(rows: readonly CompanyQuarterReportRow[], field: (r: CompanyQuarterReportRow) => number): Record<string, { turn: number; value: number }[]> {
  const out: Record<string, { turn: number; value: number }[]> = {};
  for (const id of COMPANY_IDS) out[id] = rows.filter((r) => r.companyId === id).map((r) => ({ turn: r.turn, value: field(r) }));
  return out;
}

function buildHtmlReport(title: string, rows: readonly CompanyQuarterReportRow[]): string {
  const charts = [
    buildChartHtml("現金", seriesFor(rows, (r) => r.cashUsd), "USD"),
    buildChartHtml("純資産", seriesFor(rows, (r) => r.totalEquityUsd), "USD"),
    buildChartHtml("純売上高", seriesFor(rows, (r) => r.netRevenueUsd), "USD"),
    buildChartHtml("営業利益", seriesFor(rows, (r) => r.operatingProfitUsd), "USD"),
    buildChartHtml("原料在庫", seriesFor(rows, (r) => r.rawMaterialInventoryTons), "HOSO換算トン"),
    buildChartHtml("完成品在庫（合計）", seriesFor(rows, (r) => r.finishedGoodsInventoryTonsByProduct.hoso + r.finishedGoodsInventoryTonsByProduct.pd + r.finishedGoodsInventoryTonsByProduct.vap), "HOSO換算トン"),
    buildChartHtml("未履行契約残高", seriesFor(rows, (r) => r.outstandingContractTons), "HOSO換算トン"),
    buildChartHtml("設備稼働率", seriesFor(rows, (r) => r.equipmentUtilizationRateActual * 100), "%"),
    buildChartHtml("労働稼働率（前期実績。既知の限界あり）", seriesFor(rows, (r) => r.laborUtilizationRateActual * 100), "%"),
    buildChartHtml("残業率", seriesFor(rows, (r) => r.overtimeRateActual * 100), "%"),
    buildChartHtml("正社員数", seriesFor(rows, (r) => r.regularHeadcount), "人"),
    buildChartHtml("短期借入金", seriesFor(rows, (r) => r.shortTermLoansUsd), "USD"),
    buildChartHtml("長期借入金", seriesFor(rows, (r) => r.longTermLoansUsd), "USD"),
    buildChartHtml("緊急融資", seriesFor(rows, (r) => r.emergencyLoanUsd), "USD"),
    buildChartHtml("現金圧力(cashPressure)", seriesFor(rows, (r) => r.pressures?.cashPressure ?? 0), "0〜1"),
    buildChartHtml("契約履行圧力(contractFulfillmentPressure)", seriesFor(rows, (r) => r.pressures?.contractFulfillmentPressure ?? 0), "0〜1"),
  ].join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;color:#111}
h1{font-size:20px}h3{font-size:14px;margin:18px 0 4px}.unit{color:#666;font-weight:normal;font-size:12px;margin-left:6px}
.chart-block{margin-bottom:8px}canvas{border:1px solid #ddd}</style></head>
<body><h1>${title}</h1><p>会社別の色: BAL=青 / MASS=赤 / JPQ=緑 / VAP=紫 / CONSV=橙</p>
${charts}
</body></html>`;
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(path.join(OUT_DIR, "json"));
  ensureDir(path.join(OUT_DIR, "csv"));
  ensureDir(path.join(OUT_DIR, "html"));

  console.error(`[sai1-report] 8Q standardAi/autoPolicy 実行中... (seed=${SEED_8Q})`);
  const std8: CollectedRun = collectRun(`standardAi-8q-${SEED_8Q}`, config(SEED_8Q, 8), "standardAi");
  const auto8: CollectedRun = collectRun(`autoPolicy-8q-${SEED_8Q}`, config(SEED_8Q, 8), "autoPolicy");

  console.error(`[sai1-report] 32Q standardAi/autoPolicy 実行中... (seed=${SEED_32Q})`);
  const std32: CollectedRun = collectRun(`standardAi-32q-${SEED_32Q}`, config(SEED_32Q, 32), "standardAi");
  const auto32: CollectedRun = collectRun(`autoPolicy-32q-${SEED_32Q}`, config(SEED_32Q, 32), "autoPolicy");

  console.error("[sai1-report] シナリオ行を抽出中...");
  const scenario8 = extractScenarioRows("standardAi-8q", config(SEED_8Q, 8), std8.result);
  const scenario32 = extractScenarioRows("standardAi-32q", config(SEED_32Q, 32), std32.result);

  console.error("[sai1-report] 初期条件比較表を構築中...");
  const initialConditions = buildInitialConditionRows(std8.result.history[0].period);

  console.error("[sai1-report] 原因分解テスト(A/B/C/D)実行中...");
  const testA8 = runTestA(SEED_8Q, 8);
  const testB8 = COMPANY_IDS.map((tpl) => runTestB(SEED_8Q, 8, tpl));
  const testC8 = runTestC(SEED_8Q, 8);
  const testD8 = runTestD(SEED_8Q, 8);
  const testA32 = runTestA(SEED_32Q, 32);
  const testD32 = runTestD(SEED_32Q, 32);

  console.error(`[sai1-report] 複数seed集計中... (seed数=${MULTI_SEEDS.length}, 8Q)`);
  const multiSeedA = runMultiSeed("A", MULTI_SEEDS, 8);
  const multiSeedD = runMultiSeed("D", MULTI_SEEDS, 8);

  const configRows = buildConfigSettingRows();

  // --- JSON（生データ） ---
  writeJson(path.join(OUT_DIR, "json", "kpi_8q.json"), { standardAi: std8.rows, autoPolicy: auto8.rows });
  writeJson(path.join(OUT_DIR, "json", "kpi_32q.json"), { standardAi: std32.rows, autoPolicy: auto32.rows });
  writeJson(path.join(OUT_DIR, "json", "scenario.json"), { q8: scenario8, q32: scenario32, unimplementedNotes: SCENARIO_UNIMPLEMENTED_NOTES });
  writeJson(path.join(OUT_DIR, "json", "initial_conditions.json"), initialConditions);
  writeJson(path.join(OUT_DIR, "json", "decomposition.json"), {
    testA8, testB8, testC8, testD8, testA32, testD32, multiSeedA, multiSeedD,
    seeds: { seed8q: SEED_8Q, seed32q: SEED_32Q, multiSeeds: MULTI_SEEDS },
  });
  writeJson(path.join(OUT_DIR, "json", "config_settings.json"), { rows: configRows, locations: CONFIG_LOCATIONS_SUMMARY });

  // --- CSV ---
  {
    const { headers, body } = kpiCsvRows([...std8.rows, ...auto8.rows]);
    writeCsv(path.join(OUT_DIR, "csv", "kpi_8q.csv"), headers, body);
  }
  {
    const { headers, body } = kpiCsvRows([...std32.rows, ...auto32.rows]);
    writeCsv(path.join(OUT_DIR, "csv", "kpi_32q.csv"), headers, body);
  }
  {
    const { headers, body } = reasonCodeCsvRows(std8.rows);
    writeCsv(path.join(OUT_DIR, "csv", "reason_codes_8q.csv"), headers, body);
  }
  {
    const { headers, body } = reasonCodeCsvRows(std32.rows);
    writeCsv(path.join(OUT_DIR, "csv", "reason_codes_32q.csv"), headers, body);
  }
  writeCsv(
    path.join(OUT_DIR, "csv", "scenario_32q.csv"),
    ["turn", "period", "scenarioId", "mode", "eventTiming", "worldDemandIndexApprox", "vietnamDomesticRawSupplyTons", "priceDriverCodes"],
    scenario32.map((s) => [s.turn, s.period, s.scenarioId, s.mode, s.eventTiming, s.worldDemandIndexApprox, s.vietnamDomesticRawSupplyTons, s.priceDriverCodes.join("|")])
  );
  writeCsv(
    path.join(OUT_DIR, "csv", "initial_conditions.csv"),
    ["attribute", "unit", "BAL", "MASS", "JPQ", "VAP", "CONSV", "note"],
    initialConditions.map((r) => [r.attribute, r.unit, r.valueByCompany.BAL, r.valueByCompany.MASS, r.valueByCompany.JPQ, r.valueByCompany.VAP, r.valueByCompany.CONSV, r.note])
  );
  writeCsv(
    path.join(OUT_DIR, "csv", "config_settings.csv"),
    ["file", "field", "unit", "currentValue"],
    configRows.map((r) => [r.file, r.field, r.unit, r.currentValue])
  );

  // --- HTML（単独で開けるレポート） ---
  fs.writeFileSync(path.join(OUT_DIR, "html", "report_8q.html"), buildHtmlReport("SAI-1.5 KPIレポート（8Q, standardAi）", std8.rows), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "html", "report_32q.html"), buildHtmlReport("SAI-1.5 KPIレポート（32Q, standardAi）", std32.rows), "utf8");

  console.error(`[sai1-report] 完了。出力先: ${OUT_DIR}`);
  console.error(
    JSON.stringify(
      {
        seed8q: SEED_8Q,
        seed32q: SEED_32Q,
        multiSeedCount: MULTI_SEEDS.length,
        paymentDefaultQuarters8q: Object.fromEntries(COMPANY_IDS.map((id) => [id, testA8.finalByCompany[id].paymentDefaultQuarter])),
        paymentDefaultQuarters32q: Object.fromEntries(COMPANY_IDS.map((id) => [id, testA32.finalByCompany[id].paymentDefaultQuarter])),
        multiSeedDefaultRateA: multiSeedA.paymentDefaultRateByCompany,
        multiSeedDefaultRateD: multiSeedD.paymentDefaultRateByCompany,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
