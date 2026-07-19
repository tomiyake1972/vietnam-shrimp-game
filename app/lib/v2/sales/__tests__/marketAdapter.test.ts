import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { deriveTargetDemand, deriveVietnamBasePrices } from "../marketAdapter";
import { DEMAND_MARKET_IDS } from "../../market/types";
import { unwrapUnit } from "../../core/units";

function quarterFixture(turns = 4) {
  const result = runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "adapter-fixture", turns });
  return result.quarters;
}

test("deriveVietnamBasePrices: hoso/pd/vapそれぞれベトナムの価格をそのまま返す（Phase3の値を再計算しない）", () => {
  const [q1] = quarterFixture(1);
  const prices = deriveVietnamBasePrices(q1.marketResult);
  assert.equal(unwrapUnit(prices.hoso), unwrapUnit(q1.marketResult.hosoPrices.VN.price));
  assert.equal(unwrapUnit(prices.pd), unwrapUnit(q1.marketResult.pdPremium.byCountry.VN.finalPrice));
  assert.equal(unwrapUnit(prices.vap), unwrapUnit(q1.marketResult.vapPremium.byCountry.VN.finalPrice));
});

test("deriveTargetDemand: 全市場・全商品区分についてキーが揃っている", () => {
  const [q1] = quarterFixture(1);
  const demand = deriveTargetDemand(q1.marketResult, q1.marketInput);
  for (const market of DEMAND_MARKET_IDS) {
    assert.ok(demand[market]);
    for (const product of ["hoso", "pd", "vap"] as const) {
      assert.equal(typeof unwrapUnit(demand[market][product]), "number");
      assert.ok(unwrapUnit(demand[market][product]) >= 0);
    }
  }
});

test("deriveTargetDemand: 全市場×全商品区分の対象需要合計は、ベトナムの獲得需要（allocatedDemand）を超えない", () => {
  const [q1] = quarterFixture(1);
  const demand = deriveTargetDemand(q1.marketResult, q1.marketInput);
  let total = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      total += unwrapUnit(demand[market][product]);
    }
  }
  const vietnamAllocated = unwrapUnit(q1.marketResult.hosoPrices.VN.allocatedDemand);
  assert.ok(total <= vietnamAllocated + 1e-6, `total target demand (${total}) should not exceed VN allocatedDemand (${vietnamAllocated})`);
});

test("deriveTargetDemand: priorPeriodConsumptionが大きい市場ほど対象需要も大きい（比例配分になっている）", () => {
  const [q1] = quarterFixture(1);
  const demand = deriveTargetDemand(q1.marketResult, q1.marketInput);

  const sortedByConsumption = [...DEMAND_MARKET_IDS].sort(
    (a, b) => unwrapUnit(q1.marketInput.demandMarkets[b].priorPeriodConsumption) - unwrapUnit(q1.marketInput.demandMarkets[a].priorPeriodConsumption)
  );
  const sortedByDemand = [...DEMAND_MARKET_IDS].sort((a, b) => unwrapUnit(demand[b].hoso) - unwrapUnit(demand[a].hoso));
  assert.deepEqual(sortedByDemand, sortedByConsumption);
});

test("deriveTargetDemand: Phase3の市場結果・入力オブジェクトを変更しない（副作用なし）", () => {
  const [q1] = quarterFixture(1);
  const before = JSON.stringify(q1.marketResult);
  const beforeInput = JSON.stringify(q1.marketInput);
  deriveTargetDemand(q1.marketResult, q1.marketInput);
  assert.equal(JSON.stringify(q1.marketResult), before);
  assert.equal(JSON.stringify(q1.marketInput), beforeInput);
});
