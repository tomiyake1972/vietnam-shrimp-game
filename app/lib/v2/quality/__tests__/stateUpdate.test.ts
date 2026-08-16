// ShrimpX V2 — Phase 7A 品質モジュール stateUpdate.ts テスト
//
// 対応する受入条件:
//   14. 生産がない商品は品質状態を変えない
//   16. 納期対象がない市場では納期信頼性を変えない
//   19(再掲). 顧客信頼・納期信頼性は独立したトリガー条件を持つ（片方だけ更新されうる）
//   24(一部). スコアが常に範囲内に収まる

import { test } from "node:test";
import assert from "node:assert/strict";
import { ratio, score0to100, unwrapUnit } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { updateQualityByCompanyProduct, updateTrustByCompanyMarket, initializeQualityReliabilityState } from "../stateUpdate";
import { BatchQualityAdjustment, CompanyMarketTrustState, CompanyProductQualityState, MarketDeliveryObservation, MarketTrustObservation } from "../types";
import { hosoEqTons } from "../../core/units";

const PERIOD = "2015Q1" as PeriodV2;

function makeAdjustment(overrides: Partial<BatchQualityAdjustment> = {}): BatchQualityAdjustment {
  return {
    batchId: "b1",
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    period: PERIOD,
    risk: {
      utilizationStress: 0,
      overtimeStress: 0,
      temporaryWorkerStress: 0,
      complexityStress: 0,
      rawMaterialAgeStress: 0,
      productionRampStress: 0,
      operationalRisk: 0.3,
    },
    qualityEquipmentRiskMultiplier: 1,
    effectiveOperationalRisk: 0.3,
    outcome: {
      nonConformanceRatio: 0.02,
      downgradeRatio: 0.01,
      reworkRatio: 0.005,
      discardRatio: 0.006,
      saleableRecoveryRatio: ratio(0.994),
      observedQualityScore: score0to100(70),
      majorIncident: { occurred: false, severity: 0, probability: 0, seed: "n/a" },
    },
    originalFinishedGoodsQuantity: hosoEqTons(1000),
    adjustedFinishedGoodsQuantity: hosoEqTons(994),
    downgradeQuantity: hosoEqTons(10),
    reworkQuantity: hosoEqTons(5),
    discardQuantity: hosoEqTons(6),
    ...overrides,
  };
}

test("14: 当期production対象外の会社×商品はqualityScoreを据え置く", () => {
  const previous: CompanyProductQualityState[] = [
    { companyId: "C1", product: "hoso", qualityScore: score0to100(80) },
    { companyId: "C1", product: "pd", qualityScore: score0to100(75) },
  ];
  // 当期の生産実績はhosoのみ（pdはこの四半期production対象外）
  const adjustments = [makeAdjustment({ product: "hoso" })];
  const updated = updateQualityByCompanyProduct(previous, adjustments);

  const hoso = updated.find((s) => s.product === "hoso")!;
  const pd = updated.find((s) => s.product === "pd")!;
  assert.notEqual(unwrapUnit(hoso.qualityScore), 80, "hosoは生産実績があるため更新される");
  assert.equal(unwrapUnit(pd.qualityScore), 75, "pdは生産実績がないため据え置かれる");
});

test("14b: 生産実績が全くない四半期は、既存のqualityByCompanyProduct全体が完全に不変のまま返る", () => {
  const previous: CompanyProductQualityState[] = [{ companyId: "C1", product: "hoso", qualityScore: score0to100(80) }];
  const updated = updateQualityByCompanyProduct(previous, []);
  assert.deepEqual(updated, previous);
});

test("16: dueQuantity=0の会社×市場はdeliveryReliabilityScoreを据え置く（顧客信頼は独立して更新されうる）", () => {
  const previous: CompanyMarketTrustState[] = [{ companyId: "C1", market: "CN", customerTrustScore: score0to100(50), deliveryReliabilityScore: score0to100(60) }];
  const deliveryObservations: MarketDeliveryObservation[] = [
    { companyId: "C1", market: "CN", dueQuantity: hosoEqTons(0), onTimeQuantity: hosoEqTons(0), newlyOverdueQuantity: hosoEqTons(0), continuingOverdueQuantity: hosoEqTons(0) },
  ];
  const trustObservations: MarketTrustObservation[] = [
    { companyId: "C1", market: "CN", deliveredQualityScore: score0to100(90), observedDeliveryScore: score0to100(80), majorIncidentTrustPenalty: 0 },
  ];
  const updated = updateTrustByCompanyMarket(previous, deliveryObservations, trustObservations);
  const s = updated.find((x) => x.companyId === "C1" && x.market === "CN")!;
  assert.equal(unwrapUnit(s.deliveryReliabilityScore), 60, "dueQuantity=0なので納期信頼性は据え置く");
  assert.notEqual(unwrapUnit(s.customerTrustScore), 50, "顧客信頼は履行実績(trustObservations)があるため独立して更新される");
});

test("16b: 市場に当期の履行実績も納期対象もなければ、両スコアとも完全に据え置かれる", () => {
  const previous: CompanyMarketTrustState[] = [{ companyId: "C1", market: "JP", customerTrustScore: score0to100(55), deliveryReliabilityScore: score0to100(45) }];
  const updated = updateTrustByCompanyMarket(previous, [], []);
  assert.deepEqual(updated, previous);
});

test("納期信頼性のみ更新され顧客信頼は据え置かれるケースも存在する（独立トリガー、逆方向）", () => {
  const previous: CompanyMarketTrustState[] = [{ companyId: "C1", market: "EU", customerTrustScore: score0to100(50), deliveryReliabilityScore: score0to100(50) }];
  const deliveryObservations: MarketDeliveryObservation[] = [
    { companyId: "C1", market: "EU", dueQuantity: hosoEqTons(100), onTimeQuantity: hosoEqTons(100), newlyOverdueQuantity: hosoEqTons(0), continuingOverdueQuantity: hosoEqTons(0) },
  ];
  const updated = updateTrustByCompanyMarket(previous, deliveryObservations, []);
  const s = updated[0];
  assert.notEqual(unwrapUnit(s.deliveryReliabilityScore), 50);
  assert.equal(unwrapUnit(s.customerTrustScore), 50, "顧客信頼は履行実績(trustObservations)がないため据え置く");
});

test("24: 更新後のスコアは常に[0,100]範囲に収まる（極端な入力でも発散しない）", () => {
  const previous: CompanyProductQualityState[] = [{ companyId: "C1", product: "hoso", qualityScore: score0to100(100) }];
  const badAdjustment = makeAdjustment({
    outcome: {
      nonConformanceRatio: 1,
      downgradeRatio: 0.4,
      reworkRatio: 0.3,
      discardRatio: 0.3,
      saleableRecoveryRatio: ratio(0.7),
      observedQualityScore: score0to100(0),
      majorIncident: { occurred: true, severity: 1, probability: 0.1, seed: "x" },
    },
  });
  const updated = updateQualityByCompanyProduct(previous, [badAdjustment]);
  for (const s of updated) {
    assert.ok(unwrapUnit(s.qualityScore) >= 0 && unwrapUnit(s.qualityScore) <= 100);
  }
});

test("initializeQualityReliabilityStateは全社×全商品・全社×全市場を中立値/baselineで初期化する", () => {
  const state = initializeQualityReliabilityState(["C1", "C2"], ["hoso", "pd", "vap"]);
  assert.equal(state.qualityByCompanyProduct.length, 6);
  assert.equal(state.rampHistory.length, 0);
  for (const s of state.qualityByCompanyProduct) {
    assert.ok(unwrapUnit(s.qualityScore) >= 0 && unwrapUnit(s.qualityScore) <= 100);
  }
  for (const t of state.trustByCompanyMarket) {
    assert.equal(unwrapUnit(t.customerTrustScore), 50);
    assert.equal(unwrapUnit(t.deliveryReliabilityScore), 50);
  }
});
