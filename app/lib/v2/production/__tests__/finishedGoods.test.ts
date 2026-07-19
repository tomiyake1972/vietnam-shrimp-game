import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, ratio, unwrapUnit, usdM, usdPerHosoEqKg } from "../../core/units";
import { nextPeriod, period } from "../../core/period";
import { applyFinishedGoodsExpiryForQuarterEnd, consumeFinishedGoods, createFinishedGoodsLots } from "../finishedGoods";
import { ProductionValidationError } from "../types";
import { ProductionBatch } from "../types";

const P1 = period(2020, 1);
const P2 = nextPeriod(P1);

function makeBatch(overrides: Partial<ProductionBatch> = {}): ProductionBatch {
  return {
    batchId: "PB-1",
    companyId: "C1",
    factoryId: "F1",
    product: "hoso",
    period: P1,
    rawMaterialConsumed: [{ lotId: "RM-1", quantity: hosoEqTons(100), unitCost: usdPerHosoEqKg(5), originCountry: "VN" }],
    rawMaterialConsumedTotal: hosoEqTons(100),
    finishedGoodsQuantity: hosoEqTons(90),
    processingLoss: hosoEqTons(10),
    rawMaterialCost: usdM(0.5),
    baseProcessingCost: usdM(0.03),
    capacityUtilizationIndex: ratio(1),
    shortfallQuantity: hosoEqTons(0),
    shortfallReasons: [],
    ...overrides,
  };
}

test("生産バッチから完成品ロットを生成する（数量0のバッチは対象外）", () => {
  const zero = makeBatch({ batchId: "PB-2", finishedGoodsQuantity: hosoEqTons(0) });
  const lots = createFinishedGoodsLots([makeBatch(), zero]);
  assert.equal(lots.length, 1);
  assert.equal(unwrapUnit(lots[0].originalQuantity), 90);
  assert.equal(unwrapUnit(lots[0].remainingQuantity), 90);
  assert.equal(lots[0].status, "available");
});

test("FIFOで消費し、remainingQuantityが0になるとstatus=allocatedになる", () => {
  const lots = createFinishedGoodsLots([makeBatch()]);
  const updated = consumeFinishedGoods(lots, [{ companyId: "C1", product: "hoso", quantity: hosoEqTons(90) }]);
  assert.equal(updated[0].status, "allocated");
  assert.equal(unwrapUnit(updated[0].remainingQuantity), 0);
});

test("完成品を二重充当しない（過剰消費は拒否）", () => {
  const lots = createFinishedGoodsLots([makeBatch()]);
  assert.throws(() => consumeFinishedGoods(lots, [{ companyId: "C1", product: "hoso", quantity: hosoEqTons(1000) }]), ProductionValidationError);
});

test("会社・商品が一致しない消費指示は対象ロットが無いため拒否される", () => {
  const lots = createFinishedGoodsLots([makeBatch()]);
  assert.throws(() => consumeFinishedGoods(lots, [{ companyId: "C2", product: "hoso", quantity: hosoEqTons(1) }]), ProductionValidationError);
});

test("古いロットから先に消費される（FIFO）", () => {
  const oldBatch = makeBatch({ batchId: "PB-OLD", period: P1, finishedGoodsQuantity: hosoEqTons(20) });
  const newBatch = makeBatch({ batchId: "PB-NEW", period: P2, finishedGoodsQuantity: hosoEqTons(20) });
  const lots = [...createFinishedGoodsLots([oldBatch]), ...createFinishedGoodsLots([newBatch])];
  const updated = consumeFinishedGoods(lots, [{ companyId: "C1", product: "hoso", quantity: hosoEqTons(15) }]);
  const old = updated.find((l) => l.producedPeriod === P1)!;
  const fresh = updated.find((l) => l.producedPeriod === P2)!;
  assert.equal(unwrapUnit(old.remainingQuantity), 5);
  assert.equal(unwrapUnit(fresh.remainingQuantity), 20);
});

test("期限切れ処理: expiryPeriodを過ぎたavailableロットはexpiredになり、数量は保存される", () => {
  const lots = createFinishedGoodsLots([makeBatch()]).map((l) => ({ ...l, expiryPeriod: P1 }));
  const updated = applyFinishedGoodsExpiryForQuarterEnd(lots, P2);
  assert.equal(updated[0].status, "expired");
  assert.equal(unwrapUnit(updated[0].remainingQuantity), unwrapUnit(lots[0].remainingQuantity));
});

test("入力を変更しない（不変性）", () => {
  const lots = createFinishedGoodsLots([makeBatch()]);
  const before = JSON.stringify(lots);
  consumeFinishedGoods(lots, [{ companyId: "C1", product: "hoso", quantity: hosoEqTons(10) }]);
  applyFinishedGoodsExpiryForQuarterEnd(lots, P2);
  assert.equal(JSON.stringify(lots), before);
});
