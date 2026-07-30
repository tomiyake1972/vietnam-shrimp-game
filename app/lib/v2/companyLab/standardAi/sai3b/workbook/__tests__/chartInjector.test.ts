// ShrimpX V2 — Phase SAI-3B-1: chartInjector.ts のユニットテスト
//
// exceljsはネイティブグラフの書き込みに対応していないため、生成されたxlsxが
// 破損していないこと（zip構造として正しく開けること、chart/drawingパーツが
// 実際に追加されていること）を直接検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { injectNativeCharts } from "../chartInjector";

async function buildBaseWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("グラフ");
  ws.addRow(["headcount", "defaultRate"]);
  ws.addRow([80, 0.483]);
  ws.addRow([85, 0.967]);
  ws.addRow([90, 0.433]);
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
