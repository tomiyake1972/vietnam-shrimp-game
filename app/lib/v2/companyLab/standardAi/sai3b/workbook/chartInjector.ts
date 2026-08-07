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
  /** 値が存在しない（SAI-3Aログ側で欠損している）データ点はundefinedを渡す。
   *  0への置換は行わない。buildNumCacheがそのidxの<c:pt>要素自体を省略する
   *  ことで、グラフ上は空欄（棒グラフなら棒なし、線グラフなら線が途切れる）
   *  として表現される（三宅さんの指示：欠損値をゼロへ変換しない設計原則）。 */
  readonly values: readonly (number | undefined)[];
  /** SAI-3B-2で追加。系列の色（6桁HEX、例: "4472C4"）。会社別・営業人数別の
   *  色を全シートで一貫させるため（三宅さんの指示§7）。未指定時はExcelの
   *  既定テーマ配色に委ねる。 */
  readonly colorHex?: string;
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

function buildNumCache(values: readonly (number | undefined)[]): string {
  // 欠損（undefined）・非有限値（NaN/Infinity）のデータ点は<c:pt>自体を出力しない。
  // OOXMLでは、あるidxの<c:pt>を省略することでそのデータ点が「空欄」として扱われる
  // （棒グラフなら棒が描かれず、線グラフなら線が途切れる）。0を書き込んで実データの
  // ゼロと区別がつかなくなることを避けるため、意図的にこの表現を用いる。
  const pts = values
    .map((v, i) => (v !== undefined && Number.isFinite(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : ""))
    .join("");
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function buildSeriesShapeProps(spec: ChartSpec, colorHex: string): string {
  // 棒グラフは塗りつぶし色、線グラフは線色として同じ色指定を適用する。
  if (spec.type === "bar") {
    return `<c:spPr><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill></c:spPr>`;
  }
  return `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill></a:ln></c:spPr>`;
}

function buildSeriesXml(spec: ChartSpec, series: ChartSeriesSpec, idx: number): string {
  return (
    `<c:ser>` +
    `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:v>${xmlEscape(series.name)}</c:v></c:tx>` +
    (series.colorHex ? buildSeriesShapeProps(spec, series.colorHex) : ``) +
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

/** chartFileNumbers: このdrawingが参照するchart{N}.xmlの実ファイル番号（グローバル、
 *  シートをまたいでユニーク）。rId自体はこのdrawing内でローカルに1から振り直す
 *  （drawingXmlのrIdと1:1対応させるため、配列のインデックス順=rId順とする）。 */
function buildDrawingRelsXml(chartFileNumbers: readonly number[]): string {
  const rels = chartFileNumbers
    .map((n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`)
    .join("");
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

/** 1シートぶんの注入対象（シート名＋そのシートに追加するグラフ仕様一覧）。 */
export interface SheetChartSpecs {
  readonly sheetName: string;
  readonly specs: readonly ChartSpec[];
}

/**
 * exceljsが生成したxlsxバッファへ、複数シートにまたがってネイティブの棒/線
 * グラフを追加する（SAI-3B-2で複数のダッシュボードシートにグラフを分散配置
 * するために一般化）。参照範囲はすべて既にシート上に書き込み済みのセルを
 * 指すのみで、値の再計算は行わない。chart{N}.xml・drawing{N}.xmlのファイル
 * 番号はワークブック全体でユニークになるよう、シートをまたいで採番する
 * （xl/charts/・xl/drawings/はワークブック共通の単一ディレクトリのため）。
 */
export async function injectNativeChartsMultiSheet(xlsxBuffer: Buffer, sheetSpecs: readonly SheetChartSpecs[]): Promise<Buffer> {
  const nonEmpty = sheetSpecs.filter((s) => s.specs.length > 0);
  if (nonEmpty.length === 0) return xlsxBuffer;

  const zip = await JSZip.loadAsync(xlsxBuffer);

  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");

  const contentTypesPath = "[Content_Types].xml";
  let contentTypesXml = await zip.file(contentTypesPath)!.async("string");
  const contentTypeAdditions: string[] = [];

  let globalChartCounter = 0;

  for (let drawingIndex = 0; drawingIndex < nonEmpty.length; drawingIndex++) {
    const { sheetName, specs } = nonEmpty[drawingIndex];
    const drawingNumber = drawingIndex + 1;

    const sheetPath = resolveSheetFilePath(workbookXml, workbookRelsXml, sheetName);
    const sheetFileName = sheetPath.split("/").pop()!;

    let sheetXml = await zip.file(sheetPath)!.async("string");
    if (!sheetXml.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')) {
      sheetXml = sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    }

    const sheetRelsPath = `xl/worksheets/_rels/${sheetFileName}.rels`;
    const existingSheetRels = zip.file(sheetRelsPath);
    const existingRelsXml = existingSheetRels
      ? await existingSheetRels.async("string")
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const drawingRid = `rIdSai3bChartDrawing${drawingNumber}`;
    const newSheetRelsXml = existingRelsXml.replace(
      "</Relationships>",
      `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingNumber}.xml"/></Relationships>`
    );

    if (!sheetXml.includes("<drawing ")) {
      sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${drawingRid}"/></worksheet>`);
    }

    const chartFileNumbers = specs.map(() => ++globalChartCounter);
    const drawingXml = buildDrawingXml(specs);
    const drawingRelsXml = buildDrawingRelsXml(chartFileNumbers);

    zip.file(sheetPath, sheetXml);
    zip.file(sheetRelsPath, newSheetRelsXml);
    zip.file(`xl/drawings/drawing${drawingNumber}.xml`, drawingXml);
    zip.file(`xl/drawings/_rels/drawing${drawingNumber}.xml.rels`, drawingRelsXml);
    specs.forEach((spec, i) => {
      zip.file(`xl/charts/chart${chartFileNumbers[i]}.xml`, buildChartXml(spec, chartFileNumbers[i]));
    });

    const drawingPartName = `/xl/drawings/drawing${drawingNumber}.xml`;
    if (!contentTypesXml.includes(drawingPartName)) {
      contentTypeAdditions.push(`<Override PartName="${drawingPartName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    }
    for (const n of chartFileNumbers) {
      const partName = `/xl/charts/chart${n}.xml`;
      if (!contentTypesXml.includes(partName)) {
        contentTypeAdditions.push(`<Override PartName="${partName}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      }
    }
  }

  if (contentTypeAdditions.length > 0) {
    contentTypesXml = contentTypesXml.replace("</Types>", `${contentTypeAdditions.join("")}</Types>`);
    zip.file(contentTypesPath, contentTypesXml);
  }

  const outBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return outBuffer;
}

/**
 * 単一シートのみへグラフを追加する（後方互換のための薄いラッパー。
 * SAI-3B-1時点のAPIをそのまま維持する）。
 */
export async function injectNativeCharts(xlsxBuffer: Buffer, chartSheetName: string, specs: readonly ChartSpec[]): Promise<Buffer> {
  if (specs.length === 0) return xlsxBuffer;
  return injectNativeChartsMultiSheet(xlsxBuffer, [{ sheetName: chartSheetName, specs }]);
}
