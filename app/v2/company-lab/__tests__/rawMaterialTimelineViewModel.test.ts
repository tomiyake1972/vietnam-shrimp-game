// ShrimpX V2 — Procurement Planning: rawMaterialTimelineViewModel のテスト（PROC-TL-1〜8）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { period } from "../../../lib/v2/core/period";
import { RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import { buildRawMaterialTimeline } from "../rawMaterialTimelineViewModel";

const CURRENT = period(2026, 2);
const Q1 = period(2026, 3);
const Q2 = period(2026, 4);
const Q3 = period(2027, 1);
const COMPANY = "BAL";

function lot(overrides: Partial<RawMaterialLot>): RawMaterialLot {
  return {
    lotId: overrides.lotId ?? `lot-${Math.random()}`,
    companyId: COMPANY,
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: CURRENT,
    originalQuantity: hosoEqTons(1000),
    remainingQuantity: hosoEqTons(1000),
    unitCost: usdPerHosoEqKg(2.5),
    availableFromPeriod: CURRENT,
    status: "available",
    ...overrides,
  } as RawMaterialLot;
}

// PROC-TL-1: 手持ち在庫(status=available)はcarriedInventory行・currentバケットへ入る
test("PROC-TL-1: status=availableのロットはcarriedInventory行のcurrentバケットに入る", () => {
  const timeline = buildRawMaterialTimeline([lot({ remainingQuantity: hosoEqTons(1200) })], COMPANY, CURRENT);
  const row = timeline.rows.find((r) => r.rowKey === "carriedInventory")!;
  assert.equal(row.byBucket.current.tons, 1200);
  assert.equal(row.totalTons, 1200);
});

// PROC-TL-2: 輸入(inTransitImport)は到着期に応じてバケット分けされる
test("PROC-TL-2: 輸送中輸入ロットは到着期(availableFromPeriod)に応じてcurrent/q1/q2へ分類される", () => {
  const lots = [
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(300), availableFromPeriod: CURRENT }),
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(500), availableFromPeriod: Q1 }),
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(700), availableFromPeriod: Q2 }),
  ];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  const row = timeline.rows.find((r) => r.rowKey === "importArrivals")!;
  assert.equal(row.byBucket.current.tons, 300);
  assert.equal(row.byBucket.q1.tons, 500);
  assert.equal(row.byBucket.q2.tons, 700);
  assert.equal(row.totalTons, 1500);
});

// PROC-TL-3: 養殖(growingAquaculture)は収穫期に応じてバケット分けされる
test("PROC-TL-3: 養殖中ロットは収穫期(availableFromPeriod)に応じてバケット分けされる", () => {
  const lots = [lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(400), availableFromPeriod: Q1 })];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  const row = timeline.rows.find((r) => r.rowKey === "ownFarm")!;
  assert.equal(row.byBucket.q1.tons, 400);
  assert.equal(row.byBucket.current.tons, 0);
});

// PROC-TL-4: Q+3以降はbeyondバケットへまとめられる
test("PROC-TL-4: Q+3以降の到着・収穫予定はbeyondバケットへまとめられる", () => {
  const lots = [lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(900), availableFromPeriod: Q3 })];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  const row = timeline.rows.find((r) => r.rowKey === "importArrivals")!;
  assert.equal(row.byBucket.beyond.tons, 900);
  assert.equal(row.byBucket.q2.tons, 0);
});

// PROC-TL-5: 国内買付ロットは常にstatus=availableのため、domesticProcurement行は構造的に常に0
test("PROC-TL-5: 国内買付ロット(source=domestic, status=available)はcarriedInventory行へ入り、domesticProcurement行は0のまま", () => {
  const lots = [lot({ source: "domestic", status: "available", remainingQuantity: hosoEqTons(600) })];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  const carried = timeline.rows.find((r) => r.rowKey === "carriedInventory")!;
  const domestic = timeline.rows.find((r) => r.rowKey === "domesticProcurement")!;
  assert.equal(carried.byBucket.current.tons, 600);
  assert.equal(domestic.totalTons, 0);
});

// PROC-TL-6: consumed/expiredロットはタイムラインから除外される
test("PROC-TL-6: consumed/expiredのロットはタイムラインの集計から除外される", () => {
  const lots = [
    lot({ status: "consumed", remainingQuantity: hosoEqTons(0) }),
    lot({ status: "expired", remainingQuantity: hosoEqTons(50) }),
    lot({ status: "available", remainingQuantity: hosoEqTons(100) }),
  ];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  assert.equal(timeline.grandTotalTons, 100);
});

// PROC-TL-7: 他社ロットは除外される
test("PROC-TL-7: 他社のロットは集計から除外される", () => {
  const lots = [lot({ companyId: "MASS", remainingQuantity: hosoEqTons(9999) }), lot({ remainingQuantity: hosoEqTons(200) })];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  assert.equal(timeline.grandTotalTons, 200);
});

// PROC-TL-8: totalByBucketは全行の合計と一致する
test("PROC-TL-8: totalByBucketは全行のバケット別合計と一致する", () => {
  const lots = [
    lot({ status: "available", remainingQuantity: hosoEqTons(500), availableFromPeriod: CURRENT }),
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(300), availableFromPeriod: Q1 }),
    lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(200), availableFromPeriod: Q1 }),
  ];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  assert.equal(timeline.totalByBucket.current, 500);
  assert.equal(timeline.totalByBucket.q1, 500);
  assert.equal(timeline.grandTotalTons, 1000);
});

// PROC-TL-9: 各行のcertaintyが正しく割り当てられる（carriedInventory/domestic/import=confirmed, ownFarm=expected）
test("PROC-TL-9: carriedInventory・domesticProcurement・importArrivalsはconfirmed、ownFarmはexpected", () => {
  const timeline = buildRawMaterialTimeline([], COMPANY, CURRENT);
  const byKey = new Map(timeline.rows.map((r) => [r.rowKey, r]));
  assert.equal(byKey.get("carriedInventory")!.certainty, "confirmed");
  assert.equal(byKey.get("domesticProcurement")!.certainty, "confirmed");
  assert.equal(byKey.get("importArrivals")!.certainty, "confirmed");
  assert.equal(byKey.get("ownFarm")!.certainty, "expected");
  assert.equal(byKey.get("otherCommittedLots")!.certainty, "unknown");
});

// PROC-TL-10: confirmedTotalTons/expectedTotalTonsは、養殖の見込み量を確定量へ混ぜない
test("PROC-TL-10: confirmedTotalTonsは養殖の見込み量を含まず、expectedTotalTonsは養殖の見込み量のみを表す", () => {
  const lots = [
    lot({ status: "available", remainingQuantity: hosoEqTons(1000), availableFromPeriod: CURRENT }),
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(500), availableFromPeriod: CURRENT }),
    lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(5000), availableFromPeriod: Q1 }),
  ];
  const timeline = buildRawMaterialTimeline(lots, COMPANY, CURRENT);
  // 確定量は在庫＋輸入到着のみ。養殖5000tは含めない。
  assert.equal(timeline.confirmedTotalTons, 1500);
  assert.equal(timeline.expectedTotalTons, 5000);
  // grandTotalTonsは（表示上の合計として）両方を含む。
  assert.equal(timeline.grandTotalTons, 6500);
});
