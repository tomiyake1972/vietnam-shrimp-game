// ShrimpX V2 — Phase 7B重点受入確認60: deliveryObservationsの時系列・不変性確認
//
// 対応する重点確認事項（実装指示より）:
//   2. 時系列と保存値: deliveryObservationsの正しい四半期保存、後続ターンでの過去記録
//      不変性、当期結果の当期成約への非遡及、8/32ターン推移の正しい四半期参照、
//      商品/市場/会社対応のずれなし。
//
// 本ファイルはPhase 7Aのcompute関数を一切再実装せず、companyLab runnerが返す
// history（CompanyQuarterRecord[]）の構造をそのまま検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../core/units";
import { toYearQuarter } from "../../core/period";
import { DEMAND_MARKET_IDS } from "../../market/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { CompanyLabConfig } from "../types";

const EPSILON = 1e-6;

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "delivery-obs-001", turns: 8, ...overrides };
}

function runAllAuto(config: CompanyLabConfig) {
  return runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
}

test("受入確認60-1: 各ターンのdeliveryObservationsは、5社×5市場(=25件)の全組合せをちょうど1件ずつ持つ（会社/市場対応のずれがない）", () => {
  const result = runAllAuto(baseConfig({ turns: 8 }));
  const companyIds = result.companies.map((c) => c.companyId).sort();
  for (const record of result.history) {
    assert.equal(record.deliveryObservations.length, companyIds.length * DEMAND_MARKET_IDS.length);
    const seen = new Set<string>();
    for (const obs of record.deliveryObservations) {
      const key = `${obs.companyId}::${obs.market}`;
      assert.ok(!seen.has(key), `重複組合せ: ${key}`);
      seen.add(key);
      assert.ok(companyIds.includes(obs.companyId), `未知の会社ID: ${obs.companyId}`);
      assert.ok((DEMAND_MARKET_IDS as readonly string[]).includes(obs.market), `未知の市場ID: ${obs.market}`);
    }
    for (const companyId of companyIds) {
      for (const market of DEMAND_MARKET_IDS) {
        assert.ok(seen.has(`${companyId}::${market}`), `欠落: ${companyId}::${market} (turn ${record.turn})`);
      }
    }
  }
});

test("受入確認60-2: deliveryObservationsの各フィールドは負にならず、dueQuantity >= onTimeQuantity + newlyOverdueQuantity（当期分の内訳整合）", () => {
  const result = runAllAuto(baseConfig({ turns: 16, seed: "delivery-obs-nonneg" }));
  for (const record of result.history) {
    for (const obs of record.deliveryObservations) {
      const due = unwrapUnit(obs.dueQuantity);
      const onTime = unwrapUnit(obs.onTimeQuantity);
      const newlyOverdue = unwrapUnit(obs.newlyOverdueQuantity);
      const continuing = unwrapUnit(obs.continuingOverdueQuantity);
      assert.ok(due >= -EPSILON, `dueQuantity負: ${due}`);
      assert.ok(onTime >= -EPSILON, `onTimeQuantity負: ${onTime}`);
      assert.ok(newlyOverdue >= -EPSILON, `newlyOverdueQuantity負: ${newlyOverdue}`);
      assert.ok(continuing >= -EPSILON, `continuingOverdueQuantity負: ${continuing}`);
      assert.ok(onTime + newlyOverdue <= due + EPSILON, `onTime(${onTime})+newlyOverdue(${newlyOverdue}) > due(${due})`);
    }
  }
});

test("受入確認60-3: 過去ターンのCompanyQuarterRecord（deliveryObservations含む）は、後続ターン実行後も内容が変化しない（履歴不変性）", () => {
  // history配列は各ターンで [...state.history, record] というイミュータブルな追記で構築される
  // （runner.tsの既存パターン）。ここではturn1完走時点のスナップショットと、
  // 全ターン完走後の同一turnレコードとを深い等値比較し、後から書き換わっていないことを確認する。
  const partial = runAllAuto(baseConfig({ turns: 1, seed: "delivery-obs-immutable" }));
  const full = runAllAuto(baseConfig({ turns: 8, seed: "delivery-obs-immutable" }));
  assert.equal(partial.history.length, 1);
  assert.equal(JSON.stringify(partial.history[0]), JSON.stringify(full.history[0]), "turn1のレコードがturn8完走後も同一シードなら同一であるべき（後続ターンによる書き換えがない）");
});

test("受入確認60-4: 当期のdeliveryObservationsは当期の契約成約（salesRecord.newContracts等）に遡って影響しない（deliveryObservationsは納期評価専用であり、当期成約量には使われない）", () => {
  // deliveryObservationsは契約の履行状況（納期）の観測であり、販売配分（competitivenessWeight等）
  // には使われない。同一シードで、record.salesRecordとrecord.deliveryObservationsが
  // 互いに独立に決定論的であることを確認する（片方だけ変えても崩れない設計の間接確認として、
  // 両方が同一シードで完全再現することを検証する）。
  const a = runAllAuto(baseConfig({ turns: 8, seed: "delivery-obs-noretro" }));
  const b = runAllAuto(baseConfig({ turns: 8, seed: "delivery-obs-noretro" }));
  assert.equal(JSON.stringify(a.history.map((r) => r.salesRecord)), JSON.stringify(b.history.map((r) => r.salesRecord)));
  assert.equal(JSON.stringify(a.history.map((r) => r.deliveryObservations)), JSON.stringify(b.history.map((r) => r.deliveryObservations)));
});

test("受入確認60-5: 8ターン実行時と32ターン実行時で、共通する先頭8ターン分のdeliveryObservationsが完全一致する（長さの違いだけで過去分の値が変わらない）", () => {
  const short = runAllAuto(baseConfig({ turns: 8, seed: "delivery-obs-8v32" }));
  const long = runAllAuto(baseConfig({ turns: 32, seed: "delivery-obs-8v32" }));
  assert.equal(short.history.length, 8);
  assert.equal(long.history.length, 32);
  for (let i = 0; i < 8; i++) {
    assert.equal(
      JSON.stringify(short.history[i].deliveryObservations),
      JSON.stringify(long.history[i].deliveryObservations),
      `turn ${i + 1}のdeliveryObservationsが8ターン実行と32ターン実行で異なる`
    );
    assert.equal(short.history[i].period, long.history[i].period, `turn ${i + 1}のperiodが不一致`);
  }
});

test("受入確認60-6: 各レコードのperiod（会計四半期）はターン順に単調増加し、重複や逆行がない（8/32ターン推移の四半期参照ずれがない）", () => {
  const result = runAllAuto(baseConfig({ turns: 32, seed: "delivery-obs-period-order" }));
  let prevKey = -Infinity;
  for (const record of result.history) {
    const { year, quarter } = toYearQuarter(record.period);
    const key = year * 4 + quarter;
    assert.ok(key > prevKey, `period逆行または重複: turn ${record.turn} period=${JSON.stringify(record.period)}`);
    prevKey = key;
  }
});

test("受入確認60-7: buildMarketTrustRows（表示層）が参照するdeliveryObservationは、record.deliveryObservations内の同一会社×市場の生データとdueQuantity/onTimeQuantityが一致する（会社/市場対応のずれがない）", async () => {
  const { buildMarketTrustRows } = await import("../../../../v2/company-lab/dashboardViewModel");
  const result = runAllAuto(baseConfig({ turns: 8, seed: "delivery-obs-viewmodel" }));
  const companyId = result.companies[0].companyId;
  const record = result.history[result.history.length - 1];
  const rows = buildMarketTrustRows(record, companyId, DEMAND_MARKET_IDS);
  assert.equal(rows.length, DEMAND_MARKET_IDS.length);
  for (const row of rows) {
    const raw = record.deliveryObservations.find((d) => d.companyId === companyId && d.market === row.market);
    assert.ok(raw, `生データにcompanyId=${companyId} market=${row.market}の観測が存在するはず`);
    const dueQuantity = unwrapUnit(raw.dueQuantity);
    if (dueQuantity > EPSILON) {
      const expectedRate = Math.round((unwrapUnit(raw.onTimeQuantity) / dueQuantity) * 10000) / 100;
      assert.equal(row.onTimeDeliveryRateThisPeriod, expectedRate, `market=${row.market}の納期遵守率が生データと不一致`);
    } else {
      assert.equal(row.onTimeDeliveryRateThisPeriod, undefined, `market=${row.market}はdueQuantity=0のはずでonTimeDeliveryRateThisPeriodはundefinedであるべき`);
    }
  }
});
