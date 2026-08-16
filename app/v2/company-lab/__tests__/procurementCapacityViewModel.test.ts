// ShrimpX V2 — Procurement Planning: procurementCapacityViewModel のテスト（PROC-CAP-1〜9）

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { procurementCapacity, procurementCoverageScore } from "../../../lib/v2/rawMaterials/domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../../lib/v2/rawMaterials/parameters";
import { buildProcurementCapacityViewModel } from "../procurementCapacityViewModel";

const P = RAW_MATERIALS_PARAMETERS_V1;
const COMPANY = "BAL";

// PROC-CAP-1: procurementCapacityTons/coverageScoreは既存のsalesForce.ts相当の関数から取得される
test("PROC-CAP-1: procurementCapacityTons・coverageScoreは既存関数(procurementCapacity/procurementCoverageScore)の値と一致する", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 10000,
    procurementHeadcount: 5,
    referenceSupplyTons: 50000,
  });
  assert.equal(vm.procurementCapacityTons, unwrapUnit(procurementCapacity(5, P)));
  assert.ok(Math.abs(vm.coverageScore - procurementCoverageScore(5, P)) < 1e-9);
});

// PROC-CAP-2: 調達人員0でも基礎能力は残るが、人員を増やすと能力が伸びる（「人数を入れなければ買えない」ことが分かる）
test("PROC-CAP-2: 調達人員を増やすほどprocurementCapacityTonsが増える", () => {
  const zero = buildProcurementCapacityViewModel({ companyId: COMPANY, desiredQuantityTons: 100000, procurementHeadcount: 0, referenceSupplyTons: 200000 });
  const five = buildProcurementCapacityViewModel({ companyId: COMPANY, desiredQuantityTons: 100000, procurementHeadcount: 5, referenceSupplyTons: 200000 });
  assert.ok(five.procurementCapacityTons > zero.procurementCapacityTons);
});

// PROC-CAP-3: 工場能力連動方式（factoryCommonProcessingCapacityTons指定）でも既存関数の値と一致する
test("PROC-CAP-3: 工場能力連動方式でも既存関数の値と一致する", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 10000,
    procurementHeadcount: 3,
    factoryCommonProcessingCapacityTons: 8000,
    referenceSupplyTons: 50000,
  });
  assert.equal(vm.procurementCapacityTons, unwrapUnit(procurementCapacity(3, P, 8000)));
});

// PROC-CAP-4: Desired QuantityがCapacity以下なら制約されない（Effective = Desired）
test("PROC-CAP-4: 希望量が調達能力の範囲内ならEffective Purchase Intent = Desired Quantity", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 500,
    procurementHeadcount: 10,
    factoryCommonProcessingCapacityTons: 20000,
    referenceSupplyTons: 100000,
  });
  assert.equal(vm.effectivePurchaseIntentTons, 500);
  assert.equal(vm.isConstrained, false);
});

// PROC-CAP-5: 調達能力不足のときはprocurementCapacityがbindingConstraintになる
test("PROC-CAP-5: 調達人員が少なく能力が不足する場合、bindingConstraint=procurementCapacityとなり縮小される", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 1_000_000,
    procurementHeadcount: 1,
    referenceSupplyTons: 10_000_000,
  });
  assert.equal(vm.bindingConstraint, "procurementCapacity");
  assert.equal(vm.isConstrained, true);
  assert.ok(vm.effectivePurchaseIntentTons < vm.desiredQuantityTons);
  assert.ok(Math.abs(vm.effectivePurchaseIntentTons - vm.procurementCapacityTons) < 1e-6);
});

// PROC-CAP-6: シェア上限が最も厳しい場合はbindingConstraint=shareOfSupplyCap
test("PROC-CAP-6: 基準供給量が小さくシェア上限が最も厳しい場合、bindingConstraint=shareOfSupplyCapとなる", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 1_000_000,
    procurementHeadcount: 50,
    factoryCommonProcessingCapacityTons: 1_000_000,
    referenceSupplyTons: 1000, // shareCap = 1000 × 0.35 = 350（非常に小さい）
  });
  assert.equal(vm.bindingConstraint, "shareOfSupplyCap");
  assert.ok(Math.abs(vm.effectivePurchaseIntentTons - 1000 * P.domesticPurchase.maximumPriceInfluenceShare) < 1e-6);
});

// PROC-CAP-7: 承認済み買付枠が最も厳しい場合はbindingConstraint=approvedPurchaseCap
test("PROC-CAP-7: 承認済み買付枠が最も厳しい場合、bindingConstraint=approvedPurchaseCapとなる", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 1_000_000,
    procurementHeadcount: 50,
    factoryCommonProcessingCapacityTons: 1_000_000,
    approvedPurchaseCapTons: 200,
    referenceSupplyTons: 10_000_000,
  });
  assert.equal(vm.bindingConstraint, "approvedPurchaseCap");
  assert.equal(vm.effectivePurchaseIntentTons, 200);
});

// PROC-CAP-8: Effective Purchase IntentはActual Purchase Quantityではない（本VMは実成約量を一切計算しない）
test("PROC-CAP-8: 本VMはeffectivePurchaseIntentTons以外に確定成約量に相当するフィールドを持たない", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: 5000,
    procurementHeadcount: 5,
    referenceSupplyTons: 50000,
  });
  const keys = Object.keys(vm);
  assert.ok(!keys.some((k) => /actual/i.test(k)), `VMにActual系フィールドが含まれてはならない: ${keys.join(", ")}`);
});

// PROC-CAP-9: 負値・NaNの希望量は0として扱われる
test("PROC-CAP-9: 負値・NaNの希望量は0として扱われる", () => {
  const vm = buildProcurementCapacityViewModel({
    companyId: COMPANY,
    desiredQuantityTons: -500,
    procurementHeadcount: 5,
    referenceSupplyTons: 50000,
  });
  assert.equal(vm.desiredQuantityTons, 0);
  assert.equal(vm.effectivePurchaseIntentTons, 0);
});
