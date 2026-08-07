// ShrimpX V2 — Phase SAI-3B-2: 経営KPIダッシュボード・グラフ拡充のユニットテスト
//
// dashboardCharts.tsが提供する各シート書き込み関数について、
// 三宅さんの指示§11（グラフ・シートの検証観点）のうち、writeWorkbook.test.ts側の
// 統合テストではカバーしきれないシート個別の観点（作成不能フォールバック・
// 会社別配色の一貫性・市場シェアの参加社数列・経営ダッシュボードのナビゲーション/
// 最新四半期スナップショット・80/85/90人の乖離要約）を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { loadSai3aRun } from "../../loadRun";
import { buildSai3bAnalysis } from "../../buildAnalysis";
import { buildFixtureRunFiles } from "../../__tests__/testFixtures";
import {
  writeAllDashboardSheets,
  writeCashFinanceSheet,
  writeExecutiveDashboardSheet,
  writeInventoryWorkingCapitalSheet,
  writeMarketShareSheet,
  writeProfitabilitySheet,
  writeSalesQuantitySheet,
} from "../dashboardCharts";
import { COMPANY_COLOR_HEX } from "../styles";
import type { Sai3bAnalysis } from "../../schema";

function analysisFromRuns(
  specs: readonly { runId: string; headcount: number; companyIds?: readonly string[]; defaultAtTurn?: number; omitMarketAllocationTrace?: boolean }[]
): Sai3bAnalysis {
  const runs = specs.map((s) => {
    const companyIds = s.companyIds ?? ["BAL"];
    const files = buildFixtureRunFiles({
      runId: s.runId,
      headcount: s.headcount,
      quarters: 2,
      cases: companyIds.map((companyId) => ({ seed: "s1", companyId, quarters: 2, headcount: s.headcount, defaultAtTurn: s.defaultAtTurn })),
    });
    if (s.omitMarketAllocationTrace) {
      delete (files as Record<string, string>)["market-allocation-trace.csv"];
    }
    return loadSai3aRun({ runLabel: s.runId, sourceDir: `/tmp/${s.runId}`, files });
  });
  return buildSai3bAnalysis(runs, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
}

test("writeAllDashboardSheets: 6シートが規定の順序（経営ダッシュボードを先頭に）で作成される", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  const results = writeAllDashboardSheets(wb, analysis);
  assert.deepEqual(
    results.map((r) => r.sheetName),
    ["経営ダッシュボード", "売上・数量推移", "市場シェア推移", "利益・採算推移", "資金繰り・財務推移", "在庫・運転資金推移"]
  );
  for (const name of results.map((r) => r.sheetName)) {
    assert.ok(wb.getWorksheet(name), `missing sheet: ${name}`);
  }
});

test("writeSalesQuantitySheet: fixtureデータがある場合、A・B両KPIのChartSpecが生成される", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  const result = writeSalesQuantitySheet(wb, analysis);
  // A（売上高）・B（実績販売数量、market-allocation-trace.csvあり）の2件。
  assert.equal(result.specs.length, 2);
  assert.ok(result.specs.some((s) => s.title.includes("会社別売上高推移")));
  assert.ok(result.specs.some((s) => s.title.includes("会社別販売数量推移")));
});

// 三宅さんのご指摘（受入レビュー2回目）§1: Layer2（会社・seed比較表）が
// Layer1（中央値ピボット表）と明確に区別されているか、平均・中央値・最小・
// 最大・標準偏差・seed数・defaultしたseed数の列がすべて存在するかを検証する。
test("writeSalesQuantitySheet: Layer2（会社・seed比較表）にLayer1とは別ラベル・平均/中央値/最小/最大/標準偏差/seed数/defaultしたseed数の列が書き込まれる", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  writeSalesQuantitySheet(wb, analysis);
  const ws = wb.getWorksheet("売上・数量推移")!;
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  assert.match(allText, /Layer2: 会社・seed比較表（seed横断の分布統計）/);
  assert.match(allText, /標準偏差/);
  assert.match(allText, /seed数\(n\)/);
  assert.match(allText, /defaultしたseed数/);
  // 旧・誤った実装（「時間方向の中央値のばらつき」を集計したもの）のラベルが
  // もう残っていないこと。
  assert.doesNotMatch(allText, /平均\(中央値の全turn平均\)/);
});

// H-5（運転資金の部分指標）は複数のStatSummaryのmedian同士の差分として計算される
// 合成KPIのため、個々のseedへ遡ってLayer2の分布統計を再構成できない。
// 捏造を避けるため、表ではなく明示的な「算出不可」ノートが出ることを検証する。
test("writeInventoryWorkingCapitalSheet: H-5（運転資金の部分指標）はLayer2の分布統計が「算出不可」ノートになる（表を捏造しない）", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  writeInventoryWorkingCapitalSheet(wb, analysis);
  const ws = wb.getWorksheet("在庫・運転資金推移")!;
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  assert.match(allText, /このKPIは複数のStatSummary[\s\S]*算出不可/);
});

test("writeMarketShareSheet: market-allocation-trace.csvを含まないrunのみの場合、作成不能ノートを出しChartSpecは空になる", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80, omitMarketAllocationTrace: true }]);
  assert.equal(analysis.marketShareStats.length, 0, "前提: marketShareStatsが空であること");
  const wb = new ExcelJS.Workbook();
  const result = writeMarketShareSheet(wb, analysis);
  assert.equal(result.specs.length, 0);
  const ws = wb.getWorksheet("市場シェア推移")!;
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  assert.match(allText, /現時点の出力データでは作成不能/);
});

test("writeMarketShareSheet: データがある場合、参加社数列と各社シェアが書き込まれ、グラフが市場ごとに生成される", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80, companyIds: ["BAL"] }]);
  assert.ok(analysis.marketShareStats.length > 0, "前提: marketShareStatsにデータがあること");
  const wb = new ExcelJS.Workbook();
  const result = writeMarketShareSheet(wb, analysis);
  // fixtureはCN市場のみ・BAL1社なので、CN市場のグラフが1件生成される。
  assert.ok(result.specs.length >= 1);
  assert.ok(result.specs.every((s) => s.title.includes("市場")));

  const ws = wb.getWorksheet("市場シェア推移")!;
  const headerRow = ws
    .getSheetValues()
    .find((row): row is (string | undefined)[] => Array.isArray(row) && row.includes("参加社数(5社中)"));
  assert.ok(headerRow, "参加社数(5社中)列のヘッダーが見つからない");
});

test("会社別配色（COMPANY_COLOR_HEX）が売上・数量推移シートと利益・採算推移シートの両方で同一会社に対して一致する", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80, companyIds: ["BAL", "MASS"] }]);
  const wb = new ExcelJS.Workbook();
  const salesResult = writeSalesQuantitySheet(wb, analysis);
  const profitResult = writeProfitabilitySheet(wb, analysis);

  for (const spec of [...salesResult.specs, ...profitResult.specs]) {
    for (const series of spec.series) {
      if (series.name === "BAL" || series.name === "MASS") {
        assert.equal(series.colorHex, COMPANY_COLOR_HEX[series.name], `series ${series.name} in "${spec.title}" should use canonical color`);
      }
    }
  }
});

test("writeCashFinanceSheet: E・F(1-3)・G(1-3)の7 KPIすべてがChartSpecを生成する（fixtureがCF3区分・借入・追加融資余力を含むため）", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  const result = writeCashFinanceSheet(wb, analysis);
  assert.equal(result.specs.length, 7);
});

test("writeExecutiveDashboardSheet: ナビゲーションのハイパーリンクと最新四半期スナップショットが書き込まれる", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = new ExcelJS.Workbook();
  const result = writeExecutiveDashboardSheet(wb, analysis);
  const ws = wb.getWorksheet("経営ダッシュボード")!;

  let foundHyperlinkToSalesSheet = false;
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value as ExcelJS.CellHyperlinkValue | unknown;
      if (v && typeof v === "object" && "hyperlink" in v && (v as ExcelJS.CellHyperlinkValue).hyperlink === "#'売上・数量推移'!A1") {
        foundHyperlinkToSalesSheet = true;
      }
    });
  });
  assert.ok(foundHyperlinkToSalesSheet, "売上・数量推移シートへのハイパーリンクが見つからない");

  // 最新四半期スナップショット: 会社別売上のヘッドラインチャートが1件（run1件）。
  assert.equal(result.specs.length, 1);
  assert.ok(result.specs[0].title.includes("会社別売上"));
});

test("writeExecutiveDashboardSheet: headcountDivergenceがある場合、80/85/90乖離要約テーブルが追加される", () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const wb = new ExcelJS.Workbook();
  writeExecutiveDashboardSheet(wb, analysis);
  const ws = wb.getWorksheet("経営ダッシュボード")!;
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  if (analysis.headcountDivergence.length > 0) {
    assert.match(allText, /80\/85\/90人比較: 最初に乖離が始まった四半期/);
  }
});
