// ShrimpX V2 — Phase SAI-4: 経営性格プロファイル（managementProfile.ts）の単体テスト
//
// 実装指示§9で要求されるテストのうち、プロファイルの値そのもの（会社IDによる
// バイアス値の解決・比率/絶対値バイアスの許容範囲・安全ガードフィールドの
// 非対象化・A社=基準値と完全一致）を扱う。全社×複数ターンの統合的な振る舞い
// （方向性テスト・E社の安定性テスト・4000トン上限）はautoplay/__tests__/側で扱う。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANAGEMENT_PROFILES,
  MANAGEMENT_PROFILE_BY_COMPANY_ID,
  MAX_BIAS_RATIO,
  ManagementProfile,
  deriveStandardAiParameters,
  resolveManagementProfileParameters,
} from "../managementProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";

// 【実装指示§1・§6】現金危機対応・赤字回避・容量/在庫/資金制約・デフォルト回避に
// 直結する安全ガード系フィールド。経営性格プロファイルは、これらを一切対象に
// してはならない（=どのプロファイルでもSTANDARD_AI_PARAMETERS_V1と完全に同値）。
const SAFETY_GUARD_FIELDS = [
  "cashBufferQuarters",
  "voluntaryPrepaymentMultiple",
  "minimumCashBufferFloorUsd",
  "desiredTermQuarters",
  "capexSustainedUtilizationThreshold",
  "capexCashSafetyMultiple",
  "capexMaxLoanToSizeRatio",
  "expectedAquacultureHarvestRatio",
  "aquacultureIntensity",
  "bioSecurityLevel",
  "cashConstrainedProcurementDampingAtSeverePressure",
  "severeCashPressureThreshold",
  "finishedGoodsTargetQuarters",
  "rawMaterialTargetQuarters",
  "minDomesticPurchaseRatioOfBase",
] as const;

test("MANAGEMENT_PROFILE_BY_COMPANY_ID: 5社すべてに1つずつ、重複なくプロファイルが割り当てられている", () => {
  const ids = Object.values(MANAGEMENT_PROFILE_BY_COMPANY_ID);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, "同じプロファイルが2社以上に割り当てられている（各社のプロファイルは1対1であるべき）");
});

test("balanced(A社): STANDARD_AI_PARAMETERS_V1からのバイアスが一切ない（適用後パラメータが基準値と完全に同一）", () => {
  const { params, appliedBiasItems } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.balanced);
  assert.deepEqual(params, STANDARD_AI_PARAMETERS_V1);
  assert.deepEqual(appliedBiasItems, []);
});

test("resolveManagementProfileParameters: BAL(balanced)を解決すると、STANDARD_AI_PARAMETERS_V1と完全に同一のparamsが返る", () => {
  const resolved = resolveManagementProfileParameters("BAL");
  assert.equal(resolved.profileId, "balanced");
  assert.deepEqual(resolved.params, STANDARD_AI_PARAMETERS_V1);
});

for (const profileId of ["growth", "conservative", "valueAdded", "opportunistic"] as const) {
  test(`${profileId}: 比率バイアスがすべて許容範囲(±${MAX_BIAS_RATIO})内`, () => {
    const profile = MANAGEMENT_PROFILES[profileId];
    const ratioFields: (keyof ManagementProfile)[] = [
      "salesAggressivenessRatio",
      "discountToleranceRatio",
      "importRelianceRatio",
      "inventoryResponsivenessRatio",
      "headcountPaceRatio",
      "aquacultureSelfSufficiencyRatio",
    ];
    for (const field of ratioFields) {
      const value = profile[field] as number;
      assert.ok(Math.abs(value) <= MAX_BIAS_RATIO + 1e-9, `${profileId}.${field} = ${value} が許容範囲を超えている`);
    }
  });

  test(`${profileId}: 安全ガード対象フィールドは基準値から一切変更されない`, () => {
    const { params } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES[profileId]);
    for (const field of SAFETY_GUARD_FIELDS) {
      assert.equal(
        (params as unknown as Record<string, unknown>)[field],
        (STANDARD_AI_PARAMETERS_V1 as unknown as Record<string, unknown>)[field],
        `${profileId}が安全ガードフィールド ${field} を変更してしまっている`
      );
    }
    // capexShortfallThresholdBiasByProduct自体はD社向けの差し込み口だが、対象は
    // pd/vapのみでhosoは対象外（hosoは能力そのものの制約に近いため）。
    assert.equal(params.capexShortfallThresholdBiasByProduct.hoso, undefined);
  });
}

test("growth(B社): 販売積極性・値引き許容度・輸入依存度・人員調整ペースが基準値よりわずかに高い", () => {
  const { params } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.growth);
  assert.ok(params.salesUtilizationTarget > STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.ok(params.maxDiscountRatioForExcessStock > STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock);
  assert.ok(params.importMixRatio > STANDARD_AI_PARAMETERS_V1.importMixRatio);
  assert.ok(params.regularHeadcountAdjustmentDamping > STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping);
});

test("conservative(C社): 販売積極性・値引き許容度・輸入依存度・人員調整ペース・在庫是正速度・養殖自給選好が基準値よりわずかに低い", () => {
  const { params } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.conservative);
  assert.ok(params.salesUtilizationTarget < STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.ok(params.maxDiscountRatioForExcessStock < STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock);
  assert.ok(params.importMixRatio < STANDARD_AI_PARAMETERS_V1.importMixRatio);
  assert.ok(params.regularHeadcountAdjustmentDamping < STANDARD_AI_PARAMETERS_V1.regularHeadcountAdjustmentDamping);
  assert.ok(params.inventoryCorrectionDamping < STANDARD_AI_PARAMETERS_V1.inventoryCorrectionDamping);
  assert.ok(params.maxAquacultureShareOfRequirement < STANDARD_AI_PARAMETERS_V1.maxAquacultureShareOfRequirement);
});

test("valueAdded(D社): PD/VAP受注選好・PD/VAP設備投資前倒し・養殖自給選好が基準値よりわずかに高い", () => {
  const { params } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.valueAdded);
  assert.ok(params.valueAddedOrderFactorBoost > 0);
  assert.ok((params.capexShortfallThresholdBiasByProduct.pd ?? 0) > 0);
  assert.ok((params.capexShortfallThresholdBiasByProduct.vap ?? 0) > 0);
  assert.ok(params.maxAquacultureShareOfRequirement > STANDARD_AI_PARAMETERS_V1.maxAquacultureShareOfRequirement);
});

test("opportunistic(E社): 在庫是正速度・販売積極性が基準値よりわずかに高く、それ以外は無変更（新規状態管理を追加しない設計の確認）", () => {
  const { params, appliedBiasItems } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.opportunistic);
  assert.ok(params.inventoryCorrectionDamping > STANDARD_AI_PARAMETERS_V1.inventoryCorrectionDamping);
  assert.ok(params.salesUtilizationTarget > STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.equal(appliedBiasItems.length, 2, "E社は在庫是正速度・販売積極性の2項目だけをバイアス対象とする設計のはず");
});

test("deriveStandardAiParameters: 比率バイアスが許容範囲(±10%)を超えるプロファイルはエラーになる（バイアス幅の安全弁）", () => {
  const outOfBoundsProfile: ManagementProfile = {
    ...MANAGEMENT_PROFILES.balanced,
    id: "growth",
    label: "test-out-of-bounds",
    description: "test",
    salesAggressivenessRatio: 0.5, // 意図的に許容範囲外
  };
  assert.throws(() => deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, outOfBoundsProfile));
});

test("deriveStandardAiParameters: 絶対値バイアス(valueAddedPreferenceAbsolute)が参照基準の10%相当を超えるとエラーになる", () => {
  const outOfBoundsProfile: ManagementProfile = {
    ...MANAGEMENT_PROFILES.balanced,
    id: "valueAdded",
    label: "test-out-of-bounds-absolute",
    description: "test",
    valueAddedPreferenceAbsolute: 0.5,
  };
  assert.throws(() => deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, outOfBoundsProfile));
});

test("appliedBiasItems: baseValue/biasedValueが記録されており、バイアスがない項目はappliedBiasItemsに含まれない", () => {
  const { appliedBiasItems } = deriveStandardAiParameters(STANDARD_AI_PARAMETERS_V1, MANAGEMENT_PROFILES.growth);
  const fields = appliedBiasItems.map((i) => i.field);
  assert.ok(fields.includes("salesUtilizationTarget"));
  assert.ok(!fields.includes("inventoryCorrectionDamping"), "growthプロファイルはinventoryCorrectionDampingをバイアス対象にしていないはず");
  for (const item of appliedBiasItems) {
    assert.ok(Number.isFinite(item.baseValue));
    assert.ok(Number.isFinite(item.biasedValue));
    assert.notEqual(item.baseValue, item.biasedValue);
  }
});
