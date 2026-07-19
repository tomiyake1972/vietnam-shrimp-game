// ShrimpX V2 — Phase 7A 品質モジュール operationalRisk.ts テスト
//
// 対応する受入条件（実装指示の27項目のうち）:
//   2. 稼働率80%以下では設備ストレスが0
//   3. 80%超から非線形に品質リスクが増える
//   4. 残業・臨時比率・複雑度・原料年齢・急増産がそれぞれ単調にリスクを上げる
//   5. 初回ターンは急増産ペナルティを付けない

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateComplexityStress,
  calculateOperationalRisk,
  calculateOvertimeStress,
  calculateProductionRampStress,
  calculateRawMaterialAgeStress,
  calculateTemporaryWorkerStress,
  calculateUtilizationStress,
  OperationalRiskInput,
} from "../operationalRisk";
import { QUALITY_PARAMETERS_V1 } from "../parameters";

function baseInput(overrides: Partial<OperationalRiskInput> = {}): OperationalRiskInput {
  return {
    equipmentUtilizationRate: 0.7,
    laborUtilizationRate: 0.7,
    overtimeRate: 0,
    overtimeRateCap: 0.2,
    temporaryWorkerShare: 0,
    productMixComplexity: 0,
    averageRawMaterialAgeQuarters: 0,
    currentPlannedOrAllocatedProduction: 1000,
    previousActualProduction: undefined,
    productCapacity: 2000,
    ...overrides,
  };
}

// --- 2: 稼働率80%以下では設備ストレスが0 ---

test("2: 稼働率が閾値(0.80)以下では設備稼働ストレスが常に0", () => {
  for (const rate of [0, 0.3, 0.5, 0.79, 0.8]) {
    assert.equal(calculateUtilizationStress(rate), 0, `rate=${rate}`);
  }
});

// --- 3: 80%超から非線形に品質リスクが増える ---

test("3: 稼働率が0.80を超えると設備稼働ストレスが非線形（凸関数）に増加する", () => {
  const s81 = calculateUtilizationStress(0.81);
  const s85 = calculateUtilizationStress(0.85);
  const s90 = calculateUtilizationStress(0.9);
  const s95 = calculateUtilizationStress(0.95);
  const s100 = calculateUtilizationStress(1.0);

  // 単調増加
  assert.ok(s81 > 0, "0.81は0.80を超えるため正のストレスを持つはず");
  assert.ok(s85 < s90);
  assert.ok(s90 < s95);
  assert.ok(s95 < s100);
  assert.ok(Math.abs(s100 - 1) < 1e-9);

  // 非線形（等間隔0.05刻みの増分が単調に拡大する = 凸関数、指数2の特徴）
  const d1 = s90 - s85; // 0.85→0.90
  const d2 = s95 - s90; // 0.90→0.95
  const d3 = s100 - s95; // 0.95→1.00
  assert.ok(d2 > d1, `凸性: d2(${d2}) > d1(${d1})である必要がある`);
  assert.ok(d3 > d2, `凸性: d3(${d3}) > d2(${d2})である必要がある`);
  assert.ok(Math.abs(s100 - 1) < 1e-9);
});

test("3b: 稼働率100%超はclampされ、ストレスは1を超えない", () => {
  assert.ok(Math.abs(calculateUtilizationStress(1.5) - 1) < 1e-9);
  assert.ok(Math.abs(calculateUtilizationStress(10) - 1) < 1e-9);
});

// --- 4: 各ストレス要因の単調性 ---

test("4a: 残業ストレスは実残業率に対して単調増加する", () => {
  const cap = 0.2;
  const a = calculateOvertimeStress(0.0, cap);
  const b = calculateOvertimeStress(0.1, cap);
  const c = calculateOvertimeStress(0.2, cap);
  const d = calculateOvertimeStress(0.4, cap); // 上限超過はclamp
  assert.ok(a < b);
  assert.ok(b < c);
  assert.equal(c, 1);
  assert.equal(d, 1);
});

test("4b: 臨時ワーカー比率ストレスは比率に対して単調増加する", () => {
  const a = calculateTemporaryWorkerStress(0);
  const b = calculateTemporaryWorkerStress(0.3);
  const c = calculateTemporaryWorkerStress(0.7);
  const d = calculateTemporaryWorkerStress(1.5); // clamp
  assert.ok(a < b && b < c);
  assert.equal(d, 1);
});

test("4c: 商品構成複雑度ストレスは複雑度に対して単調増加する", () => {
  const a = calculateComplexityStress(0);
  const b = calculateComplexityStress(0.5);
  const c = calculateComplexityStress(1);
  assert.ok(a < b && b < c);
});

test("4d: 原料経過期間ストレスは経過期間に対して単調増加し、データなし(0)では0", () => {
  const params = QUALITY_PARAMETERS_V1;
  const none = calculateRawMaterialAgeStress(0, params);
  const young = calculateRawMaterialAgeStress(1, params);
  const old = calculateRawMaterialAgeStress(3, params);
  const veryOld = calculateRawMaterialAgeStress(10, params); // clamp
  assert.equal(none, 0, "データがない(0)場合は推測せず0");
  assert.ok(young < old);
  assert.equal(veryOld, 1);
});

test("4e: 急増産ストレスは増産幅に対して単調増加する", () => {
  const capacity = 2000;
  const prev = 1000;
  const same = calculateProductionRampStress(1000, prev, capacity);
  const small = calculateProductionRampStress(1200, prev, capacity);
  const large = calculateProductionRampStress(1800, prev, capacity);
  assert.equal(same, 0, "前期と同水準なら急増産ストレスは0");
  assert.ok(small < large);
});

// --- 5: 初回ターンは急増産ペナルティを付けない ---

test("5: 前期実績がない(初回ターン相当)場合、急増産ストレスは常に0", () => {
  const s = calculateProductionRampStress(5000, undefined, 2000);
  assert.equal(s, 0);
});

test("5b: 前期実績が0の場合も急増産ストレスは0（分母の発散防止）", () => {
  const s = calculateProductionRampStress(5000, 0, 2000);
  assert.equal(s, 0);
});

// --- 統合: calculateOperationalRisk ---

test("設備稼働ストレスは設備・労働のうち大きい方を使う", () => {
  const inputEquipmentHigh = baseInput({ equipmentUtilizationRate: 0.95, laborUtilizationRate: 0.5 });
  const inputLaborHigh = baseInput({ equipmentUtilizationRate: 0.5, laborUtilizationRate: 0.95 });
  const a = calculateOperationalRisk(inputEquipmentHigh);
  const b = calculateOperationalRisk(inputLaborHigh);
  assert.ok(a.utilizationStress > 0);
  assert.equal(a.utilizationStress, b.utilizationStress, "設備・労働どちらが高くても同じ結果になるはず");
});

test("operationalRiskは常に[0,1]に収まる（極端な入力でも発散しない）", () => {
  const extreme = calculateOperationalRisk(
    baseInput({
      equipmentUtilizationRate: 5,
      laborUtilizationRate: 5,
      overtimeRate: 100,
      temporaryWorkerShare: 100,
      productMixComplexity: 100,
      averageRawMaterialAgeQuarters: 1000,
      currentPlannedOrAllocatedProduction: 1e9,
      previousActualProduction: 1,
      productCapacity: 1,
    })
  );
  assert.ok(Number.isFinite(extreme.operationalRisk));
  assert.ok(extreme.operationalRisk >= 0 && extreme.operationalRisk <= 1);
});

test("負荷ゼロ・複雑度ゼロ・初回ターンではoperationalRiskが0になる", () => {
  const risk = calculateOperationalRisk(
    baseInput({
      equipmentUtilizationRate: 0.5,
      laborUtilizationRate: 0.5,
      overtimeRate: 0,
      temporaryWorkerShare: 0,
      productMixComplexity: 0,
      averageRawMaterialAgeQuarters: 0,
      previousActualProduction: undefined,
    })
  );
  assert.equal(risk.operationalRisk, 0);
});
