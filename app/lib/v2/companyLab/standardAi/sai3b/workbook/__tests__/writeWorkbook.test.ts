// ShrimpX V2 — Phase SAI-3B-1: workbook組み立てのユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { loadSai3aRun } from "../../loadRun";
import { buildSai3bAnalysis } from "../../buildAnalysis";
import { buildSai3bWorkbook, renderSai3bWorkbookToBuffer } from "../writeWorkbook";
import { buildFixtureRunFiles } from "../../__tests__/testFixtures";

function analysisFromRuns(specs: readonly { runId: string; headcount: number; defaultAtTurn?: number }[]) {
  const runs = specs.map((s) => {
    const files = buildFixtureRunFiles({
      runId: s.runId,
      headcount: s.headcount,
      quarters: 2,
      cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: s.headcount, defaultAtTurn: s.defaultAtTurn }],
    });
    return loadSai3aRun({ runLabel: s.runId, sourceDir: `/tmp/${s.runId}`, files });
  });
  return buildSai3bAnalysis(runs, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
}

const EXPECTED_SHEETS = [
  "README",
  "経営ダッシュボード",
  "売上・数量推移",
  "市場シェア推移",
  "利益・採算推移",
  "資金繰り・財務推移",
  "在庫・運転資金推移",
  "全体サマリー",
  "グラフ",
  "会社別業績",
  "四半期業績",
  "販売分析",
  "調達_生産_在庫",
  "営業能力分析",
  "営業能力_市場別",
  "計画調整分析",
  "Default_信用_警告",
  "ReasonCode集計",
  "四半期判断トレース",
  "Raw_Case",
  "Raw_Quarter",
  "Raw_Decision",
  "Raw_Adjustment",
  "Raw_Warnings",
];

test("buildSai3bWorkbook: 単一runで必須シートがすべて存在する", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(wb.getWorksheet(name), `missing sheet: ${name}`);
  }
  // 単一run時は80_85_90人比較シートを作らない。
  assert.equal(wb.getWorksheet("80_85_90人比較"), undefined);
});

test("buildSai3bWorkbook: 複数run（headcount比較）で80_85_90人比較シートが追加される", () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("80_85_90人比較");
  assert.ok(ws);
});

// SAI-3B-2 §6: 80_85_90人比較シートに、乖離開始点の詳細テーブルが
// 既存の横並び比較表の下に追加されていること（経営ダッシュボードの要約とは別）。
test("buildSai3bWorkbook: headcountDivergenceがある場合、80_85_90人比較シートに乖離開始点の詳細テーブルが追加される", () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  assert.ok(analysis.headcountDivergence.length > 0, "前提: headcountDivergenceにデータがあること");
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("80_85_90人比較")!;
  const allText = ws
    .getSheetValues()
    .flat()
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  assert.match(allText, /80\/85\/90人比較の強化: 最初に乖離が始まった四半期（詳細）/);
  assert.match(allText, /乖離を検出したKPI/);
});

// 三宅さんのご指摘（受入レビュー2回目）§2: 営業人件費（cumulativeSalesForceCostUsd）が
// 従来Raw_Caseの生データダンプにしか存在しなかった（80_85_90人比較の正式KPIとして
// 未実装だった）ことの是正。横並び比較表の列として追加されていること、および
// 本シート自体にネイティブグラフ（会社×営業人数の比較グラフ）が追加されていることを検証する。
test("buildSai3bWorkbook: 80_85_90人比較シートに営業人件費列が追加される", () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("80_85_90人比較")!;
  const headerRow = ws.getRow(2).values as (string | undefined)[]; // 1行目はnote、2行目がヘッダー
  const headerTexts = headerRow.filter((v): v is string => typeof v === "string");
  assert.ok(
    headerTexts.some((h) => h.includes("営業人件費")),
    `営業人件費列が見つからない: ${JSON.stringify(headerTexts)}`
  );
});

test("renderSai3bWorkbookToBuffer: 80_85_90人比較シートに会社別営業人件費のネイティブグラフが追加される", async () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const buffer = await renderSai3bWorkbookToBuffer(analysis);
  const zip = await JSZip.loadAsync(buffer);
  const chartFileNames = Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
  let salesForceCostChartXml: string | undefined;
  for (const name of chartFileNames) {
    const xml = await zip.file(name)!.async("string");
    if (xml.includes("会社別 平均営業人件費")) {
      salesForceCostChartXml = xml;
      break;
    }
  }
  assert.ok(salesForceCostChartXml, "会社別 平均営業人件費のグラフXMLが見つからない");
});

test("buildSai3bWorkbook: 数値セルが文字列化されていない", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("会社別業績")!;
  // ヘッダー行(1行目)の次(2行目)が最初のデータ行。累計売上(USD)列(11列目)は数値のはず。
  const revenueCell = ws.getRow(2).getCell(11);
  assert.equal(typeof revenueCell.value, "number");
});

test("buildSai3bWorkbook: オートフィルター・ウィンドウ枠固定が設定されている", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("会社別業績")!;
  assert.ok(ws.autoFilter, "autoFilter should be set");
  assert.ok(ws.views && ws.views.length > 0 && ws.views[0].state === "frozen");
});

test("buildSai3bWorkbook: default/underwritingFrozenがないrunでも生成できる", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  assert.ok(wb.getWorksheet("Default_信用_警告"));
});

test("renderSai3bWorkbookToBuffer: グラフ付きxlsxを生成し、exceljsで再読込できる", async () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const buffer = await renderSai3bWorkbookToBuffer(analysis);
  assert.ok(buffer.length > 0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(wb.getWorksheet(name), `missing sheet after reload: ${name}`);
  }
  assert.ok(wb.getWorksheet("80_85_90人比較"));
});

// 三宅さんのご指摘（受入レビュー）に基づく回帰テスト:
// averageSalesEffortUtilizationRateが欠損しているrunがあっても、Excelの表・
// グラフ用データ表・ネイティブグラフのいずれでも0へ変換されないこと。
test("buildSai3bWorkbook: 営業能力使用率が欠損しているrunでも、表・グラフ用データが0に変換されない", () => {
  const normalFiles = buildFixtureRunFiles({
    runId: "h80",
    headcount: 80,
    quarters: 2,
    cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }],
  });
  const missingUtilFiles = buildFixtureRunFiles({
    runId: "h85",
    headcount: 85,
    quarters: 2,
    cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85 }],
    utilizationRateMissing: true,
  });
  const runs = [
    loadSai3aRun({ runLabel: "h80", sourceDir: "/tmp/h80", files: normalFiles }),
    loadSai3aRun({ runLabel: "h85", sourceDir: "/tmp/h85", files: missingUtilFiles }),
  ];
  const analysis = buildSai3bAnalysis(runs, { generatedAtIso: "2026-01-01T00:00:00.000Z" });

  // 集計値そのものがundefinedであり（0ではない）、正常runの値は数値のまま保持されていること。
  const h80Row = analysis.dashboard.find((r) => r.runLabel === "h80")!;
  const h85Row = analysis.dashboard.find((r) => r.runLabel === "h85")!;
  assert.equal(typeof h80Row.averageSalesEffortUtilizationRate, "number");
  assert.ok((h80Row.averageSalesEffortUtilizationRate ?? 0) > 0);
  assert.equal(h85Row.averageSalesEffortUtilizationRate, undefined, "欠損runの集計値はundefinedのはず（0ではない）");

  const wb = buildSai3bWorkbook(analysis);

  // 全体サマリーシート: note行(1)+header行(2)の後、3行目=h80、4行目=h85。
  // 平均営業能力使用率は20列目。
  const dashboardWs = wb.getWorksheet("全体サマリー")!;
  const UTIL_COL_DASHBOARD = 20;
  assert.equal(dashboardWs.getRow(2).getCell(UTIL_COL_DASHBOARD).value, "平均営業能力使用率");
  assert.notEqual(dashboardWs.getRow(3).getCell(UTIL_COL_DASHBOARD).value, 0);
  assert.equal(dashboardWs.getRow(4).getCell(UTIL_COL_DASHBOARD).value, "", "h85行の使用率セルは空欄（0ではない）のはず");

  // グラフ用データ表シート: 平均営業能力使用率は10列目（A〜J）。
  const chartDataWs = wb.getWorksheet("グラフ")!;
  const UTIL_COL_CHARTDATA = 10;
  assert.equal(chartDataWs.getRow(2).getCell(UTIL_COL_CHARTDATA).value, "平均営業能力使用率");
  assert.notEqual(chartDataWs.getRow(3).getCell(UTIL_COL_CHARTDATA).value, 0);
  assert.equal(chartDataWs.getRow(4).getCell(UTIL_COL_CHARTDATA).value, "", "h85行のグラフ用データセルも空欄（0ではない）のはず");
});

test("renderSai3bWorkbookToBuffer: 営業能力使用率が欠損しているrunは、ネイティブグラフのnumCacheでも0に置換されず空欄（<c:pt>省略）になる", async () => {
  const normalFiles = buildFixtureRunFiles({
    runId: "h80",
    headcount: 80,
    quarters: 2,
    cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }],
  });
  const missingUtilFiles = buildFixtureRunFiles({
    runId: "h85",
    headcount: 85,
    quarters: 2,
    cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 85 }],
    utilizationRateMissing: true,
  });
  const runs = [
    loadSai3aRun({ runLabel: "h80", sourceDir: "/tmp/h80", files: normalFiles }),
    loadSai3aRun({ runLabel: "h85", sourceDir: "/tmp/h85", files: missingUtilFiles }),
  ];
  const analysis = buildSai3bAnalysis(runs, { generatedAtIso: "2026-01-01T00:00:00.000Z" });

  const buffer = await renderSai3bWorkbookToBuffer(analysis);
  const zip = await JSZip.loadAsync(buffer);

  // SAI-3B-2でダッシュボード系シートのグラフが「グラフ」シートより先に追加され、
  // chart番号がグローバルに振られるため、固定範囲(1-4)ではなく実際に存在する
  // xl/charts/chart*.xmlすべてから「平均営業能力使用率」のグラフXMLを探す。
  const chartFileNames = Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
  assert.ok(chartFileNames.length > 0, "ネイティブグラフのXMLファイルが1つも見つからない");
  let utilChartXml: string | undefined;
  for (const name of chartFileNames) {
    const xml = await zip.file(name)!.async("string");
    if (xml.includes("平均営業能力使用率")) {
      utilChartXml = xml;
      break;
    }
  }
  assert.ok(utilChartXml, "営業能力使用率のグラフXMLが見つからない");

  // numCacheのptCountはrun数（2）のまま、かつ<c:v>0</c:v>を含まない
  // （h85＝2件目のデータ点はidx省略により空欄として表現される）。
  assert.match(utilChartXml!, /<c:ptCount val="2"\/>/);
  assert.doesNotMatch(utilChartXml!, /<c:v>0<\/c:v>/, "欠損データ点が0として書き込まれてはいけない");
  // idx="1"（2件目=h85）の<c:pt>が数値キャッシュに存在しないこと（省略されていること）。
  const valNumCacheMatch = /<c:val><c:numRef>[\s\S]*?<c:numCache>[\s\S]*?<\/c:numCache><\/c:numRef><\/c:val>/.exec(utilChartXml!);
  assert.ok(valNumCacheMatch, "val numCacheが見つからない");
  assert.doesNotMatch(valNumCacheMatch![0], /<c:pt idx="1">/, "欠損runのidxの<c:pt>は省略されているべき");
  assert.match(valNumCacheMatch![0], /<c:pt idx="0">/, "正常runのidxの<c:pt>は存在しているべき");
});
