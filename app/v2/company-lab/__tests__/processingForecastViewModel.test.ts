// ShrimpX V2 — 「現在の入力に基づく処理見込み」表示用データ層 単体テスト
//
// この層は独自の配分計算を持たず、生産処理エンジンの純粋関数
// allocateProductionPlans / calculateFactoryEffectiveCapacity をそのまま呼ぶ。
// したがってここでの検証の主眼は「エンジンと同じ結果になっているか」であり、
// 期待値もエンジン実装（優先度は小さいほど高い／同順位は水位法／能力の適用順序は
// 原料→共通処理→冷凍包装→商品別→労働）に従って組み立てる。
//
// 【禁止事項】期待値を「先着配分」など独自ロジックで作らない。優先度に依存する値
// （VAP約810t等）を固定値として書かない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../lib/v2/core/period";
import { hosoEqTons, ratio, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { CompanyProductionPlanEntry, Factory, WorkerAssignment } from "../../../lib/v2/production/types";
import { RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import { allocateProductionPlans } from "../../../lib/v2/production/allocation";
import { PRODUCTION_PARAMETERS_V1 } from "../../../lib/v2/production/parameters";
import { CapexState } from "../../../lib/v2/capex";
import { Product } from "../../../lib/v2/market/types";
import {
  buildCompanyProcessingForecast,
  CAPACITY_RATE_FACTOR_KEYS,
  CapacityEffectiveRateRow,
  CompanyProcessingForecast,
  FORECAST_HEADING_TEXT,
  ProcessingForecastRow,
} from "../processingForecastViewModel";

const P = period(2015, 2);
const EMPTY_CAPEX: CapexState = { companies: [] };

function factory(overrides: Partial<Factory> & Pick<Factory, "factoryId" | "companyId">): Factory {
  const zero = hosoEqTons(0);
  return {
    status: "active",
    commonProcessingCapacity: zero,
    hosoCapacity: zero,
    pdCapacity: zero,
    vapCapacity: zero,
    freezingPackagingCapacity: zero,
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
    ...overrides,
  };
}

/** 能力に十分な余裕がある基準工場（個別テストで絞る能力だけを上書きする）。 */
function baseFactory(overrides: Partial<Factory> = {}): Factory {
  return factory({
    factoryId: "BAL-F1",
    companyId: "BAL",
    commonProcessingCapacity: hosoEqTons(100_000),
    hosoCapacity: hosoEqTons(100_000),
    pdCapacity: hosoEqTons(100_000),
    vapCapacity: hosoEqTons(100_000),
    freezingPackagingCapacity: hosoEqTons(100_000),
    ...overrides,
  });
}

function plan(product: Product, desiredTons: number, priority: number): CompanyProductionPlanEntry {
  return {
    companyId: "BAL",
    factoryId: "BAL-F1",
    product,
    desiredQuantity: hosoEqTons(desiredTons),
    priority,
  };
}

/** 労働が制約にならないだけのワーカーを置く（労働を検証する回だけ人数を絞る）。 */
function workers(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    factoryId: "BAL-F1",
    companyId: "BAL",
    regularHeadcount: 20_000,
    temporaryHeadcount: 0,
    skills: [
      { product: "hoso", skillLevel: ratio(1) },
      { product: "pd", skillLevel: ratio(1) },
      { product: "vap", skillLevel: ratio(1) },
    ],
    overtimeRate: ratio(0),
    attendanceRate: ratio(1),
    ...overrides,
  };
}

function lot(tons: number, lotId = "L-1"): RawMaterialLot {
  return {
    lotId,
    companyId: "BAL",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: period(2015, 1),
    originalQuantity: hosoEqTons(tons),
    remainingQuantity: hosoEqTons(tons),
    unitCost: usdPerHosoEqKg(5),
    availableFromPeriod: period(2015, 1),
    status: "available",
  };
}

function build(args: {
  factories?: readonly Factory[];
  plans: readonly CompanyProductionPlanEntry[];
  workerAssignments?: readonly WorkerAssignment[];
  lots?: readonly RawMaterialLot[];
}): CompanyProcessingForecast {
  return buildCompanyProcessingForecast({
    companyId: "BAL",
    baseFactories: args.factories ?? [baseFactory()],
    capexState: EMPTY_CAPEX,
    period: P,
    productionPlans: args.plans,
    workerAssignments: args.workerAssignments ?? [workers()],
    rawMaterialLots: args.lots ?? [lot(1_000_000)],
  });
}

function rowOf(forecast: CompanyProcessingForecast, product: Product): ProcessingForecastRow {
  const found = forecast.rows.find((r) => r.product === product);
  assert.ok(found, `商品 ${product} の行が無い`);
  return found;
}

function rateRowOf(rows: readonly CapacityEffectiveRateRow[], poolKey: string): CapacityEffectiveRateRow {
  const found = rows.find((r) => r.poolKey === poolKey);
  assert.ok(found, `能力プール ${poolKey} の行が無い`);
  return found;
}

// ---------------------------------------------------------------------
// 1. 優先度の効果（三宅さんの指示 §5 の1・2番目）
// ---------------------------------------------------------------------

// 共通処理能力を絞り、3商品で奪い合う状況を作る。
const CONTESTED_FACTORY = baseFactory({ commonProcessingCapacity: hosoEqTons(10_000) });
const CONTESTED_PLANS_VAP_LAST = [plan("hoso", 5_000, 1), plan("pd", 4_000, 2), plan("vap", 3_000, 3)];
const CONTESTED_PLANS_VAP_FIRST = [plan("hoso", 5_000, 2), plan("pd", 4_000, 3), plan("vap", 3_000, 1)];

test("PFC-1: VAPの優先度を3→1へ上げると、VAPの処理見込みが増える", () => {
  const before = build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_LAST });
  const after = build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_FIRST });
  assert.ok(
    rowOf(after, "vap").forecastProcessedTons > rowOf(before, "vap").forecastProcessedTons,
    `VAP見込みが増えていない: ${rowOf(before, "vap").forecastProcessedTons} → ${rowOf(after, "vap").forecastProcessedTons}`
  );
  assert.ok(rowOf(before, "vap").forecastUnprocessedTons > rowOf(after, "vap").forecastUnprocessedTons);
});

test("PFC-2: 共通能力が一定なら、VAPを最優先にした結果として他商品の処理見込みが減る", () => {
  const before = build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_LAST });
  const after = build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_FIRST });
  const beforeOthers = rowOf(before, "hoso").forecastProcessedTons + rowOf(before, "pd").forecastProcessedTons;
  const afterOthers = rowOf(after, "hoso").forecastProcessedTons + rowOf(after, "pd").forecastProcessedTons;
  assert.ok(afterOthers < beforeOthers, `他商品の見込みが減っていない: ${beforeOthers} → ${afterOthers}`);
  // 共通処理能力（原料投入ベース）は変わらないので、総処理量は同じ水準にとどまる。
  const beforeTotal = before.rows.reduce((s, r) => s + r.forecastProcessedTons, 0);
  const afterTotal = after.rows.reduce((s, r) => s + r.forecastProcessedTons, 0);
  assert.ok(Math.abs(beforeTotal - afterTotal) < 1e-6, "共通能力が同じなら総処理見込みは変わらない");
});

test("PFC-3: 優先度が固定値ではないことを示す — VAPの見込みは優先度の指定だけで変わる", () => {
  const p3 = rowOf(build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_LAST }), "vap").forecastProcessedTons;
  const p1 = rowOf(build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_FIRST }), "vap").forecastProcessedTons;
  assert.notEqual(p3, p1, "同じ能力・同じ希望量でも、優先度が違えば見込みは変わる（固定値ではない）");
});

// ---------------------------------------------------------------------
// 2. 各能力が制約になるケース（§5 の3・4・5番目）
// ---------------------------------------------------------------------

test("PFC-4: 希望量が商品別実効能力を超えた場合、その実効能力で制限される", () => {
  // VAP名目2,000t × 0.9 × 0.95 = 1,710t
  const f = baseFactory({ vapCapacity: hosoEqTons(2_000) });
  const forecast = build({ factories: [f], plans: [plan("vap", 5_000, 1)] });
  const row = rowOf(forecast, "vap");
  assert.equal(row.productNominalCapacityTons, 2_000);
  assert.equal(row.productEffectiveCapacityTons, 1_710);
  assert.equal(row.forecastProcessedTons, 1_710);
  assert.equal(row.forecastUnprocessedTons, 3_290);
  assert.equal(row.primaryConstraint?.reason, "productCapacityShortage");
});

test("PFC-5: 共通処理能力が不足するとき、エンジンと同じ優先順位で配分される（自前計算と一致させない）", () => {
  const engine = allocateProductionPlans(
    CONTESTED_PLANS_VAP_LAST,
    [CONTESTED_FACTORY],
    [workers()],
    [lot(1_000_000)],
    P,
    PRODUCTION_PARAMETERS_V1
  );
  const forecast = build({ factories: [CONTESTED_FACTORY], plans: CONTESTED_PLANS_VAP_LAST });
  for (const entry of engine.entries) {
    const row = rowOf(forecast, entry.product);
    assert.equal(row.forecastProcessedTons, entry.allocatedQuantity as unknown as number);
  }
  assert.equal(rowOf(forecast, "vap").primaryConstraint?.reason, "commonCapacityShortage");
});

test("PFC-6: 冷凍・包装能力が最小の制約になるケースでは、それが主因として出る", () => {
  const f = baseFactory({ freezingPackagingCapacity: hosoEqTons(1_000) });
  const forecast = build({ factories: [f], plans: [plan("hoso", 5_000, 1)] });
  const row = rowOf(forecast, "hoso");
  assert.equal(row.primaryConstraint?.reason, "packagingCapacityShortage");
  assert.equal(row.forecastProcessedTons, 855, "1,000 × 0.9 × 0.95 = 855t");
  assert.equal(row.stages.freezingPackagingLimitedTons, 855);
});

test("PFC-7: 原料在庫が不足するときは原料が主因になる（原料も見込み計算に含まれる）", () => {
  const forecast = build({ plans: [plan("hoso", 5_000, 1)], lots: [lot(1_200)] });
  const row = rowOf(forecast, "hoso");
  assert.equal(row.primaryConstraint?.reason, "rawMaterialShortage");
  assert.equal(forecast.availableRawMaterialTons, 1_200);
});

test("PFC-8: 人員が不足するときは有効労働能力が制約として出る（人員も見込み計算に含まれる）", () => {
  const forecast = build({
    plans: [plan("hoso", 5_000, 1)],
    workerAssignments: [workers({ regularHeadcount: 10, temporaryHeadcount: 0 })],
  });
  const row = rowOf(forecast, "hoso");
  assert.equal(row.primaryConstraint?.reason, "laborShortage");
  assert.ok(row.forecastProcessedTons < 5_000);
});

test("PFC-9: 同順位の商品は先着順ではなく希望量に比例して配分され、エンジンと一致する", () => {
  const f = baseFactory({ commonProcessingCapacity: hosoEqTons(6_000) });
  const tiePlans = [plan("hoso", 6_000, 1), plan("pd", 2_000, 1)];
  const forecast = build({ factories: [f], plans: tiePlans });
  const reversed = build({ factories: [f], plans: [...tiePlans].reverse() });
  // 入力順に依存しない
  assert.equal(rowOf(forecast, "hoso").forecastProcessedTons, rowOf(reversed, "hoso").forecastProcessedTons);
  assert.equal(rowOf(forecast, "pd").forecastProcessedTons, rowOf(reversed, "pd").forecastProcessedTons);
  // 希望量比 3:1 に比例している（先着ならHOSOが6,000tを総取りする）
  const h = rowOf(forecast, "hoso").forecastProcessedTons;
  const p = rowOf(forecast, "pd").forecastProcessedTons;
  assert.ok(p > 0, "先着配分ならPDは0になるが、水位法では0にならない");
  assert.ok(Math.abs(h / p - 3) < 1e-3, `希望量比3:1で配分されるべき: ${h} : ${p}`);
  // エンジン直呼びとも完全一致
  const engine = allocateProductionPlans(tiePlans, [f], [workers()], [lot(1_000_000)], P, PRODUCTION_PARAMETERS_V1);
  for (const entry of engine.entries) {
    assert.equal(rowOf(forecast, entry.product).forecastProcessedTons, entry.allocatedQuantity as unknown as number);
  }
});

test("PFC-10: 制約が複数ある場合、主因と補足要因が区別される（先頭が主因）", () => {
  // 共通処理能力(実効2,565t)をHOSOが1,000t使い、残り1,565tがVAPへ回る（共通能力で不足）。
  // そのうえでVAPの商品別実効能力855tがさらに効く（商品別能力でも不足）。
  const f = baseFactory({ commonProcessingCapacity: hosoEqTons(3_000), vapCapacity: hosoEqTons(1_000) });
  const forecast = build({ factories: [f], plans: [plan("hoso", 1_000, 1), plan("vap", 4_000, 2)] });
  const vap = rowOf(forecast, "vap");
  assert.ok(vap.constraints.length >= 2, "複数の制約が効いている状況を作れていない");
  assert.equal(vap.constraints[0].role, "primary");
  for (const c of vap.constraints.slice(1)) assert.equal(c.role, "contributing");
  assert.equal(vap.primaryConstraint, vap.constraints[0]);
  assert.ok(vap.priorityNote !== undefined, "優先度が下位で共有プールを奪い合う行には注記が付く");
});

// ---------------------------------------------------------------------
// 3. 名目・実効率・実効能力の関係（§5 の7番目、§2）
// ---------------------------------------------------------------------

test("PFC-11: 名目能力 × 実効率 ＝ 実効能力 が5つの能力プールすべてで成り立つ", () => {
  const forecast = build({ plans: [plan("hoso", 1_000, 1)] });
  assert.equal(forecast.companyRateTable.rows.length, 5);
  for (const row of forecast.companyRateTable.rows) {
    assert.notEqual(row.effectiveRate, undefined);
    assert.ok(
      Math.abs(row.nominalTons * (row.effectiveRate as number) - row.effectiveTons) < 1e-6,
      `${row.poolKey}: ${row.nominalTons} × ${row.effectiveRate} ≠ ${row.effectiveTons}`
    );
  }
});

test("PFC-12: 実効率を構成する補正要因は基準稼働率と設備利用可能率の2つだけで、その積が実効率に一致する", () => {
  const forecast = build({ plans: [plan("hoso", 1_000, 1)] });
  const hoso = rateRowOf(forecast.companyRateTable.rows, "hoso");
  assert.deepEqual(hoso.factors.map((f) => f.key), [...CAPACITY_RATE_FACTOR_KEYS]);
  assert.equal(hoso.factors.length, 2, "コードに存在しない補正要因を増やしてはならない");
  assert.equal(hoso.factors[0].value, 0.9);
  assert.equal(hoso.factors[1].value, 0.95);
  assert.ok(Math.abs((hoso.factorsProduct as number) - 0.855) < 1e-9);
  assert.ok(Math.abs((hoso.effectiveRate as number) - 0.855) < 1e-6);
  assert.ok(hoso.correctionNote.includes("85.5"));
});

test("PFC-13: 能力プールごとに実効率を出す（一律85.5%と決め打ちしない）", () => {
  const f = baseFactory({ status: "idle" });
  const forecast = build({ factories: [f], plans: [plan("hoso", 1_000, 1)] });
  for (const row of forecast.companyRateTable.rows) {
    assert.equal(row.effectiveTons, 0, "停止中の工場は実効能力0（名目は残る）");
    assert.equal(row.effectiveRate, 0);
  }
});

test("PFC-14: 名目能力が0のプールの実効率はundefined（0で埋めない）", () => {
  const f = factory({ factoryId: "BAL-F1", companyId: "BAL", hosoCapacity: hosoEqTons(1_000) });
  const forecast = build({ factories: [f], plans: [] });
  assert.equal(rateRowOf(forecast.companyRateTable.rows, "vap").nominalTons, 0);
  assert.equal(rateRowOf(forecast.companyRateTable.rows, "vap").effectiveRate, undefined);
});

// ---------------------------------------------------------------------
// 4. 見込みであることの明示・スコープ隔離
// ---------------------------------------------------------------------

test("PFC-15: 確定結果ではないことが型と文言の両方で明示される", () => {
  const forecast = build({ plans: [plan("hoso", 1_000, 1)] });
  assert.equal(forecast.isForecast, true);
  assert.equal(forecast.headingText, FORECAST_HEADING_TEXT);
  assert.ok(forecast.caveatTexts.length > 0);
});

test("PFC-16: 他社の工場・生産計画・原料ロットは一切混入しない", () => {
  const massFactory = factory({ factoryId: "MASS-F1", companyId: "MASS", hosoCapacity: hosoEqTons(50_000) });
  const massPlan: CompanyProductionPlanEntry = {
    companyId: "MASS",
    factoryId: "MASS-F1",
    product: "hoso",
    desiredQuantity: hosoEqTons(9_999),
    priority: 1,
  };
  const massLot: RawMaterialLot = { ...lot(999_999, "L-MASS"), companyId: "MASS" };
  const forecast = buildCompanyProcessingForecast({
    companyId: "BAL",
    baseFactories: [baseFactory(), massFactory],
    capexState: EMPTY_CAPEX,
    period: P,
    productionPlans: [plan("hoso", 1_000, 1), massPlan],
    workerAssignments: [workers(), { ...workers(), companyId: "MASS", factoryId: "MASS-F1" }],
    rawMaterialLots: [lot(5_000), massLot],
  });
  assert.deepEqual(forecast.rows.map((r) => r.factoryId), ["BAL-F1"]);
  assert.equal(forecast.rows.length, 1);
  assert.equal(forecast.availableRawMaterialTons, 5_000, "他社ロットを自社の利用可能原料に含めない");
  assert.deepEqual(forecast.factoryRateTables.map((t) => t.factoryId), ["BAL-F1"]);
});

test("PFC-17: 生産計画が空のとき、行を0で埋めずに空配列を返す", () => {
  const forecast = build({ plans: [] });
  assert.deepEqual(forecast.rows, []);
  assert.equal(forecast.companyRateTable.rows.length, 5, "能力の説明は計画が無くても表示する");
});
