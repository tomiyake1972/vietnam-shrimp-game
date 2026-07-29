// ShrimpX V2 — Phase SAI-3B-1: Excelブック組み立て（ExcelJS）
//
// Sai3bAnalysis（buildAnalysis.tsが組み立てた、全シートぶんの集計済みデータ）を
// 受け取り、ExcelJS.Workbookへ変換する。ここでは値の計算・集計は一切行わない
// （集計はaggregate.ts側の責務。本ファイルは表示・書式のみを担当する）。
// fsには触れない（実際のファイル書き込みはcli層・scripts/sai3bExcel.tsが行う）。

import ExcelJS from "exceljs";
import {
  DashboardSummaryRow,
  Sai3bAnalysis,
} from "../schema";
import {
  applyFreezeAndFilter,
  AGGREGATE_RESULT_FILL,
  BODY_FONT,
  boolToLabel,
  columnLetter,
  INPUT_CONDITION_FILL,
  INTEGER_FORMAT,
  NOTE_FONT,
  QUANTITY_FORMAT,
  RATE_FORMAT,
  SUBHEADER_FILL,
  SUBHEADER_FONT,
  USD_FORMAT,
  writeHeaderRow,
} from "./styles";
import { ChartSpec, injectNativeCharts } from "./chartInjector";

type CellValue = string | number | boolean | undefined;
type ColumnFormat = "usd" | "quantity" | "rate" | "integer" | "text" | "bool";

interface ColumnDef<T> {
  readonly header: string;
  readonly width?: number;
  readonly format?: ColumnFormat;
  readonly value: (row: T) => CellValue;
}

const NUM_FMT_BY_FORMAT: Readonly<Record<ColumnFormat, string | undefined>> = {
  usd: USD_FORMAT,
  quantity: QUANTITY_FORMAT,
  rate: RATE_FORMAT,
  integer: INTEGER_FORMAT,
  text: undefined,
  bool: undefined,
};

/** 汎用の「ヘッダー＋データ行」テーブルシート書き込みヘルパー。
 *  すべてのシートで共通のヘッダー書式・オートフィルター・ウィンドウ枠固定を適用する。 */
interface WrittenSheet {
  readonly ws: ExcelJS.Worksheet;
  readonly headerRowNumber: number;
}

function writeTableSheet<T>(
  wb: ExcelJS.Workbook,
  sheetName: string,
  columns: readonly ColumnDef<T>[],
  rows: readonly T[],
  opts?: { readonly freezeCols?: number; readonly note?: string }
): WrittenSheet {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((c) => ({ width: c.width ?? 16 }));
  let headerRowNumber = 1;
  if (opts?.note) {
    const noteRow = ws.addRow([opts.note]);
    noteRow.getCell(1).font = NOTE_FONT;
    ws.mergeCells(1, 1, 1, Math.max(columns.length, 1));
    headerRowNumber = 2;
  }
  writeHeaderRow(ws, columns.map((c) => c.header));

  for (const row of rows) {
    const values = columns.map((c) => {
      const v = c.value(row);
      if (v === undefined) return "";
      if (c.format === "bool") return boolToLabel(v as boolean);
      return v as string | number;
    });
    const excelRow = ws.addRow(values);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.font = BODY_FONT;
      const fmt = c.format ? NUM_FMT_BY_FORMAT[c.format] : undefined;
      if (fmt) cell.numFmt = fmt;
    });
  }

  if (rows.length === 0) {
    const emptyRow = ws.addRow(["(該当データなし)"]);
    emptyRow.getCell(1).font = NOTE_FONT;
  }

  applyFreezeAndFilter(ws, headerRowNumber, opts?.freezeCols ?? 0);
  return { ws, headerRowNumber };
}

// ---------------------------------------------------------------------
// README・実行条件
// ---------------------------------------------------------------------

function writeReadmeSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const ws = wb.addWorksheet("README");
  ws.columns = [{ width: 34 }, { width: 90 }];

  function section(title: string) {
    const row = ws.addRow([title]);
    row.getCell(1).font = SUBHEADER_FONT;
    row.getCell(1).fill = SUBHEADER_FILL;
    ws.mergeCells(row.number, 1, row.number, 2);
  }
  function kv(label: string, value: string | number) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = BODY_FONT;
    row.getCell(2).font = BODY_FONT;
    row.getCell(2).alignment = { wrapText: true };
  }

  writeHeaderRow(ws, ["SAI-3B-1 Excel経営分析ブック 第1版", ""]);
  kv("ブック生成日時", analysis.generatedAtIso);
  kv("SAI-3Bバージョン", analysis.sai3bVersion);
  ws.addRow([]);

  section("入力run一覧・実行条件");
  for (const r of analysis.loadedRuns) {
    kv(`run識別ラベル`, r.runLabel);
    kv("　runId（manifest.json）", r.manifest.runId);
    kv("　SAI-3A schema version", r.manifest.schemaVersion);
    kv("　入力ディレクトリ", r.sourceDir);
    kv("　seed数", r.manifest.seeds.length);
    kv("　seed一覧", r.manifest.seeds.join(", "));
    kv("　会社数", r.manifest.companyIds.length);
    kv("　会社ID一覧", r.manifest.companyIds.join(", "));
    kv("　quarter数", r.manifest.quarters);
    kv("　営業人数（salesForceHeadcountTotal）", r.manifest.salesForceHeadcountTotal);
    kv("　standardBaselineId", r.manifest.standardBaselineId);
    kv("　aiPolicyVersion", r.manifest.aiPolicyVersion);
    kv("　実行日時（executedAtIso）", r.manifest.executedAtIso ?? "(不明)");
    kv("　appCommitId", r.manifest.appCommitId ?? "(不明)");
    kv(
      "　入力ファイル一覧",
      "manifest.json, case-summary.csv, quarter-summary.csv, decision-trace.jsonl, adjustment-trace.csv, warnings.csv, run-summary.json"
    );
    if (r.loadWarnings.length > 0) {
      kv("　読み込み時の警告", r.loadWarnings.join(" / "));
    }
    ws.addRow([]);
  }

  section("複数run比較の検証結果");
  kv("比較可能か", analysis.comparison.comparable ? "はい" : "いいえ（下記issuesを確認してください）");
  kv("共通seed数", analysis.comparison.commonSeeds.length);
  kv("共通会社数", analysis.comparison.commonCompanyIds.length);
  kv("共通quarter数", analysis.comparison.commonQuarters);
  if (analysis.comparison.issues.length > 0) {
    for (const issue of analysis.comparison.issues) kv("　警告", issue);
  } else {
    kv("　警告", "(なし)");
  }
  ws.addRow([]);

  section("各シートの説明");
  const sheetDescriptions: readonly [string, string][] = [
    ["全体サマリー", "run単位（営業人数条件別）の経営状況ダッシュボード。完走・エラー件数、default/underwritingFrozen発生率、売上・利益、営業工数制約の影響等。"],
    ["会社別業績", "会社×seed単位の最終業績一覧。フィルター・並べ替え・ウィンドウ枠固定対応。"],
    ["四半期業績", "会社×seed×quarter単位のPL/BS/CF・主要KPI一覧。"],
    ["販売分析", "市場×商品×会社×seed×quarter単位の希望販売量・営業工数調整後・最終計画数量。"],
    ["調達_生産_在庫", "原料調達（希望/最終）・生産計画・在庫の推移。"],
    ["営業能力分析", "会社×seed×quarter単位の営業人数・営業能力・使用率・削減量。"],
    ["営業能力_市場別", "市場別の営業人員配分・物理数量ベースの希望/最終/削減内訳。"],
    ["計画調整分析", "「希望→調整→最終決定」の全調整エントリ（before/after/delta/reason code）。"],
    ["Default_信用_警告", "payment default / underwriting frozen発生前後の四半期を追跡。"],
    ["ReasonCode集計", "reason code別の発生件数（会社別・営業人数別・quarter別・default有無別）。"],
    ["80_85_90人比較", "複数run入力時のみ生成。同一会社・同一seedを対応させた営業人数別比較。"],
    ["四半期判断トレース", "期首状態→AI提出案→制約調整→最終決定→四半期結果→警告の縦持ちトレース。"],
    ["Raw_Case / Raw_Quarter / Raw_Decision / Raw_Adjustment / Raw_Warnings", "SAI-3Aの元ログを集計前の表形式でそのまま収録。"],
  ];
  for (const [sheet, desc] of sheetDescriptions) kv(sheet, desc);
  ws.addRow([]);

  section("単位");
  kv("金額", "米ドル(USD)。表示形式は $#,##0（マイナスは赤字表示）。");
  kv("数量", "トン、HOSO換算（HosoEqTons）。表示形式は #,##0.0。");
  kv("比率", "0.0%形式（例: 48.3%）。");
  ws.addRow([]);

  section("wish（希望）とfinal（最終）の意味に関する重要な注意");
  kv(
    "販売",
    "salesQuantityTrace.desiredQuantityBeforeEffortConstraintは、営業工数制約を適用する前の真の希望販売数量。" +
      "finalPlannedQuantityは営業工数制約適用後の最終販売計画数量（実際の成約結果ではない）。"
  );
  kv(
    "調達",
    "wish（domesticPurchaseDesiredQuantity等）はAI提出希望量であり、資金制約（procurementConstraint）適用後の" +
      "final（domesticPurchaseFinalQuantity等）と直接比較可能。"
  );
  kv(
    "生産・労務・財務",
    "wish（productionDesiredQuantityByProduct等）はAIが実際に提出した計画であり、標準AI内部の" +
      "全調整前の「真の希望」ではない（finalはAIの提出値と同じ値がそのまま使われる）。"
  );
  kv("数値化できない標準AI診断", "reason codeのみで記録され、対応するbefore/after数値は存在しない（捏造していない）。");
  kv(
    "重要",
    "上記4種類（販売・調達・生産労務財務・診断）は意味が異なるため、本ブックでは単一の「制約前希望量」列として" +
      "統一表示していない。各シートの列名・注記でドメインごとに区別している。"
  );
  ws.addRow([]);

  section("集計単位に関する注意");
  kv("default率", "ケース単位（分母=completedCases、四半期単位ではない）。全体サマリーシート参照。");
  kv("平均値", "cumulativeRevenueUsd等の平均は、defaultが発生したケースも含めた全完走ケースの平均（除外していない）。");
  kv("欠損値", "0として扱わず、空欄のまま表示している。");

  if (analysis.missingFieldReports.length > 0) {
    ws.addRow([]);
    section("不足しているログ項目（今回取得できなかった値）");
    for (const note of analysis.missingFieldReports) {
      const row = ws.addRow([note]);
      row.getCell(1).font = NOTE_FONT;
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(1).alignment = { wrapText: true };
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];
}

// ---------------------------------------------------------------------
// 全体サマリー（ダッシュボード）
// ---------------------------------------------------------------------

function writeDashboardSheet(wb: ExcelJS.Workbook, rows: readonly DashboardSummaryRow[]): void {
  const columns: readonly ColumnDef<DashboardSummaryRow>[] = [
    { header: "run", width: 24, value: (r) => r.runLabel },
    { header: "営業人数", width: 10, format: "integer", value: (r) => r.salesForceHeadcountTotal },
    { header: "完走ケース数", width: 12, format: "integer", value: (r) => r.completedCases },
    { header: "エラーケース数", width: 12, format: "integer", value: (r) => r.errorCases },
    { header: "全ケース数", width: 10, format: "integer", value: (r) => r.totalCases },
    { header: "default発生数", width: 12, format: "integer", value: (r) => r.paymentDefaultCaseCount },
    { header: "default率(ケース単位)", width: 16, format: "rate", value: (r) => r.paymentDefaultRateByCase },
    { header: "UWフローズン発生数", width: 14, format: "integer", value: (r) => r.underwritingFrozenCaseCount },
    { header: "UWフローズン率", width: 14, format: "rate", value: (r) => r.underwritingFrozenRateByCase },
    { header: "重大警告件数", width: 12, format: "integer", value: (r) => r.criticalWarningCount },
    { header: "総売上(USD)", width: 16, format: "usd", value: (r) => r.totalRevenueUsd },
    { header: "総粗利益(USD)", width: 16, format: "usd", value: (r) => r.totalGrossProfitUsd },
    { header: "総営業利益(USD)", width: 16, format: "usd", value: (r) => r.totalOperatingProfitUsd },
    { header: "平均期末現金(USD)", width: 16, format: "usd", value: (r) => r.averageFinalCashUsd },
    { header: "平均借入(USD)", width: 16, format: "usd", value: (r) => r.averageFinalLoansUsd },
    { header: "最終計画販売数量(t)", width: 16, format: "quantity", value: (r) => r.totalFinalSalesQuantityHosoEqTons },
    { header: "制約前希望販売数量(t)", width: 18, format: "quantity", value: (r) => r.totalDesiredBeforeEffortConstraintHosoEqTons },
    { header: "営業工数制約削減量(t)", width: 18, format: "quantity", value: (r) => r.totalReductionFromEffortConstraintHosoEqTons },
    { header: "削減率", width: 10, format: "rate", value: (r) => r.effortConstraintReductionRate },
    { header: "平均営業能力使用率", width: 16, format: "rate", value: (r) => r.averageSalesEffortUtilizationRate },
    { header: "最頻reason code", width: 30, value: (r) => r.topReasonCode },
    { header: "最頻reason code件数", width: 14, format: "integer", value: (r) => r.topReasonCodeCount },
  ];
  const { ws, headerRowNumber } = writeTableSheet(wb, "全体サマリー", columns, rows, {
    note: "runごと（営業人数条件別）の経営状況ダッシュボード。runが複数ある場合は行ごとに横並び比較できる。",
  });

  // 入力条件（run/営業人数）列と集計結果列を色分けする（三宅さんの指示§5）。
  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    ws.getCell(r, 1).fill = INPUT_CONDITION_FILL;
    ws.getCell(r, 2).fill = INPUT_CONDITION_FILL;
    for (let c = 3; c <= columns.length; c++) ws.getCell(r, c).fill = AGGREGATE_RESULT_FILL;
  }

  // default率が高い行を強調する条件付き書式（cellIsはgreaterThanOrEqualを
  // サポートしないため、expression形式で>=0.5を表現する）。
  if (rows.length > 0) {
    const firstDataRow = headerRowNumber + 1;
    ws.addConditionalFormatting({
      ref: `G${firstDataRow}:G${ws.rowCount}`,
      rules: [
        { type: "expression", formulae: [`G${firstDataRow}>=0.5`], style: { font: { color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC00000" } } }, priority: 1 },
      ],
    });
  }
}

// ---------------------------------------------------------------------
// グラフ（ネイティブExcelグラフ用のデータ表。実際のグラフ描画はworkbook/
// chartInjector.tsが本シートのセル範囲を参照してOOXMLへ後付けする）。
// ---------------------------------------------------------------------

export const CHART_SHEET_NAME = "グラフ";
/** グラフ用データ表の先頭行番号（1行目は注記、2行目がヘッダー、3行目からデータ）。 */
const CHART_DATA_HEADER_ROW = 2;

function writeChartsDataSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<DashboardSummaryRow>[] = [
    { header: "run", width: 20, value: (r) => r.runLabel },
    { header: "営業人数", width: 10, format: "integer", value: (r) => r.salesForceHeadcountTotal },
    { header: "default率", width: 10, format: "rate", value: (r) => r.paymentDefaultRateByCase },
    { header: "総売上(USD)", width: 16, format: "usd", value: (r) => r.totalRevenueUsd },
    { header: "総粗利益(USD)", width: 16, format: "usd", value: (r) => r.totalGrossProfitUsd },
    { header: "総営業利益(USD)", width: 16, format: "usd", value: (r) => r.totalOperatingProfitUsd },
    { header: "平均期末現金(USD)", width: 16, format: "usd", value: (r) => r.averageFinalCashUsd },
    { header: "制約前希望販売量(t)", width: 18, format: "quantity", value: (r) => r.totalDesiredBeforeEffortConstraintHosoEqTons },
    { header: "最終計画販売量(t)", width: 16, format: "quantity", value: (r) => r.totalFinalSalesQuantityHosoEqTons },
    { header: "平均営業能力使用率", width: 16, format: "rate", value: (r) => r.averageSalesEffortUtilizationRate },
  ];
  writeTableSheet(wb, CHART_SHEET_NAME, columns, analysis.dashboard, {
    note: "以下はグラフ描画専用のデータ表（全体サマリーシートの値をそのまま転記）。グラフ本体は右側に自動配置される。",
  });
}

export function buildSai3bWorkbook(analysis: Sai3bAnalysis): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShrimpX V2 SAI-3B-1";
  wb.created = new Date(analysis.generatedAtIso);
  wb.modified = wb.created;

  writeReadmeSheet(wb, analysis);
  writeDashboardSheet(wb, analysis.dashboard);
  writeChartsDataSheet(wb, analysis);
  writeCompanyPerformanceSheet(wb, analysis);
  writeQuarterPerformanceSheet(wb, analysis);
  writeSalesAnalysisSheet(wb, analysis);
  writeProcurementProductionSheet(wb, analysis);
  writeSalesCapacitySheets(wb, analysis);
  writeAdjustmentAnalysisSheet(wb, analysis);
  writeDefaultWarningSheet(wb, analysis);
  writeReasonCodeTallySheet(wb, analysis);
  if (analysis.loadedRuns.length >= 2) {
    writeHeadcountComparisonSheet(wb, analysis);
  }
  writeDecisionTraceSheet(wb, analysis);
  writeRawDataSheets(wb, analysis);

  return wb;
}

// ---------------------------------------------------------------------
// 会社別業績
// ---------------------------------------------------------------------

function writeCompanyPerformanceSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["companyPerformance"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "完走", width: 8, format: "bool", value: (r) => r.completed },
    { header: "完走turn数", width: 10, format: "integer", value: (r) => r.completedTurns },
    { header: "要求turn数", width: 10, format: "integer", value: (r) => r.requestedTurns },
    { header: "default発生", width: 10, format: "bool", value: (r) => r.paymentDefaultEver },
    { header: "default初回turn", width: 12, format: "integer", value: (r) => r.paymentDefaultFirstTurn },
    { header: "UWフローズン発生", width: 12, format: "bool", value: (r) => r.underwritingFrozenEver },
    { header: "UWフローズン初回turn", width: 14, format: "integer", value: (r) => r.underwritingFrozenFirstTurn },
    { header: "累計売上(USD)", width: 16, format: "usd", value: (r) => r.cumulativeRevenueUsd },
    { header: "累計粗利益(USD)", width: 16, format: "usd", value: (r) => r.cumulativeGrossProfitUsd },
    { header: "累計営業利益(USD)", width: 16, format: "usd", value: (r) => r.cumulativeOperatingProfitUsd },
    { header: "最終現金(USD)", width: 16, format: "usd", value: (r) => r.finalCashUsd },
    { header: "最終借入(USD)", width: 16, format: "usd", value: (r) => r.finalLoansUsd },
    { header: "最終製品在庫(t)", width: 14, format: "quantity", value: (r) => r.finalFinishedGoodsInventoryHosoEqTons },
    { header: "累計最終計画販売量(t)", width: 16, format: "quantity", value: (r) => r.cumulativeSalesQuantityHosoEqTons },
    { header: "重大警告数", width: 10, format: "integer", value: (r) => r.warningCount },
  ];
  const { ws, headerRowNumber } = writeTableSheet(wb, "会社別業績", columns, analysis.companyPerformance, { freezeCols: 3 });
  applyBooleanConditionalFormat(ws, headerRowNumber, 7, "はい");
  applyBooleanConditionalFormat(ws, headerRowNumber, 9, "はい");
}

// ---------------------------------------------------------------------
// 四半期業績
// ---------------------------------------------------------------------

function writeQuarterPerformanceSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["quarterPerformance"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "period", width: 10, value: (r) => r.period },
    { header: "売上(USD)", width: 14, format: "usd", value: (r) => r.netRevenueUsd },
    { header: "粗利益(USD)", width: 14, format: "usd", value: (r) => r.grossProfitUsd },
    { header: "営業利益(USD)", width: 14, format: "usd", value: (r) => r.operatingProfitUsd },
    { header: "純利益(USD)", width: 14, format: "usd", value: (r) => r.netIncomeUsd },
    { header: "期末現金(USD)", width: 14, format: "usd", value: (r) => r.closingCashUsd },
    { header: "短期借入(USD)", width: 14, format: "usd", value: (r) => r.shortTermLoansUsd },
    { header: "長期借入(USD)", width: 14, format: "usd", value: (r) => r.longTermLoansUsd },
    { header: "売掛金(期首,USD)", width: 15, format: "usd", value: (r) => r.accountsReceivableUsdAtStart },
    { header: "買掛金(期首,USD)", width: 15, format: "usd", value: (r) => r.accountsPayableUsdAtStart },
    { header: "原料在庫(t)", width: 12, format: "quantity", value: (r) => r.rawMaterialInventoryHosoEqTons },
    { header: "製品在庫(t)", width: 12, format: "quantity", value: (r) => r.finishedGoodsInventoryHosoEqTons },
    { header: "生産計画(AI提出,t)", width: 16, format: "quantity", value: (r) => r.productionPlanQuantityTotal },
    { header: "最終計画販売量(t)", width: 16, format: "quantity", value: (r) => r.finalPlannedSalesQuantityTotal },
    { header: "payment default", width: 12, format: "bool", value: (r) => r.paymentDefault },
    { header: "underwriting frozen", width: 14, format: "bool", value: (r) => r.underwritingFrozen },
    { header: "信用区分(期首)", width: 12, value: (r) => r.startCreditTier },
    { header: "主要警告code", width: 30, value: (r) => r.topWarningCodes },
  ];
  const { ws, headerRowNumber } = writeTableSheet(wb, "四半期業績", columns, analysis.quarterPerformance, {
    freezeCols: 4,
    note: "生産計画・売掛金/買掛金(期首)は実績値ではない点に注意（README参照）。",
  });
  applyBooleanConditionalFormat(ws, headerRowNumber, 18, "はい");
  applyBooleanConditionalFormat(ws, headerRowNumber, 19, "はい");
  applyNegativeConditionalFormat(ws, headerRowNumber, 10);
}

// ---------------------------------------------------------------------
// 販売分析
// ---------------------------------------------------------------------

function writeSalesAnalysisSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["salesAnalysis"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "市場", width: 8, value: (r) => r.market },
    { header: "商品", width: 8, value: (r) => r.product },
    { header: "希望販売量(制約前,t)", width: 18, format: "quantity", value: (r) => r.desiredQuantityBeforeEffortConstraint },
    { header: "最終計画数量(t)", width: 16, format: "quantity", value: (r) => r.finalPlannedQuantity },
    { header: "エンジン側scaleFactor", width: 16, format: "rate", value: (r) => r.engineEffortScaleFactor },
    { header: "削減量(t)", width: 12, format: "quantity", value: (r) => r.reductionFromEffortConstraint },
    { header: "削減率", width: 10, format: "rate", value: (r) => r.reductionRate },
  ];
  writeTableSheet(wb, "販売分析", columns, analysis.salesAnalysis, {
    freezeCols: 6,
    note: "単価・粗利益は元ログに含まれないため掲載していない（README「不足しているログ項目」参照）。",
  });
}

// ---------------------------------------------------------------------
// 調達・生産・在庫
// ---------------------------------------------------------------------

function writeProcurementProductionSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["procurementProduction"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "国内買付希望(t)", width: 16, format: "quantity", value: (r) => r.domesticPurchaseDesiredQuantity },
    { header: "国内買付最終(t)", width: 16, format: "quantity", value: (r) => r.domesticPurchaseFinalQuantity },
    { header: "輸入希望(t)", width: 14, format: "quantity", value: (r) => r.importOrdersDesiredQuantity },
    { header: "輸入最終(t)", width: 14, format: "quantity", value: (r) => r.importOrdersFinalQuantity },
    { header: "輸入ブロック", width: 10, format: "bool", value: (r) => r.importOrdersBlocked },
    { header: "養殖投入希望(t)", width: 16, format: "quantity", value: (r) => r.aquacultureStockingDesiredQuantity },
    { header: "養殖投入最終(t)", width: 16, format: "quantity", value: (r) => r.aquacultureStockingFinalQuantity },
    { header: "生産計画HOSO(t)", width: 14, format: "quantity", value: (r) => r.productionDesiredQuantityByProduct.hoso },
    { header: "生産計画PD(t)", width: 14, format: "quantity", value: (r) => r.productionDesiredQuantityByProduct.pd },
    { header: "生産計画VAP(t)", width: 14, format: "quantity", value: (r) => r.productionDesiredQuantityByProduct.vap },
    { header: "原料在庫(t)", width: 12, format: "quantity", value: (r) => r.rawMaterialInventoryHosoEqTons },
    { header: "製品在庫(t)", width: 12, format: "quantity", value: (r) => r.finishedGoodsInventoryHosoEqTons },
    { header: "廃棄量(t)", width: 12, format: "quantity", value: (r) => r.discardQuantityHosoEqTons },
  ];
  writeTableSheet(wb, "調達_生産_在庫", columns, analysis.procurementProduction, {
    freezeCols: 4,
    note: "生産計画はAI提出値（wish）。生産能力制約後の実績値はSAI-3Aの出力に含まれていない。",
  });
}

// ---------------------------------------------------------------------
// 営業能力分析（会社単位＋市場別）
// ---------------------------------------------------------------------

function writeSalesCapacitySheets(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["salesCapacity"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "営業人数(期首)", width: 12, format: "integer", value: (r) => r.salesForceHeadcountTotal },
    { header: "営業工数換算能力(t)", width: 18, format: "quantity", value: (r) => r.capacityHosoEqTonsActual },
    { header: "営業工数換算使用量(t)", width: 18, format: "quantity", value: (r) => r.usedHosoEqTons },
    { header: "使用率", width: 10, format: "rate", value: (r) => r.utilizationRate },
    { header: "工数制約削減量(t)", width: 16, format: "quantity", value: (r) => r.reductionFromEffortConstraintHosoEqTons },
  ];
  const { ws, headerRowNumber } = writeTableSheet(wb, "営業能力分析", columns, analysis.salesCapacity, {
    freezeCols: 4,
    note: "使用率が100%近辺に集中しているかを確認できるよう、使用率列に条件付き書式を設定。",
  });
  if (analysis.salesCapacity.length > 0) {
    const firstDataRow = headerRowNumber + 1;
    ws.addConditionalFormatting({
      ref: `H${firstDataRow}:H${ws.rowCount}`,
      rules: [
        { type: "expression", formulae: [`H${firstDataRow}>=0.98`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } } }, priority: 1 },
      ],
    });
  }

  const marketColumns: readonly ColumnDef<Sai3bAnalysis["salesCapacityMarketBreakdown"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "市場", width: 8, value: (r) => r.market },
    { header: "営業人数(市場配分)", width: 14, format: "integer", value: (r) => r.headcount },
    { header: "希望量合計(物理,t)", width: 16, format: "quantity", value: (r) => r.desiredPhysicalQuantityTotal },
    { header: "最終計画量合計(物理,t)", width: 18, format: "quantity", value: (r) => r.finalPlannedPhysicalQuantityTotal },
    { header: "削減量合計(物理,t)", width: 16, format: "quantity", value: (r) => r.reductionPhysicalQuantityTotal },
    { header: "削減率", width: 10, format: "rate", value: (r) => r.reductionRate },
  ];
  writeTableSheet(wb, "営業能力_市場別", marketColumns, analysis.salesCapacityMarketBreakdown, {
    freezeCols: 5,
    note: "物理数量ベース（営業工数換算前）。市場別の営業工数換算能力自体は係数を用いた再計算が必要なため掲載していない。",
  });
}

// ---------------------------------------------------------------------
// 計画調整分析
// ---------------------------------------------------------------------

function writeAdjustmentAnalysisSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["adjustmentAnalysis"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "ドメイン区分", width: 20, value: (r) => r.domainGroup },
    { header: "市場", width: 8, value: (r) => r.market },
    { header: "商品", width: 8, value: (r) => r.product },
    { header: "調整カテゴリ(stage)", width: 22, value: (r) => r.adjustmentStage },
    { header: "before", width: 14, format: "quantity", value: (r) => r.before },
    { header: "after", width: 14, format: "quantity", value: (r) => r.after },
    { header: "delta", width: 14, format: "quantity", value: (r) => r.delta },
    { header: "delta率", width: 10, format: "rate", value: (r) => r.deltaRate },
    { header: "reason code", width: 34, value: (r) => r.code },
    { header: "閾値", width: 12, format: "quantity", value: (r) => r.threshold },
    { header: "関連指標", width: 20, value: (r) => r.relevantMetric },
    { header: "ログ参照キー", width: 26, value: (r) => r.logRefKey },
  ];
  writeTableSheet(wb, "計画調整分析", columns, analysis.adjustmentAnalysis, {
    freezeCols: 4,
    note: "ドメイン区分=standardAiDiagnosticの行はbefore/after/deltaが常に空欄（数値化できない診断のためreason codeのみ。捏造していない）。",
  });
}

// ---------------------------------------------------------------------
// Default・信用・警告
// ---------------------------------------------------------------------

function writeDefaultWarningSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["defaultWarningEvents"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "イベント種別", width: 16, value: (r) => r.eventType },
    { header: "発生前quarter", width: 12, format: "bool", value: (r) => r.isPriorQuarter },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "period", width: 10, value: (r) => r.period },
    { header: "現金(USD)", width: 14, format: "usd", value: (r) => r.cashUsd },
    { header: "現金の前期差(USD)", width: 16, format: "usd", value: (r) => r.cashUsdDeltaFromPriorQuarter },
    { header: "借入合計(USD)", width: 14, format: "usd", value: (r) => r.loansUsd },
    { header: "追加融資余力(USD)", width: 16, format: "usd", value: (r) => r.availableAdditionalCapacityUsd },
    { header: "売上(USD)", width: 14, format: "usd", value: (r) => r.revenueUsd },
    { header: "粗利益(USD)", width: 14, format: "usd", value: (r) => r.grossProfitUsd },
    { header: "営業利益(USD)", width: 14, format: "usd", value: (r) => r.operatingProfitUsd },
    { header: "製品在庫(t)", width: 12, format: "quantity", value: (r) => r.inventoryHosoEqTons },
    { header: "warning code", width: 30, value: (r) => r.warningCodes },
  ];
  const { ws, headerRowNumber } = writeTableSheet(wb, "Default_信用_警告", columns, analysis.defaultWarningEvents, {
    freezeCols: 4,
    note: "default/underwritingFrozenが発生した会社×seedについて、発生前quarterと発生quarterを並べて追跡する。非defaultケースとの比較は「会社別業績」シートでpaymentDefaultEver=いいえによりフィルタできる。",
  });
  applyNegativeConditionalFormat(ws, headerRowNumber, 8);
}

// ---------------------------------------------------------------------
// Reason Code集計
// ---------------------------------------------------------------------

function writeReasonCodeTallySheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const headcounts = Array.from(new Set(analysis.loadedRuns.map((r) => r.manifest.salesForceHeadcountTotal))).sort((a, b) => a - b);
  const companyIds = Array.from(new Set(analysis.loadedRuns.flatMap((r) => r.manifest.companyIds))).sort();

  const columns: ColumnDef<Sai3bAnalysis["reasonCodeTally"][number]>[] = [
    { header: "code", width: 34, value: (r) => r.code },
    { header: "source", width: 12, value: (r) => r.source },
    { header: "domain", width: 20, value: (r) => r.domain },
    { header: "説明", width: 40, value: (r) => r.description },
    { header: "総発生件数", width: 12, format: "integer", value: (r) => r.totalOccurrences },
    { header: "発生ケース数", width: 12, format: "integer", value: (r) => r.caseCount },
    { header: "defaultケース内発生数", width: 16, format: "integer", value: (r) => r.occurrencesInDefaultCases },
    { header: "非defaultケース内発生数", width: 18, format: "integer", value: (r) => r.occurrencesInNonDefaultCases },
  ];
  for (const c of companyIds) {
    columns.push({ header: `会社:${c}`, width: 10, format: "integer", value: (r) => r.companyBreakdown[c] });
  }
  for (const hc of headcounts) {
    columns.push({ header: `営業人数:${hc}`, width: 12, format: "integer", value: (r) => r.headcountBreakdown[hc] });
  }
  columns.push({
    header: "quarter別内訳",
    width: 40,
    value: (r) =>
      Object.entries(r.quarterBreakdown)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([turn, count]) => `T${turn}:${count}`)
        .join(", "),
  });

  writeTableSheet(wb, "ReasonCode集計", columns, analysis.reasonCodeTally, {
    note: "既存のreason code registry（standardAi/reasonCodes.ts・companyLab/types.ts）をそのまま参照。新規コードはExcel側で作っていない。",
  });
}

// ---------------------------------------------------------------------
// 80・85・90人比較
// ---------------------------------------------------------------------

function writeHeadcountComparisonSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const headcounts = Array.from(new Set(analysis.loadedRuns.map((r) => r.manifest.salesForceHeadcountTotal))).sort((a, b) => a - b);
  const rows = analysis.headcountComparison;

  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "85人だけdefaultフラグ", width: 16, format: "bool", value: (r) => r.middleHeadcountOnlyDefaultFlag },
  ];
  for (const hc of headcounts) {
    columns.push({ header: `${hc}人:default有無`, width: 14, format: "bool", value: (r) => r.paymentDefaultByHeadcount[hc] });
    columns.push({ header: `${hc}人:default初回turn`, width: 16, format: "integer", value: (r) => r.paymentDefaultFirstTurnByHeadcount[hc] });
    columns.push({ header: `${hc}人:売上(USD)`, width: 16, format: "usd", value: (r) => r.revenueByHeadcount[hc] });
    columns.push({ header: `${hc}人:粗利益(USD)`, width: 16, format: "usd", value: (r) => r.grossProfitByHeadcount[hc] });
    columns.push({ header: `${hc}人:営業利益(USD)`, width: 16, format: "usd", value: (r) => r.operatingProfitByHeadcount[hc] });
    columns.push({ header: `${hc}人:最終現金(USD)`, width: 16, format: "usd", value: (r) => r.finalCashByHeadcount[hc] });
    columns.push({ header: `${hc}人:最終借入(USD)`, width: 16, format: "usd", value: (r) => r.finalLoansByHeadcount[hc] });
  }

  const { ws, headerRowNumber } = writeTableSheet(wb, "80_85_90人比較", columns, rows, {
    freezeCols: 2,
    note:
      "同一会社・同一seedを対応させた営業人数別比較。「85人だけdefaultフラグ」は営業人数の中間値のみがdefaultし他は" +
      "しないケースを機械的に検出したものであり、原因（underwritingFrozen等）を特定・断定するものではない（未解決課題のまま）。",
  });
  applyBooleanConditionalFormat(ws, headerRowNumber, 3, "はい");
}

// ---------------------------------------------------------------------
// 四半期判断トレース
// ---------------------------------------------------------------------

function writeDecisionTraceSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const columns: readonly ColumnDef<Sai3bAnalysis["decisionTrace"][number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "会社ID", width: 10, value: (r) => r.companyId },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "period", width: 10, value: (r) => r.period },
    { header: "段階順序", width: 8, format: "integer", value: (r) => r.stageOrder },
    { header: "段階", width: 20, value: (r) => r.stage },
    { header: "内容", width: 90, value: (r) => r.summary },
  ];
  writeTableSheet(wb, "四半期判断トレース", columns, analysis.decisionTrace, {
    freezeCols: 5,
    note: "会社・seed・runでフィルターし、段階順序(1〜6)どおりに読むことで、期首状態→AI提出案→制約調整→最終決定→四半期結果→警告の流れを追える。",
  });
}

// ---------------------------------------------------------------------
// Raw Data
// ---------------------------------------------------------------------

const MAX_RAW_ROWS_PER_SHEET = 200_000;

function writeRawDataSheets(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  writeRawCaseSheet(wb, analysis);
  writeRawQuarterSheet(wb, analysis);
  writeRawDecisionSheet(wb, analysis);
  writeRawAdjustmentSheet(wb, analysis);
  writeRawWarningsSheet(wb, analysis);
}

function truncateNote(total: number): string | undefined {
  return total > MAX_RAW_ROWS_PER_SHEET
    ? `行数が上限(${MAX_RAW_ROWS_PER_SHEET.toLocaleString()}行)を超えたため、先頭${MAX_RAW_ROWS_PER_SHEET.toLocaleString()}行のみ収録（全${total.toLocaleString()}行）。全件はCSV/JSONL原本を参照。`
    : undefined;
}

function writeRawCaseSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const all = analysis.loadedRuns.flatMap((run) => run.caseSummaryRows.map((r) => ({ runLabel: run.runLabel, ...r })));
  const rows = all.slice(0, MAX_RAW_ROWS_PER_SHEET);
  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "companyId", width: 10, value: (r) => r.companyId },
    { header: "completedTurns", width: 12, format: "integer", value: (r) => r.completedTurns },
    { header: "requestedTurns", width: 12, format: "integer", value: (r) => r.requestedTurns },
    { header: "completed", width: 10, format: "bool", value: (r) => r.completed },
    { header: "cumulativeRevenueUsd", width: 18, format: "usd", value: (r) => r.cumulativeRevenueUsd },
    { header: "cumulativeGrossProfitUsd", width: 18, format: "usd", value: (r) => r.cumulativeGrossProfitUsd },
    { header: "cumulativeOperatingProfitUsd", width: 20, format: "usd", value: (r) => r.cumulativeOperatingProfitUsd },
    { header: "cumulativeSalesForceCostUsd", width: 20, format: "usd", value: (r) => r.cumulativeSalesForceCostUsd },
    { header: "finalCashUsd", width: 16, format: "usd", value: (r) => r.finalCashUsd },
    { header: "finalLoansUsd", width: 16, format: "usd", value: (r) => r.finalLoansUsd },
    { header: "finalAvailableAdditionalCapacityUsd", width: 22, format: "usd", value: (r) => r.finalAvailableAdditionalCapacityUsd },
    { header: "paymentDefaultEverByRequestedTurns", width: 20, format: "bool", value: (r) => r.paymentDefaultEverByRequestedTurns },
    { header: "paymentDefaultFirstTurn", width: 14, format: "integer", value: (r) => r.paymentDefaultFirstTurn },
    { header: "underwritingFrozenEverByRequestedTurns", width: 22, format: "bool", value: (r) => r.underwritingFrozenEverByRequestedTurns },
    { header: "underwritingFrozenFirstTurn", width: 16, format: "integer", value: (r) => r.underwritingFrozenFirstTurn },
    { header: "topReasonCodes", width: 30, value: (r) => r.topReasonCodes.join("|") },
    { header: "warningCount", width: 10, format: "integer", value: (r) => r.warningCount },
  ];
  writeTableSheet(wb, "Raw_Case", columns, rows, { freezeCols: 3, note: truncateNote(all.length) });
}

function writeRawQuarterSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const all = analysis.loadedRuns.flatMap((run) => run.quarterSummaryRows.map((r) => ({ runLabel: run.runLabel, ...r })));
  const rows = all.slice(0, MAX_RAW_ROWS_PER_SHEET);
  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "companyId", width: 10, value: (r) => r.companyId },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "period", width: 10, value: (r) => r.period },
    { header: "netRevenueUsd", width: 16, format: "usd", value: (r) => r.netRevenueUsd },
    { header: "grossProfitUsd", width: 16, format: "usd", value: (r) => r.grossProfitUsd },
    { header: "operatingProfitUsd", width: 16, format: "usd", value: (r) => r.operatingProfitUsd },
    { header: "closingCashUsd", width: 16, format: "usd", value: (r) => r.closingCashUsd },
    { header: "paymentDefault", width: 12, format: "bool", value: (r) => r.paymentDefault },
    { header: "underwritingFrozen", width: 14, format: "bool", value: (r) => r.underwritingFrozen },
    { header: "salesEffortUtilizationRate", width: 20, format: "rate", value: (r) => r.salesEffortUtilizationRate },
    { header: "warningCount", width: 10, format: "integer", value: (r) => r.warningCount },
  ];
  writeTableSheet(wb, "Raw_Quarter", columns, rows, { freezeCols: 4, note: truncateNote(all.length) });
}

function writeRawDecisionSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const all = analysis.loadedRuns.flatMap((run) =>
    run.decisionTraceLines.map((l) => ({
      runLabel: run.runLabel,
      seed: l.seed,
      companyId: l.companyId,
      turn: l.turn,
      period: l.period,
      domesticPurchaseDesiredQuantity: l.decision.wish.domesticPurchaseDesiredQuantity,
      domesticPurchaseFinalQuantity: l.decision.final.domesticPurchaseFinalQuantity,
      financingRequestDesiredAmountUsd: l.decision.wish.financingRequestDesiredAmountUsd,
      salesTraceCount: l.salesQuantityTrace.length,
    }))
  );
  const rows = all.slice(0, MAX_RAW_ROWS_PER_SHEET);
  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "companyId", width: 10, value: (r) => r.companyId },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "period", width: 10, value: (r) => r.period },
    { header: "domesticPurchaseDesiredQuantity", width: 22, format: "quantity", value: (r) => r.domesticPurchaseDesiredQuantity },
    { header: "domesticPurchaseFinalQuantity", width: 22, format: "quantity", value: (r) => r.domesticPurchaseFinalQuantity },
    { header: "financingRequestDesiredAmountUsd", width: 22, format: "usd", value: (r) => r.financingRequestDesiredAmountUsd },
    { header: "salesQuantityTrace件数", width: 16, format: "integer", value: (r) => r.salesTraceCount },
  ];
  writeTableSheet(wb, "Raw_Decision", columns, rows, {
    freezeCols: 4,
    note: (truncateNote(all.length) ?? "") + " 完全な生データはdecision-trace.jsonl原本（JSON 1行1レコード）を参照。本シートは主要スカラー値のみの要約。",
  });
}

function writeRawAdjustmentSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const all = analysis.loadedRuns.flatMap((run) => run.adjustmentTraceRows.map((r) => ({ runLabel: run.runLabel, ...r })));
  const rows = all.slice(0, MAX_RAW_ROWS_PER_SHEET);
  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "companyId", width: 10, value: (r) => r.companyId },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "category", width: 20, value: (r) => r.category },
    { header: "source", width: 12, value: (r) => r.source },
    { header: "code", width: 34, value: (r) => r.code },
    { header: "severity", width: 10, value: (r) => r.severity },
    { header: "before", width: 14, format: "quantity", value: (r) => r.before },
    { header: "after", width: 14, format: "quantity", value: (r) => r.after },
    { header: "delta", width: 14, format: "quantity", value: (r) => r.delta },
    { header: "message", width: 50, value: (r) => r.message },
  ];
  writeTableSheet(wb, "Raw_Adjustment", columns, rows, { freezeCols: 4, note: truncateNote(all.length) });
}

function writeRawWarningsSheet(wb: ExcelJS.Workbook, analysis: Sai3bAnalysis): void {
  const all = analysis.loadedRuns.flatMap((run) => run.warningRows.map((r) => ({ runLabel: run.runLabel, ...r })));
  const rows = all.slice(0, MAX_RAW_ROWS_PER_SHEET);
  const columns: ColumnDef<(typeof rows)[number]>[] = [
    { header: "run", width: 22, value: (r) => r.runLabel },
    { header: "seed", width: 14, value: (r) => r.seed },
    { header: "companyId", width: 10, value: (r) => r.companyId },
    { header: "turn", width: 6, format: "integer", value: (r) => r.turn },
    { header: "code", width: 34, value: (r) => r.code },
    { header: "source", width: 12, value: (r) => r.source },
    { header: "severity", width: 10, value: (r) => r.severity },
    { header: "message", width: 60, value: (r) => r.message },
  ];
  writeTableSheet(wb, "Raw_Warnings", columns, rows, { freezeCols: 4, note: truncateNote(all.length) });
}

// ---------------------------------------------------------------------
// 条件付き書式ヘルパー
// ---------------------------------------------------------------------

function applyBooleanConditionalFormat(ws: ExcelJS.Worksheet, headerRowNumber: number, columnIndex1Based: number, trueLabel: string): void {
  const colLetter = columnLetter(columnIndex1Based);
  const firstDataRow = headerRowNumber + 1;
  const lastRow = ws.rowCount;
  if (lastRow < firstDataRow) return;
  ws.addConditionalFormatting({
    ref: `${colLetter}${firstDataRow}:${colLetter}${lastRow}`,
    rules: [
      {
        type: "containsText",
        operator: "containsText",
        text: trueLabel,
        style: { font: { color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC00000" } } },
        priority: 1,
      },
    ],
  });
}

function applyNegativeConditionalFormat(ws: ExcelJS.Worksheet, headerRowNumber: number, columnIndex1Based: number): void {
  const colLetter = columnLetter(columnIndex1Based);
  const firstDataRow = headerRowNumber + 1;
  const lastRow = ws.rowCount;
  if (lastRow < firstDataRow) return;
  ws.addConditionalFormatting({
    ref: `${colLetter}${firstDataRow}:${colLetter}${lastRow}`,
    rules: [
      { type: "cellIs", operator: "lessThan", formulae: ["0"], style: { font: { color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFC00000" } } }, priority: 1 },
    ],
  });
}

// ---------------------------------------------------------------------
// ネイティブExcelグラフの生成（第1版・重要な可視化に絞って4種類。
// exceljsはネイティブグラフ書き込みに対応していないため、chartInjector.tsが
// xlsx出力後にOOXMLパーツを後付けする。参照範囲は「グラフ」シート
// （writeChartsDataSheet）に書き込み済みのセルのみで、値の再計算は行わない。
// 使用率の四半期推移・defaultケースの時系列・会社別分布のグラフは、第1版の
// スコープ確定（三宅さんの指示「グラフを増やしすぎず」「第1版を確実に完成」）
// のためSAI-3B-2へ持ち越す（design_notes参照）。 ---------------------------------------------------------------------

function buildSai3bChartSpecs(analysis: Sai3bAnalysis): readonly ChartSpec[] {
  const rows = analysis.dashboard;
  if (rows.length === 0) return [];

  const firstDataRow = CHART_DATA_HEADER_ROW + 1;
  const lastDataRow = CHART_DATA_HEADER_ROW + rows.length;
  const sheet = `'${CHART_SHEET_NAME}'`;
  const categories = rows.map((r) => `${r.runLabel}(${r.salesForceHeadcountTotal}人)`);
  const categoriesRef = `${sheet}!$A$${firstDataRow}:$A$${lastDataRow}`;

  const col = (letter: string) => `${sheet}!$${letter}$${firstDataRow}:$${letter}$${lastDataRow}`;

  const specs: ChartSpec[] = [
    {
      title: "営業人数別 default率（ケース単位）",
      type: "bar",
      categoriesRef,
      categories,
      series: [{ name: "default率", valuesRef: col("C"), values: rows.map((r) => r.paymentDefaultRateByCase) }],
      anchorCol: 12,
      anchorRow: 1,
      widthCols: 8,
      heightRows: 16,
    },
    {
      title: "営業人数別 売上・粗利益・営業利益・期末現金",
      type: "bar",
      categoriesRef,
      categories,
      series: [
        { name: "総売上(USD)", valuesRef: col("D"), values: rows.map((r) => r.totalRevenueUsd) },
        { name: "総粗利益(USD)", valuesRef: col("E"), values: rows.map((r) => r.totalGrossProfitUsd) },
        { name: "総営業利益(USD)", valuesRef: col("F"), values: rows.map((r) => r.totalOperatingProfitUsd) },
        { name: "平均期末現金(USD)", valuesRef: col("G"), values: rows.map((r) => r.averageFinalCashUsd) },
      ],
      anchorCol: 12,
      anchorRow: 18,
      widthCols: 10,
      heightRows: 16,
    },
    {
      title: "希望販売量(制約前) vs 最終計画数量",
      type: "bar",
      categoriesRef,
      categories,
      series: [
        { name: "制約前希望販売量(t)", valuesRef: col("H"), values: rows.map((r) => r.totalDesiredBeforeEffortConstraintHosoEqTons) },
        { name: "最終計画販売量(t)", valuesRef: col("I"), values: rows.map((r) => r.totalFinalSalesQuantityHosoEqTons) },
      ],
      anchorCol: 12,
      anchorRow: 35,
      widthCols: 8,
      heightRows: 16,
    },
    {
      title: "営業人数別 平均営業能力使用率",
      type: "bar",
      categoriesRef,
      categories,
      series: [{ name: "平均使用率", valuesRef: col("J"), values: rows.map((r) => r.averageSalesEffortUtilizationRate ?? 0) }],
      anchorCol: 12,
      anchorRow: 52,
      widthCols: 8,
      heightRows: 16,
    },
  ];
  return specs;
}

/**
 * Sai3bAnalysisから、ネイティブExcelグラフを含む最終的なxlsxバッファを生成する。
 * buildSai3bWorkbook（同期・グラフなし）でシート一式を組み立てた後、
 * chartInjector.injectNativeCharts（非同期）でグラフを後付けする。
 */
export async function renderSai3bWorkbookToBuffer(analysis: Sai3bAnalysis): Promise<Buffer> {
  const wb = buildSai3bWorkbook(analysis);
  const baseBuffer = Buffer.from(await wb.xlsx.writeBuffer());
  const specs = buildSai3bChartSpecs(analysis);
  if (specs.length === 0) return baseBuffer;
  return injectNativeCharts(baseBuffer, CHART_SHEET_NAME, specs);
}
