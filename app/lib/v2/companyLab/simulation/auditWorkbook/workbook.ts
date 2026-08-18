// ShrimpX V2 — Standard AI 32Q Audit Workbook: Excel(.xlsx) 生成
//
// 【AI-readable設計（実装指示§26）】各シートは Row1 が単一のヘッダー行、Row2 からデータ。
// merged cells / 装飾用の空行 / 複数ヘッダー行 / 色だけで意味を表す表現 / 数式は使わない。
// 数値セルには数値だけを書き、単位は列名と 17_DATA_DICTIONARY で示す。
//
// 【Human readability（実装指示§27）】先頭行固定・オートフィルタ・列幅・数値書式だけ付ける。
//
// 【欠損値（実装指示§29）】null は空セルとして書き、0 と構造的に区別する。
//
// 【既存ライブラリを再利用（実装指示§33）】ExcelJS は既にこのプロジェクトの依存関係にある
// （AI Analysis Pack・SAI-3B workbook と同じ）。新しいExcel生成基盤は作らない。

import ExcelJS from "exceljs";
import { AUDIT_DATA_DICTIONARY } from "./dictionary";
import { AuditCellValue, StandardAiAuditWorkbookData } from "./types";

const NUMBER_FORMAT_USD = "#,##0";
const NUMBER_FORMAT_TONS = "#,##0.00";
const NUMBER_FORMAT_RATIO = "0.0000";

function numberFormatFor(fieldName: string): string | null {
  if (/Usd$/.test(fieldName)) return NUMBER_FORMAT_USD;
  if (/Tons$/.test(fieldName)) return NUMBER_FORMAT_TONS;
  if (/Ratio$|Score$|UsdPerKg$/.test(fieldName)) return NUMBER_FORMAT_RATIO;
  return null;
}

/**
 * 1シート＝1ヘッダー行＋データ行。行オブジェクトのキー順をそのまま列順にする
 * （どのシートも同じ規則で書けるようにし、シートごとの独自レイアウトを作らない）。
 */
function addObjectSheet(workbook: ExcelJS.Workbook, sheetName: string, rows: readonly Readonly<Record<string, AuditCellValue>>[], headerOverride?: readonly string[]): void {
  const sheet = workbook.addWorksheet(sheetName);
  const header = headerOverride ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (header.length === 0) {
    // 行が1件も無いシートでも、AIが「列が存在しない」と「値が無い」を区別できるよう
    // 必ず注記を残す（空シートを黙って出さない）。
    sheet.addRow(["note"]);
    sheet.addRow(["No rows available for this run. See 00_README missingDataNotes."]);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getColumn(1).width = 60;
    return;
  }
  sheet.addRow([...header]);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    sheet.addRow(header.map((key) => (row[key] === null || row[key] === undefined ? null : row[key])));
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  header.forEach((fieldName, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.min(34, Math.max(12, fieldName.length + 3));
    const format = numberFormatFor(fieldName);
    if (format) column.numFmt = format;
  });
}

function addKeyValueSheet(workbook: ExcelJS.Workbook, sheetName: string, rows: readonly { readonly field: string; readonly value: AuditCellValue }[]): void {
  addObjectSheet(workbook, sheetName, rows as readonly Readonly<Record<string, AuditCellValue>>[], ["field", "value"]);
}

/** 00_README の本文（実装指示§4）。AIが最初に読むシート。 */
function buildReadmeRows(data: StandardAiAuditWorkbookData): readonly { readonly field: string; readonly value: AuditCellValue }[] {
  const m = data.meta;
  const rows: { field: string; value: AuditCellValue }[] = [
    { field: "workbookPurpose", value: "Standard AI 32Q audit export. Machine-readable record of what the Standard AI decided each quarter, why, and what business results followed." },
    { field: "simulationRunId", value: m.simulationRunId },
    { field: "scenarioId", value: m.scenarioId },
    { field: "seed", value: m.seed },
    { field: "asOfTurn", value: m.asOfTurn },
    { field: "gameEndTurn", value: m.gameEndTurn },
    { field: "requestedTurns", value: m.requestedTurns },
    { field: "completedTurns", value: m.completedTurns },
    { field: "generatedAt", value: m.generatedAt },
    { field: "status", value: m.status },
    { field: "companyIds", value: m.companyIds.join(", ") },
    { field: "shareholderValueModelVersion", value: "tsv-dcf-v1" },

    { field: "semantics.turn", value: "One Turn = one quarter. Use the period column for the calendar quarter; do not derive it from the turn number." },
    { field: "semantics.products", value: "HOSO (headless shell-on), PD (peeled & deveined), VAP (value added product). All quantities are HOSO equivalent tons (HosoEqTons)." },
    { field: "semantics.backlog", value: "Backlog is NOT overdue. 12_BACKLOG_DETAIL splits it into OVERDUE / DUE_THIS_TURN / FUTURE_DUE. Growth in FUTURE_DUE is a healthy forward obligation, not a delivery failure." },
    { field: "semantics.utilization", value: "equipmentUtilization and laborUtilization are different metrics. Never merge them into a single 'the plant is at capacity' statement." },
    { field: "semantics.profitVsCash", value: "operatingProfit is an accrual P&L measure. Do not explain it with cash flow or accounts-receivable timing; use operatingCashFlow for cash questions." },
    { field: "semantics.debt", value: "interestBearingDebt (short + long term loans) is not the same as totalLiabilities (which also includes payables and accrued interest)." },
    { field: "semantics.capacity", value: "Product-line capacity (hoso/pd/vap) and common pre-processing capacity are separate constraints. A company can be limited by the shared common capacity while product lines still have headroom." },
    { field: "semantics.proposalVsActual", value: "04_STANDARD_AI_DECISIONS keeps proposedValue (what was submitted to the engine) and actualAppliedValue (what the engine realised) in separate columns. A Standard AI proposal is not automatically the actual outcome." },
    { field: "semantics.diagnostics", value: "05_DECISION_DIAGNOSTICS rows with source=STANDARD_AI_TRACE are the AI's own deterministic reasoning (observation, diagnosis, reason codes). They are not ground truth; rows with source=ENGINE_RESULT are what the engine reported." },
    { field: "semantics.dividend", value: "Standard AI evaluates a dividend only in Q4 (isAnnualEvaluationPeriod=TRUE) and only when its policy gates pass: financial health healthy, no crisis, no new CAPEX proposal, positive current-quarter net income, positive distributable earnings. The payout base is the current-quarter net income flow; accumulated distributable earnings act only as a cap." },
    { field: "semantics.shareholderValue", value: "Current Company Value = enterpriseValue (10-year, 10% DCF of normalized quarterly operating cash flow) + cash - debt. Dividend Value = dividends actually paid, compounded at 15%/year to the evaluation turn. TSV = Dividend Value + Current Company Value." },
    { field: "semantics.missingValues", value: "A blank cell means unavailable or not applicable. It is NOT zero. Zero is always written explicitly as 0." },

    { field: "aiAnalysisInstruction", value: "Use source fields directly. Do not infer missing values. Distinguish facts, diagnostics, and interpretation." },
    { field: "aiAnalysisTip.decisionChain", value: "To trace Decision -> Reason -> Actual Result -> Business Performance: join 04_STANDARD_AI_DECISIONS (decision), 05_DECISION_DIAGNOSTICS (reason codes), the matching detail sheet (06-15), and 03_TURN_KPI (performance) on companyId + turn." },
    { field: "sheetIndex", value: "00_README, 01_RUN_SUMMARY, 02_COMPANY_SUMMARY, 03_TURN_KPI, 04_STANDARD_AI_DECISIONS, 05_DECISION_DIAGNOSTICS, 06_SALES_DETAIL, 07_PRODUCTION_DETAIL, 08_PROCUREMENT_DETAIL, 09_WORKFORCE_DETAIL, 10_CAPEX_DETAIL, 11_FINANCE_DETAIL, 12_BACKLOG_DETAIL, 13_MARKET_DETAIL, 14_DIVIDEND_DETAIL, 15_FACTORY_CAPACITY, 16_FINAL_RESULTS, 17_DATA_DICTIONARY, 18_EVENT_LOG, 19_AI_PROFILE_VISION" },
    { field: "rowCounts", value: `03_TURN_KPI=${data.turnKpi.length}, 04_STANDARD_AI_DECISIONS=${data.decisions.length}, 05_DECISION_DIAGNOSTICS=${data.diagnostics.length}, 06_SALES_DETAIL=${data.sales.length}, 07_PRODUCTION_DETAIL=${data.production.length}, 10_CAPEX_DETAIL=${data.capex.length}, 12_BACKLOG_DETAIL=${data.backlog.length}, 14_DIVIDEND_DETAIL=${data.dividend.length}` },

    { field: "limitation.diagnosticDetail", value: "Standard AI diagnostics are persisted per run as a six-stage trace. The full StandardAiDiagnosticEntry structure (thresholdValue, keyValues, domain, targetFactoryId, gateName) is not stored per run, so those columns are blank. Reason codes and severities are preserved in full." },
    { field: "limitation.backlogPerTurn", value: "Per-turn backlog split by dueStatus is not persisted. 12_BACKLOG_DETAIL is a snapshot at asOfTurn; per-turn backlog and overdue totals are confirmed values in 03_TURN_KPI." },
    { field: "limitation.factoryCapacity", value: "Per-turn per-factory capacity is not persisted. Capacity columns in 15_FACTORY_CAPACITY are filled from the initial fixture; factories built during the run show factorySource=BUILT_DURING_RUN with blank capacity columns. Company-level effective capacity per turn is available in the same sheet." },
    { field: "limitation.legacyRuns", value: "Some diagnostic fields may be unavailable for legacy runs. See missingDataNote rows below." },
  ];
  if (data.meta.missingDataNotes.length === 0) {
    rows.push({ field: "missingDataNote", value: "(none)" });
  } else {
    data.meta.missingDataNotes.forEach((note, index) => rows.push({ field: `missingDataNote.${index + 1}`, value: note }));
  }
  return rows;
}

export async function buildStandardAiAuditWorkbook(data: StandardAiAuditWorkbookData): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ShrimpX Standard AI Audit Workbook";

  addKeyValueSheet(workbook, "00_README", buildReadmeRows(data));
  addKeyValueSheet(workbook, "01_RUN_SUMMARY", data.runSummary);
  // 01のcompany profile部分は、1行1事実を守るため別テーブルとして同じsheetには混ぜない。
  addObjectSheet(workbook, "01b_COMPANY_PROFILE", data.companyProfiles as never);
  addObjectSheet(workbook, "02_COMPANY_SUMMARY", data.companySummary as never);
  addObjectSheet(workbook, "03_TURN_KPI", data.turnKpi as never);
  addObjectSheet(workbook, "04_STANDARD_AI_DECISIONS", data.decisions as never);
  addObjectSheet(workbook, "05_DECISION_DIAGNOSTICS", data.diagnostics as never);
  addObjectSheet(workbook, "06_SALES_DETAIL", data.sales as never);
  addObjectSheet(workbook, "07_PRODUCTION_DETAIL", data.production as never);
  addObjectSheet(workbook, "08_PROCUREMENT_DETAIL", data.procurement as never);
  addObjectSheet(workbook, "09_WORKFORCE_DETAIL", data.workforce as never);
  addObjectSheet(workbook, "10_CAPEX_DETAIL", data.capex as never);
  addObjectSheet(workbook, "11_FINANCE_DETAIL", data.finance as never);
  addObjectSheet(workbook, "12_BACKLOG_DETAIL", data.backlog as never);
  addObjectSheet(workbook, "13_MARKET_DETAIL", data.market as never);
  addObjectSheet(workbook, "14_DIVIDEND_DETAIL", data.dividend as never);
  addObjectSheet(workbook, "15_FACTORY_CAPACITY", data.factoryCapacity as never);
  addObjectSheet(workbook, "16_FINAL_RESULTS", data.finalResults as never);
  addObjectSheet(workbook, "17_DATA_DICTIONARY", AUDIT_DATA_DICTIONARY as never);
  addObjectSheet(workbook, "18_EVENT_LOG", data.events as never);
  addObjectSheet(workbook, "19_AI_PROFILE_VISION", data.profileVision as never);

  return workbook.xlsx.writeBuffer();
}
