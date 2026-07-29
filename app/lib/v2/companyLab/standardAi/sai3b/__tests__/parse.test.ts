// ShrimpX V2 — Phase SAI-3B-1: parse.ts のユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAdjustmentTraceCsv,
  parseCaseSummaryCsv,
  parseCsvText,
  parseDecisionTraceJsonl,
  parseManifestJson,
  parseQuarterSummaryCsv,
  parseRunSummaryJson,
  parseWarningsCsv,
} from "../parse";
import { Sai3bInputError } from "../schema";

test("parseCsvText: 基本的なCSVをヘッダーと行に分解できる", () => {
  const { header, rows } = parseCsvText("a,b,c\n1,2,3\n4,5,6\n");
  assert.deepEqual(header, ["a", "b", "c"]);
  assert.deepEqual(rows, [
    ["1", "2", "3"],
    ["4", "5", "6"],
  ]);
});

test("parseCsvText: ダブルクォート内のカンマ・改行・エスケープされた\"\"を正しく扱う", () => {
  const csv = 'a,b\n"1,2","line1\nline2"\n"say ""hi""",plain\n';
  const { rows } = parseCsvText(csv);
  assert.deepEqual(rows, [
    ["1,2", "line1\nline2"],
    ['say "hi"', "plain"],
  ]);
});

test("parseCsvText: 列数が不正な行はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseCsvText("a,b,c\n1,2\n"), Sai3bInputError);
});

test("parseCsvText: 空ファイルはSai3bInputErrorを投げる", () => {
  assert.throws(() => parseCsvText(""), Sai3bInputError);
});

test("parseCsvText: 閉じられていない引用符はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseCsvText('a,b\n"1,2\n'), Sai3bInputError);
});

test("parseManifestJson: 不正なJSONはSai3bInputErrorを投げる", () => {
  assert.throws(() => parseManifestJson("{not json", "test"), Sai3bInputError);
});

test("parseManifestJson: 必須フィールド欠落はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseManifestJson(JSON.stringify({ schemaVersion: "1.0.0" }), "test"), Sai3bInputError);
});

test("parseManifestJson: 正常なmanifestを解析できる", () => {
  const manifest = parseManifestJson(
    JSON.stringify({
      schemaVersion: "1.0.0",
      runId: "r1",
      scenarioId: "baseline",
      standardBaselineId: "moderate-pressure",
      seeds: ["s1"],
      quarters: 2,
      companyIds: ["BAL"],
      aiPolicyVersion: "STANDARD_AI_PARAMETERS_V1",
      salesForceHeadcountTotal: 80,
      keyParameters: {},
      outputFormats: ["json", "csv"],
    }),
    "test"
  );
  assert.equal(manifest.runId, "r1");
  assert.equal(manifest.salesForceHeadcountTotal, 80);
});

test("parseCaseSummaryCsv: 必須列欠落はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseCaseSummaryCsv("seed,companyId\ns1,BAL\n", "test"), Sai3bInputError);
});

test("parseCaseSummaryCsv: 正常なCSVを解析できる（true/false・空値の扱いを含む）", () => {
  const csv =
    "seed,companyId,completedTurns,requestedTurns,completed,cumulativeRevenueUsd,cumulativeGrossProfitUsd,cumulativeOperatingProfitUsd,cumulativeSalesForceCostUsd,finalCashUsd,finalLoansUsd,finalAvailableAdditionalCapacityUsd,paymentDefaultEverByRequestedTurns,paymentDefaultFirstTurn,underwritingFrozenEverByRequestedTurns,underwritingFrozenFirstTurn,topReasonCodes,warningCount\n" +
    "s1,BAL,2,2,true,100,10,5,1,20,30,0,false,,false,,A|B,3\n";
  const rows = parseCaseSummaryCsv(csv, "test");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].paymentDefaultEverByRequestedTurns, false);
  assert.equal(rows[0].paymentDefaultFirstTurn, undefined);
  assert.deepEqual(rows[0].topReasonCodes, ["A", "B"]);
});

test("parseCaseSummaryCsv: 不正なbooleanはSai3bInputErrorを投げる", () => {
  const csv =
    "seed,companyId,completedTurns,requestedTurns,completed,cumulativeRevenueUsd,cumulativeGrossProfitUsd,cumulativeOperatingProfitUsd,cumulativeSalesForceCostUsd,finalCashUsd,finalLoansUsd,finalAvailableAdditionalCapacityUsd,paymentDefaultEverByRequestedTurns,paymentDefaultFirstTurn,underwritingFrozenEverByRequestedTurns,underwritingFrozenFirstTurn,topReasonCodes,warningCount\n" +
    "s1,BAL,2,2,YES,100,10,5,1,20,30,0,false,,false,,A|B,3\n";
  assert.throws(() => parseCaseSummaryCsv(csv, "test"), Sai3bInputError);
});

test("parseQuarterSummaryCsv: NaN文字列（数値化できない元値）はundefinedとして扱う", () => {
  const header =
    "seed,companyId,turn,period,startAvailableAdditionalCapacityUsd,netRevenueUsd,grossProfitUsd,operatingProfitUsd,netIncomeUsd,closingCashUsd,endingShortTermLoansUsd,endingLongTermLoansUsd,salesEffortCapacityHosoEqTonsActual,salesEffortUsedHosoEqTons,salesEffortUtilizationRate,salesReductionFromEffortConstraintHosoEqTons,rawMaterialInventoryHosoEqTons,finishedGoodsInventoryHosoEqTons,discardQuantityHosoEqTons,paymentDefault,paymentDefaultNewlyTriggered,underwritingFrozen,underwritingFrozenNewlyTriggered,warningCount\n";
  const row = "s1,BAL,1,2015Q1,NaN,100,10,5,5,20,0,0,100,99,0.99,1,0,0,0,false,false,false,false,1\n";
  const rows = parseQuarterSummaryCsv(header + row, "test");
  assert.equal(rows[0].startAvailableAdditionalCapacityUsd, undefined);
  assert.equal(rows[0].netRevenueUsd, 100);
});

test("parseDecisionTraceJsonl: 不正なJSON行はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseDecisionTraceJsonl("{not json}\n", "test"), Sai3bInputError);
});

test("parseDecisionTraceJsonl: 必須フィールド欠落はSai3bInputErrorを投げる", () => {
  assert.throws(() => parseDecisionTraceJsonl(JSON.stringify({ seed: "s1" }) + "\n", "test"), Sai3bInputError);
});

test("parseAdjustmentTraceCsv/parseWarningsCsv/parseRunSummaryJson: 正常系", () => {
  const adjHeader =
    "seed,companyId,turn,period,category,source,code,severity,affectedDecision,affectedMarketOrProduct,before,after,delta,message,threshold,relevantMetric\n";
  const adjRow = "s1,BAL,1,2015Q1,sales_effort_capacity,standardAi,CODE1,warning,sales,,,,,msg,,\n";
  const adjRows = parseAdjustmentTraceCsv(adjHeader + adjRow, "test");
  assert.equal(adjRows.length, 1);
  assert.equal(adjRows[0].before, undefined);

  const warnHeader = "seed,companyId,turn,period,code,source,severity,message\n";
  const warnRow = "s1,BAL,1,2015Q1,CODE1,standardAi,info,msg\n";
  const warnRows = parseWarningsCsv(warnHeader + warnRow, "test");
  assert.equal(warnRows.length, 1);

  const runSummary = parseRunSummaryJson(JSON.stringify({ runSummary: { runId: "r1" }, errors: [] }), "test");
  assert.equal(runSummary.errors.length, 0);
});
