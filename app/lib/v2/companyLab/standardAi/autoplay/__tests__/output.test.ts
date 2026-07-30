// ShrimpX V2 — Phase SAI-3A: 出力ファイル整形（output.ts）のテスト
//
// 三宅さんの指示§10のうち「schema versionが保持されること」「出力したJSON/CSVを
// 再度読み込めること」を確認する。ここではfsへの実際の書き込みは行わず、
// formatXxx関数が返す文字列をそのままパースして検証する（output.ts自体が
// fsに触れない純粋関数のため）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAdjustmentTraceCsv,
  formatCaseSummaryCsv,
  formatDecisionTraceJsonl,
  formatManifestJson,
  formatMarketAllocationTraceCsv,
  formatQuarterSummaryCsv,
  formatRunSummaryJson,
  formatWarningsCsv,
} from "../output";
import { runAutoplayBatch } from "../runBatch";
import { SAI3A_LOG_SCHEMA_VERSION, AutoplayRunManifest } from "../schema";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

function parseCsv(content: string): { header: readonly string[]; rows: readonly (readonly string[])[] } {
  const lines = content.split("\n").filter((l) => l.length > 0);
  const splitLine = (line: string): string[] => {
    // 簡易CSVパーサ（テスト用。ダブルクォート囲み・エスケープに最小限対応）。
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const [header, ...rest] = lines.map(splitLine);
  return { header, rows: rest };
}

test("formatManifestJson: schema versionが出力へ保持され、JSONとして再読み込みできる", () => {
  const manifest: AutoplayRunManifest = {
    schemaVersion: SAI3A_LOG_SCHEMA_VERSION,
    runId: "sai3a-test-manifest",
    scenarioId: "baseline",
    standardBaselineId: "moderate-pressure",
    seeds: ["s1", "s2"],
    quarters: 8,
    companyIds: ["BAL", "MASS", "JPQ", "VAP", "CONSV"],
    aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
    salesForceHeadcountTotal: 80,
    keyParameters: {},
    outputFormats: ["json", "csv"],
  };
  const content = formatManifestJson(manifest);
  const parsed = JSON.parse(content);
  assert.equal(parsed.schemaVersion, SAI3A_LOG_SCHEMA_VERSION);
  assert.deepEqual(parsed.seeds, ["s1", "s2"]);
  assert.equal(parsed.quarters, 8);
});

test("output.ts: バッチ実行結果から生成した全出力ファイルが、それぞれの形式として再読み込みできる", () => {
  const batch = runAutoplayBatch({
    runId: "sai3a-test-output-roundtrip",
    scenarioId: "baseline",
    seeds: ["sai3a-out-1", "sai3a-out-2"],
    quarters: 4,
    companyIds: ["BAL", "MASS"],
    candidate,
  });

  // case-summary.csv
  const caseSummary = parseCsv(formatCaseSummaryCsv(batch));
  assert.equal(caseSummary.rows.length, 4); // 2 seeds × 2 companies
  assert.ok(caseSummary.header.includes("seed") && caseSummary.header.includes("companyId"));
  for (const row of caseSummary.rows) assert.equal(row.length, caseSummary.header.length);

  // quarter-summary.csv（SAI-3B-2で列を追加。CF3分割・生産/販売数量の商品別・
  // 品質/信頼の市場別内訳が含まれること、かつ既存の主要スカラー列も引き続き
  // 含まれることを確認する）。
  const quarterSummary = parseCsv(formatQuarterSummaryCsv(batch));
  assert.equal(quarterSummary.rows.length, 4 * 4); // 2 seeds × 2 companies × 4 quarters
  for (const row of quarterSummary.rows) assert.equal(row.length, quarterSummary.header.length);
  for (const col of [
    "operatingCashFlowUsd",
    "investingCashFlowUsd",
    "financingCashFlowUsd",
    "downgradeQuantityHosoEqTons",
    "newContractedQuantityHosoEqTons",
    "fulfilledQuantityHosoEqTons",
    "outstandingQuantityHosoEqTons",
    "overdueQuantityHosoEqTons",
    "productionQuantityHosoEqTons_hoso",
    "salesQuantityHosoEqTons_hoso",
    "customerTrustAtEnd_CN",
    "qualityScoreAtEnd_hoso",
    "deliveryReliabilityAtEnd_CN",
  ]) {
    assert.ok(quarterSummary.header.includes(col), `quarter-summary.csvに列 "${col}" が含まれていない`);
  }

  // market-allocation-trace.csv（SAI-3B-2で追加）
  const marketAllocationTrace = parseCsv(formatMarketAllocationTraceCsv(batch));
  assert.ok(marketAllocationTrace.rows.length > 0, "market-allocation-trace.csvに行が1件もない");
  for (const row of marketAllocationTrace.rows) assert.equal(row.length, marketAllocationTrace.header.length);
  assert.deepEqual(
    [...marketAllocationTrace.header].sort(),
    [
      "allocatedQuantityHosoEqTons",
      "askPriceUsdPerHosoEqKg",
      "basePriceUsdPerHosoEqKg",
      "companyId",
      "competitivenessWeight",
      "coverageScore",
      "externalOptionQuantityHosoEqTons",
      "market",
      "period",
      "product",
      "seed",
      "targetDemandHosoEqTons",
      "turn",
    ].sort()
  );

  // decision-trace.jsonl
  const jsonlLines = formatDecisionTraceJsonl(batch)
    .split("\n")
    .filter((l) => l.length > 0);
  assert.equal(jsonlLines.length, 4 * 4);
  for (const line of jsonlLines) {
    const parsed = JSON.parse(line);
    assert.ok(typeof parsed.seed === "string");
    assert.ok(typeof parsed.companyId === "string");
    assert.ok(typeof parsed.turn === "number");
    assert.ok(parsed.startState && typeof parsed.startState === "object");
    assert.ok(parsed.decision && typeof parsed.decision === "object");
    assert.ok(Array.isArray(parsed.salesQuantityTrace));
  }

  // adjustment-trace.csv
  const adjustmentTrace = parseCsv(formatAdjustmentTraceCsv(batch));
  assert.ok(adjustmentTrace.rows.length > 0);
  for (const row of adjustmentTrace.rows) assert.equal(row.length, adjustmentTrace.header.length);

  // warnings.csv
  const warnings = parseCsv(formatWarningsCsv(batch));
  for (const row of warnings.rows) assert.equal(row.length, warnings.header.length);

  // run-summary.json
  const runSummary = JSON.parse(formatRunSummaryJson(batch));
  assert.equal(runSummary.runSummary.totalCases, 4);
  assert.equal(runSummary.runSummary.completedCases, 4);
  assert.deepEqual(runSummary.errors, []);
});
