// ShrimpX V2 — Phase SAI-3B-1: Excelブック共通スタイル定義
//
// companyLab/adminExport/companyLabAdminExcelBuilder.ts と同じ命名規則
// （Arial・ヘッダー塗り潰し・USD書式）を踏襲し、SAI-3B独自の色分けを追加する
// （三宅さんの指示§5「入力条件と集計結果の色分け」「default・重大警告・負の現金の
// 条件付き書式」）。

import ExcelJS from "exceljs";

export const FONT_NAME = "Arial" as const;

export const HEADER_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, bold: true, size: 11, color: { argb: "FFFFFFFF" } };
export const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
export const SUBHEADER_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, bold: true, size: 11, color: { argb: "FF000000" } };
export const SUBHEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
export const BODY_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 10 };
export const NOTE_FONT: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 9, italic: true, color: { argb: "FF808080" } };

/** 入力条件（実行時に指定された値）セルの塗り潰し色。 */
export const INPUT_CONDITION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
/** 集計結果セルの塗り潰し色。 */
export const AGGREGATE_RESULT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };

export const USD_FORMAT = '$#,##0;[Red]($#,##0);"-"';
export const QUANTITY_FORMAT = "#,##0.0;[Red](#,##0.0);\"-\"";
export const RATE_FORMAT = "0.0%;[Red](0.0%);\"-\"";
export const INTEGER_FORMAT = "#,##0;[Red](#,##0);\"-\"";

export function writeHeaderRow(ws: ExcelJS.Worksheet, values: readonly (string | number)[]): ExcelJS.Row {
  const row = ws.addRow(values as (string | number)[]);
  row.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  row.height = 24;
  return row;
}

/** ヘッダー行を固定し（freeze pane）、データ範囲にオートフィルターを設定する。
 *  freezeRows=1、freezeCols=先頭の識別列数（会社ID・seed等）を既定2列とする。 */
export function applyFreezeAndFilter(ws: ExcelJS.Worksheet, headerRowNumber: number, freezeCols = 0): void {
  ws.views = [{ state: "frozen", xSplit: freezeCols, ySplit: headerRowNumber, activeCell: "A1" }];
  const lastRow = ws.rowCount;
  if (lastRow > headerRowNumber) {
    ws.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: lastRow, column: ws.columnCount } };
  }
}

export function columnLetter(index1Based: number): string {
  let n = index1Based;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** booleanをtrue/falseの文字列ではなく、日本語「はい/いいえ」に変換して見やすくする
 *  （元の値そのものは変えず、表示のみの変換）。 */
export function boolToLabel(v: boolean | undefined): string {
  if (v === undefined) return "";
  return v ? "はい" : "いいえ";
}

// ---------------------------------------------------------------------
// SAI-3B-2で追加。会社別・営業人数別の色をブック全体で一貫させるための
// 固定パレット（三宅さんの指示§7「会社A〜E・80/85/90人の配色を全シートで統一」）。
// ---------------------------------------------------------------------

/** 会社IDの標準表示順（全シート共通。report/decomposeHarness.tsのALL_COMPANY_IDSと同じ順）。 */
export const CANONICAL_COMPANY_ORDER: readonly string[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

/** 会社ID(SaiCompanyId) -> 色（6桁HEX、"#"なし）。全シートで同じ会社は同じ色。 */
export const COMPANY_COLOR_HEX: Readonly<Record<string, string>> = {
  BAL: "4472C4", // 青
  MASS: "ED7D31", // オレンジ
  JPQ: "A5A5A5", // グレー
  VAP: "FFC000", // 黄
  CONSV: "70AD47", // 緑
};

export function companyColorHex(companyId: string): string | undefined {
  return COMPANY_COLOR_HEX[companyId];
}

/** 営業人数(headcount) -> 色。80/85/90の3値が主な用途だが、他の値が来ても
 *  ソート順に応じて固定パレットを順番に割り当てることで一貫性を保つ。 */
const HEADCOUNT_PALETTE: readonly string[] = ["4472C4", "C00000", "70AD47", "FFC000", "7030A0", "1F4E78"];

export function headcountColorHex(sortedHeadcounts: readonly number[], headcount: number): string | undefined {
  const idx = sortedHeadcounts.indexOf(headcount);
  if (idx < 0) return undefined;
  return HEADCOUNT_PALETTE[idx % HEADCOUNT_PALETTE.length];
}
