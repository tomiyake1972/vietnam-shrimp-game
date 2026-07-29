// ShrimpX V2 — Phase SAI-3B-1: ネイティブExcelグラフの後付け注入
//
// 【背景】本リポジトリのexceljs（4.4.0）はネイティブのExcelグラフ書き込みに
// 対応していない（xlsx/xform/book/workbook-xform.jsに「chartsheetsをサポート
// するインフラがない」旨のコメントがあり、実装上もaddChart等のAPIが存在しない）。
// 新規のグラフ専用npm依存を追加する代わりに、既存依存のjszip（package.json既存）
// を用いて、exceljsが生成したxlsx（zipアーカイブ）へ、最小限のネイティブグラフ
// （棒グラフ）のOOXMLパーツを直接追加する。
//
// 【方針】グラフの元データは、すべて既に「グラフ」シート上にexceljsで書き込み
// 済みのセル範囲を参照するのみで、Excel側で値を再計算しない。参照先の値は
// 生成時点のSai3bAnalysisの値をキャッシュ値としても埋め込む（Excelが開いた際に
// 再計算されるまでの間も正しい値が表示されるようにするため。値の再計算ロジックは
// 一切持たない、単なる表示用キャッシュ）。

import JSZip from "jszip";

export interface ChartSeriesSpec {
  readonly name: string;
  /** 値のセル範囲（例: "'グラフ'!$C$2:$C$4"）。 */
  readonly valuesRef: string;
  readonly values: readonly number[];
}

export interface ChartSpec {
  readonly title: string;
  readonly type: "bar" | "line";
  /** カテゴリ（横軸）のセル範囲（例: "'グラフ'!$A$2:$A$4"）。 */
  readonly categoriesRef: string;
  readonly categories: readonly string[];
  readonly series: readonly ChartSeriesSpec[];
  /** アンカー位置（0-indexed列・行）。 */
  readonly anchorCol: number;
  readonly anchorRow: number;
  readonly widthCols: number;
  readonly heightRows: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildStrCache(values: readonly string[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join("");
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`;
}

function buildNumCache(values: readonly number[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`).join("");
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function buildSeriesXml(spec: ChartSpec, series: ChartSeriesSpec, idx: number): string {
  return (
    `<c:ser>` +
    `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:v>${xmlEscape(series.name)}</c:v></c:tx>` +
    `<c:cat><c:strRef><c:f>${xmlEscape(spec.categoriesRef)}</c:f>${buildStrCache(spec.categories)}</c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${xmlEscape(series.valuesRef)}</c:f>${buildNumCache(series.values)}</c:numRef></c:val>` +
    (spec.type === "line" ? `<c:smooth val="0"/>` : ``) +
    `</c:ser>`
  );
}

function buildChartXml(spec: ChartSpec, index: number): string {
  const axId1 = 100000000 + index * 2;
  const axId2 = axId1 + 1;
  const seriesXml = spec.series.map((s, i) => buildSeriesXml(spec, s, i)).join("");
  const chartTypeTag = spec.type === "bar" ? "barChart" : "lineChart";
  const chartTypeSpecific = spec.type === "bar" ? `<c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` : `<c:grouping val="standard"/><c:varyColors val="0"/>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:chart>` +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlEscape(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
    `<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>` +
    `<c:${chartTypeTag}>${chartTypeSpecific}${seriesXml}<c:axId val="${axId1}"/><c:axId val="${axId2}"/></c:${chartTypeTag}>` +
    `<c:catAx><c:axId val="${axId1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${axId2}"/></c:catAx>` +
    `<c:valAx><c:axId val="${axId2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${axId1}"/></c:valAx>` +
    `</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/></c:legend>` +
    `<c:plotVisOnly val="1"/>` +
    `</c:chart>` +
    `</c:chartSpace>`
  );
}

function buildDrawingXml(specs: readonly ChartSpec[]): string {
  const anchors = specs
    .map((spec, i) => {
      const fromRow = spec.anchorRow;
      const fromCol = spec.anchorCol;
      const toRow = fromRow + spec.heightRows;
      const toCol = fromCol + spec.widthCols;
      const rId = `rId${i + 1}`;
      return (
        `<xdr:twoCellAnchor>` +
        `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro="">` +
        `<xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rId}"/>` +
        `</a:graphicData></a:graphic>` +
        `</xdr:graphicFrame>` +
        `<xdr:clientData/>` +
        `</xdr:twoCellAnchor>`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    anchors +
    `</xdr:wsDr>`
  );
}

function buildDrawingRelsXml(chartCount: number): string {
  const rels = Array.from({ length: chartCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

/** xl/workbook.xml と xl/_rels/workbook.xml.rels から、シート名 -> 実ファイルパス（例: xl/worksheets/sheet3.xml）を解決する。 */
function resolveSheetFilePath(workbookXml: string, workbookRelsXml: string, sheetName: string): string {
  const sheetTagMatch = new RegExp(`<sheet[^>]*name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`).exec(workbookXml);
  if (!sheetTagMatch) throw new Error(`chartInjector: workbook.xml内にシート名 "${sheetName}" が見つかりません。`);
  const ridMatch = /r:id="([^"]+)"/.exec(sheetTagMatch[0]);
  if (!ridMatch) throw new Error(`chartInjector: シート "${sheetName}" のr:idが見つかりません。`);
  const rid = ridMatch[1];
  const relMatch = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*/>`).exec(workbookRelsXml);
  if (!relMatch) throw new Error(`chartInjector: workbook.xml.rels内にr:id "${rid}" のRelationshipが見つかりません。`);
  const targetMatch = /Target="([^"]+)"/.exec(relMatch[0]);
  if (!targetMatch) throw new Error(`chartInjector: Relationship "${rid}" のTargetが見つかりません。`);
  return `xl/${targetMatch[1]}`;
}

/**
 * exceljsが生成したxlsxバッファへ、指定したシート（chartSheetName）上に
 * ネイティブの棒/線グラフを追加する。参照範囲はすべて既にシート上に書き込み
 * 済みのセルを指すのみで、値の再計算は行わない。
 */
export async function injectNativeCharts(xlsxBuffer: Buffer, chartSheetName: string, specs: readonly ChartSpec[]): Promise<Buffer> {
  if (specs.length === 0) return xlsxBuffer;

  const zip = await JSZip.loadAsync(xlsxBuffer);

  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const sheetPath = resolveSheetFilePath(workbookXml, workbookRelsXml, chartSheetName);
  const sheetFileName = sheetPath.split("/").pop()!;

  let sheetXml = await zip.file(sheetPath)!.async("string");
  if (!sheetXml.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')) {
    sheetXml = sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  }

  const sheetRelsPath = `xl/worksheets/_rels/${sheetFileName}.rels`;
  const existingSheetRels = zip.file(sheetRelsPath);
  const existingRelsXml = existingSheetRels ? await existingSheetRels.async("string") : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const drawingRid = `rIdSai3bChartDrawing1`;
  const newSheetRelsXml = existingRelsXml.replace(
    "</Relationships>",
    `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`
  );

  if (!sheetXml.includes("<drawing ")) {
    sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${drawingRid}"/></worksheet>`);
  }

  const drawingXml = buildDrawingXml(specs);
  const drawingRelsXml = buildDrawingRelsXml(specs.length);

  zip.file(sheetPath, sheetXml);
  zip.file(sheetRelsPath, newSheetRelsXml);
  zip.file("xl/drawings/drawing1.xml", drawingXml);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", drawingRelsXml);
  specs.forEach((spec, i) => {
    zip.file(`xl/charts/chart${i + 1}.xml`, buildChartXml(spec, i));
  });

  const contentTypesPath = "[Content_Types].xml";
  let contentTypesXml = await zip.file(contentTypesPath)!.async("string");
  const additions: string[] = [];
  if (!contentTypesXml.includes("/xl/drawings/drawing1.xml")) {
    additions.push(`<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
  }
  for (let i = 0; i < specs.length; i++) {
    const partName = `/xl/charts/chart${i + 1}.xml`;
    if (!contentTypesXml.includes(partName)) {
      additions.push(`<Override PartName="${partName}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    }
  }
  if (additions.length > 0) {
    contentTypesXml = contentTypesXml.replace("</Types>", `${additions.join("")}</Types>`);
    zip.file(contentTypesPath, contentTypesXml);
  }

  const outBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return outBuffer;
}
