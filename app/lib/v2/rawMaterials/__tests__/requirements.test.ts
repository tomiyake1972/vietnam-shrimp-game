import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRawMaterialRequirements } from "../requirements";
import { SalesContract } from "../../sales/types";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const P2 = period(2015, 2);

function contract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: `SC-${Math.random()}`,
    companyId: "A",
    market: "CN",
    product: "hoso",
    contractedPeriod: P1,
    dueDate: P2,
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(100),
    unitPrice: usdPerHosoEqKg(4.5),
    status: "open",
    ...overrides,
  };
}

test("会社×納期×商品区分ごとにoutstandingQuantityを合計する", () => {
  const contracts = [
    contract({ contractId: "1", companyId: "A", dueDate: P2, product: "hoso", outstandingQuantity: hosoEqTons(100) }),
    contract({ contractId: "2", companyId: "A", dueDate: P2, product: "hoso", outstandingQuantity: hosoEqTons(50) }),
    contract({ contractId: "3", companyId: "A", dueDate: P2, product: "pd", outstandingQuantity: hosoEqTons(30) }),
    contract({ contractId: "4", companyId: "B", dueDate: P2, product: "hoso", outstandingQuantity: hosoEqTons(20) }),
  ];
  const result = summarizeRawMaterialRequirements(contracts);

  assert.equal(result.length, 3);
  const aHoso = result.find((r) => r.companyId === "A" && r.product === "hoso")!;
  assert.equal(unwrapUnit(aHoso.requiredQuantity), 150);
  const aPd = result.find((r) => r.companyId === "A" && r.product === "pd")!;
  assert.equal(unwrapUnit(aPd.requiredQuantity), 30);
  const bHoso = result.find((r) => r.companyId === "B" && r.product === "hoso")!;
  assert.equal(unwrapUnit(bHoso.requiredQuantity), 20);
});

test("fulfilled・cancelledの契約は集計対象外", () => {
  const contracts = [
    contract({ contractId: "1", status: "fulfilled", outstandingQuantity: hosoEqTons(0) }),
    contract({ contractId: "2", status: "cancelled", outstandingQuantity: hosoEqTons(100) }),
  ];
  const result = summarizeRawMaterialRequirements(contracts);
  assert.equal(result.length, 0);
});

test("overdue・partiallyFulfilledの契約は集計対象", () => {
  const contracts = [
    contract({ contractId: "1", status: "overdue", outstandingQuantity: hosoEqTons(40) }),
    contract({ contractId: "2", status: "partiallyFulfilled", outstandingQuantity: hosoEqTons(10) }),
  ];
  const result = summarizeRawMaterialRequirements(contracts);
  assert.equal(result.length, 1);
  assert.equal(unwrapUnit(result[0].requiredQuantity), 50);
});

test("必要量集計は自動発注しない（純粋な集計情報のみを返す＝副作用が一切ない）", () => {
  const contracts = [contract({ contractId: "1" })];
  const before = JSON.stringify(contracts);
  summarizeRawMaterialRequirements(contracts);
  assert.equal(JSON.stringify(contracts), before);
});

test("結果は会社→納期→商品区分の順で決定論的にソートされる", () => {
  const contracts = [
    contract({ contractId: "1", companyId: "B", dueDate: P2, product: "vap" }),
    contract({ contractId: "2", companyId: "A", dueDate: P1, product: "pd" }),
    contract({ contractId: "3", companyId: "A", dueDate: P2, product: "hoso" }),
  ];
  const result = summarizeRawMaterialRequirements(contracts);
  assert.deepEqual(
    result.map((r) => `${r.companyId}-${r.dueDate}-${r.product}`),
    ["A-2015Q1-pd", "A-2015Q2-hoso", "B-2015Q2-vap"]
  );
});
