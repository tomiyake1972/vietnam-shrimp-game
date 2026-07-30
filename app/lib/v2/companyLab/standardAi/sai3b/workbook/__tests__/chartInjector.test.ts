// ShrimpX V2 — Phase SAI-3B-1: chartInjector.ts のユニットテスト
//
// exceljsはネイティブグラフの書き込みに対応していないため、生成されたxlsxが
// 破損していないこと（zip構造として正しく開けること、chart/drawingパーツが
// 実際に追加されていること）を直接検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { injectNativeCharts, injectNativeChartsMultiSheet } from "../chartInjector";

async function buildBaseWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("グラフ");
  ws.addRow(["headcount", "defaultRate"]);
  ws.addRow([80, 0.483]);
  ws.addRow([85, 0.967]);
  ws.addRow([90, 0.433]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildTwoSheetWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet("シートA");
  ws1.addRow(["headcount", "value"]);
  ws1.addRow([80, 100]);
  ws1.addRow([85, 200]);
  const ws2 = wb.addWorksheet("シートB");
  ws2.addRow(["quarter", "value"]);
  ws2.addRow(["2015Q1", 10]);
  ws2.addRow(["2015Q2", 20]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("injectNativeCharts: グラフを追加してもzipとして破損せず開ける", async () => {
  const base = await buildBaseWorkbookBuffer();
  const out = await injectNativeCharts(base, "グラフ", [
    {
      title: "Default rate by headcount",
      type: "bar",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "defaultRate", valuesRef: "'グラフ'!$B$2:$B$4", values: [0.483, 0.967, 0.433] }],
      anchorCol: 3,
      anchorRow: 0,
      widthCols: 8,
      heightRows: 15,
    },
  ]);

  const zip = await JSZip.loadAsync(out);
  assert.ok(zip.file("xl/charts/chart1.xml"), "chart1.xml should exist");
  assert.ok(zip.file("xl/drawings/drawing1.xml"), "drawing1.xml should exist");
  assert.ok(zip.file("xl/drawings/_rels/drawing1.xml.rels"), "drawing rels should exist");

  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(contentTypes, /chart1\.xml/);
  assert.match(contentTypes, /drawing1\.xml/);

  // exceljsでの再読込がエラーにならないこと（他シート・データが壊れていないこと）。
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("グラフ")!;
  assert.equal(ws.getRow(2).getCell(1).value, 80);
  assert.equal(ws.getRow(3).getCell(2).value, 0.967);
});

test("injectNativeCharts: グラフ仕様が空の場合は元バッファをそのまま返す", async () => {
  const base = await buildBaseWorkbookBuffer();
  const out = await injectNativeCharts(base, "グラフ", []);
  assert.equal(out, base);
});

test("injectNativeCharts: 複数グラフを同一シートへ追加できる", async () => {
  const base = await buildBaseWorkbookBuffer();
  const out = await injectNativeCharts(base, "グラフ", [
    {
      title: "Chart 1",
      type: "bar",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "s1", valuesRef: "'グラフ'!$B$2:$B$4", values: [1, 2, 3] }],
      anchorCol: 3,
      anchorRow: 0,
      widthCols: 6,
      heightRows: 10,
    },
    {
      title: "Chart 2",
      type: "line",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "s2", valuesRef: "'グラフ'!$B$2:$B$4", values: [4, 5, 6] }],
      anchorCol: 3,
      anchorRow: 12,
      widthCols: 6,
      heightRows: 10,
    },
  ]);
  const zip = await JSZip.loadAsync(out);
  assert.ok(zip.file("xl/charts/chart1.xml"));
  assert.ok(zip.file("xl/charts/chart2.xml"));
  const drawing = await zip.file("xl/drawings/drawing1.xml")!.async("string");
  const anchorCount = (drawing.match(/<xdr:twoCellAnchor>/g) ?? []).length;
  assert.equal(anchorCount, 2);
});

// SAI-3B-2で追加。複数のダッシュボードシートにグラフを分散配置するための
// injectNativeChartsMultiSheetが、シートをまたいでchart/drawingパーツ番号を
// 正しくユニーク採番し、どちらのシートにもグラフが実際に追加されることを確認する。
test("injectNativeChartsMultiSheet: 複数シートへそれぞれグラフを追加でき、chart/drawing番号がワークブック全体でユニークになる", async () => {
  const base = await buildTwoSheetWorkbookBuffer();
  const out = await injectNativeChartsMultiSheet(base, [
    {
      sheetName: "シートA",
      specs: [
        {
          title: "Chart on Sheet A",
          type: "bar",
          categoriesRef: "'シートA'!$A$2:$A$3",
          categories: ["80", "85"],
          series: [{ name: "value", valuesRef: "'シートA'!$B$2:$B$3", values: [100, 200] }],
          anchorCol: 3,
          anchorRow: 0,
          widthCols: 6,
          heightRows: 10,
        },
      ],
    },
    {
      sheetName: "シートB",
      specs: [
        {
          title: "Chart 1 on Sheet B",
          type: "line",
          categoriesRef: "'シートB'!$A$2:$A$3",
          categories: ["2015Q1", "2015Q2"],
          series: [{ name: "value", valuesRef: "'シートB'!$B$2:$B$3", values: [10, 20] }],
          anchorCol: 3,
          anchorRow: 0,
          widthCols: 6,
          heightRows: 10,
        },
        {
          title: "Chart 2 on Sheet B",
          type: "bar",
          categoriesRef: "'シートB'!$A$2:$A$3",
          categories: ["2015Q1", "2015Q2"],
          series: [{ name: "value2", valuesRef: "'シートB'!$B$2:$B$3", values: [30, 40] }],
          anchorCol: 3,
          anchorRow: 12,
          widthCols: 6,
          heightRows: 10,
        },
      ],
    },
  ]);

  const zip = await JSZip.loadAsync(out);
  // シートA用drawing1・シートB用drawing2、chart1(シートA)・chart2/chart3(シートB)が
  // それぞれ存在し、番号が衝突していないこと。
  assert.ok(zip.file("xl/drawings/drawing1.xml"), "drawing1.xml (シートA) should exist");
  assert.ok(zip.file("xl/drawings/drawing2.xml"), "drawing2.xml (シートB) should exist");
  assert.ok(zip.file("xl/charts/chart1.xml"), "chart1.xml should exist");
  assert.ok(zip.file("xl/charts/chart2.xml"), "chart2.xml should exist");
  assert.ok(zip.file("xl/charts/chart3.xml"), "chart3.xml should exist");
  assert.ok(!zip.file("xl/charts/chart4.xml"), "chart4.xmlは存在しないはず（グラフは合計3件）");

  const chart1Xml = await zip.file("xl/charts/chart1.xml")!.async("string");
  assert.match(chart1Xml, /Chart on Sheet A/);
  const chart2Xml = await zip.file("xl/charts/chart2.xml")!.async("string");
  assert.match(chart2Xml, /Chart 1 on Sheet B/);
  const chart3Xml = await zip.file("xl/charts/chart3.xml")!.async("string");
  assert.match(chart3Xml, /Chart 2 on Sheet B/);

  const drawing2Rels = await zip.file("xl/drawings/_rels/drawing2.xml.rels")!.async("string");
  assert.match(drawing2Rels, /Target="\.\.\/charts\/chart2\.xml"/);
  assert.match(drawing2Rels, /Target="\.\.\/charts\/chart3\.xml"/);

  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  for (const part of ["drawing1.xml", "drawing2.xml", "chart1.xml", "chart2.xml", "chart3.xml"]) {
    assert.match(contentTypes, new RegExp(part.replace(".", "\\.")));
  }

  // exceljsで再読込でき、両シートのデータが壊れていないこと。
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out as unknown as ExcelJS.Buffer);
  assert.equal(wb.getWorksheet("シートA")!.getRow(2).getCell(1).value, 80);
  assert.equal(wb.getWorksheet("シートB")!.getRow(3).getCell(2).value, 20);
});

test("injectNativeCharts: colorHexを指定した系列は、bar/lineそれぞれ正しい形式でspPrへ出力される", async () => {
  const base = await buildBaseWorkbookBuffer();
  const out = await injectNativeCharts(base, "グラフ", [
    {
      title: "Bar with color",
      type: "bar",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "s1", valuesRef: "'グラフ'!$B$2:$B$4", values: [1, 2, 3], colorHex: "4472C4" }],
      anchorCol: 3,
      anchorRow: 0,
      widthCols: 6,
      heightRows: 10,
    },
    {
      title: "Line with color",
      type: "line",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "s2", valuesRef: "'グラフ'!$B$2:$B$4", values: [1, 2, 3], colorHex: "ED7D31" }],
      anchorCol: 3,
      anchorRow: 12,
      widthCols: 6,
      heightRows: 10,
    },
  ]);
  const zip = await JSZip.loadAsync(out);
  const chart1Xml = await zip.file("xl/charts/chart1.xml")!.async("string");
  assert.match(chart1Xml, /<c:spPr><a:solidFill><a:srgbClr val="4472C4"\/><\/a:solidFill><\/c:spPr>/);
  const chart2Xml = await zip.file("xl/charts/chart2.xml")!.async("string");
  assert.match(chart2Xml, /<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="ED7D31"\/><\/a:solidFill><\/a:ln><\/c:spPr>/);
});

test("injectNativeChartsMultiSheet: すべてのシートでspecsが空なら元バッファをそのまま返す", async () => {
  const base = await buildTwoSheetWorkbookBuffer();
  const out = await injectNativeChartsMultiSheet(base, [
    { sheetName: "シートA", specs: [] },
    { sheetName: "シートB", specs: [] },
  ]);
  assert.equal(out, base);
});

// 三宅さんのご指摘（受入レビュー）に基づく回帰テスト: 欠損値（undefined）を
// 渡した場合、numCacheが0へ置換せず、当該idxの<c:pt>自体を省略すること。
test("injectNativeCharts: seriesにundefinedを含む場合、0へ変換せずnumCacheの当該idxを省略する", async () => {
  const base = await buildBaseWorkbookBuffer();
  const out = await injectNativeCharts(base, "グラフ", [
    {
      title: "Missing value chart",
      type: "bar",
      categoriesRef: "'グラフ'!$A$2:$A$4",
      categories: ["80", "85", "90"],
      series: [{ name: "defaultRate", valuesRef: "'グラフ'!$B$2:$B$4", values: [0.483, undefined, 0.433] }],
      anchorCol: 3,
      anchorRow: 0,
      widthCols: 8,
      heightRows: 15,
    },
  ]);

  const zip = await JSZip.loadAsync(out);
  const chartXml = await zip.file("xl/charts/chart1.xml")!.async("string");

  // 数値(val/numCache)側のみを対象に検証する。カテゴリ(cat/strCache)側は
  // "80"/"85"/"90"のラベル3件がすべて存在するのが正しく、idx="1"を含んでいて
  // 問題ない（欠損しているのは値であってカテゴリラベルではないため）。
  const valNumCacheMatch = /<c:val><c:numRef>[\s\S]*?<c:numCache>[\s\S]*?<\/c:numCache><\/c:numRef><\/c:val>/.exec(chartXml);
  assert.ok(valNumCacheMatch, "val numCacheが見つからない");
  const numCacheXml = valNumCacheMatch![0];

  assert.match(numCacheXml, /<c:ptCount val="3"\/>/, "ptCountは元の配列長(3)のままのはず");
  assert.doesNotMatch(numCacheXml, /<c:v>0<\/c:v>/, "欠損データ点が0として書き込まれてはいけない");
  assert.match(numCacheXml, /<c:pt idx="0"><c:v>0\.483<\/c:v><\/c:pt>/);
  assert.doesNotMatch(numCacheXml, /<c:pt idx="1">/, "欠損(idx=1)の<c:pt>は省略されているべき");
  assert.match(numCacheXml, /<c:pt idx="2"><c:v>0\.433<\/c:v><\/c:pt>/);
});
