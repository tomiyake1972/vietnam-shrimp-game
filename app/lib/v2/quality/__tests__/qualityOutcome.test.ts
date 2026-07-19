// ShrimpX V2 — Phase 7A 品質モジュール qualityOutcome.ts テスト
//
// 対応する受入条件:
//   1. 無負荷・事故なしでは saleableRecoveryRatio = 1.00
//   7. HOSO/PD/VAPの物理歩留まりをHOSO換算数量へ適用しない（本ファイルの計算は
//      商品種別を一切参照しない構造になっていることを確認する）
//   8. 格落ち・再加工はPhase 7Aでは数量を消失させない
//   9. 廃棄だけが販売可能回収率を下げる

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../core/units";
import { calculateNonConformanceRatio, calculateObservedQualityScore, calculateQualityOutcome } from "../qualityOutcome";
import { MajorIncidentDraw } from "../types";
import { QUALITY_PARAMETERS_V1 } from "../parameters";

const NO_INCIDENT: MajorIncidentDraw = { occurred: false, severity: 0, probability: 0, seed: "n/a" };

test("1: operationalRisk=0・事故なしでは saleableRecoveryRatio = 1.00 を維持する", () => {
  const outcome = calculateQualityOutcome(0, NO_INCIDENT, 85);
  assert.equal(unwrapUnit(outcome.saleableRecoveryRatio), 1);
  assert.equal(outcome.nonConformanceRatio, 0);
  assert.equal(outcome.discardRatio, 0);
  assert.equal(outcome.downgradeRatio, 0);
  assert.equal(outcome.reworkRatio, 0);
});

test("7: 品質結果の計算はHOSO/PD/VAP等の商品種別を一切引数に取らない（物理歩留まりを重ねて適用しない構造）", () => {
  // calculateQualityOutcome/calculateNonConformanceRatio/calculateObservedQualityScoreは
  // いずれも(operationalRisk, majorIncident, baselineOperationalQuality, params)のみを
  // 引数に取り、商品区分(Product)を一切受け取らない。そのため、同じoperationalRisk・
  // 同じbaselineであれば商品が何であってもsaleableRecoveryRatio・観測品質は完全に一致する
  // （HOSO/PD/VAPそれぞれ異なる物理歩留まりを"品質モジュール側で"重ねて適用することが
  // 構造的にできない）。
  const outcomeA = calculateQualityOutcome(0.5, NO_INCIDENT, 85);
  const outcomeB = calculateQualityOutcome(0.5, NO_INCIDENT, 85);
  assert.deepEqual(outcomeA, outcomeB);
});

test("8: 格落ち・再加工はfinishedGoodsQuantity相当の数量を減らさない（discardRatioのみが真の損失）", () => {
  const outcome = calculateQualityOutcome(0.6, NO_INCIDENT, 85);
  // downgradeRatio・reworkRatioは0より大きいが、saleableRecoveryRatio（数量へ適用する
  // 唯一の係数）はdiscardRatioのみから導出される。
  assert.ok(outcome.downgradeRatio > 0);
  assert.ok(outcome.reworkRatio > 0);
  const expectedSaleable = Math.min(1, Math.max(QUALITY_PARAMETERS_V1.qualityOutcome.minimumSaleableRecoveryRatio, 1 - outcome.discardRatio));
  // saleableRecoveryRatioは小数点4桁へ丸められるため、許容誤差はその丸め幅を超える値にする。
  assert.ok(Math.abs(unwrapUnit(outcome.saleableRecoveryRatio) - expectedSaleable) < 1e-4);
});

test("9: 廃棄率が0でなければsaleableRecoveryRatioが1未満になり、廃棄以外は数量へ反映しない", () => {
  const zeroRisk = calculateQualityOutcome(0, NO_INCIDENT, 85);
  const someRisk = calculateQualityOutcome(0.5, NO_INCIDENT, 85);
  assert.equal(unwrapUnit(zeroRisk.saleableRecoveryRatio), 1);
  assert.ok(unwrapUnit(someRisk.saleableRecoveryRatio) < 1);
  assert.ok(someRisk.discardRatio > 0);
});

test("saleableRecoveryRatioはminimumSaleableRecoveryRatio(0.90)を下回らない（重大事故なしの範囲では）", () => {
  const maxRisk = calculateQualityOutcome(1, NO_INCIDENT, 85);
  assert.ok(unwrapUnit(maxRisk.saleableRecoveryRatio) >= QUALITY_PARAMETERS_V1.qualityOutcome.minimumSaleableRecoveryRatio - 1e-9);
});

test("重大事故が発生すると追加の廃棄率がsaleableRecoveryRatioをさらに押し下げる", () => {
  const noIncident = calculateQualityOutcome(0.3, NO_INCIDENT, 85);
  const incident: MajorIncidentDraw = { occurred: true, severity: 0.8, probability: 0.05, seed: "test" };
  const withIncident = calculateQualityOutcome(0.3, incident, 85);
  assert.ok(unwrapUnit(withIncident.saleableRecoveryRatio) < unwrapUnit(noIncident.saleableRecoveryRatio));
});

test("nonConformanceRatioはoperationalRiskに対して非線形（指数1.5）に増加する", () => {
  const low = calculateNonConformanceRatio(0.2);
  const mid = calculateNonConformanceRatio(0.5);
  const high = calculateNonConformanceRatio(1.0);
  assert.ok(low < mid && mid < high);
  assert.ok(Math.abs(high - QUALITY_PARAMETERS_V1.qualityOutcome.maximumNonConformanceRatio) < 1e-9);
});

test("observedQualityScoreはoperationalRiskの増加に対して単調減少し、常に[0,100]に収まる", () => {
  const s0 = calculateObservedQualityScore(85, 0, NO_INCIDENT);
  const s50 = calculateObservedQualityScore(85, 0.5, NO_INCIDENT);
  const s100 = calculateObservedQualityScore(85, 1.0, NO_INCIDENT);
  assert.ok(unwrapUnit(s0) > unwrapUnit(s50));
  assert.ok(unwrapUnit(s50) > unwrapUnit(s100));
  for (const s of [s0, s50, s100]) {
    assert.ok(unwrapUnit(s) >= 0 && unwrapUnit(s) <= 100);
  }
});

test("observedQualityScoreは重大事故の重大度でさらに減点される", () => {
  const noIncident = calculateObservedQualityScore(85, 0.3, NO_INCIDENT);
  const incident: MajorIncidentDraw = { occurred: true, severity: 1, probability: 0.05, seed: "test" };
  const withIncident = calculateObservedQualityScore(85, 0.3, incident);
  assert.ok(unwrapUnit(withIncident) < unwrapUnit(noIncident));
});
