// ShrimpX V2 — PD専用機械化投資（省人化）の実効労務負荷係数 単体テスト（2026-08-01新規）
//
// production/pdMechanizationEffect.tsの純粋関数群を、capex/companyLab/production
// エンジン本体を経由せず直接検証する。特に:
//   - 投資直後（習熟度0）は効果ゼロ
//   - 習熟度が上がるほど実効係数が下がる
//   - 実効係数はfloorCoefficientを下回らない
//   - 低稼働なら投資完了済みでも効果が出ない・小さい
//   - HOSO/VAPの労務負荷係数には一切影響しない（副作用なし）
// をカバーする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { CapitalProject, FutureCapacityEffectPlaceholder, LaborIntensityReductionEffect } from "../../capex/types";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";
import { calculateLaborCapacityFromAssignedHeadcount, requiredHeadcountForQuantity } from "../labor";
import {
  buildCompanyProductionParametersForPdMechanization,
  buildProductionParametersWithEffectivePdIntensity,
  calculateEffectivePdLaborIntensity,
  computePdMechanizationLevel,
  computePdMechanizationQualityBonus,
  computePdMechanizationRampProgress,
  findActivePdMechanizationEffect,
} from "../pdMechanizationEffect";

const EPS = 1e-9;
const BASE_PD_COEFFICIENT = PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.pd; // 1.2

function laborIntensityReduction(overrides: Partial<LaborIntensityReductionEffect> = {}): LaborIntensityReductionEffect {
  return {
    targetProduct: "pd",
    maxReductionRatio: 0.2,
    floorCoefficient: 1.0,
    rampUpQuarters: 2,
    ...overrides,
  };
}

function futureCapacityEffect(overrides: Partial<FutureCapacityEffectPlaceholder> = {}): FutureCapacityEffectPlaceholder {
  return {
    capacityIncreaseTonsPerQuarter: 0,
    readinessQuartersAfterCompletion: 1,
    laborIntensityReduction: laborIntensityReduction(),
    ...overrides,
  };
}

function makePdMechanizationProject(overrides: Partial<CapitalProject> = {}): CapitalProject {
  return {
    projectId: "P-PD-MECH-1",
    companyId: "TEST",
    projectType: "pdMechanization",
    approvedBudgetUsd: 2_500_000,
    paymentSchedule: [
      { stageIndex: 0, plannedRatio: 0.4 },
      { stageIndex: 1, plannedRatio: 0.6 },
    ],
    completedPaymentStagesCount: 2,
    cumulativePaidUsd: 2_500_000,
    elapsedConstructionQuartersWithPayment: 2,
    requiredConstructionQuarters: 2,
    status: "completed",
    proposedPeriod: period(2015, 1),
    approvedPeriod: period(2015, 1),
    completedPeriod: period(2015, 2), // 完成期。readiness=1のためoperationalStart=2015Q4。
    capitalizedAmountUsd: 2_500_000,
    priority: 1,
    lastDiagnosticReasons: [],
    futureCapacityEffect: futureCapacityEffect(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. calculateEffectivePdLaborIntensity（実装指示のシグネチャどおりの純粋関数）
// ---------------------------------------------------------------------

test("EF-1: mechanizationLevel=0（投資直後相当）は実効係数が起点のまま変化しない", () => {
  const effective = calculateEffectivePdLaborIntensity(BASE_PD_COEFFICIENT, 0, 0.2, 1.0);
  assert.equal(effective, BASE_PD_COEFFICIENT);
});

test("EF-2: mechanizationLevelが上がるほど実効係数が下がる（単調減少）", () => {
  const levels = [0, 0.25, 0.5, 0.75, 1.0];
  const values = levels.map((level) => calculateEffectivePdLaborIntensity(BASE_PD_COEFFICIENT, level, 0.2, 1.0));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] <= values[i - 1] + EPS, `level=${levels[i]}の実効係数(${values[i]})はlevel=${levels[i - 1]}の値(${values[i - 1]})を上回ってはならない`);
  }
  assert.ok(values[values.length - 1] < values[0] - EPS, "mechanizationLevel=1.0の実効係数は0の値より真に小さいはず");
});

test("EF-3: mechanizationLevel=1.0・maxReductionRatio=0.2なら1.2→0.96まで下がる（floorを下回らない範囲）", () => {
  // floorCoefficientを十分低く（0.5）設定し、0.96自体がfloorでクリップされないことを確認する。
  const effective = calculateEffectivePdLaborIntensity(1.2, 1.0, 0.2, 0.5);
  assert.ok(Math.abs(effective - 0.96) < 1e-9);
});

test("EF-4: 実効係数はfloorCoefficient(1.0)を下回らない（maxReductionRatioが大きくても床でクリップ）", () => {
  const effective = calculateEffectivePdLaborIntensity(1.2, 1.0, 0.9, 1.0);
  assert.ok(effective >= 1.0 - EPS, `実効係数(${effective})はfloorCoefficient(1.0)を下回ってはならない`);
  assert.ok(Math.abs(effective - 1.0) < EPS);
});

test("EF-5: floorCoefficientを1.0以外（例: 1.05）にした場合もその値を下限とする", () => {
  const effective = calculateEffectivePdLaborIntensity(1.2, 1.0, 0.5, 1.05);
  assert.ok(Math.abs(effective - 1.05) < EPS);
});

// ---------------------------------------------------------------------
// 2. 習熟度（ramp progress）— 投資直後はゼロ、段階的に立ち上がる
// ---------------------------------------------------------------------

test("RAMP-1: 稼働開始前（未完成）の案件は習熟度0", () => {
  const project = makePdMechanizationProject({ status: "underConstruction", completedPeriod: undefined });
  const progress = computePdMechanizationRampProgress([project], period(2016, 1));
  assert.equal(progress, 0);
});

test("RAMP-2: 稼働開始四半期（導入1四半期目）は習熟度0", () => {
  // completedPeriod=2015Q2, readiness=1 → operationalStart=2015Q4。
  const project = makePdMechanizationProject();
  const progress = computePdMechanizationRampProgress([project], period(2015, 4));
  assert.equal(progress, 0);
});

test("RAMP-3: 稼働開始から1四半期後（2四半期目）はrampUpQuarters=2に対し0.5まで立ち上がる", () => {
  const project = makePdMechanizationProject();
  const progress = computePdMechanizationRampProgress([project], period(2016, 1)); // operationalStartの1四半期後
  assert.ok(Math.abs(progress - 0.5) < EPS);
});

test("RAMP-4: 稼働開始から2四半期後（3四半期目）で満額（1.0）に達する", () => {
  const project = makePdMechanizationProject();
  const progress = computePdMechanizationRampProgress([project], period(2016, 2));
  assert.equal(progress, 1);
});

test("RAMP-5: 満額到達後はそれ以上進んでも1.0のまま", () => {
  const project = makePdMechanizationProject();
  const progress = computePdMechanizationRampProgress([project], period(2020, 1));
  assert.equal(progress, 1);
});

test("RAMP-6: pdMechanization案件が無ければ習熟度0", () => {
  const progress = computePdMechanizationRampProgress([], period(2016, 2));
  assert.equal(progress, 0);
});

// ---------------------------------------------------------------------
// 3. mechanizationLevel = 習熟度 × 当期PD稼働率（低稼働なら効果が出ない）
// ---------------------------------------------------------------------

test("LEVEL-1: 習熟度が満額でも稼働率0なら、mechanizationLevelは0", () => {
  assert.equal(computePdMechanizationLevel(1.0, 0), 0);
});

test("LEVEL-2: 習熟度が満額でも稼働率が低ければmechanizationLevelは小さい", () => {
  const level = computePdMechanizationLevel(1.0, 0.1);
  assert.ok(Math.abs(level - 0.1) < EPS);
});

test("LEVEL-3: 低稼働（稼働率10%）なら、投資が完了・満額習熟していても実効係数の低下はごくわずか", () => {
  const level = computePdMechanizationLevel(1.0, 0.1);
  const effective = calculateEffectivePdLaborIntensity(BASE_PD_COEFFICIENT, level, 0.2, 1.0);
  // 1.2 × (1 - 0.2×0.1) = 1.176。1.2に近い、小さな低下にとどまる。
  assert.ok(effective > 1.15, `低稼働時の実効係数(${effective})は基準1.2にかなり近いはず`);
  assert.ok(effective < BASE_PD_COEFFICIENT, "低稼働でも稼働率>0なら、ごくわずかでも効果はゼロより下がる");
});

test("LEVEL-4: 高稼働（稼働率100%）・満額習熟なら、想定どおりの最大効果が出る", () => {
  const level = computePdMechanizationLevel(1.0, 1.0);
  // 実際の暫定パラメータ（capex/parameters.ts、floorCoefficient=1.0）どおりに計算すると
  // 1.2×(1-0.2)=0.96 < floor(1.0)のためfloorでクリップされ1.0になる（=HOSO水準まで
  // 下がるがそれ以上は下がらない、という設計意図どおりの挙動）。
  const effectiveWithProductionFloor = calculateEffectivePdLaborIntensity(BASE_PD_COEFFICIENT, level, 0.2, 1.0);
  assert.ok(Math.abs(effectiveWithProductionFloor - 1.0) < EPS);
  // floorをさらに下げれば（0.5）、クリップされずに0.96まで下がることを別途確認する。
  const effectiveWithLowerFloor = calculateEffectivePdLaborIntensity(BASE_PD_COEFFICIENT, level, 0.2, 0.5);
  assert.ok(Math.abs(effectiveWithLowerFloor - 0.96) < EPS);
});

// ---------------------------------------------------------------------
// 4. findActivePdMechanizationEffect
// ---------------------------------------------------------------------

test("META-1: 稼働中のpdMechanization案件が無ければundefined", () => {
  const project = makePdMechanizationProject({ status: "underConstruction", completedPeriod: undefined });
  const found = findActivePdMechanizationEffect([project], period(2015, 4));
  assert.equal(found, undefined);
});

test("META-2: 稼働中のpdMechanization案件があれば、そのlaborIntensityReductionメタデータを返す", () => {
  const project = makePdMechanizationProject();
  const found = findActivePdMechanizationEffect([project], period(2016, 2));
  assert.ok(found);
  assert.equal(found!.maxReductionRatio, 0.2);
  assert.equal(found!.floorCoefficient, 1.0);
});

// ---------------------------------------------------------------------
// 5. buildCompanyProductionParametersForPdMechanization — 統合レベル。
//    HOSO/VAPには一切影響しないこと（副作用が無いこと）を確認する。
// ---------------------------------------------------------------------

test("PARAMS-1: pdMechanization未投資の会社はPRODUCTION_PARAMETERS_V1をそのまま返す（同一参照）", () => {
  const params = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [], period(2016, 2), 1.0);
  assert.equal(params, PRODUCTION_PARAMETERS_V1);
});

test("PARAMS-2: 投資直後（習熟度0）の会社もPRODUCTION_PARAMETERS_V1をそのまま返す（変化なし）", () => {
  const project = makePdMechanizationProject();
  const params = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2015, 4), 1.0);
  assert.equal(params, PRODUCTION_PARAMETERS_V1);
});

test("PARAMS-3: 満額習熟・高稼働の会社は、PDの実効係数だけが下がり、HOSO・VAPの係数には一切変化がない", () => {
  const project = makePdMechanizationProject();
  const params = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2016, 2), 1.0);
  assert.notEqual(params, PRODUCTION_PARAMETERS_V1);
  assert.ok(params.labor.laborIntensityCoefficientByProduct.pd < PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.pd);
  assert.equal(params.labor.laborIntensityCoefficientByProduct.hoso, PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.hoso);
  assert.equal(params.labor.laborIntensityCoefficientByProduct.vap, PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.vap);
  // 基準の比率（HOSO:PD:VAP = 1.0:1.2:3.0）を壊さず、PDだけが下がっていることを確認。
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.hoso, 1.0);
  assert.equal(PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficientByProduct.vap, 3.0);
});

test("PARAMS-4: buildProductionParametersWithEffectivePdIntensityは、指定した係数以外のlabor設定（efficiency等）を一切変更しない", () => {
  const params = buildProductionParametersWithEffectivePdIntensity(PRODUCTION_PARAMETERS_V1, 0.96);
  assert.equal(params.labor.laborIntensityCoefficientByProduct.pd, 0.96);
  assert.equal(params.labor.regularEfficiencyPerHeadTons, PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons);
  assert.equal(params.labor.temporaryEfficiencyPerHeadTons, PRODUCTION_PARAMETERS_V1.labor.temporaryEfficiencyPerHeadTons);
  assert.equal(params.labor.overtimeRateCap, PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap);
  assert.equal(params.yield, PRODUCTION_PARAMETERS_V1.yield);
});

// ---------------------------------------------------------------------
// 6. production/labor.tsの2関数（calculateLaborCapacityFromAssignedHeadcount・
//    requiredHeadcountForQuantity）を、会社別に組み立てたparamsで呼んだときに、
//    HOSO・VAPの計算結果が基準パラメータで呼んだ場合と完全に一致すること
//    （＝会社別上書きの副作用がPDだけに閉じていること）を、関数のシグネチャを
//    変更していない前提で直接検証する。
// ---------------------------------------------------------------------

test("ENGINE-1: 会社別の実効PD係数を持つparamsで呼んでも、HOSO/VAPの有効労働能力は基準paramsと完全に一致する", () => {
  const project = makePdMechanizationProject();
  const companyParams = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2016, 2), 1.0);

  for (const product of ["hoso", "vap"] as const) {
    const base = calculateLaborCapacityFromAssignedHeadcount(10, 5, 1, 1, 0, 1_000_000, product, PRODUCTION_PARAMETERS_V1);
    const overridden = calculateLaborCapacityFromAssignedHeadcount(10, 5, 1, 1, 0, 1_000_000, product, companyParams);
    assert.equal(overridden, base, `商品"${product}"の有効労働能力は会社別paramsの影響を受けてはならない`);
  }
});

test("ENGINE-2: PDについては、会社別paramsを使うと同じ人数でより多く生産できる（必要な労務量が減っている）", () => {
  const project = makePdMechanizationProject();
  const companyParams = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2016, 2), 1.0);

  const basePd = calculateLaborCapacityFromAssignedHeadcount(10, 5, 1, 1, 0, 1_000_000, "pd", PRODUCTION_PARAMETERS_V1);
  const overriddenPd = calculateLaborCapacityFromAssignedHeadcount(10, 5, 1, 1, 0, 1_000_000, "pd", companyParams);
  assert.ok(overriddenPd > basePd, "PD実効係数が下がった会社は、同じ人数でより多くの有効労働能力を得られるはず");
});

test("ENGINE-3: requiredHeadcountForQuantityも、HOSO/VAPは会社別paramsの影響を受けない", () => {
  const project = makePdMechanizationProject();
  const companyParams = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2016, 2), 1.0);

  for (const product of ["hoso", "vap"] as const) {
    const base = requiredHeadcountForQuantity(100, 6, 1, 1, 0, product, PRODUCTION_PARAMETERS_V1);
    const overridden = requiredHeadcountForQuantity(100, 6, 1, 1, 0, product, companyParams);
    assert.equal(overridden, base, `商品"${product}"の必要人数は会社別paramsの影響を受けてはならない`);
  }
});

test("ENGINE-4: requiredHeadcountForQuantityのPDは、会社別paramsのほうが必要人数が少なくなる", () => {
  const project = makePdMechanizationProject();
  const companyParams = buildCompanyProductionParametersForPdMechanization(PRODUCTION_PARAMETERS_V1, [project], period(2016, 2), 1.0);

  const baseRequired = requiredHeadcountForQuantity(100, 6, 1, 1, 0, "pd", PRODUCTION_PARAMETERS_V1);
  const overriddenRequired = requiredHeadcountForQuantity(100, 6, 1, 1, 0, "pd", companyParams);
  assert.ok(overriddenRequired < baseRequired, "PD実効係数が下がった会社は、同じ数量を処理するのに必要な人数が減るはず");
});

// ---------------------------------------------------------------------
// 7. 副次効果（小さく、上限付き）
// ---------------------------------------------------------------------

test("QUALITY-1: mechanizationLevel=0では品質ボーナスは0", () => {
  assert.equal(computePdMechanizationQualityBonus(0), 0);
});

test("QUALITY-2: mechanizationLevelが上がるほど品質ボーナスも上がるが、小さく上限がある", () => {
  const bonusLow = computePdMechanizationQualityBonus(0.5);
  const bonusHigh = computePdMechanizationQualityBonus(1.0);
  assert.ok(bonusHigh > bonusLow);
  // 上限を明示: 満額でも数点程度の小さな加点にとどまる（主効果＝労務負荷係数の
  // 20%削減という大きさに比べて明らかに小さい）。
  assert.ok(bonusHigh <= 5, `品質ボーナス(${bonusHigh})は小さく上限付きであるべき`);
});
