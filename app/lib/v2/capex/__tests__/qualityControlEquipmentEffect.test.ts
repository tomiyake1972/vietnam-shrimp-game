// ShrimpX V2 — Phase QI-I1: 品質管理設備の効果計算（純粋関数）テスト
//
// 対応する指示§11の項目: 1(設備なし=1.0)・2(full effectがparameterどおり)・
// 3(rampが決定論的)・4(ramp完了後full effect)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQualityEquipmentRiskMultiplier } from "../qualityControlEquipmentEffect";
import { QUALITY_PARAMETERS_V1, QualityParameters } from "../../quality/parameters";

test("QI1-EFFECT-1: 設備なし（quartersSinceActivation<=0）はmultiplier=1.0（効果なし）", () => {
  assert.equal(computeQualityEquipmentRiskMultiplier(0, QUALITY_PARAMETERS_V1), 1);
  assert.equal(computeQualityEquipmentRiskMultiplier(-1, QUALITY_PARAMETERS_V1), 1);
});

test("QI1-EFFECT-2: フルランプ到達後のmultiplierはparameterどおり（1 - fullEffectRiskReductionRatio）", () => {
  const params: QualityParameters = {
    ...QUALITY_PARAMETERS_V1,
    qualityControlEquipment: { fullEffectRiskReductionRatio: 0.3, rampQuarters: 2 },
  };
  const multiplier = computeQualityEquipmentRiskMultiplier(10, params); // 十分にランプ完了した経過四半期数
  assert.ok(Math.abs(multiplier - 0.7) < 1e-9, `期待値0.7、実際${multiplier}`);
});

test("QI1-EFFECT-3: 同一入力に対する計算は決定論的（純粋関数）", () => {
  const params = QUALITY_PARAMETERS_V1;
  const a = computeQualityEquipmentRiskMultiplier(1, params);
  const b = computeQualityEquipmentRiskMultiplier(1, params);
  assert.equal(a, b);
});

test("QI1-EFFECT-4: ランプ完了前は途中の乗数になる（0四半期<経過<rampQuartersでは0%と100%の間）", () => {
  const params: QualityParameters = {
    ...QUALITY_PARAMETERS_V1,
    qualityControlEquipment: { fullEffectRiskReductionRatio: 0.3, rampQuarters: 2 },
  };
  const atZero = computeQualityEquipmentRiskMultiplier(0, params);
  const atHalfRamp = computeQualityEquipmentRiskMultiplier(1, params); // 1/2 ramp progress
  const atFull = computeQualityEquipmentRiskMultiplier(2, params);
  assert.equal(atZero, 1, "完成直後（経過0）は効果0（multiplier=1.0）であるべき");
  assert.ok(atHalfRamp > atFull && atHalfRamp < atZero, "ランプ途中はfullとzeroの間の値であるべき");
  assert.ok(Math.abs(atHalfRamp - 0.85) < 1e-9, `1/2ランプ時のmultiplierは0.85のはず、実際${atHalfRamp}`);
  assert.ok(Math.abs(atFull - 0.7) < 1e-9, `フルランプ時のmultiplierは0.7のはず、実際${atFull}`);
});

test("QI1-EFFECT-5: multiplierは常に[0,1]の範囲に収まる（fullEffectRiskReductionRatio=1.0でもリスクを負値にしない）", () => {
  const params: QualityParameters = {
    ...QUALITY_PARAMETERS_V1,
    qualityControlEquipment: { fullEffectRiskReductionRatio: 1.0, rampQuarters: 1 },
  };
  const multiplier = computeQualityEquipmentRiskMultiplier(5, params);
  assert.ok(multiplier >= 0 && multiplier <= 1, `multiplierは[0,1]に収まるべき、実際${multiplier}`);
});
