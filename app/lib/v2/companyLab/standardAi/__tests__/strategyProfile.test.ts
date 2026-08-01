// ShrimpX V2 — 商品戦略プロファイル（strategyProfile.ts）の単体テスト
//
// managementProfile.test.ts と同じ検証方針: 会社ID→プロファイルの1対1・重複なし、
// BALANCEDがSTANDARD_AI_PARAMETERS_V1と完全に同一（deepEqual・appliedBiasItems空）、
// 各プロファイルのバイアス方向、比率バイアスの許容範囲。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_PROFILES,
  STRATEGY_PROFILE_BY_COMPANY_ID,
  StrategyProfile,
  deriveStrategyProfileParameters,
  resolveStrategyProfile,
  resolveStrategyProfileParameters,
} from "../strategyProfile";
import { MAX_BIAS_RATIO } from "../managementProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";

test("STRATEGY_PROFILE_BY_COMPANY_ID: 各会社に1つずつプロファイルが割り当てられている（重複はプロファイル単位ではなく会社単位でチェック）", () => {
  const entries = Object.entries(STRATEGY_PROFILE_BY_COMPANY_ID);
  assert.ok(entries.length >= 4, "検証ハーネスが必要とする4プロファイル分の会社が最低限そろっていること");
  // 会社ID自体はキーなので構造的に重複しない。ここでは「値が4種のStrategyProfileIdの
  // いずれかである」ことだけを確認する（本テーブルは5社全員を独自の戦略プロファイルへ
  // 割り当てる必要はない、という設計意図の確認）。
  for (const [companyId, profileId] of entries) {
    assert.ok(profileId in STRATEGY_PROFILES, `${companyId}に割り当てられた${profileId}が定義されていない`);
  }
});

test("4種類のプロファイルが少なくとも1社ずつ実際に使われている（検証ハーネス用途を満たす）", () => {
  const usedProfileIds = new Set(Object.values(STRATEGY_PROFILE_BY_COMPANY_ID));
  for (const id of ["BALANCED", "HOSO_SCALE", "PD_AUTOMATION", "VAP_DIFFERENTIATION"] as const) {
    assert.ok(usedProfileIds.has(id), `${id}がどの会社にも割り当てられていない`);
  }
});

test("BALANCED: STANDARD_AI_PARAMETERS_V1からのバイアスが一切ない（適用後パラメータが基準値と完全に同一）", () => {
  const { params, appliedBiasItems } = deriveStrategyProfileParameters(STANDARD_AI_PARAMETERS_V1, STRATEGY_PROFILES.BALANCED);
  assert.deepEqual(params, STANDARD_AI_PARAMETERS_V1);
  assert.deepEqual(appliedBiasItems, []);
});

test("BALANCED: capex overlay・investment overlayともに無効", () => {
  assert.equal(STRATEGY_PROFILES.BALANCED.capexOverlay.pdMechanization, false);
  assert.equal(STRATEGY_PROFILES.BALANCED.capexOverlay.qualityControlEquipment, false);
  assert.equal(STRATEGY_PROFILES.BALANCED.investmentOverlay.vapProductDevelopment, false);
});

test("resolveStrategyProfileParameters: 未知の会社IDはBALANCEDへフォールバックし、基準値と完全に同一のparamsが返る", () => {
  const resolved = resolveStrategyProfileParameters("UNKNOWN_COMPANY");
  assert.equal(resolved.profileId, "BALANCED");
  assert.deepEqual(resolved.params, STANDARD_AI_PARAMETERS_V1);
});

for (const profileId of ["HOSO_SCALE", "PD_AUTOMATION", "VAP_DIFFERENTIATION"] as const) {
  test(`${profileId}: 比率バイアスがすべて許容範囲(±${MAX_BIAS_RATIO})内`, () => {
    const profile: StrategyProfile = STRATEGY_PROFILES[profileId];
    const ratioFields: (keyof StrategyProfile)[] = ["salesAggressivenessRatio", "discountToleranceRatio", "importRelianceRatio"];
    for (const field of ratioFields) {
      const value = profile[field] as number;
      assert.ok(Math.abs(value) <= MAX_BIAS_RATIO + 1e-9, `${profileId}.${field} = ${value} が許容範囲を超えている`);
    }
    for (const [product, ratio] of Object.entries(profile.productOrientationBiasRatioByProduct)) {
      assert.ok(Math.abs(ratio as number) <= MAX_BIAS_RATIO + 1e-9, `${profileId}.productOrientationBiasRatioByProduct.${product} = ${ratio} が許容範囲を超えている`);
    }
  });
}

test("HOSO_SCALE: 販売積極性・輸入依存度・HOSO商品志向・HOSO設備投資前倒しが基準値より高く、値引き許容度は低い", () => {
  const { params } = deriveStrategyProfileParameters(STANDARD_AI_PARAMETERS_V1, STRATEGY_PROFILES.HOSO_SCALE);
  assert.ok(params.salesUtilizationTarget > STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.ok(params.maxDiscountRatioForExcessStock < STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock);
  assert.ok(params.importMixRatio > STANDARD_AI_PARAMETERS_V1.importMixRatio);
  assert.ok((params.productOrientationMultipliers.hoso ?? 1) > 1);
  assert.ok((params.capexShortfallThresholdBiasByProduct.hoso ?? 0) > 0);
  // PD/VAPへは影響しない。
  assert.equal(params.productOrientationMultipliers.pd, undefined);
  assert.equal(params.productOrientationMultipliers.vap, undefined);
});

test("HOSO_SCALE: capex overlay・investment overlayともに無効（既存の調達規模効果に委ねる設計）", () => {
  assert.equal(STRATEGY_PROFILES.HOSO_SCALE.capexOverlay.pdMechanization, false);
  assert.equal(STRATEGY_PROFILES.HOSO_SCALE.capexOverlay.qualityControlEquipment, false);
  assert.equal(STRATEGY_PROFILES.HOSO_SCALE.investmentOverlay.vapProductDevelopment, false);
});

test("PD_AUTOMATION: PD商品志向・PD設備投資前倒しが基準値より高く、HOSO/VAPへは影響しない", () => {
  const { params } = deriveStrategyProfileParameters(STANDARD_AI_PARAMETERS_V1, STRATEGY_PROFILES.PD_AUTOMATION);
  assert.ok((params.productOrientationMultipliers.pd ?? 1) > 1);
  assert.ok((params.capexShortfallThresholdBiasByProduct.pd ?? 0) > 0);
  assert.equal(params.productOrientationMultipliers.hoso, undefined);
  assert.equal(params.productOrientationMultipliers.vap, undefined);
  assert.equal(params.capexShortfallThresholdBiasByProduct.vap, undefined);
});

test("PD_AUTOMATION: pdMechanization capex overlayのみ有効。investment overlayは無効", () => {
  assert.equal(STRATEGY_PROFILES.PD_AUTOMATION.capexOverlay.pdMechanization, true);
  assert.equal(STRATEGY_PROFILES.PD_AUTOMATION.capexOverlay.qualityControlEquipment, false);
  assert.equal(STRATEGY_PROFILES.PD_AUTOMATION.investmentOverlay.vapProductDevelopment, false);
});

test("VAP_DIFFERENTIATION: VAP商品志向・高付加価値受注選好が基準値より高く、HOSO/PDへは影響しない", () => {
  const { params } = deriveStrategyProfileParameters(STANDARD_AI_PARAMETERS_V1, STRATEGY_PROFILES.VAP_DIFFERENTIATION);
  assert.ok((params.productOrientationMultipliers.vap ?? 1) > 1);
  assert.ok(params.valueAddedOrderFactorBoost > 0);
  assert.equal(params.productOrientationMultipliers.hoso, undefined);
  assert.equal(params.productOrientationMultipliers.pd, undefined);
});

test("VAP_DIFFERENTIATION: qualityControlEquipment capex overlay・VAP投資overlayともに有効", () => {
  assert.equal(STRATEGY_PROFILES.VAP_DIFFERENTIATION.capexOverlay.pdMechanization, false);
  assert.equal(STRATEGY_PROFILES.VAP_DIFFERENTIATION.capexOverlay.qualityControlEquipment, true);
  assert.equal(STRATEGY_PROFILES.VAP_DIFFERENTIATION.investmentOverlay.vapProductDevelopment, true);
});

test("resolveStrategyProfile: 会社IDからプロファイルを正しく解決する", () => {
  assert.equal(resolveStrategyProfile(STRATEGY_PROFILE_BY_COMPANY_ID_KEY("HOSO_SCALE")).id, "HOSO_SCALE");
});

// STRATEGY_PROFILE_BY_COMPANY_IDに実際に割り当てられている会社IDを1件取得するヘルパー
// （テスト自身が具体的な会社IDラベルの割当てに依存しすぎないようにする）。
function STRATEGY_PROFILE_BY_COMPANY_ID_KEY(profileId: keyof typeof STRATEGY_PROFILES): string {
  const found = Object.entries(STRATEGY_PROFILE_BY_COMPANY_ID).find(([, v]) => v === profileId);
  if (!found) throw new Error(`${profileId}が割り当てられた会社が見つからない`);
  return found[0];
}

test("productOrientationMultipliers: 既にorientationレイヤーが設定した値の上へさらに重ねる（4層構成の合成確認）", () => {
  const baseWithOrientation = {
    ...STANDARD_AI_PARAMETERS_V1,
    productOrientationMultipliers: { hoso: 1.1, pd: 1.0, vap: 0.9 },
  };
  const { params } = deriveStrategyProfileParameters(baseWithOrientation, STRATEGY_PROFILES.HOSO_SCALE);
  // 1.1 * 1.05 = 1.155
  assert.ok(Math.abs((params.productOrientationMultipliers.hoso ?? 0) - 1.1 * 1.05) < 1e-9);
  // pd/vapはHOSO_SCALEのバイアス対象外なので、orientationレイヤーの値がそのまま残る。
  assert.equal(params.productOrientationMultipliers.pd, 1.0);
  assert.equal(params.productOrientationMultipliers.vap, 0.9);
});
