// ShrimpX V2 — Phase 8G §6 quarterlyResultsSpreadsheetViewModel.ts の回帰テスト
//
// 実際のcompanyLab統合ラン（runCompanyLabWithAutoPolicyForAllCompanies）で
// 確定させた本物のCompanyQuarterRecordを渡し、既存のCompanyQuarterSummary・
// CompanyFinancialQuarterResultの値をそのまま抽出しているだけであること
// （新しい指標・係数を計算していないこと）を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { extractCompanyFinancialResult } from "../play/_lib/financialViewSelectors";
import { buildQuarterlyResultsSpreadsheetRows } from "../quarterlyResultsSpreadsheetViewModel";

function runMinimal() {
  const config: CompanyLabConfig = { scenarioId: "baseline-v0.1", mode: "canonical", seed: "qrs-vm-001", turns: 4 };
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

const shared = runMinimal();
const COMPANY_ID = "BAL";

test("§1: turn数ぶんの行が、turn・periodともに元のCompanyQuarterRecordと完全一致して生成される", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  assert.equal(rows.length, shared.history.length);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.turn, shared.history[i].turn);
    assert.equal(row.period, String(shared.history[i].period));
  }
});

test("§2: 数量・価格系フィールドは、元のCompanySummaryの値とunwrapUnit後で完全に一致する（新しい計算をしていないこと）", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  for (const [i, row] of rows.entries()) {
    const summary = shared.history[i].companySummaries.find((s) => s.companyId === COMPANY_ID)!;
    assert.equal(row.newContractedQuantity, unwrapUnit(summary.newContractedQuantity));
    assert.equal(row.newContractedAveragePrice, summary.newContractedAveragePrice);
    assert.equal(row.fulfilledQuantity, unwrapUnit(summary.fulfilledQuantity));
    assert.equal(row.outstandingQuantity, unwrapUnit(summary.outstandingQuantity));
    assert.equal(row.overdueQuantity, unwrapUnit(summary.overdueQuantity));
    assert.equal(row.domesticPurchaseQuantity, unwrapUnit(summary.domesticPurchaseQuantity));
    assert.equal(row.domesticPurchasePrice, summary.domesticPurchasePrice);
    assert.equal(row.importInTransitQuantity, unwrapUnit(summary.importInTransitQuantity));
    assert.equal(row.importArrivedQuantity, unwrapUnit(summary.importArrivedQuantity));
    assert.equal(row.rawMaterialInventory, unwrapUnit(summary.rawMaterialInventory));
    assert.equal(row.hosoProduced, unwrapUnit(summary.hosoProduced));
    assert.equal(row.pdProduced, unwrapUnit(summary.pdProduced));
    assert.equal(row.vapProduced, unwrapUnit(summary.vapProduced));
    assert.equal(row.finishedGoodsInventory, unwrapUnit(summary.finishedGoodsInventory));
    assert.equal(row.equipmentUtilizationRate, unwrapUnit(summary.equipmentUtilizationRate));
    assert.equal(row.laborUtilizationRate, unwrapUnit(summary.laborUtilizationRate));
  }
});

test("§3: 財務系フィールドは、extractCompanyFinancialResultが返す値と完全に一致する", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  for (const [i, row] of rows.entries()) {
    const fr = extractCompanyFinancialResult(shared.history[i], COMPANY_ID);
    assert.ok(fr, `turn ${shared.history[i].turn}: 財務結果が見つかるはず`);
    assert.equal(row.netRevenue, fr!.profitAndLoss.netRevenue);
    assert.equal(row.operatingProfit, fr!.profitAndLoss.operatingProfit);
    assert.equal(row.netIncome, fr!.profitAndLoss.netIncome);
    assert.equal(row.closingCash, fr!.cashFlow.closingCash);
  }
});

test("§4: 存在しない会社IDを渡すと、companySummariesが見つからず全レコードが読み飛ばされ、空配列になる（0埋め・捏造をしない）", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, "NOT-A-REAL-COMPANY");
  assert.equal(rows.length, 0);
});

test("§5: 空のレコード配列を渡すと空配列を返す（エラーにならない）", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows([], COMPANY_ID);
  assert.deepEqual(rows, []);
});

test("§6: 他社（自社以外）のデータはいずれの行にも一切含まれない（情報開示レベルの確認）", () => {
  const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  const serialized = JSON.stringify(rows);
  const otherCompanyIds = ["MASS", "JPQ", "VAP", "CONSV"];
  for (const otherId of otherCompanyIds) {
    // BALの数値と偶然一致するのを避けるため、他社IDそのものの文字列が出力に含まれないことだけを確認する
    // （行データはnumber/string(period)のみで、companyIdフィールド自体を持たないため、通常は絶対に出ない）。
    assert.ok(!serialized.includes(`"${otherId}"`), `${otherId}（他社ID）が出力に含まれていないこと`);
  }
});

test("§7: 同一入力に対して常に同じ結果を返す（決定論性。再読込で値が変化しないことに相当する）", () => {
  const rowsA = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  const rowsB = buildQuarterlyResultsSpreadsheetRows(shared.history, COMPANY_ID);
  assert.deepEqual(rowsA, rowsB);
});
