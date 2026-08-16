// ShrimpX V2 — Procurement Planning: plannedProcurementViewModel のテスト（PROC-PLAN-1〜12）

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../lib/v2/core/period";
import {
  buildPlannedAquacultureRow,
  buildPlannedDomesticRow,
  buildPlannedImportRows,
  buildPlannedProcurementSummary,
  resolveImportArrivalBucket,
} from "../plannedProcurementViewModel";

const CURRENT = period(2026, 2);
const STANDARD_LEAD_TIME = 2;

// PROC-PLAN-1: 国内買付Plannedは常にcertainty=planned・currentバケット
test("PROC-PLAN-1: 国内買付Planned行はcertainty=planned・currentバケットに全量入る", () => {
  const row = buildPlannedDomesticRow(5000);
  assert.equal(row.certainty, "planned");
  assert.equal(row.byBucket.current.tons, 5000);
  assert.equal(row.totalTons, 5000);
});

// PROC-PLAN-2: 希望量0は行として意味を持たない（totalTons=0）
test("PROC-PLAN-2: 国内買付希望量が0以下ならtotalTonsは0", () => {
  const row = buildPlannedDomesticRow(-100);
  assert.equal(row.totalTons, 0);
});

// PROC-PLAN-3: 輸入発注は標準リードタイムでバケット分けされる
test("PROC-PLAN-3: leadTimeTurns未指定の輸入発注は標準リードタイム(2)でQ+2バケットへ入る", () => {
  const rows = buildPlannedImportRows(
    [{ originCountry: "ID", orderedQuantityTons: 800, leadTimeTurns: undefined }],
    CURRENT,
    STANDARD_LEAD_TIME
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].byBucket.q2.tons, 800);
  assert.equal(rows[0].certainty, "planned");
});

// PROC-PLAN-4: leadTimeTurns=1なら Q+1 バケットへ入る
test("PROC-PLAN-4: leadTimeTurns=1の輸入発注はQ+1バケットへ入る", () => {
  const rows = buildPlannedImportRows([{ originCountry: "EC", orderedQuantityTons: 300, leadTimeTurns: 1 }], CURRENT, STANDARD_LEAD_TIME);
  assert.equal(rows[0].byBucket.q1.tons, 300);
});

// PROC-PLAN-5: leadTimeTurns=4以上はbeyondバケット
test("PROC-PLAN-5: leadTimeTurns=4の輸入発注はbeyondバケットへ入る", () => {
  const rows = buildPlannedImportRows([{ originCountry: "VN", orderedQuantityTons: 100, leadTimeTurns: 4 }], CURRENT, STANDARD_LEAD_TIME);
  assert.equal(rows[0].byBucket.beyond.tons, 100);
});

// PROC-PLAN-6: 発注量0の原産国は行として出力されない
test("PROC-PLAN-6: 発注量0の原産国はPlanned行に含まれない", () => {
  const rows = buildPlannedImportRows(
    [
      { originCountry: "IN", orderedQuantityTons: 0, leadTimeTurns: undefined },
      { originCountry: "ID", orderedQuantityTons: 500, leadTimeTurns: undefined },
    ],
    CURRENT,
    STANDARD_LEAD_TIME
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].rowKey.includes("ID"));
});

// PROC-PLAN-7: 養殖Plannedは常にQ+1バケット
test("PROC-PLAN-7: 養殖池入れPlanned行は常にQ+1バケットへ入る（harvestPeriod省略時規約）", () => {
  const row = buildPlannedAquacultureRow(3200, CURRENT);
  assert.ok(row !== null);
  assert.equal(row!.certainty, "planned");
  assert.equal(row!.byBucket.q1.tons, 3200);
});

// PROC-PLAN-8: expectedProductionTons未定義・0はnullを返す（存在しない養殖能力の会社等）
test("PROC-PLAN-8: 期待生産量が未定義または0以下ならnullを返す", () => {
  assert.equal(buildPlannedAquacultureRow(undefined, CURRENT), null);
  assert.equal(buildPlannedAquacultureRow(0, CURRENT), null);
});

// PROC-PLAN-9: buildPlannedProcurementSummaryは3種の行を統合し、バケット別合計を計算する
test("PROC-PLAN-9: buildPlannedProcurementSummaryは国内・輸入・養殖のPlanned行を統合する", () => {
  const summary = buildPlannedProcurementSummary(
    5000,
    [{ originCountry: "ID", orderedQuantityTons: 800, leadTimeTurns: undefined }],
    3200,
    CURRENT,
    STANDARD_LEAD_TIME
  );
  assert.equal(summary.rows.length, 3);
  assert.equal(summary.totalTons, 5000 + 800 + 3200);
  assert.equal(summary.totalByBucket.current, 5000);
  assert.equal(summary.totalByBucket.q1, 3200);
  assert.equal(summary.totalByBucket.q2, 800);
});

// PROC-PLAN-10: 全入力が0のときrowsは空
test("PROC-PLAN-10: 国内・輸入・養殖のすべてが0のとき、rowsは空配列", () => {
  const summary = buildPlannedProcurementSummary(0, [], undefined, CURRENT, STANDARD_LEAD_TIME);
  assert.equal(summary.rows.length, 0);
  assert.equal(summary.totalTons, 0);
});

// PROC-PLAN-11: source別内訳（domestic/import/aquaculture）が正しく分類・シェア計算される
test("PROC-PLAN-11: summarizePlannedProcurementBySourceは国内・輸入・養殖を正しく分類しシェアを求める", () => {
  const summary = buildPlannedProcurementSummary(
    5000,
    [{ originCountry: "ID", orderedQuantityTons: 800, leadTimeTurns: undefined }],
    3200,
    CURRENT,
    STANDARD_LEAD_TIME
  );
  const bySource = summary.bySource;
  assert.equal(bySource.length, 3);
  const domestic = bySource.find((s) => s.source === "domestic")!;
  const importEntry = bySource.find((s) => s.source === "import")!;
  const aquaculture = bySource.find((s) => s.source === "aquaculture")!;
  assert.equal(domestic.quantityTons, 5000);
  assert.equal(importEntry.quantityTons, 800);
  assert.equal(aquaculture.quantityTons, 3200);
  const total = 5000 + 800 + 3200;
  assert.ok(Math.abs(domestic.shareOfTotal - 5000 / total) < 1e-9);
  assert.ok(Math.abs(importEntry.shareOfTotal - 800 / total) < 1e-9);
  assert.ok(Math.abs(aquaculture.shareOfTotal - 3200 / total) < 1e-9);
});

// PROC-PLAN-12: 全て0のときはshareOfTotalも0（0除算を捏造しない）
test("PROC-PLAN-12: すべてのPlanned行が空のとき、bySourceの各shareOfTotalは0", () => {
  const summary = buildPlannedProcurementSummary(0, [], undefined, CURRENT, STANDARD_LEAD_TIME);
  for (const entry of summary.bySource) {
    assert.equal(entry.quantityTons, 0);
    assert.equal(entry.shareOfTotal, 0);
  }
});

// PROC-PLAN-13: resolveImportArrivalBucketはbuildPlannedImportRowsと同じバケットを返す（単一の情報源）
test("PROC-PLAN-13: resolveImportArrivalBucketはleadTimeTurns未指定時に標準リードタイムでQ+2相当を返す", () => {
  assert.equal(resolveImportArrivalBucket(CURRENT, undefined, STANDARD_LEAD_TIME), "q2");
  assert.equal(resolveImportArrivalBucket(CURRENT, 1, STANDARD_LEAD_TIME), "q1");
  assert.equal(resolveImportArrivalBucket(CURRENT, 4, STANDARD_LEAD_TIME), "beyond");
});
