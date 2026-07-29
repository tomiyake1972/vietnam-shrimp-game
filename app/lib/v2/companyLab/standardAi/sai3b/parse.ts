// ShrimpX V2 — Phase SAI-3B-1: SAI-3Aログ・パース（純粋関数のみ）
//
// 【方針】fsには一切触れない。呼び出し元（loadRun.ts経由でCLI層）がすでに
// 読み込んだファイル内容の文字列を受け取り、検証済みの構造化データへ変換する
// だけの純粋関数群。不正なCSV・JSON・JSONLは、値を捏造・スキップして通す
// のではなく、Sai3bInputErrorを投げて分かりやすく失敗させる
// （三宅さんの指示§9「不正CSV・JSON・JSONLを検出する」）。

import { AdjustmentTraceEntry, AutoplayRunManifest, CaseSummaryRow, SaiCompanyId } from "../autoplay/schema";
import type { DecisionTraceLine } from "../autoplay/output";
import { Sai3bAdjustmentTraceRow, Sai3bInputError, Sai3bQuarterSummaryRow, Sai3bRunSummaryJson, Sai3bWarningRow } from "./schema";

// ---------------------------------------------------------------------
// 汎用CSVパース（output.ts の csvEscape/toCsv と対になる読み取り側）
// ---------------------------------------------------------------------

/** ダブルクォート内のカンマ・改行・エスケープされた""を正しく扱う最小限のCSVパーサ。 */
export function parseCsvText(text: string): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // 末尾に改行がない最終行、または空でない残余フィールドがあれば取り込む。
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  if (inQuotes) {
    throw new Sai3bInputError("CSVの引用符が閉じられていません（ダブルクォートの対応が取れていません）。");
  }

  const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmptyRows.length === 0) {
    throw new Sai3bInputError("CSVにヘッダー行がありません（空ファイルの可能性があります）。");
  }
  const [header, ...dataRows] = nonEmptyRows;
  for (const [idx, r] of dataRows.entries()) {
    if (r.length !== header.length) {
      throw new Sai3bInputError(
        `CSVの列数が不正です（${idx + 2}行目: 列数${r.length}、ヘッダーの列数${header.length}）。`
      );
    }
  }
  return { header, rows: dataRows };
}

function rowsToRecords(header: readonly string[], rows: readonly (readonly string[])[]): readonly Readonly<Record<string, string>>[] {
  return rows.map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = r[i];
    });
    return rec;
  });
}

function requireColumns(sourceLabel: string, header: readonly string[], required: readonly string[]): void {
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Sai3bInputError(`${sourceLabel}: 必須列が不足しています: ${missing.join(", ")}（実際の列: ${header.join(", ")}）`);
  }
}

function toOptionalString(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = v;
  return trimmed.length === 0 ? undefined : trimmed;
}

function toOptionalNumber(v: string | undefined): number | undefined {
  const s = toOptionalString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (Number.isNaN(n)) return undefined;
  return n;
}

function toRequiredNumber(sourceLabel: string, field: string, v: string | undefined): number {
  if (v === undefined || v.length === 0) {
    throw new Sai3bInputError(`${sourceLabel}: 必須の数値フィールド "${field}" が空です。`);
  }
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Sai3bInputError(`${sourceLabel}: フィールド "${field}" が数値として解釈できません（値: "${v}"）。`);
  }
  return n;
}

function toOptionalBoolean(v: string | undefined): boolean | undefined {
  const s = toOptionalString(v);
  if (s === undefined) return undefined;
  if (s === "true") return true;
  if (s === "false") return false;
  throw new Sai3bInputError(`真偽値として解釈できない値です（値: "${s}"）。"true"/"false"のいずれかである必要があります。`);
}

function toRequiredBoolean(sourceLabel: string, field: string, v: string | undefined): boolean {
  const result = toOptionalBoolean(v);
  if (result === undefined) {
    throw new Sai3bInputError(`${sourceLabel}: 必須の真偽値フィールド "${field}" が空または不正です（値: "${v}"）。`);
  }
  return result;
}

function toRequiredString(sourceLabel: string, field: string, v: string | undefined): string {
  if (v === undefined || v.length === 0) {
    throw new Sai3bInputError(`${sourceLabel}: 必須のフィールド "${field}" が空です。`);
  }
  return v;
}

// ---------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------

export function parseManifestJson(text: string, sourceLabel: string): AutoplayRunManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Sai3bInputError(`${sourceLabel}: manifest.jsonがJSONとして解析できません（${e instanceof Error ? e.message : String(e)}）。`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Sai3bInputError(`${sourceLabel}: manifest.jsonの内容がオブジェクトではありません。`);
  }
  const m = parsed as Record<string, unknown>;
  const required = ["schemaVersion", "runId", "scenarioId", "standardBaselineId", "seeds", "quarters", "companyIds", "aiPolicyVersion", "salesForceHeadcountTotal"];
  const missing = required.filter((k) => !(k in m));
  if (missing.length > 0) {
    throw new Sai3bInputError(`${sourceLabel}: manifest.jsonに必須フィールドが不足しています: ${missing.join(", ")}`);
  }
  if (!Array.isArray(m.seeds) || !Array.isArray(m.companyIds)) {
    throw new Sai3bInputError(`${sourceLabel}: manifest.jsonのseeds/companyIdsが配列ではありません。`);
  }
  return m as unknown as AutoplayRunManifest;
}

// ---------------------------------------------------------------------
// case-summary.csv
// ---------------------------------------------------------------------

const CASE_SUMMARY_REQUIRED_COLUMNS: readonly string[] = [
  "seed",
  "companyId",
  "completedTurns",
  "requestedTurns",
  "completed",
  "cumulativeRevenueUsd",
  "cumulativeGrossProfitUsd",
  "cumulativeOperatingProfitUsd",
  "cumulativeSalesForceCostUsd",
  "finalCashUsd",
  "finalLoansUsd",
  "finalAvailableAdditionalCapacityUsd",
  "paymentDefaultEverByRequestedTurns",
  "paymentDefaultFirstTurn",
  "underwritingFrozenEverByRequestedTurns",
  "underwritingFrozenFirstTurn",
  "topReasonCodes",
  "warningCount",
];

export function parseCaseSummaryCsv(text: string, sourceLabel: string): readonly CaseSummaryRow[] {
  const { header, rows } = parseCsvText(text);
  requireColumns(`${sourceLabel}/case-summary.csv`, header, CASE_SUMMARY_REQUIRED_COLUMNS);
  const label = `${sourceLabel}/case-summary.csv`;
  return rowsToRecords(header, rows).map((r) => ({
    seed: toRequiredString(label, "seed", r.seed),
    companyId: toRequiredString(label, "companyId", r.companyId) as SaiCompanyId,
    completedTurns: toRequiredNumber(label, "completedTurns", r.completedTurns),
    requestedTurns: toRequiredNumber(label, "requestedTurns", r.requestedTurns),
    completed: toRequiredBoolean(label, "completed", r.completed),
    cumulativeRevenueUsd: toRequiredNumber(label, "cumulativeRevenueUsd", r.cumulativeRevenueUsd),
    cumulativeGrossProfitUsd: toRequiredNumber(label, "cumulativeGrossProfitUsd", r.cumulativeGrossProfitUsd),
    cumulativeOperatingProfitUsd: toRequiredNumber(label, "cumulativeOperatingProfitUsd", r.cumulativeOperatingProfitUsd),
    cumulativeSalesForceCostUsd: toRequiredNumber(label, "cumulativeSalesForceCostUsd", r.cumulativeSalesForceCostUsd),
    finalCashUsd: toRequiredNumber(label, "finalCashUsd", r.finalCashUsd),
    finalLoansUsd: toRequiredNumber(label, "finalLoansUsd", r.finalLoansUsd),
    finalAvailableAdditionalCapacityUsd: toRequiredNumber(label, "finalAvailableAdditionalCapacityUsd", r.finalAvailableAdditionalCapacityUsd),
    paymentDefaultEverByRequestedTurns: toRequiredBoolean(label, "paymentDefaultEverByRequestedTurns", r.paymentDefaultEverByRequestedTurns),
    paymentDefaultFirstTurn: toOptionalNumber(r.paymentDefaultFirstTurn),
    underwritingFrozenEverByRequestedTurns: toRequiredBoolean(label, "underwritingFrozenEverByRequestedTurns", r.underwritingFrozenEverByRequestedTurns),
    underwritingFrozenFirstTurn: toOptionalNumber(r.underwritingFrozenFirstTurn),
    topReasonCodes: (toOptionalString(r.topReasonCodes) ?? "").split("|").filter((s) => s.length > 0),
    warningCount: toRequiredNumber(label, "warningCount", r.warningCount),
  }));
}

// ---------------------------------------------------------------------
// quarter-summary.csv
// ---------------------------------------------------------------------

const QUARTER_SUMMARY_REQUIRED_COLUMNS: readonly string[] = [
  "seed",
  "companyId",
  "turn",
  "period",
  "netRevenueUsd",
  "grossProfitUsd",
  "operatingProfitUsd",
  "netIncomeUsd",
  "closingCashUsd",
  "endingShortTermLoansUsd",
  "endingLongTermLoansUsd",
  "salesEffortCapacityHosoEqTonsActual",
  "salesEffortUsedHosoEqTons",
  "salesEffortUtilizationRate",
  "salesReductionFromEffortConstraintHosoEqTons",
  "rawMaterialInventoryHosoEqTons",
  "finishedGoodsInventoryHosoEqTons",
  "discardQuantityHosoEqTons",
  "paymentDefault",
  "paymentDefaultNewlyTriggered",
  "underwritingFrozen",
  "underwritingFrozenNewlyTriggered",
  "warningCount",
];

export function parseQuarterSummaryCsv(text: string, sourceLabel: string): readonly Sai3bQuarterSummaryRow[] {
  const { header, rows } = parseCsvText(text);
  requireColumns(`${sourceLabel}/quarter-summary.csv`, header, QUARTER_SUMMARY_REQUIRED_COLUMNS);
  const label = `${sourceLabel}/quarter-summary.csv`;
  return rowsToRecords(header, rows).map((r) => ({
    seed: toRequiredString(label, "seed", r.seed),
    companyId: toRequiredString(label, "companyId", r.companyId),
    turn: toRequiredNumber(label, "turn", r.turn),
    period: toRequiredString(label, "period", r.period),
    startCashUsd: toOptionalNumber(r.startCashUsd),
    startShortTermLoansUsd: toOptionalNumber(r.startShortTermLoansUsd),
    startLongTermLoansUsd: toOptionalNumber(r.startLongTermLoansUsd),
    startAvailableAdditionalCapacityUsd: toOptionalNumber(r.startAvailableAdditionalCapacityUsd),
    startCreditTier: toOptionalString(r.startCreditTier),
    startCreditScore0to100: toOptionalNumber(r.startCreditScore0to100),
    startFinancialHealthTier: toOptionalString(r.startFinancialHealthTier),
    startPaymentDefault: toOptionalBoolean(r.startPaymentDefault),
    startUnderwritingFrozen: toOptionalBoolean(r.startUnderwritingFrozen),
    startRawMaterialInventoryHosoEqTons: toOptionalNumber(r.startRawMaterialInventoryHosoEqTons),
    startFinishedGoodsInventoryHosoEqTons: toOptionalNumber(r.startFinishedGoodsInventoryHosoEqTons),
    startSalesForceHeadcountTotal: toOptionalNumber(r.startSalesForceHeadcountTotal),
    startSalesEffortCapacityHosoEqTonsReference: toOptionalNumber(r.startSalesEffortCapacityHosoEqTonsReference),
    netRevenueUsd: toRequiredNumber(label, "netRevenueUsd", r.netRevenueUsd),
    grossProfitUsd: toRequiredNumber(label, "grossProfitUsd", r.grossProfitUsd),
    operatingProfitUsd: toRequiredNumber(label, "operatingProfitUsd", r.operatingProfitUsd),
    netIncomeUsd: toRequiredNumber(label, "netIncomeUsd", r.netIncomeUsd),
    closingCashUsd: toRequiredNumber(label, "closingCashUsd", r.closingCashUsd),
    endingShortTermLoansUsd: toRequiredNumber(label, "endingShortTermLoansUsd", r.endingShortTermLoansUsd),
    endingLongTermLoansUsd: toRequiredNumber(label, "endingLongTermLoansUsd", r.endingLongTermLoansUsd),
    endingAvailableAdditionalCapacityUsd: toOptionalNumber(r.endingAvailableAdditionalCapacityUsd),
    salesEffortCapacityHosoEqTonsActual: toRequiredNumber(label, "salesEffortCapacityHosoEqTonsActual", r.salesEffortCapacityHosoEqTonsActual),
    salesEffortUsedHosoEqTons: toRequiredNumber(label, "salesEffortUsedHosoEqTons", r.salesEffortUsedHosoEqTons),
    salesEffortUtilizationRate: toOptionalNumber(r.salesEffortUtilizationRate),
    salesReductionFromEffortConstraintHosoEqTons: toRequiredNumber(label, "salesReductionFromEffortConstraintHosoEqTons", r.salesReductionFromEffortConstraintHosoEqTons),
    rawMaterialInventoryHosoEqTons: toRequiredNumber(label, "rawMaterialInventoryHosoEqTons", r.rawMaterialInventoryHosoEqTons),
    finishedGoodsInventoryHosoEqTons: toRequiredNumber(label, "finishedGoodsInventoryHosoEqTons", r.finishedGoodsInventoryHosoEqTons),
    discardQuantityHosoEqTons: toRequiredNumber(label, "discardQuantityHosoEqTons", r.discardQuantityHosoEqTons),
    paymentDefault: toRequiredBoolean(label, "paymentDefault", r.paymentDefault),
    paymentDefaultNewlyTriggered: toRequiredBoolean(label, "paymentDefaultNewlyTriggered", r.paymentDefaultNewlyTriggered),
    underwritingFrozen: toRequiredBoolean(label, "underwritingFrozen", r.underwritingFrozen),
    underwritingFrozenNewlyTriggered: toRequiredBoolean(label, "underwritingFrozenNewlyTriggered", r.underwritingFrozenNewlyTriggered),
    warningCount: toRequiredNumber(label, "warningCount", r.warningCount),
  }));
}

// ---------------------------------------------------------------------
// decision-trace.jsonl
// ---------------------------------------------------------------------

export function parseDecisionTraceJsonl(text: string, sourceLabel: string): readonly DecisionTraceLine[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Sai3bInputError(`${sourceLabel}/decision-trace.jsonl: ${idx + 1}行目がJSONとして解析できません（${e instanceof Error ? e.message : String(e)}）。`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Sai3bInputError(`${sourceLabel}/decision-trace.jsonl: ${idx + 1}行目がオブジェクトではありません。`);
    }
    const obj = parsed as Record<string, unknown>;
    const required = ["seed", "companyId", "turn", "period", "startState", "decision", "salesQuantityTrace"];
    const missing = required.filter((k) => !(k in obj));
    if (missing.length > 0) {
      throw new Sai3bInputError(`${sourceLabel}/decision-trace.jsonl: ${idx + 1}行目に必須フィールドが不足しています: ${missing.join(", ")}`);
    }
    return obj as unknown as DecisionTraceLine;
  });
}

// ---------------------------------------------------------------------
// adjustment-trace.csv
// ---------------------------------------------------------------------

const ADJUSTMENT_TRACE_REQUIRED_COLUMNS: readonly string[] = [
  "seed",
  "companyId",
  "turn",
  "period",
  "category",
  "source",
  "code",
  "severity",
  "affectedDecision",
  "affectedMarketOrProduct",
  "before",
  "after",
  "delta",
  "message",
  "threshold",
  "relevantMetric",
];

export function parseAdjustmentTraceCsv(text: string, sourceLabel: string): readonly Sai3bAdjustmentTraceRow[] {
  const { header, rows } = parseCsvText(text);
  requireColumns(`${sourceLabel}/adjustment-trace.csv`, header, ADJUSTMENT_TRACE_REQUIRED_COLUMNS);
  const label = `${sourceLabel}/adjustment-trace.csv`;
  return rowsToRecords(header, rows).map((r) => ({
    seed: toRequiredString(label, "seed", r.seed),
    companyId: toRequiredString(label, "companyId", r.companyId),
    turn: toRequiredNumber(label, "turn", r.turn),
    period: toRequiredString(label, "period", r.period),
    category: toRequiredString(label, "category", r.category) as AdjustmentTraceEntry["category"],
    source: toRequiredString(label, "source", r.source) as AdjustmentTraceEntry["source"],
    code: toRequiredString(label, "code", r.code),
    severity: toRequiredString(label, "severity", r.severity),
    affectedDecision: toRequiredString(label, "affectedDecision", r.affectedDecision),
    affectedMarketOrProduct: toOptionalString(r.affectedMarketOrProduct),
    before: toOptionalNumber(r.before),
    after: toOptionalNumber(r.after),
    delta: toOptionalNumber(r.delta),
    message: r.message ?? "",
    threshold: toOptionalNumber(r.threshold),
    relevantMetric: toOptionalString(r.relevantMetric),
  }));
}

// ---------------------------------------------------------------------
// warnings.csv
// ---------------------------------------------------------------------

const WARNINGS_REQUIRED_COLUMNS: readonly string[] = ["seed", "companyId", "turn", "period", "code", "source", "severity", "message"];

export function parseWarningsCsv(text: string, sourceLabel: string): readonly Sai3bWarningRow[] {
  const { header, rows } = parseCsvText(text);
  requireColumns(`${sourceLabel}/warnings.csv`, header, WARNINGS_REQUIRED_COLUMNS);
  const label = `${sourceLabel}/warnings.csv`;
  return rowsToRecords(header, rows).map((r) => ({
    seed: toRequiredString(label, "seed", r.seed),
    companyId: toRequiredString(label, "companyId", r.companyId),
    turn: toRequiredNumber(label, "turn", r.turn),
    period: toRequiredString(label, "period", r.period),
    code: toRequiredString(label, "code", r.code),
    source: toRequiredString(label, "source", r.source),
    severity: toRequiredString(label, "severity", r.severity),
    message: r.message ?? "",
  }));
}

// ---------------------------------------------------------------------
// run-summary.json
// ---------------------------------------------------------------------

export function parseRunSummaryJson(text: string, sourceLabel: string): Sai3bRunSummaryJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Sai3bInputError(`${sourceLabel}: run-summary.jsonがJSONとして解析できません（${e instanceof Error ? e.message : String(e)}）。`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Sai3bInputError(`${sourceLabel}: run-summary.jsonの内容がオブジェクトではありません。`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!("runSummary" in obj) || !("errors" in obj)) {
    throw new Sai3bInputError(`${sourceLabel}: run-summary.jsonに runSummary / errors フィールドが不足しています。`);
  }
  return obj as unknown as Sai3bRunSummaryJson;
}

export function parseCsvTextInternal(text: string): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  return parseCsvText(text);
}
