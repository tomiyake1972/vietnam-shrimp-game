// ShrimpX V2 — Export（加工能力セクション）の処理見込みが、意思決定画面とまったく
// 同じ共有計算結果であることの検証。
//
// 三宅さんの指示: 「Excelと画面は、同じ共有view-modelまたは純粋計算関数から値を
// 取得してください。計算ロジックを二重に持たせないでください。会社別ブックでは
// 自社の能力と自社の生産計画だけを表示し、他社の非公開情報を混入させないで
// ください。」
//
// 【禁止事項】ここで期待値を独自に計算しない。画面が呼ぶ
// buildCompanyProcessingForecast の出力そのものと突き合わせる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../../../lib/v2/core/period";
import { hosoEqTons, ratio, usdPerHosoEqKg } from "../../../../lib/v2/core/units";
import { buildCompanyFixtures } from "../../../../lib/v2/companyLab/fixtures";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../../../../lib/v2/production/types";
import { RawMaterialLot } from "../../../../lib/v2/rawMaterials/types";
import { buildExportProcessingCapacity } from "../_lib/dto/processingCapacityDto";
import { buildCompanyProcessingForecast } from "../../../../v2/company-lab/processingForecastViewModel";

const START = period(2015, 1);
const AS_OF = period(2015, 2);
const FIXTURES = buildCompanyFixtures(START);
const BAL = FIXTURES.find((f) => f.companyId === "BAL");
assert.ok(BAL, "BALのfixtureが存在する");
const BAL_FACTORY_ID = BAL.factories[0].factoryId;

const PLANS: readonly CompanyProductionPlanEntry[] = [
  { companyId: "BAL", factoryId: BAL_FACTORY_ID, product: "hoso", desiredQuantity: hosoEqTons(4_000), priority: 1 },
  { companyId: "BAL", factoryId: BAL_FACTORY_ID, product: "pd", desiredQuantity: hosoEqTons(3_000), priority: 2 },
  { companyId: "BAL", factoryId: BAL_FACTORY_ID, product: "vap", desiredQuantity: hosoEqTons(2_000), priority: 3 },
];

const WORKERS: readonly WorkerAssignment[] = BAL.workerBaseline.map((w) => ({
  ...w,
  temporaryHeadcount: 0,
  overtimeRate: ratio(0),
}));

const LOTS: readonly RawMaterialLot[] = [
  {
    lotId: "L-BAL",
    companyId: "BAL",
    source: "domesticPurchase",
    originCountry: "VN",
    inboundPeriod: START,
    originalQuantity: hosoEqTons(20_000),
    remainingQuantity: hosoEqTons(20_000),
    unitCost: usdPerHosoEqKg(5),
    availableFromPeriod: START,
    status: "available",
  },
];

const EXPORTED = buildExportProcessingCapacity({
  companyId: "BAL",
  fixtures: FIXTURES,
  capexState: { companies: [] },
  asOfPeriod: AS_OF,
  productionPlans: PLANS,
  workerAssignments: WORKERS,
  rawMaterialLots: LOTS,
});

const SCREEN = buildCompanyProcessingForecast({
  companyId: "BAL",
  baseFactories: FIXTURES.flatMap((f) => f.factories),
  capexState: { companies: [] },
  period: AS_OF,
  productionPlans: PLANS,
  workerAssignments: WORKERS,
  rawMaterialLots: LOTS,
});

test("EXPFC-1: Export側の処理見込みの数値が、画面側の共有計算結果と1行ずつ完全一致する", () => {
  assert.equal(EXPORTED.forecast.rows.length, SCREEN.rows.length);
  assert.ok(SCREEN.rows.length > 0, "検証対象の行が無い");
  EXPORTED.forecast.rows.forEach((exported, i) => {
    const screen = SCREEN.rows[i];
    assert.equal(exported.product, screen.product);
    assert.equal(exported.factoryId, screen.factoryId);
    assert.equal(exported.priority, screen.priority);
    assert.equal(exported.desiredTons, screen.desiredTons);
    assert.equal(exported.productNominalCapacityTons, screen.productNominalCapacityTons);
    assert.equal(exported.productEffectiveCapacityTons, screen.productEffectiveCapacityTons);
    assert.equal(exported.forecastProcessedTons, screen.forecastProcessedTons);
    assert.equal(exported.forecastUnprocessedTons, screen.forecastUnprocessedTons);
    assert.equal(exported.constraintSummary, screen.constraintSummary);
    assert.equal(exported.primaryConstraintLabel, screen.primaryConstraint?.label ?? null);
  });
  assert.equal(EXPORTED.forecast.availableRawMaterialTons, SCREEN.availableRawMaterialTons);
});

test("EXPFC-2: Export側の実効率テーブルも、画面側と同じ値・同じ補正要因である", () => {
  assert.equal(EXPORTED.forecast.companyRateTable.rows.length, SCREEN.companyRateTable.rows.length);
  EXPORTED.forecast.companyRateTable.rows.forEach((exported, i) => {
    const screen = SCREEN.companyRateTable.rows[i];
    assert.equal(exported.poolKey, screen.poolKey);
    assert.equal(exported.nominalTons, screen.nominalTons);
    assert.equal(exported.effectiveTons, screen.effectiveTons);
    assert.equal(exported.effectiveRate, screen.effectiveRate ?? null);
    assert.deepEqual(
      exported.factors.map((f) => [f.key, f.value]),
      screen.factors.map((f) => [f.key, f.value])
    );
    assert.equal(exported.correctionNote, screen.correctionNote);
  });
});

test("EXPFC-3: 会社スコープのExportに、他社の生産計画・原料ロットが混入しない", () => {
  const massPlan: CompanyProductionPlanEntry = {
    companyId: "MASS",
    factoryId: "MASS-F1",
    product: "hoso",
    desiredQuantity: hosoEqTons(99_999),
    priority: 1,
  };
  const massLot: RawMaterialLot = { ...LOTS[0], lotId: "L-MASS", companyId: "MASS", remainingQuantity: hosoEqTons(999_999) };
  const exported = buildExportProcessingCapacity({
    companyId: "BAL",
    fixtures: FIXTURES,
    capexState: { companies: [] },
    asOfPeriod: AS_OF,
    productionPlans: [...PLANS, massPlan],
    workerAssignments: WORKERS,
    rawMaterialLots: [...LOTS, massLot],
  });
  const serialized = JSON.stringify(exported);
  assert.ok(!serialized.includes("MASS"), "他社IDがExportへ混入している");
  assert.ok(!serialized.includes("99999") && !serialized.includes("999999"));
  assert.equal(exported.forecast.availableRawMaterialTons, EXPORTED.forecast.availableRawMaterialTons);
});

test("EXPFC-4: 見込みであることの見出し・注意書きがExport側にも必ず入る", () => {
  assert.equal(EXPORTED.forecast.headingText, SCREEN.headingText);
  assert.ok(EXPORTED.forecast.caveatTexts.length > 0);
  assert.ok(EXPORTED.forecast.constraintOrderTexts.length === 5);
  assert.ok(EXPORTED.forecast.priorityRuleText.length > 0);
});

test("EXPFC-5: 生産計画を渡さない経路では見込み行を0で埋めず空にする", () => {
  const exported = buildExportProcessingCapacity({
    companyId: "BAL",
    fixtures: FIXTURES,
    capexState: { companies: [] },
    asOfPeriod: AS_OF,
  });
  assert.deepEqual(exported.forecast.rows, []);
  assert.equal(exported.forecast.companyRateTable.rows.length, 5, "能力の説明は計画が無くても出す");
});
