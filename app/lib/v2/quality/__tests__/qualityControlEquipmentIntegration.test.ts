// ShrimpX V2 — Phase QI-I1: 品質管理設備 batchAdjustment統合テスト
//
// 対応する指示§11の項目: 7(operational stressは残る)・8(downgrade低下)・
// 9(rework低下)・10(disposal低下)・11(major incident risk低下)・
// 12(Quality Scoreへの直接加点なし)・13(既存weighted aggregationを使用)・
// 14(Trust波及が既存経路で発生)・15(VAP capability波及が既存経路で発生)・
// 16(Player/engine共通mechanic)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdM } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { Factory, FactoryLoadMetrics, ProductionBatch } from "../../production/types";
import { applyQualityToBatches, QualityAdjustmentInput } from "../batchAdjustment";
import { updateQualityByCompanyProduct } from "../stateUpdate";
import { updateCustomerTrustScore } from "../scoreUpdates";
import { calculateCompanyCapabilityCoefficient } from "../../companyLab/premiumPolicy";
import { QUALITY_PARAMETERS_V1 } from "../parameters";
import { score0to100 } from "../../core/units";

const PERIOD = "2015Q1" as PeriodV2;

function makeFactory(overrides: Partial<Factory> = {}): Factory {
  return {
    factoryId: "F1",
    companyId: "C1",
    status: "active",
    commonProcessingCapacity: hosoEqTons(10000),
    hosoCapacity: hosoEqTons(5000),
    pdCapacity: hosoEqTons(5000),
    vapCapacity: hosoEqTons(5000),
    freezingPackagingCapacity: hosoEqTons(10000),
    baseUtilizationRate: ratio(1),
    equipmentAvailabilityRate: ratio(1),
    ...overrides,
  };
}

/** 高負荷（重過負荷）操業条件: 高稼働率・高残業・高臨時ワーカー比率。 */
function makeHighStressLoadMetrics(factoryId: string, overrides: Partial<FactoryLoadMetrics> = {}): FactoryLoadMetrics {
  return {
    factoryId,
    companyId: "C1",
    period: PERIOD,
    equipmentUtilizationRate: ratio(0.98),
    laborUtilizationRate: ratio(0.98),
    overtimeRate: ratio(0.2),
    temporaryWorkerShare: ratio(0.5),
    productMixComplexity: ratio(0.8),
    averageRawMaterialAgeQuarters: 3,
    productionShortfallRate: ratio(0),
    processingLossRate: ratio(0),
    ...overrides,
  };
}

function makeBatch(factoryId: string, overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  const finished = overrides.finishedGoodsQuantity ?? hosoEqTons(1000);
  return {
    batchId: `C1::${factoryId}::hoso`,
    companyId: "C1",
    factoryId,
    product: "hoso",
    period: PERIOD,
    rawMaterialConsumed: [],
    rawMaterialConsumedTotal: hosoEqTons(unwrapUnit(finished)),
    finishedGoodsQuantity: finished,
    processingLoss: hosoEqTons(0),
    rawMaterialCost: usdM(0),
    baseProcessingCost: usdM(0),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<QualityAdjustmentInput> = {}): QualityAdjustmentInput {
  return {
    batches: [makeBatch("F1"), makeBatch("F2")],
    factoryLoadMetrics: [makeHighStressLoadMetrics("F1"), makeHighStressLoadMetrics("F2")],
    factories: [makeFactory({ factoryId: "F1" }), makeFactory({ factoryId: "F2" })],
    rampHistory: [],
    overtimeRateCap: 0.2,
    period: PERIOD,
    turn: 5,
    gameSeed: "qi-i1-integration-seed",
    ...overrides,
  };
}

test("QI1-INT-7: 設備があっても高負荷操業ではeffectiveOperationalRiskが残る（0にならない）", () => {
  const result = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const f1Adjustment = result.adjustments.find((a) => a.factoryId === "F1")!;
  assert.ok(f1Adjustment.risk.operationalRisk > 0, "高負荷操業なのでraw operationalRiskは正のはず");
  assert.ok(f1Adjustment.effectiveOperationalRisk > 0, "設備があってもeffectiveOperationalRiskは0にならないはず（強制floor禁止）");
  assert.ok(f1Adjustment.effectiveOperationalRisk < f1Adjustment.risk.operationalRisk, "設備によりeffectiveOperationalRiskはrawより小さくなるはず");
});

test("QI1-INT-8/9/10: 設備ありのFactoryはdowngrade/rework/disposal（discard）比率が下がる", () => {
  const withEquipment = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const withoutEquipment = applyQualityToBatches(baseInput());
  const withF1 = withEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  const withoutF1 = withoutEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  assert.ok(withF1.outcome.downgradeRatio < withoutF1.outcome.downgradeRatio, "downgradeRatioが低下するはず");
  assert.ok(withF1.outcome.reworkRatio < withoutF1.outcome.reworkRatio, "reworkRatioが低下するはず");
  assert.ok(withF1.outcome.discardRatio < withoutF1.outcome.discardRatio, "discardRatio（廃棄）が低下するはず");
});

test("QI1-INT-11: 設備ありのFactoryはmajor incident確率が下がる", () => {
  // majorIncidentは乱数抽選だが、事前確率（probability）自体は決定論的にrisk依存で計算される。
  // ここではrisk.majorIncident.probabilityフィールドを比較する。
  const withEquipment = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const withoutEquipment = applyQualityToBatches(baseInput());
  const withF1 = withEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  const withoutF1 = withoutEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  assert.ok(
    withF1.outcome.majorIncident.probability < withoutF1.outcome.majorIncident.probability,
    "major incident発生確率が低下するはず"
  );
});

test("QI1-INT-12: rawのrisk.operationalRiskは設備の有無で一切変わらない（Quality Scoreへの直接加点なし）", () => {
  const withEquipment = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const withoutEquipment = applyQualityToBatches(baseInput());
  const withF1 = withEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  const withoutF1 = withoutEquipment.adjustments.find((a) => a.factoryId === "F1")!;
  assert.equal(
    withF1.risk.operationalRisk,
    withoutF1.risk.operationalRisk,
    "risk.operationalRisk（純粋な操業条件からのリスク）は設備の有無で変わらないはず（effectiveOperationalRiskだけが変わる）"
  );
});

test("QI1-INT-5/6再掲: 設備ありのFactoryだけ効果があり、無いFactoryへは一切漏れない", () => {
  const result = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const f1 = result.adjustments.find((a) => a.factoryId === "F1")!;
  const f2 = result.adjustments.find((a) => a.factoryId === "F2")!;
  assert.equal(f1.qualityEquipmentRiskMultiplier, 0.7);
  assert.equal(f2.qualityEquipmentRiskMultiplier, 1, "設備の無いF2の乗数は1.0（無効果）のはず");
  assert.equal(f2.effectiveOperationalRisk, f2.risk.operationalRisk, "F2はeffectiveとrawが完全一致するはず（設備の影響が一切漏れていない証明）");
});

test("QI1-INT-13: 設備ありFactoryと無しFactoryが混在する会社×商品でも、既存の生産量加重平均集約（updateQualityByCompanyProduct）がそのまま使える", () => {
  const result = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  // 新しい集約ロジックを追加せず、既存のstateUpdate.tsをそのまま使う。
  const updated = updateQualityByCompanyProduct([], result.adjustments, QUALITY_PARAMETERS_V1);
  const entry = updated.find((s) => s.companyId === "C1" && s.product === "hoso");
  assert.ok(entry, "会社×商品ぶんのQuality Scoreが既存の集約関数でそのまま生成されるはず");
  assert.ok(unwrapUnit(entry!.qualityScore) >= 0 && unwrapUnit(entry!.qualityScore) <= 100);
});

test("QI1-INT-14: 品質改善（設備あり）による観測品質スコアの差は、既存のupdateCustomerTrustScore経路でそのままTrustへ波及する", () => {
  const withEquipment = applyQualityToBatches(baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) }));
  const withoutEquipment = applyQualityToBatches(baseInput());
  const withF1Score = withEquipment.adjustments.find((a) => a.factoryId === "F1")!.outcome.observedQualityScore;
  const withoutF1Score = withoutEquipment.adjustments.find((a) => a.factoryId === "F1")!.outcome.observedQualityScore;

  const trustWith = updateCustomerTrustScore(score0to100(50), withF1Score, score0to100(90), 0, QUALITY_PARAMETERS_V1);
  const trustWithout = updateCustomerTrustScore(score0to100(50), withoutF1Score, score0to100(90), 0, QUALITY_PARAMETERS_V1);
  assert.ok(
    unwrapUnit(trustWith) >= unwrapUnit(trustWithout),
    "設備による品質改善は、既存のupdateCustomerTrustScore経路を通じてTrustの改善（または同等）につながるはず"
  );
});

test("QI1-INT-15: 品質スコアの差は、既存のcalculateCompanyCapabilityCoefficient（VAP capability composite）経路でそのまま波及する", () => {
  const higherQualityCoefficient = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(50), qualityScore: score0to100(80) });
  const lowerQualityCoefficient = calculateCompanyCapabilityCoefficient({ productDevelopmentScore: score0to100(50), qualityScore: score0to100(60) });
  assert.ok(
    higherQualityCoefficient > lowerQualityCoefficient,
    "品質スコアが高いほど、既存のVAP capability compositeも高くなるはず（新しい経路を作らず既存関数をそのまま使う）"
  );
});

test("QI1-INT-16: qualityEquipmentRiskMultiplierByFactoryはPLAYER/Standard AIの区別を一切持たない（会社の意思決定主体に依存しない共通mechanic）", () => {
  // applyQualityToBatchesのQualityAdjustmentInputにはdecisionOwner等の概念が存在しない
  // （factoryIdだけで乗数を引く）。これは型定義上の構造的な保証であり、実行時にも
  // 同じ入力（factoryId→乗数）に対して常に同じ結果を返すことで再確認する。
  const input = baseInput({ qualityEquipmentRiskMultiplierByFactory: new Map([["F1", 0.7]]) });
  const result1 = applyQualityToBatches(input);
  const result2 = applyQualityToBatches(input);
  assert.deepEqual(
    result1.adjustments.map((a) => a.qualityEquipmentRiskMultiplier),
    result2.adjustments.map((a) => a.qualityEquipmentRiskMultiplier)
  );
});
