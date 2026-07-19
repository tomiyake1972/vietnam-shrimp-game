import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdM, usdPerHosoEqKg } from "../../core/units";
import { nextPeriod, period } from "../../core/period";
import { planContractFulfillment } from "../fulfillment";
import { applyFulfillments, updateContractStatusesForQuarterEnd } from "../../sales/backlog";
import { SalesContract } from "../../sales/types";
import { FinishedGoodsLot, ProductionBatch } from "../types";
import { createFinishedGoodsLots } from "../finishedGoods";

const P1 = period(2020, 1);
const P2 = nextPeriod(P1);
const P3 = nextPeriod(P2);

function makeContract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "SC-1",
    companyId: "C1",
    market: "CN",
    product: "hoso",
    contractedPeriod: P1,
    dueDate: P2,
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(100),
    unitPrice: usdPerHosoEqKg(6),
    status: "open",
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  return {
    batchId: "PB-1",
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    period: P1,
    rawMaterialConsumed: [],
    rawMaterialConsumedTotal: hosoEqTons(0),
    finishedGoodsQuantity: hosoEqTons(50),
    processingLoss: hosoEqTons(0),
    rawMaterialCost: usdM(0),
    baseProcessingCost: usdM(0),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

function lotsFrom(batches: ProductionBatch[]): readonly FinishedGoodsLot[] {
  return createFinishedGoodsLots(batches);
}

test("会社と商品が一致する完成品だけを使用する", () => {
  const contracts = [makeContract({ companyId: "C1", product: "hoso" })];
  const lots = lotsFrom([makeBatch({ companyId: "C2", product: "hoso" }), makeBatch({ batchId: "PB-2", companyId: "C1", product: "pd" })]);
  const plan = planContractFulfillment(contracts, lots);
  assert.equal(plan.usage.length, 0);
});

test("納期の早い契約から処理する", () => {
  const early = makeContract({ contractId: "SC-EARLY", dueDate: P2, originalQuantity: hosoEqTons(30), outstandingQuantity: hosoEqTons(30) });
  const late = makeContract({ contractId: "SC-LATE", dueDate: P3, originalQuantity: hosoEqTons(30), outstandingQuantity: hosoEqTons(30) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(30) })]);
  const plan = planContractFulfillment([late, early], lots);
  const earlyFill = plan.explicitInstructions.find((i) => i.contractId === "SC-EARLY");
  const lateFill = plan.explicitInstructions.find((i) => i.contractId === "SC-LATE");
  assert.ok(earlyFill && unwrapUnit(earlyFill.quantity) === 30);
  assert.equal(lateFill, undefined);
});

test("同一納期では契約ID順で処理し、入力順に依存しない", () => {
  const a = makeContract({ contractId: "SC-A", dueDate: P2, originalQuantity: hosoEqTons(20), outstandingQuantity: hosoEqTons(20) });
  const b = makeContract({ contractId: "SC-B", dueDate: P2, originalQuantity: hosoEqTons(20), outstandingQuantity: hosoEqTons(20) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(20) })]);
  const plan1 = planContractFulfillment([a, b], lots);
  const plan2 = planContractFulfillment([b, a], lots);
  assert.deepEqual(
    plan1.explicitInstructions.map((i) => [i.contractId, unwrapUnit(i.quantity)]),
    plan2.explicitInstructions.map((i) => [i.contractId, unwrapUnit(i.quantity)])
  );
  // SC-Aが先に消費される
  const aFill = plan1.explicitInstructions.find((i) => i.contractId === "SC-A")!;
  assert.equal(unwrapUnit(aFill.quantity), 20);
  const bFill = plan1.explicitInstructions.find((i) => i.contractId === "SC-B");
  assert.equal(bFill, undefined);
});

test("部分履行を認める。完成品不足では約定残を残す", () => {
  const contract = makeContract({ originalQuantity: hosoEqTons(100), outstandingQuantity: hosoEqTons(100) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(30) })]);
  const plan = planContractFulfillment([contract], lots);
  const fill = plan.explicitInstructions[0];
  assert.equal(unwrapUnit(fill.quantity), 30);
  const updated = applyFulfillments([contract], plan.explicitInstructions);
  assert.equal(updated[0].status, "partiallyFulfilled");
  assert.equal(unwrapUnit(updated[0].outstandingQuantity), 70);
});

test("契約数量を超えて履行しない", () => {
  const contract = makeContract({ originalQuantity: hosoEqTons(20), outstandingQuantity: hosoEqTons(20) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(100) })]);
  const plan = planContractFulfillment([contract], lots);
  const fill = plan.explicitInstructions[0];
  assert.equal(unwrapUnit(fill.quantity), 20);
});

test("Phase4の既存applyFulfillmentsをそのまま呼び出して契約状態を更新できる", () => {
  const contract = makeContract({ originalQuantity: hosoEqTons(40), outstandingQuantity: hosoEqTons(40) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(40) })]);
  const plan = planContractFulfillment([contract], lots);
  const updated = applyFulfillments([contract], plan.explicitInstructions);
  assert.equal(updated[0].status, "fulfilled");
  const final = updateContractStatusesForQuarterEnd(updated, P3);
  assert.equal(final[0].status, "fulfilled");
});

test("履行量と使用完成品ロットを追跡する（usage）", () => {
  const contract = makeContract({ originalQuantity: hosoEqTons(40), outstandingQuantity: hosoEqTons(40) });
  const lots = lotsFrom([makeBatch({ finishedGoodsQuantity: hosoEqTons(40) })]);
  const plan = planContractFulfillment([contract], lots);
  assert.equal(plan.usage.length, 1);
  assert.equal(plan.usage[0].contractId, contract.contractId);
  assert.equal(unwrapUnit(plan.usage[0].quantity), 40);
});

test("入力を変更しない（不変性）", () => {
  const contract = makeContract();
  const lots = lotsFrom([makeBatch()]);
  const before = JSON.stringify({ contract, lots });
  planContractFulfillment([contract], lots);
  assert.equal(JSON.stringify({ contract, lots }), before);
});
