// ShrimpX V2 — PD省人化投資と余剰人員の接続（加工品市場進化 §g）のテスト
//
// PMW-1〜PMW-4。Phase5の損益分岐分析では「常用人件費は人数連動なので、
// 実際に人が減らない限り下がらない」ことが分かっていた。ここで検証するのは
// 「省人化で必要人員が減ったことが、判断側の人員過剰判定へ実際につながるか」
// である（＝余剰人員が遊んだまま残る状態になっていないか）。

import test from "node:test";
import assert from "node:assert/strict";

import { computeRequiredRegularHeadcount } from "../workforce";
import { PD_MECHANIZATION_PARAMETERS_V1, computeEffectivePdCoefficient } from "../../capex/pdMechanization";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";

const SKILL = { hoso: 0.8, pd: 0.8, vap: 0.8 };

function requiredFor(pdQuantity: number, mechanizationLevel?: number): number {
  return computeRequiredRegularHeadcount({
    quantityByProduct: { hoso: 0, pd: pdQuantity, vap: 0 },
    skillByProduct: SKILL,
    attendanceRate: 0.95,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
    ...(mechanizationLevel === undefined ? {} : { mechanizationLevel }),
  }).requiredRegularHeadcount;
}

test("PMW-1: 既定（未機械化）ではPD労働集約度係数1.8が使われる", () => {
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd, 1.8);
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.mechanizedLaborIntensityCoefficient.pd, 1.2);
  // 明示的に既定値を渡した場合と、渡さない場合が一致する。
  assert.ok(Math.abs(requiredFor(1000) - requiredFor(1000, 0)) < 1e-9);
});

test("PMW-2: 【接続の中核】省人化で実効PD係数が下がると、必要常用人員が実際に減る", () => {
  const baseline = requiredFor(1000);
  // 機械化レベル1.0（完全成熟）のときの実効PD係数。
  const fullyMechanizedCoefficient = computeEffectivePdCoefficient(1.0, PD_MECHANIZATION_PARAMETERS_V1);
  assert.ok(
    fullyMechanizedCoefficient < PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd,
    `省人化後の実効係数(${fullyMechanizedCoefficient})は既定(1.2)より小さいはず`
  );

  const mechanized = requiredFor(1000, fullyMechanizedCoefficient);
  assert.ok(mechanized < baseline, `省人化後の必要人員(${mechanized})は投資前(${baseline})より少ないはず`);

  // 削減率は実効係数の比そのもの（独自の係数を持ち込んでいないことの確認）。
  const expectedRatio = fullyMechanizedCoefficient / PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd;
  assert.ok(Math.abs(mechanized / baseline - expectedRatio) < 1e-9, "必要人員の比は実効PD係数の比と一致するべき");
});

test("PMW-3: 機械化レベルが進むほど必要人員が単調に減る", () => {
  let previous = Infinity;
  for (const level of [0, 0.25, 0.5, 0.75, 1.0]) {
    const coefficient = computeEffectivePdCoefficient(level, PD_MECHANIZATION_PARAMETERS_V1);
    const required = requiredFor(1000, coefficient);
    assert.ok(required <= previous + 1e-9, `機械化レベル${level}で必要人員が増えている（${previous} → ${required}）`);
    previous = required;
  }
});

test("PMW-4: 省人化はHOSOに一切効かず、VAPには部分的にのみ効く", () => {
  const base = {
    skillByProduct: SKILL,
    attendanceRate: 0.95,
    appliedOvertimeRate: 0,
    temporaryHeadcount: 0,
  };
  // HOSO: 機械化前後とも係数1.0のため、必要人員は完全に不変。
  const hosoBefore = computeRequiredRegularHeadcount({ ...base, quantityByProduct: { hoso: 1000, pd: 0, vap: 0 } }).requiredRegularHeadcount;
  const hosoAfter = computeRequiredRegularHeadcount({
    ...base,
    quantityByProduct: { hoso: 1000, pd: 0, vap: 0 },
    mechanizationLevel: 1.0,
  }).requiredRegularHeadcount;
  assert.equal(hosoAfter, hosoBefore, "HOSOは殻剥き工程が無いため機械化の影響を受けない");

  // VAP: 前工程の殻剥きを共通化するぶんだけ部分的に減る（3.0 → 2.6 = 13.3%減）。
  const vapBefore = computeRequiredRegularHeadcount({ ...base, quantityByProduct: { hoso: 0, pd: 0, vap: 1000 } }).requiredRegularHeadcount;
  const vapAfter = computeRequiredRegularHeadcount({
    ...base,
    quantityByProduct: { hoso: 0, pd: 0, vap: 1000 },
    mechanizationLevel: 1.0,
  }).requiredRegularHeadcount;
  assert.ok(vapAfter < vapBefore, "VAPは部分的に省人化される");
  assert.ok(Math.abs(vapAfter / vapBefore - 2.6 / 3.0) < 1e-9, `VAPの削減率は係数比そのもの（実測 ${vapAfter / vapBefore}）`);

  // PDの削減率のほうがVAPより大きい。
  const pdBefore = computeRequiredRegularHeadcount({ ...base, quantityByProduct: { hoso: 0, pd: 1000, vap: 0 } }).requiredRegularHeadcount;
  const pdAfter = computeRequiredRegularHeadcount({
    ...base,
    quantityByProduct: { hoso: 0, pd: 1000, vap: 0 },
    mechanizationLevel: 1.0,
  }).requiredRegularHeadcount;
  assert.ok(pdAfter / pdBefore < vapAfter / vapBefore, "PDの削減率はVAPより大きい");
});

test("PMW-5: 【人員過剰判定への接続】省人化後の必要人員は、標準AIの人員過剰しきい値を実際に割り込む", () => {
  // decision/labor.ts の判定: requiredRegular < currentRegular × (1 - EXCESS_MARGIN_RATIO)
  // で「持続的な人員過剰」となり、常用ワーカーが段階的に縮小される。
  // 省人化前の必要人員をそのまま現員としたとき、省人化後にこの条件を満たすか。
  const EXCESS_MARGIN_RATIO = 0.15; // decision/labor.ts のローカル定数と同値
  const currentRegular = requiredFor(1000); // 投資前にちょうど足りている状態
  const mechanizedRequired = requiredFor(1000, computeEffectivePdCoefficient(1.0, PD_MECHANIZATION_PARAMETERS_V1));

  assert.ok(
    mechanizedRequired < currentRegular * (1 - EXCESS_MARGIN_RATIO),
    `省人化後の必要人員(${mechanizedRequired})が人員過剰しきい値(${currentRegular * (1 - EXCESS_MARGIN_RATIO)})を割り込まない` +
      "＝余剰人員が遊んだまま残り、常用人件費が下がらないため投資が回収できない"
  );
});
