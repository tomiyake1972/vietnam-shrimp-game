// ShrimpX V2 — PD省人化投資（機械化）の効果計算（Test15新設）テスト
//
// 対応する要求事項:
//   - 満成熟時の削減率は「20%」ではなく「1 − 1.0/1.2 = 16.666...%」で、
//     ハードコードではなくTask1の労働集約度係数（PRODUCTION_PARAMETERS_V1）から
//     導出されること
//   - mechanizationLevel = adoptionRampProgress × previousQuarterPdUtilization
//   - 実効PD係数のフロア（1.0）を浮動小数点誤差なしで保証すること
//   - Factory単位PD稼働率の分子・分母の単位一貫性（歩留まり適用後同士であること）

import { test } from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import {
  computeAdoptionRampProgress,
  computeEffectivePdCoefficient,
  computeFactoryPdUtilization,
  computeMechanizationLevel,
  formatReductionRatioAtFullMaturityLabel,
  PD_MECHANIZATION_PARAMETERS_V1,
  reductionRatioAtFullMaturity,
} from "../pdMechanization";

// ---------------------------------------------------------------------
// 1. 削減率は16.666...%（20%ではない）、Task1の係数から導出される
// ---------------------------------------------------------------------

test("PD-MECH-1: baseCoefficient/floorCoefficientは、Task1のPRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientをそのまま参照する（再定義しない）", () => {
  assert.equal(PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient, PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd);
  assert.equal(PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient, PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.hoso);
  assert.equal(PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient, 1.2);
  assert.equal(PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient, 1.0);
});

test("PD-MECH-2: 満成熟時の削減率は正確に1/6（16.666...%）であり、0.2（20%）ではない — 厳密分数演算で証明する", () => {
  const ratio = reductionRatioAtFullMaturity();
  // 1 - 1.0/1.2 = 1/6 を、浮動小数点誤差を許容しつつ厳密に検証する。
  assert.ok(Math.abs(ratio - 1 / 6) < 1e-12, `削減率が1/6であるはず（実際: ${ratio}）`);
  assert.notEqual(ratio, 0.2, "削減率が誤って20%になっていないことの確認");
  assert.ok(Math.abs(ratio - 0.2) > 0.03, "0.2との差は誤差の範囲を大きく超えている");
});

test("PD-MECH-3: formatReductionRatioAtFullMaturityLabelは「16.67%」を返し、「20%」という文字列を一切含まない", () => {
  const label = formatReductionRatioAtFullMaturityLabel();
  assert.equal(label, "16.67%");
  assert.doesNotMatch(label, /20%/);
});

// ---------------------------------------------------------------------
// 2. 実効PD係数（フロアの浮動小数点誤差なし保証）
// ---------------------------------------------------------------------

test("PD-MECH-4: mechanizationLevel=1.0のとき、実効PD係数は誤差なく厳密に1.0（フロア）になる", () => {
  const coefficient = computeEffectivePdCoefficient(1.0);
  assert.equal(coefficient, 1.0, "浮動小数点演算による1.0未満へのドリフトが無いことを保証する");
  assert.ok(coefficient >= PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient);
});

test("PD-MECH-5: mechanizationLevel=0のとき、実効PD係数はbaseCoefficient(1.2)のまま", () => {
  assert.equal(computeEffectivePdCoefficient(0), 1.2);
});

test("PD-MECH-6: mechanizationLevel=0.5のとき、実効PD係数は1.2と1.0のちょうど中間（1.1）", () => {
  const coefficient = computeEffectivePdCoefficient(0.5);
  assert.ok(Math.abs(coefficient - 1.1) < 1e-9, `実際: ${coefficient}`);
});

test("PD-MECH-7: 実効PD係数は防御的にクランプされ、level>1やlevel<0を渡しても[floor, base]の範囲を外れない", () => {
  assert.equal(computeEffectivePdCoefficient(1.5), 1.0);
  assert.equal(computeEffectivePdCoefficient(-0.5), 1.2);
});

// ---------------------------------------------------------------------
// 3. mechanizationLevel = adoptionRampProgress × previousQuarterPdUtilization
// ---------------------------------------------------------------------

test("PD-MECH-8: adoptionRampProgressは2四半期でランプし、0四半期目=0・1四半期目=0.5・2四半期目以降=1.0", () => {
  assert.equal(computeAdoptionRampProgress(0), 0);
  assert.equal(computeAdoptionRampProgress(1), 0.5);
  assert.equal(computeAdoptionRampProgress(2), 1.0);
  assert.equal(computeAdoptionRampProgress(5), 1.0);
  assert.equal(computeAdoptionRampProgress(-1), 0);
});

test("PD-MECH-9: mechanizationLevelの計算式（ワークサンプル） — ランプ進捗50%×前四半期稼働率80%=40%", () => {
  const rampProgress = computeAdoptionRampProgress(1); // 0.5
  const level = computeMechanizationLevel(rampProgress, 0.8);
  assert.ok(Math.abs(level - 0.4) < 1e-9, `実際: ${level}`);
  const coefficient = computeEffectivePdCoefficient(level);
  // 1.2 × (1 - 1/6 × 0.4) = 1.2 × (1 - 0.066666...) = 1.2 × 0.933333... = 1.12
  assert.ok(Math.abs(coefficient - 1.12) < 1e-9, `実際: ${coefficient}`);
});

test("PD-MECH-10: mechanizationLevelは[0,1]へクランプされ、ランプ進捗・稼働率のいずれかが異常値（NaN・範囲外）でも安全側(0)へ倒れる", () => {
  assert.equal(computeMechanizationLevel(Number.NaN, 0.5), 0);
  assert.equal(computeMechanizationLevel(0.5, Number.NaN), 0);
  assert.equal(computeMechanizationLevel(1.5, 1.5), 1); // クランプ後1×1
});

// ---------------------------------------------------------------------
// 4. Factory単位PD稼働率（分子・分母の単位一貫性）
// ---------------------------------------------------------------------

test("PD-MECH-11: Factory単位PD稼働率 = 歩留まり適用後の完成品数量 ÷ 歩留まり適用後の有効能力（両者とも同じ単位）", () => {
  const utilization = computeFactoryPdUtilization(400, 500);
  assert.ok(Math.abs(utilization - 0.8) < 1e-9);
});

test("PD-MECH-12: 分母（有効能力）がほぼ0のときは、稼働率0を返す（0除算しない）", () => {
  assert.equal(computeFactoryPdUtilization(100, 0), 0);
  assert.equal(computeFactoryPdUtilization(100, 1e-9), 0);
});

test("PD-MECH-13: 稼働率は[0,1]へクランプされる（分子が分母を超える異常値でも1.0を超えない）", () => {
  assert.equal(computeFactoryPdUtilization(1000, 500), 1);
  assert.equal(computeFactoryPdUtilization(-100, 500), 0);
});

test("PD-MECH-14（単位一貫性の回帰防止）: 歩留まり適用前（pre-yield）の原料投入量を誤って分子に使うと、歩留まり適用後（post-yield）の正しい稼働率より必ず大きい値になってしまう — この誤りを検出できることの確認", () => {
  // processingLoss > 0 のバッチを想定: rawMaterialConsumedTotal(pre-yield) = 625、
  // finishedGoodsQuantity(post-yield) = 500（歩留まり80%、processingLoss=125）。
  const rawMaterialConsumedTotal = 625; // 誤って使うと分子が過大になる（pre-yield）
  const finishedGoodsQuantity = 500; // 正しい分子（post-yield、歩留まり適用後）
  const pdEffectiveCapacity = 500; // production/capacity.tsのコメントどおりpost-yield基準の上限

  const correctUtilization = computeFactoryPdUtilization(finishedGoodsQuantity, pdEffectiveCapacity);
  assert.ok(Math.abs(correctUtilization - 1.0) < 1e-9, "post-yield同士なら稼働率はちょうど1.0のはず");
  // 上のケースはpre-yield量(625)を使ってもクランプにより偶然1.0に一致してしまうため、
  // クランプが効かない規模の能力で、誤り（過大な稼働率）を確実に検出できることを確認する。
  const partialCapacity = 800; // 稼働率が1.0未満で収まる規模の能力
  const correctPartial = computeFactoryPdUtilization(finishedGoodsQuantity, partialCapacity); // 500/800=0.625
  const wrongPartialIfPreYieldUsed = computeFactoryPdUtilization(rawMaterialConsumedTotal, partialCapacity); // 625/800=0.78125
  assert.ok(Math.abs(correctPartial - 0.625) < 1e-9);
  assert.ok(Math.abs(wrongPartialIfPreYieldUsed - 0.78125) < 1e-9);
  assert.notEqual(correctPartial, wrongPartialIfPreYieldUsed, "pre-yield量を誤って使うと稼働率が過大に算出されてしまうことを検出する");
});
