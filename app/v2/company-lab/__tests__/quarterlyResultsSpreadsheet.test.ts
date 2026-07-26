// ShrimpX V2 — Phase 8G §6 QuarterlyResultsSpreadsheet（四半期結果のスプレッドシート型UI）の回帰テスト
//
// renderToStaticMarkupで実データを描画し（jsdom・testing-library未導入という
// このリポジトリの既存の制約を踏まえ、marketPanelConsumerMarketWiring.test.ts・
// importLotsPanel.test.tsと同じ手法を踏襲する）、各turnが列として、既存の指標が
// 行として、それぞれ描画されることと、呼び出し側（両画面）への配線を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuarterlyResultsSpreadsheet from "../components/QuarterlyResultsSpreadsheet";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../lib/v2/companyLab/autoPolicy";
import { CompanyLabConfig } from "../../../lib/v2/companyLab/types";
import { buildQuarterlyResultsSpreadsheetRows } from "../quarterlyResultsSpreadsheetViewModel";

function runMinimal() {
  const config: CompanyLabConfig = { scenarioId: "baseline-v0.1", mode: "canonical", seed: "qrs-panel-001", turns: 3 };
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

const shared = runMinimal();
const rows = buildQuarterlyResultsSpreadsheetRows(shared.history, "BAL");

test("§1: turnの数ぶんの列見出し（turn番号・期）が描画される", () => {
  assert.ok(rows.length > 0, "前提条件：行データが生成されていること");
  const html = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows }));

  for (const row of rows) {
    assert.ok(html.includes(`turn ${row.turn}`), `turn ${row.turn}の列見出しが描画されていること`);
    assert.ok(html.includes(row.period), `期表示（${row.period}）が描画されていること`);
  }
});

test("§2: 主要な指標ラベルがすべて行見出しとして描画される", () => {
  const html = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows }));
  const expectedLabels = [
    "新規成約数量",
    "履行数量",
    "国内買付量",
    "輸入中",
    "輸入到着",
    "原料在庫",
    "HOSO生産量",
    "PD生産量",
    "VAP生産量",
    "完成品在庫",
    "設備稼働率",
    "労務稼働率",
    "純売上高",
    "営業利益",
    "当期純利益",
    "期末現金",
  ];
  for (const label of expectedLabels) {
    assert.ok(html.includes(label), `指標「${label}」の行見出しが描画されていること`);
  }
});

test("§3: 行データが空の場合はエラーにならず、代わりに「まだ確定した四半期結果がありません」と表示される", () => {
  const html = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows: [] }));
  assert.ok(html.includes("まだ確定した四半期結果がありません"));
});

test("§4: 財務データが無い(null)行では「－」が表示され、NaN・Infinity・undefinedが出力されない", () => {
  const rowsWithNullFinancials = rows.map((r) => ({ ...r, netRevenue: null, operatingProfit: null, netIncome: null, closingCash: null }));
  const html = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows: rowsWithNullFinancials }));
  assert.ok(html.includes("－"), "財務データが無い行には「－」が表示されること");
  assert.ok(!html.includes("NaN"));
  assert.ok(!html.includes("Infinity"));
  assert.ok(!html.includes("undefined"));
});

test("§5: 同一の入力を2回描画しても完全に同じHTMLになる（再読込で変化しないことの確認）", () => {
  const htmlA = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows }));
  const htmlB = renderToStaticMarkup(React.createElement(QuarterlyResultsSpreadsheet, { rows }));
  assert.equal(htmlA, htmlB);
});

test("§6: PlayerScreenClient.tsx・page.tsxの両方が、QuarterlyResultsSpreadsheetを呼び出している（配線漏れ検知）", () => {
  const playerScreenClientPath = path.join(__dirname, "..", "play", "[labId]", "PlayerScreenClient.tsx");
  const pageTsxPath = path.join(__dirname, "..", "page.tsx");

  const playerScreenClientSource = readFileSync(playerScreenClientPath, "utf8");
  const pageTsxSource = readFileSync(pageTsxPath, "utf8");

  assert.ok(playerScreenClientSource.includes("<QuarterlyResultsSpreadsheet"), "PlayerScreenClient.tsxがQuarterlyResultsSpreadsheetを呼び出していること");
  assert.ok(pageTsxSource.includes("<QuarterlyResultsSpreadsheet"), "page.tsx（GM画面）がQuarterlyResultsSpreadsheetを呼び出していること");
});
