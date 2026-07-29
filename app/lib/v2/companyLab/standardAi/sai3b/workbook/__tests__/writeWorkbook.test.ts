// ShrimpX V2 — Phase SAI-3B-1: workbook組み立てのユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { loadSai3aRun } from "../../loadRun";
import { buildSai3bAnalysis } from "../../buildAnalysis";
import { buildSai3bWorkbook, renderSai3bWorkbookToBuffer } from "../writeWorkbook";
import { buildFixtureRunFiles } from "../../__tests__/testFixtures";

function analysisFromRuns(specs: readonly { runId: string; headcount: number; defaultAtTurn?: number }[]) {
  const runs = specs.map((s) => {
    const files = buildFixtureRunFiles({
      runId: s.runId,
      headcount: s.headcount,
      quarters: 2,
      cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: s.headcount, defaultAtTurn: s.defaultAtTurn }],
    });
    return loadSai3aRun({ runLabel: s.runId, sourceDir: `/tmp/${s.runId}`, files });
  });
  return buildSai3bAnalysis(runs, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
}

const EXPECTED_SHEETS = [
  "README",
  "全体サマリー",
  "グラフ",
  "会社別業績",
  "四半期業績",
  "販売分析",
  "調達_生産_在庫",
  "営業能力分析",
  "営業能力_市場別",
  "計画調整分析",
  "Default_信用_警告",
  "ReasonCode集計",
  "四半期判断トレース",
  "Raw_Case",
  "Raw_Quarter",
  "Raw_Decision",
  "Raw_Adjustment",
  "Raw_Warnings",
];

test("buildSai3bWorkbook: 単一runで必須シートがすべて存在する", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(wb.getWorksheet(name), `missing sheet: ${name}`);
  }
  // 単一run時は80_85_90人比較シートを作らない。
  assert.equal(wb.getWorksheet("80_85_90人比較"), undefined);
});

test("buildSai3bWorkbook: 複数run（headcount比較）で80_85_90人比較シートが追加される", () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("80_85_90人比較");
  assert.ok(ws);
});

test("buildSai3bWorkbook: 数値セルが文字列化されていない", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("会社別業績")!;
  // ヘッダー行(1行目)の次(2行目)が最初のデータ行。累計売上(USD)列(11列目)は数値のはず。
  const revenueCell = ws.getRow(2).getCell(11);
  assert.equal(typeof revenueCell.value, "number");
});

test("buildSai3bWorkbook: オートフィルター・ウィンドウ枠固定が設定されている", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  const ws = wb.getWorksheet("会社別業績")!;
  assert.ok(ws.autoFilter, "autoFilter should be set");
  assert.ok(ws.views && ws.views.length > 0 && ws.views[0].state === "frozen");
});

test("buildSai3bWorkbook: default/underwritingFrozenがないrunでも生成できる", () => {
  const analysis = analysisFromRuns([{ runId: "r1", headcount: 80 }]);
  const wb = buildSai3bWorkbook(analysis);
  assert.ok(wb.getWorksheet("Default_信用_警告"));
});

test("renderSai3bWorkbookToBuffer: グラフ付きxlsxを生成し、exceljsで再読込できる", async () => {
  const analysis = analysisFromRuns([
    { runId: "h80", headcount: 80 },
    { runId: "h85", headcount: 85, defaultAtTurn: 1 },
    { runId: "h90", headcount: 90 },
  ]);
  const buffer = await renderSai3bWorkbookToBuffer(analysis);
  assert.ok(buffer.length > 0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(wb.getWorksheet(name), `missing sheet after reload: ${name}`);
  }
  assert.ok(wb.getWorksheet("80_85_90人比較"));
});
