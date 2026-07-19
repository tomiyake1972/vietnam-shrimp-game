import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFulfillments, cancelContract, updateContractStatusesForQuarterEnd } from "../backlog";
import { SalesContract, SalesValidationError } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

function contract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "SC-2015Q1-CN-hoso-A",
    companyId: "A",
    market: "CN",
    product: "hoso",
    contractedPeriod: period(2015, 1),
    dueDate: period(2015, 2),
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(100),
    unitPrice: usdPerHosoEqKg(4.5),
    status: "open",
    ...overrides,
  };
}

test("部分履行: 未履行数量が減り、状態がpartiallyFulfilledになる", () => {
  const [updated] = applyFulfillments([contract()], [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(30) }]);
  assert.equal(unwrapUnit(updated.outstandingQuantity), 70);
  assert.equal(updated.status, "partiallyFulfilled");
});

test("完全履行: 未履行数量が0になり、状態がfulfilledになる", () => {
  const [updated] = applyFulfillments([contract()], [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(100) }]);
  assert.equal(unwrapUnit(updated.outstandingQuantity), 0);
  assert.equal(updated.status, "fulfilled");
});

test("段階的な部分履行の合計が契約数量を超えない", () => {
  let contracts: readonly SalesContract[] = [contract()];
  contracts = applyFulfillments(contracts, [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(40) }]);
  contracts = applyFulfillments(contracts, [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(40) }]);
  assert.equal(unwrapUnit(contracts[0].outstandingQuantity), 20);
  assert.equal(contracts[0].status, "partiallyFulfilled");
});

test("過剰履行は拒否される（未履行数量を超える履行はSalesValidationError）", () => {
  assert.throws(
    () => applyFulfillments([contract()], [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(150) }]),
    SalesValidationError
  );
});

test("完了済み契約への追加履行はSalesValidationErrorを投げる", () => {
  const fulfilled = [contract({ outstandingQuantity: hosoEqTons(0), status: "fulfilled" })];
  assert.throws(
    () => applyFulfillments(fulfilled, [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(10) }]),
    SalesValidationError
  );
});

test("キャンセル済み契約への履行はSalesValidationErrorを投げる", () => {
  const cancelled = [contract({ status: "cancelled" })];
  assert.throws(
    () => applyFulfillments(cancelled, [{ kind: "explicit", contractId: "SC-2015Q1-CN-hoso-A", quantity: hosoEqTons(10) }]),
    SalesValidationError
  );
});

test("存在しない契約IDへの履行はSalesValidationErrorを投げる", () => {
  assert.throws(
    () => applyFulfillments([contract()], [{ kind: "explicit", contractId: "NOPE", quantity: hosoEqTons(10) }]),
    SalesValidationError
  );
});

test("cancelContract: 未履行契約をキャンセルできる", () => {
  const [updated] = cancelContract([contract()], "SC-2015Q1-CN-hoso-A");
  assert.equal(updated.status, "cancelled");
});

test("cancelContract: 完了済み契約はキャンセルできない", () => {
  const fulfilled = [contract({ outstandingQuantity: hosoEqTons(0), status: "fulfilled" })];
  assert.throws(() => cancelContract(fulfilled, "SC-2015Q1-CN-hoso-A"), SalesValidationError);
});

test("FIFO履行: 古い契約（成約四半期が早い順）から消費される", () => {
  const older = contract({ contractId: "SC-2015Q1-CN-hoso-A", contractedPeriod: period(2015, 1), dueDate: period(2015, 2), originalQuantity: hosoEqTons(50), outstandingQuantity: hosoEqTons(50) });
  const newer = contract({ contractId: "SC-2015Q2-CN-hoso-A", contractedPeriod: period(2015, 2), dueDate: period(2015, 3), originalQuantity: hosoEqTons(50), outstandingQuantity: hosoEqTons(50) });

  const updated = applyFulfillments([newer, older], [{ kind: "fifo", companyId: "A", market: "CN", product: "hoso", quantity: hosoEqTons(30) }]);

  const updatedOlder = updated.find((c) => c.contractId === "SC-2015Q1-CN-hoso-A")!;
  const updatedNewer = updated.find((c) => c.contractId === "SC-2015Q2-CN-hoso-A")!;
  assert.equal(unwrapUnit(updatedOlder.outstandingQuantity), 20, "older contract should be consumed first");
  assert.equal(unwrapUnit(updatedNewer.outstandingQuantity), 50, "newer contract untouched while older still has room");
});

test("FIFO履行: 1件で足りなければ次に古い契約へ繰り越して消費する", () => {
  const older = contract({ contractId: "SC-2015Q1-CN-hoso-A", contractedPeriod: period(2015, 1), dueDate: period(2015, 2), originalQuantity: hosoEqTons(20), outstandingQuantity: hosoEqTons(20) });
  const newer = contract({ contractId: "SC-2015Q2-CN-hoso-A", contractedPeriod: period(2015, 2), dueDate: period(2015, 3), originalQuantity: hosoEqTons(50), outstandingQuantity: hosoEqTons(50) });

  const updated = applyFulfillments([older, newer], [{ kind: "fifo", companyId: "A", market: "CN", product: "hoso", quantity: hosoEqTons(35) }]);

  const updatedOlder = updated.find((c) => c.contractId === "SC-2015Q1-CN-hoso-A")!;
  const updatedNewer = updated.find((c) => c.contractId === "SC-2015Q2-CN-hoso-A")!;
  assert.equal(unwrapUnit(updatedOlder.outstandingQuantity), 0);
  assert.equal(updatedOlder.status, "fulfilled");
  assert.equal(unwrapUnit(updatedNewer.outstandingQuantity), 35);
  assert.equal(updatedNewer.status, "partiallyFulfilled");
});

test("FIFO履行: 対象契約の合計未履行数量を超える指示はSalesValidationErrorを投げる", () => {
  const c = contract({ outstandingQuantity: hosoEqTons(10) });
  assert.throws(
    () => applyFulfillments([c], [{ kind: "fifo", companyId: "A", market: "CN", product: "hoso", quantity: hosoEqTons(20) }]),
    SalesValidationError
  );
});

test("FIFO履行: 他の会社・市場・商品の契約には影響しない", () => {
  const targetContract = contract({ contractId: "SC-2015Q1-CN-hoso-A" });
  const otherCompany = contract({ contractId: "SC-2015Q1-CN-hoso-B", companyId: "B" });
  const otherMarket = contract({ contractId: "SC-2015Q1-US-hoso-A", market: "US" });

  const updated = applyFulfillments(
    [targetContract, otherCompany, otherMarket],
    [{ kind: "fifo", companyId: "A", market: "CN", product: "hoso", quantity: hosoEqTons(10) }]
  );

  assert.equal(unwrapUnit(updated.find((c) => c.contractId === "SC-2015Q1-CN-hoso-B")!.outstandingQuantity), 100);
  assert.equal(unwrapUnit(updated.find((c) => c.contractId === "SC-2015Q1-US-hoso-A")!.outstandingQuantity), 100);
});

test("四半期末更新: 納期を過ぎ未履行数量が残る契約はoverdueになる", () => {
  const c = contract({ dueDate: period(2015, 2), outstandingQuantity: hosoEqTons(50) });
  const updated = updateContractStatusesForQuarterEnd([c], period(2015, 3));
  assert.equal(updated[0].status, "overdue");
});

test("四半期末更新: 納期前の契約はoverdueにならない", () => {
  const c = contract({ dueDate: period(2015, 4), outstandingQuantity: hosoEqTons(50) });
  const updated = updateContractStatusesForQuarterEnd([c], period(2015, 2));
  assert.equal(updated[0].status, "open");
});

test("四半期末更新: 完了済み・キャンセル済み契約はoverdueにならない", () => {
  const fulfilled = contract({ status: "fulfilled", outstandingQuantity: hosoEqTons(0), dueDate: period(2015, 1) });
  const cancelled = contract({ contractId: "SC-2015Q1-CN-hoso-B", status: "cancelled", dueDate: period(2015, 1) });
  const updated = updateContractStatusesForQuarterEnd([fulfilled, cancelled], period(2099, 4));
  assert.equal(updated[0].status, "fulfilled");
  assert.equal(updated[1].status, "cancelled");
});

test("四半期末更新: 納期を過ぎても未履行数量が0なら（fulfilled扱い済みのはずだが念のため）overdueにしない", () => {
  const c = contract({ dueDate: period(2015, 1), outstandingQuantity: hosoEqTons(0), status: "fulfilled" });
  const updated = updateContractStatusesForQuarterEnd([c], period(2099, 4));
  assert.equal(updated[0].status, "fulfilled");
});
