import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateMarketProduct } from "../allocation";
import { buildContractId, createContractsFromAllocation } from "../contracts";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);

function entry(companyId: string, overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId,
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 5,
    ...overrides,
  };
}

test("buildContractIdは決定論的（同じ入力は常に同じID）", () => {
  const id1 = buildContractId(P1, "CN", "hoso", "A");
  const id2 = buildContractId(P1, "CN", "hoso", "A");
  assert.equal(id1, id2);
});

test("会社・市場・商品区分のいずれかが異なればcontractIdも異なる（重複しない）", () => {
  const ids = new Set([
    buildContractId(P1, "CN", "hoso", "A"),
    buildContractId(P1, "US", "hoso", "A"),
    buildContractId(P1, "CN", "pd", "A"),
    buildContractId(P1, "CN", "hoso", "B"),
  ]);
  assert.equal(ids.size, 4);
});

test("成約量0の会社には契約が作られない", () => {
  const entries = [entry("A", { desiredQuantity: hosoEqTons(0) })];
  const allocation = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([allocation], entries, SALES_PARAMETERS_V1);
  assert.equal(contracts.length, 0);
});

test("標準納期は成約の翌四半期になる", () => {
  const entries = [entry("A")];
  const allocation = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([allocation], entries, SALES_PARAMETERS_V1);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].contractedPeriod, "2015Q1");
  assert.equal(contracts[0].dueDate, "2015Q2");
});

test("希望リードタイムを指定すると納期に反映される（2ターン先）", () => {
  const entries = [entry("A", { desiredLeadTimeTurns: 2 })];
  const allocation = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([allocation], entries, SALES_PARAMETERS_V1);
  assert.equal(contracts[0].dueDate, "2015Q3");
});

test("契約は成約時点で未履行(open)状態、当初数量=未履行数量、成約単価=提示価格", () => {
  const entries = [entry("A", { priceAdjustmentUsdPerHosoEqKg: 0.1 })];
  const allocation = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([allocation], entries, SALES_PARAMETERS_V1);
  const c = contracts[0];
  assert.equal(c.status, "open");
  assert.equal(unwrapUnit(c.originalQuantity), unwrapUnit(c.outstandingQuantity));
  const companyEntry = allocation.companies.find((x) => x.companyId === "A")!;
  assert.equal(unwrapUnit(c.unitPrice), unwrapUnit(companyEntry.askPrice));
  assert.equal(unwrapUnit(c.originalQuantity), unwrapUnit(companyEntry.allocatedQuantity));
});

test("契約には売上・利益等の金額フィールドが一切含まれない（成約時点で計上しない）", () => {
  const entries = [entry("A")];
  const allocation = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([allocation], entries, SALES_PARAMETERS_V1);
  const keys = Object.keys(contracts[0]);
  for (const forbidden of ["revenue", "profit", "cogs", "accountsReceivable", "salesAmount"]) {
    assert.ok(!keys.includes(forbidden), `contract should not contain "${forbidden}"`);
  }
});

test("複数market×productにまたがる配分から、それぞれ独立した契約が生成される", () => {
  const cnEntries = [entry("A", { market: "CN", product: "hoso" })];
  const usEntries = [entry("A", { market: "US", product: "pd" })];
  const cnAlloc = allocateMarketProduct("CN", "hoso", P1, cnEntries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const usAlloc = allocateMarketProduct("US", "pd", P1, usEntries, BASE_PRICE, hosoEqTons(1000), SALES_PARAMETERS_V1);
  const contracts = createContractsFromAllocation([cnAlloc, usAlloc], [...cnEntries, ...usEntries], SALES_PARAMETERS_V1);
  assert.equal(contracts.length, 2);
  assert.notEqual(contracts[0].contractId, contracts[1].contractId);
});
