// ShrimpX V2 — Phase 7A 品質モジュール deliveryObservation.ts テスト
//
// 対応する受入条件:
//   16. 納期対象がない市場では納期信頼性を変えない（本ファイルでは観測がdueQuantity=0を
//       正しく返すことを確認し、「変えない」判断自体はstateUpdate.test.tsで確認する）
//   17. 期限内・遅延・未履行を正しく区別する
//   18. 同じ未履行数量を無制限に重複罰しない（過年度からの持ち越し分の分離集計）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { SalesContract } from "../../sales/types";
import { computeMarketDeliveryObservations } from "../deliveryObservation";

const PERIOD_CURRENT = "2015Q2" as PeriodV2;
const PERIOD_PAST = "2015Q1" as PeriodV2;

function makeContract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "CT-1",
    companyId: "C1",
    market: "CN",
    product: "hoso",
    contractedPeriod: "2015Q1" as PeriodV2,
    dueDate: PERIOD_CURRENT,
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(0),
    unitPrice: usdPerHosoEqKg(3),
    status: "fulfilled",
    ...overrides,
  };
}

test("16: 対象契約がない会社×市場はdueQuantity=0の観測を返す", () => {
  const observations = computeMarketDeliveryObservations([{ companyId: "C1", market: "CN" }], [], PERIOD_CURRENT);
  assert.equal(observations.length, 1);
  assert.equal(unwrapUnit(observations[0].dueQuantity), 0);
  assert.equal(unwrapUnit(observations[0].onTimeQuantity), 0);
});

test("17a: dueDate=当期・status=fulfilledは期限内(onTimeQuantity)として計上する", () => {
  const contract = makeContract({ dueDate: PERIOD_CURRENT, status: "fulfilled", originalQuantity: hosoEqTons(120) });
  const [obs] = computeMarketDeliveryObservations([{ companyId: "C1", market: "CN" }], [contract], PERIOD_CURRENT);
  assert.equal(unwrapUnit(obs.dueQuantity), 120);
  assert.equal(unwrapUnit(obs.onTimeQuantity), 120);
  assert.equal(unwrapUnit(obs.newlyOverdueQuantity), 0);
});

test("17b: dueDate=当期・status=overdueは未履行(newlyOverdueQuantity)として計上する", () => {
  const contract = makeContract({ dueDate: PERIOD_CURRENT, status: "overdue", originalQuantity: hosoEqTons(80), outstandingQuantity: hosoEqTons(80) });
  const [obs] = computeMarketDeliveryObservations([{ companyId: "C1", market: "CN" }], [contract], PERIOD_CURRENT);
  assert.equal(unwrapUnit(obs.dueQuantity), 80);
  assert.equal(unwrapUnit(obs.onTimeQuantity), 0);
  assert.equal(unwrapUnit(obs.newlyOverdueQuantity), 80);
});

test("18a: dueDate<当期・status=overdue(過年度からの持ち越し)はcontinuingOverdueQuantityへ分離集計し、dueQuantityには含めない", () => {
  const carriedOver = makeContract({ dueDate: PERIOD_PAST, status: "overdue", originalQuantity: hosoEqTons(50), outstandingQuantity: hosoEqTons(50) });
  const [obs] = computeMarketDeliveryObservations([{ companyId: "C1", market: "CN" }], [carriedOver], PERIOD_CURRENT);
  assert.equal(unwrapUnit(obs.dueQuantity), 0, "過年度からの持ち越し分は当期のdueQuantity(評価対象コホート)に含めない");
  assert.equal(unwrapUnit(obs.continuingOverdueQuantity), 50);
});

test("17c+18b: 当期分と過年度持ち越し分が混在していても正しく分離される", () => {
  const contracts: SalesContract[] = [
    makeContract({ contractId: "CT-A", dueDate: PERIOD_CURRENT, status: "fulfilled", originalQuantity: hosoEqTons(100) }),
    makeContract({ contractId: "CT-B", dueDate: PERIOD_CURRENT, status: "overdue", originalQuantity: hosoEqTons(30), outstandingQuantity: hosoEqTons(30) }),
    makeContract({ contractId: "CT-C", dueDate: PERIOD_PAST, status: "overdue", originalQuantity: hosoEqTons(20), outstandingQuantity: hosoEqTons(20) }),
  ];
  const [obs] = computeMarketDeliveryObservations([{ companyId: "C1", market: "CN" }], contracts, PERIOD_CURRENT);
  assert.equal(unwrapUnit(obs.dueQuantity), 130, "当期分のみ(100+30)");
  assert.equal(unwrapUnit(obs.onTimeQuantity), 100);
  assert.equal(unwrapUnit(obs.newlyOverdueQuantity), 30);
  assert.equal(unwrapUnit(obs.continuingOverdueQuantity), 20, "過年度持ち越し分は別集計");
});

test("会社×市場ごとに独立して集計される（他社・他市場の契約は混入しない）", () => {
  const contracts: SalesContract[] = [
    makeContract({ contractId: "CT-1", companyId: "C1", market: "CN", dueDate: PERIOD_CURRENT, status: "fulfilled", originalQuantity: hosoEqTons(100) }),
    makeContract({ contractId: "CT-2", companyId: "C2", market: "CN", dueDate: PERIOD_CURRENT, status: "overdue", originalQuantity: hosoEqTons(200), outstandingQuantity: hosoEqTons(200) }),
    makeContract({ contractId: "CT-3", companyId: "C1", market: "US", dueDate: PERIOD_CURRENT, status: "fulfilled", originalQuantity: hosoEqTons(50) }),
  ];
  const observations = computeMarketDeliveryObservations(
    [
      { companyId: "C1", market: "CN" },
      { companyId: "C2", market: "CN" },
      { companyId: "C1", market: "US" },
    ],
    contracts,
    PERIOD_CURRENT
  );
  const byKey = new Map(observations.map((o) => [`${o.companyId}::${o.market}`, o]));
  assert.equal(unwrapUnit(byKey.get("C1::CN")!.dueQuantity), 100);
  assert.equal(unwrapUnit(byKey.get("C2::CN")!.newlyOverdueQuantity), 200);
  assert.equal(unwrapUnit(byKey.get("C1::US")!.onTimeQuantity), 50);
});
