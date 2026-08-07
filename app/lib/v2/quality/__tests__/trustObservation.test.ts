// ShrimpX V2 — Phase 7A 品質モジュール trustObservation.ts テスト
//
// 履行実績(usage)・ロットの品質情報(qualityInfo)・納期観測から、会社×市場の
// 顧客信頼観測を正しく組み立てることを確認する。重大事故の影響市場が、
// lotId経由で事故対象商品を受領した市場だけへ正確に反映されること（実装指示が
// 許容する「全市場への限定的なフォールバック」を使わずに済んでいること）も確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, score0to100, unwrapUnit, usdM, usdPerHosoEqKg } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { FinishedGoodsLot, FinishedGoodsUsageRecord } from "../../production/types";
import { SalesContract } from "../../sales/types";
import { computeMarketTrustObservations } from "../trustObservation";
import { MarketDeliveryObservation } from "../types";

const PERIOD = "2015Q1" as PeriodV2;

function makeLot(overrides: Partial<FinishedGoodsLot> = {}): FinishedGoodsLot {
  return {
    lotId: "L1",
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    producedPeriod: PERIOD,
    originalQuantity: hosoEqTons(100),
    remainingQuantity: hosoEqTons(100),
    sourceRawMaterialLots: [],
    rawMaterialOriginCountries: [],
    rawMaterialUnitCost: usdPerHosoEqKg(3),
    baseProcessingCost: usdM(0),
    availableFromPeriod: PERIOD,
    status: "available",
    ...overrides,
  };
}

function makeContract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "CT1",
    companyId: "C1",
    market: "CN",
    product: "hoso",
    contractedPeriod: PERIOD,
    dueDate: PERIOD,
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(0),
    unitPrice: usdPerHosoEqKg(3),
    status: "fulfilled",
    ...overrides,
  };
}

test("履行実績がない会社×市場は観測を返さない（呼び出し側が据え置きと判断できるようにする）", () => {
  const obs = computeMarketTrustObservations([], new Map(), new Map(), []);
  assert.equal(obs.length, 0);
});

test("履行に使われたロットの品質スコアが、数量加重で会社×市場のdeliveredQualityScoreへ反映される", () => {
  const contract = makeContract({ contractId: "CT1", market: "CN" });
  const lotHighQuality = makeLot({ lotId: "L1", qualityInfo: { qualityScore: score0to100(90), downgradeRatio: ratio(0), producedPeriod: PERIOD } });
  const usage: FinishedGoodsUsageRecord[] = [{ contractId: "CT1", companyId: "C1", product: "hoso", lotId: "L1", quantity: hosoEqTons(50) }];

  const obs = computeMarketTrustObservations(usage, new Map([["CT1", contract]]), new Map([["L1", lotHighQuality]]), []);
  assert.equal(obs.length, 1);
  assert.equal(unwrapUnit(obs[0].deliveredQualityScore), 90);
});

test("qualityInfoがないロット(旧データ等)は中立値(50)として扱われる", () => {
  const contract = makeContract({ contractId: "CT1", market: "CN" });
  const lotNoQualityInfo = makeLot({ lotId: "L1" });
  const usage: FinishedGoodsUsageRecord[] = [{ contractId: "CT1", companyId: "C1", product: "hoso", lotId: "L1", quantity: hosoEqTons(50) }];
  const obs = computeMarketTrustObservations(usage, new Map([["CT1", contract]]), new Map([["L1", lotNoQualityInfo]]), []);
  assert.equal(unwrapUnit(obs[0].deliveredQualityScore), 50);
});

test("重大事故の影響は、その事故対象ロットを受領した市場にのみ反映される（他市場は無関係）", () => {
  const contractCN = makeContract({ contractId: "CT-CN", market: "CN" });
  const contractUS = makeContract({ contractId: "CT-US", market: "US", companyId: "C1" });
  const incidentLot = makeLot({
    lotId: "L-INCIDENT",
    qualityInfo: { qualityScore: score0to100(40), downgradeRatio: ratio(0.1), majorIncidentId: "inc-1", majorIncidentSeverity: 0.8, producedPeriod: PERIOD },
  });
  const cleanLot = makeLot({ lotId: "L-CLEAN", qualityInfo: { qualityScore: score0to100(80), downgradeRatio: ratio(0), producedPeriod: PERIOD } });

  const usage: FinishedGoodsUsageRecord[] = [
    { contractId: "CT-CN", companyId: "C1", product: "hoso", lotId: "L-INCIDENT", quantity: hosoEqTons(50) },
    { contractId: "CT-US", companyId: "C1", product: "hoso", lotId: "L-CLEAN", quantity: hosoEqTons(50) },
  ];

  const obs = computeMarketTrustObservations(
    usage,
    new Map([
      ["CT-CN", contractCN],
      ["CT-US", contractUS],
    ]),
    new Map([
      ["L-INCIDENT", incidentLot],
      ["L-CLEAN", cleanLot],
    ]),
    []
  );

  const cn = obs.find((o) => o.market === "CN")!;
  const us = obs.find((o) => o.market === "US")!;
  assert.ok(cn.majorIncidentTrustPenalty > 0, "CN市場は事故対象ロットを受領しているためペナルティを受ける");
  assert.equal(us.majorIncidentTrustPenalty, 0, "US市場は事故と無関係のロットのみ受領しているためペナルティなし");
});

test("納期観測(deliveryObservations)がある場合、observedDeliveryScoreへ正しく反映される", () => {
  const contract = makeContract({ contractId: "CT1", market: "CN" });
  const lot = makeLot({ lotId: "L1", qualityInfo: { qualityScore: score0to100(80), downgradeRatio: ratio(0), producedPeriod: PERIOD } });
  const usage: FinishedGoodsUsageRecord[] = [{ contractId: "CT1", companyId: "C1", product: "hoso", lotId: "L1", quantity: hosoEqTons(50) }];
  const deliveryObservations: MarketDeliveryObservation[] = [
    { companyId: "C1", market: "CN", dueQuantity: hosoEqTons(200), onTimeQuantity: hosoEqTons(150), newlyOverdueQuantity: hosoEqTons(50), continuingOverdueQuantity: hosoEqTons(0) },
  ];
  const obs = computeMarketTrustObservations(usage, new Map([["CT1", contract]]), new Map([["L1", lot]]), deliveryObservations);
  assert.equal(unwrapUnit(obs[0].observedDeliveryScore), 75); // 150/200*100
});
