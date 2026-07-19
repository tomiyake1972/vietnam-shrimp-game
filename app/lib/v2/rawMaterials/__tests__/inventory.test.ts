import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeRawMaterialInventory, createDomesticPurchaseLots, consumeRawMaterials, applyExpiryForQuarterEnd } from "../inventory";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../parameters";
import { DomesticPurchaseAllocationResult, RawMaterialLot, RawMaterialsValidationError } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const P3 = period(2015, 3);

function lot(overrides: Partial<RawMaterialLot> = {}): RawMaterialLot {
  return {
    lotId: `L-${Math.random()}`,
    companyId: "A",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: P1,
    originalQuantity: hosoEqTons(100),
    remainingQuantity: hosoEqTons(100),
    unitCost: usdPerHosoEqKg(3.0),
    availableFromPeriod: P1,
    status: "available",
    ...overrides,
  };
}

test("initializeRawMaterialInventoryは空のロット一覧を返す", () => {
  const inv = initializeRawMaterialInventory(P1);
  assert.equal(inv.lots.length, 0);
  assert.equal(inv.currentPeriod, P1);
});

test("createDomesticPurchaseLotsは配分量>0の会社ごとに1ロットずつ作る", () => {
  const allocation: DomesticPurchaseAllocationResult = {
    period: P1,
    marketPrice: usdPerHosoEqKg(3.0),
    availableSupply: hosoEqTons(1000),
    companies: [
      { companyId: "A", bidPrice: usdPerHosoEqKg(3.1), coverageScore: 0.5, competitivenessWeight: 0.5, allocatedQuantity: hosoEqTons(100) },
      { companyId: "B", bidPrice: usdPerHosoEqKg(2.9), coverageScore: 0.5, competitivenessWeight: 0.3, allocatedQuantity: hosoEqTons(0) },
    ],
    unallocatedSupply: hosoEqTons(900),
  };
  const lots = createDomesticPurchaseLots(allocation, RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].companyId, "A");
  assert.equal(lots[0].status, "available");
  assert.equal(lots[0].source, "domestic");
});

test("FIFO消費: availableFromPeriodが古いロットから消費される", () => {
  const lots = [
    lot({ lotId: "OLD", availableFromPeriod: P1, inboundPeriod: P1, remainingQuantity: hosoEqTons(30) }),
    lot({ lotId: "NEW", availableFromPeriod: P2, inboundPeriod: P2, remainingQuantity: hosoEqTons(30) }),
  ];
  const updated = consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(40) }]);
  const oldLot = updated.find((l) => l.lotId === "OLD")!;
  const newLot = updated.find((l) => l.lotId === "NEW")!;
  assert.equal(unwrapUnit(oldLot.remainingQuantity), 0);
  assert.equal(oldLot.status, "consumed");
  assert.equal(unwrapUnit(newLot.remainingQuantity), 20);
  assert.equal(newLot.status, "available");
});

test("部分消費・完全消費の両方が正しく反映される", () => {
  const lots = [lot({ lotId: "L1", remainingQuantity: hosoEqTons(50) })];
  const partial = consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(20) }]);
  assert.equal(unwrapUnit(partial[0].remainingQuantity), 30);
  assert.equal(partial[0].status, "available");

  const full = consumeRawMaterials(partial, [{ companyId: "A", quantity: hosoEqTons(30) }]);
  assert.equal(unwrapUnit(full[0].remainingQuantity), 0);
  assert.equal(full[0].status, "consumed");
});

test("過剰消費は拒否される", () => {
  const lots = [lot({ remainingQuantity: hosoEqTons(10) })];
  assert.throws(() => consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(11) }]), RawMaterialsValidationError);
});

test("他社のロットは消費対象にならない", () => {
  const lots = [lot({ lotId: "A1", companyId: "A", remainingQuantity: hosoEqTons(10) }), lot({ lotId: "B1", companyId: "B", remainingQuantity: hosoEqTons(10) })];
  assert.throws(() => consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(15) }]), RawMaterialsValidationError);
});

test("inTransitImport・growingAquaculture状態のロットは消費対象にならない", () => {
  const lots = [
    lot({ lotId: "T1", status: "inTransitImport", source: "import", remainingQuantity: hosoEqTons(100) }),
    lot({ lotId: "G1", status: "growingAquaculture", source: "aquaculture", remainingQuantity: hosoEqTons(100) }),
  ];
  assert.throws(() => consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(10) }]), RawMaterialsValidationError);
});

test("入庫・消費・廃棄を通じて数量が保存される（originalQuantityは不変）", () => {
  const lots = [lot({ lotId: "L1", originalQuantity: hosoEqTons(100), remainingQuantity: hosoEqTons(100) })];
  const consumed = consumeRawMaterials(lots, [{ companyId: "A", quantity: hosoEqTons(40) }]);
  assert.equal(unwrapUnit(consumed[0].originalQuantity), 100);
  assert.equal(unwrapUnit(consumed[0].remainingQuantity), 60);
});

test("期限切れ処理: expiryPeriodを過ぎたavailableロットはexpiredへ遷移し、remainingQuantityは保持される", () => {
  const lots = [lot({ lotId: "L1", expiryPeriod: P2, remainingQuantity: hosoEqTons(40) })];
  const notYet = applyExpiryForQuarterEnd(lots, P2);
  assert.equal(notYet[0].status, "available");

  const expired = applyExpiryForQuarterEnd(lots, P3);
  assert.equal(expired[0].status, "expired");
  assert.equal(unwrapUnit(expired[0].remainingQuantity), 40);
});

test("expiryPeriod未設定のロットは期限切れ処理の対象外", () => {
  const lots = [lot({ lotId: "L1", expiryPeriod: undefined })];
  const result = applyExpiryForQuarterEnd(lots, P3);
  assert.equal(result[0].status, "available");
});

test("高値で確保した会社の取得原価（bidPrice）がそのままロットのunitCostへ保持される", () => {
  const allocation: DomesticPurchaseAllocationResult = {
    period: P1,
    marketPrice: usdPerHosoEqKg(3.0),
    availableSupply: hosoEqTons(1000),
    companies: [{ companyId: "A", bidPrice: usdPerHosoEqKg(3.9), coverageScore: 0.5, competitivenessWeight: 0.9, allocatedQuantity: hosoEqTons(80) }],
    unallocatedSupply: hosoEqTons(920),
  };
  const lots = createDomesticPurchaseLots(allocation, RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(unwrapUnit(lots[0].unitCost), 3.9);
  assert.ok(unwrapUnit(lots[0].unitCost) > unwrapUnit(allocation.marketPrice), "高値提示分がunitCostに反映されているはず");
});

test("国内・輸入・養殖の各ロットIDは重複しない", () => {
  const allocation: DomesticPurchaseAllocationResult = {
    period: P1,
    marketPrice: usdPerHosoEqKg(3.0),
    availableSupply: hosoEqTons(1000),
    companies: [{ companyId: "A", bidPrice: usdPerHosoEqKg(3.1), coverageScore: 0.5, competitivenessWeight: 0.5, allocatedQuantity: hosoEqTons(100) }],
    unallocatedSupply: hosoEqTons(900),
  };
  const domesticLots = createDomesticPurchaseLots(allocation, RAW_MATERIALS_PARAMETERS_V1);
  const otherLots = [lot({ lotId: "RM-import-2015Q1-EC-A-1", source: "import" }), lot({ lotId: "RM-aquaculture-2015Q1-VN-A-1", source: "aquaculture" })];
  const ids = new Set([...domesticLots.map((l) => l.lotId), ...otherLots.map((l) => l.lotId)]);
  assert.equal(ids.size, domesticLots.length + otherLots.length);
});
