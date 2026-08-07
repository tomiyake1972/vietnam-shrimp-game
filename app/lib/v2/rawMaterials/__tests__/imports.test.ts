import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateLandedPrice, createImportLots, receiveArrivedImports } from "../imports";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../parameters";
import { ImportOrderInput, RawMaterialsValidationError } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { CountryId } from "../../market/types";

const P1 = period(2015, 1);
const P2 = period(2015, 2);
const P3 = period(2015, 3);

const ORIGIN_PRICE: Readonly<Record<CountryId, ReturnType<typeof usdPerHosoEqKg>>> = {
  EC: usdPerHosoEqKg(4.0),
  IN: usdPerHosoEqKg(3.5),
  ID: usdPerHosoEqKg(3.8),
  VN: usdPerHosoEqKg(4.2),
};

const ORIGIN_SUPPLY: Readonly<Record<CountryId, ReturnType<typeof hosoEqTons>>> = {
  EC: hosoEqTons(10000),
  IN: hosoEqTons(8000),
  ID: hosoEqTons(6000),
  VN: hosoEqTons(0),
};

function order(companyId: string, overrides: Partial<ImportOrderInput> = {}): ImportOrderInput {
  return {
    companyId,
    originCountry: "EC",
    orderedQuantity: hosoEqTons(100),
    orderedPeriod: P1,
    ...overrides,
  };
}

test("calculateLandedPriceは起点価格に運賃・関税・保険・原産国別調整額を加算する", () => {
  const breakdown = calculateLandedPrice(usdPerHosoEqKg(4.0), "EC", RAW_MATERIALS_PARAMETERS_V1);
  const p = RAW_MATERIALS_PARAMETERS_V1.imports;
  const expected = 4.0 + 4.0 * p.dutyRatio + p.freightUsdPerHosoEqKg + p.insuranceHandlingUsdPerHosoEqKg + (p.originCountryAdjustmentUsdPerHosoEqKg.EC ?? 0);
  assert.ok(Math.abs(unwrapUnit(breakdown.landedPrice) - expected) < 1e-9);
});

test("輸入注文は発注時点では在庫にならず、status=inTransitImportで生成される", () => {
  const orders = [order("A")];
  const lots = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].status, "inTransitImport");
});

test("標準リードタイム経過後の四半期にreceiveArrivedImportsでstatus=availableへ遷移する", () => {
  const orders = [order("A", { orderedPeriod: P1 })];
  const lots = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  const leadTime = RAW_MATERIALS_PARAMETERS_V1.imports.standardLeadTimeTurns;
  assert.equal(leadTime, 2);
  assert.equal(lots[0].availableFromPeriod, P3);

  const stillInTransit = receiveArrivedImports(lots, P2);
  assert.equal(stillInTransit[0].status, "inTransitImport");

  const arrived = receiveArrivedImports(lots, P3);
  assert.equal(arrived[0].status, "available");
});

test("カスタムリードタイムを指定すると到着四半期に反映される", () => {
  const orders = [order("A", { orderedPeriod: P1, leadTimeTurns: 1 })];
  const lots = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(lots[0].availableFromPeriod, P2);
});

test("最大許容着地価格を下回らない注文はRawMaterialsValidationErrorを投げる", () => {
  const breakdown = calculateLandedPrice(ORIGIN_PRICE.EC, "EC", RAW_MATERIALS_PARAMETERS_V1);
  const tooStrict = [order("A", { maxLandedPriceUsdPerHosoEqKg: usdPerHosoEqKg(unwrapUnit(breakdown.landedPrice) - 0.5) })];
  assert.throws(() => createImportLots(tooStrict, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1), RawMaterialsValidationError);
});

test("原産国別供給上限を超える注文合計は決定論的に配分される（合計が上限を超えない）", () => {
  const cap = unwrapUnit(ORIGIN_SUPPLY.EC) * RAW_MATERIALS_PARAMETERS_V1.imports.importAvailableSupplyRatio;
  const orders = ["A", "B", "C"].map((id) => order(id, { orderedQuantity: hosoEqTons(cap) })); // 3社×cap分の注文で合計が上限の3倍
  const lots = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  const total = lots.reduce((s, l) => s + unwrapUnit(l.originalQuantity), 0);
  assert.ok(total <= cap + 0.1, `total (${total}) should not exceed cap (${cap})`);
  // 各社ほぼ均等に按分される（重み=希望量が全員同じため）。
  const perCompany = lots.map((l) => unwrapUnit(l.originalQuantity));
  for (const q of perCompany) {
    assert.ok(Math.abs(q - cap / 3) < 0.1);
  }
});

test("入力順を変えても原産国別配分の合計は変わらない", () => {
  const orders = ["A", "B", "C", "D"].map((id, i) => order(id, { orderedQuantity: hosoEqTons(500 + i * 100) }));
  const shuffled = [orders[2], orders[0], orders[3], orders[1]];

  const lotsA = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  const lotsB = createImportLots(shuffled, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);

  const totalA = lotsA.reduce((s, l) => s + unwrapUnit(l.originalQuantity), 0);
  const totalB = lotsB.reduce((s, l) => s + unwrapUnit(l.originalQuantity), 0);
  assert.ok(Math.abs(totalA - totalB) < 1e-6);

  const byCompanyA = new Map(lotsA.map((l) => [l.companyId, unwrapUnit(l.originalQuantity)]));
  const byCompanyB = new Map(lotsB.map((l) => [l.companyId, unwrapUnit(l.originalQuantity)]));
  for (const id of ["A", "B", "C", "D"]) {
    assert.ok(Math.abs((byCompanyA.get(id) ?? 0) - (byCompanyB.get(id) ?? 0)) < 1e-6);
  }
});

test("5社の輸入量では国際基準価格（原産国のHOSO FOB価格）を変更しない", () => {
  const before = JSON.stringify(ORIGIN_PRICE);
  createImportLots([order("A")], ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  assert.equal(JSON.stringify(ORIGIN_PRICE), before);
});

test("輸入注文の数量が0以下だとRawMaterialsValidationErrorを投げる", () => {
  assert.throws(
    () => createImportLots([{ ...order("A"), orderedQuantity: hosoEqTons(0) }], ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1),
    RawMaterialsValidationError
  );
});

test("複数の原産国から同時に輸入しても、原産国ごとに独立して上限が適用される", () => {
  const orders = [order("A", { originCountry: "EC", orderedQuantity: hosoEqTons(20000) }), order("B", { originCountry: "IN", orderedQuantity: hosoEqTons(20000) })];
  const lots = createImportLots(orders, ORIGIN_PRICE, ORIGIN_SUPPLY, RAW_MATERIALS_PARAMETERS_V1);
  const ecCap = unwrapUnit(ORIGIN_SUPPLY.EC) * RAW_MATERIALS_PARAMETERS_V1.imports.importAvailableSupplyRatio;
  const inCap = unwrapUnit(ORIGIN_SUPPLY.IN) * RAW_MATERIALS_PARAMETERS_V1.imports.importAvailableSupplyRatio;
  const ecLot = lots.find((l) => l.originCountry === "EC")!;
  const inLot = lots.find((l) => l.originCountry === "IN")!;
  assert.ok(Math.abs(unwrapUnit(ecLot.originalQuantity) - ecCap) < 0.1);
  assert.ok(Math.abs(unwrapUnit(inLot.originalQuantity) - inCap) < 0.1);
});
