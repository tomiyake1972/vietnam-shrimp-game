// ShrimpX V2 — 会社別に獲得できるVAPプレミアム（premiumPolicy.ts）の単体テスト
//
// 検証項目:
//  1. 会社能力係数が下限0.7・上限1.3を超えないこと
//  2. 営業関係・商品開発・品質保証すべてが高い会社は、すべて低い会社よりも
//     会社別獲得プレミアムが高いこと
//  3. 重大事故があった会社は能力係数が下がること
//  4. HOSO/PDの価格計算には一切影響しないこと（副作用がないこと）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1,
  CompanyCapabilityCoefficientInput,
  calculateCompanyCapabilityCoefficient,
  calculateCompanyRealizedVapPremiumRatio,
  minimumAcceptablePremium,
  orderQuantityFactor,
  targetPremium,
} from "../premiumPolicy";
import { CompanyPremiumEconomics } from "../types";

const HIGH_INPUT: CompanyCapabilityCoefficientInput = {
  salesBaseScoreVap: 95,
  productDevelopmentScore: 95,
  qualityAssuranceLevel: 1,
  deliveryReliability: 1,
  recentMajorIncidentPenalty: 0,
};

const LOW_INPUT: CompanyCapabilityCoefficientInput = {
  salesBaseScoreVap: 5,
  productDevelopmentScore: 5,
  qualityAssuranceLevel: 0,
  deliveryReliability: 0,
  recentMajorIncidentPenalty: 0,
};

const NEUTRAL_INPUT: CompanyCapabilityCoefficientInput = {
  salesBaseScoreVap: 50,
  productDevelopmentScore: 50,
  qualityAssuranceLevel: 0.5,
  deliveryReliability: 0.5,
  recentMajorIncidentPenalty: 0,
};

test("会社能力係数が下限0.7・上限1.3を超えないこと", () => {
  const high = calculateCompanyCapabilityCoefficient(HIGH_INPUT);
  const low = calculateCompanyCapabilityCoefficient(LOW_INPUT);
  assert.ok(high <= COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1.coefficientCap, `上限を超えない（実際: ${high}）`);
  assert.ok(low >= COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1.coefficientFloor, `下限を割らない（実際: ${low}）`);

  // 極端な値（レンジ外・巨大な事故ペナルティ等）を与えても必ずclampされる。
  const extreme = calculateCompanyCapabilityCoefficient({
    salesBaseScoreVap: 1000,
    productDevelopmentScore: 1000,
    qualityAssuranceLevel: 100,
    deliveryReliability: 100,
    recentMajorIncidentPenalty: 0,
  });
  assert.ok(extreme <= COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1.coefficientCap);

  const extremePenalty = calculateCompanyCapabilityCoefficient({
    ...NEUTRAL_INPUT,
    recentMajorIncidentPenalty: 1000,
  });
  assert.ok(extremePenalty >= COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1.coefficientFloor);
});

test("中立値の入力では能力係数は1.0", () => {
  const coefficient = calculateCompanyCapabilityCoefficient(NEUTRAL_INPUT);
  assert.ok(Math.abs(coefficient - 1.0) < 1e-9, `中立入力では係数1.0（実際: ${coefficient}）`);
});

test("営業関係・商品開発・品質保証すべてが高い会社は、すべて低い会社より会社別獲得プレミアムが高いこと", () => {
  const marketPremiumRatio = 0.35; // 市場全体のVAPプレミアム（USD/HOSO換算kg想定）。

  const highCoefficient = calculateCompanyCapabilityCoefficient(HIGH_INPUT);
  const lowCoefficient = calculateCompanyCapabilityCoefficient(LOW_INPUT);
  assert.ok(highCoefficient > lowCoefficient, "高能力会社の係数が高能力会社より高い");

  const highRealized = calculateCompanyRealizedVapPremiumRatio(marketPremiumRatio, highCoefficient);
  const lowRealized = calculateCompanyRealizedVapPremiumRatio(marketPremiumRatio, lowCoefficient);
  assert.ok(highRealized > lowRealized, "会社別獲得プレミアムも高能力会社の方が高い");

  // 市場プレミアムが同一なら、能力係数の比較がそのままプレミアムの比較になる。
  assert.ok(Math.abs(highRealized / lowRealized - highCoefficient / lowCoefficient) < 1e-9);
});

test("重大事故があった会社は能力係数が下がること", () => {
  const withoutIncident = calculateCompanyCapabilityCoefficient(NEUTRAL_INPUT);
  const withIncident = calculateCompanyCapabilityCoefficient({ ...NEUTRAL_INPUT, recentMajorIncidentPenalty: 0.5 });
  assert.ok(withIncident < withoutIncident, "重大事故ペナルティがあると能力係数は下がる");

  const severeIncident = calculateCompanyCapabilityCoefficient({ ...NEUTRAL_INPUT, recentMajorIncidentPenalty: 1.0 });
  assert.ok(severeIncident < withIncident, "重大度が高いほどさらに下がる（severity比例）");
});

// --- HOSO/PDの価格計算には一切影響しないこと（副作用がないこと） ---

const SAMPLE_ECON: CompanyPremiumEconomics = {
  expectedVariableProcessingCostUsdPerHosoEqKg: 1.0,
  allocatedFixedCostUsdPerHosoEqKg: 0.3,
  sellingAndLogisticsCostUsdPerHosoEqKg: 0.2,
  targetMarginUsdPerHosoEqKg: 0.5,
  avoidableVariableProcessingCostUsdPerHosoEqKg: 0.8,
  incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
  minimumContributionMarginUsdPerHosoEqKg: 0.1,
};

test("HOSO/PDの価格計算には一切影響しないこと（targetPremium/minimumAcceptablePremium/orderQuantityFactorは既存シグネチャのまま無変更で動作する）", () => {
  // targetPremium・minimumAcceptablePremiumは能力係数を一切引数に取らない
  // （HOSO/PDの経済性計算経路には会社別VAP能力係数が絶対に混入しない設計であることの
  // 型レベル・実行レベルの両方での確認）。
  const target = targetPremium(SAMPLE_ECON);
  const minimum = minimumAcceptablePremium(SAMPLE_ECON);
  assert.strictEqual(target, 2.0);
  assert.strictEqual(minimum, 1.0);

  // orderQuantityFactorはPD/HOSOにもそのまま使われる既存API。会社別VAP能力係数
  // （calculateCompanyCapabilityCoefficient・calculateCompanyRealizedVapPremiumRatio）を
  // 一切経由せずに呼んでも、従来と完全に同じ結果を返す（副作用が無いことの確認）。
  const marketPremium = 1.6; // target(2.0)未満・minimum(1.0)以上 → 縮小受注のはず
  const factorBefore = orderQuantityFactor(SAMPLE_ECON, marketPremium);
  // 同じ呼び出しを何度繰り返しても結果は不変（グローバル状態を持たない）。
  const factorAfter = orderQuantityFactor(SAMPLE_ECON, marketPremium);
  assert.strictEqual(factorBefore, factorAfter);
  assert.ok(factorBefore > 0 && factorBefore < 1, "目標未満・最低以上では縮小受注係数(0,1)になる");
});
