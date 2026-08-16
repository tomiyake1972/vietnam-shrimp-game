// ShrimpX V2 — Procurement Planning: procurementRequirementViewModel のテスト（PROC-REQ-1〜9）

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, usdPerHosoEqKg } from "../../../lib/v2/core/units";
import { period } from "../../../lib/v2/core/period";
import { RawMaterialLot } from "../../../lib/v2/rawMaterials/types";
import { SalesContract } from "../../../lib/v2/sales/types";
import {
  buildAvailableRawMaterialThisQuarter,
  buildFutureContractObligations,
  buildProcurementRequirementViewModel,
  buildProductionRawRequirement,
} from "../procurementRequirementViewModel";

const CURRENT = period(2026, 2);
const COMPANY = "BAL";

function lot(overrides: Partial<RawMaterialLot>): RawMaterialLot {
  return {
    lotId: overrides.lotId ?? `lot-${Math.random()}`,
    companyId: COMPANY,
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: CURRENT,
    originalQuantity: hosoEqTons(1000),
    remainingQuantity: hosoEqTons(1000),
    unitCost: overrides.unitCost ?? usdPerHosoEqKg(2.5),
    availableFromPeriod: CURRENT,
    status: "available",
    ...overrides,
  } as RawMaterialLot;
}

// PROC-REQ-1: Planned Production = HOSO+PD+VAPの単純合計（歩留まり換算なし）
test("PROC-REQ-1: 必要原料量は生産計画のHOSO/PD/VAP単純合計と一致する（歩留まり換算なし）", () => {
  const result = buildProductionRawRequirement([
    { product: "hoso", desiredQuantity: 8000 },
    { product: "pd", desiredQuantity: 7000 },
    { product: "vap", desiredQuantity: 9600 },
  ]);
  assert.equal(result.plannedProductionByProduct.hoso, 8000);
  assert.equal(result.plannedProductionByProduct.pd, 7000);
  assert.equal(result.plannedProductionByProduct.vap, 9600);
  assert.equal(result.plannedProductionTotalTons, 24600);
  // 必要原料量は計画生産量とビット単位で同一（PD÷0.54・VAP÷0.90等の換算を挟まない）。
  assert.equal(result.requiredRawMaterialTons, 24600);
  assert.equal(result.requiredRawMaterialTons, result.plannedProductionTotalTons);
});

// PROC-REQ-2: 複数工場の同一商品行は合算される
test("PROC-REQ-2: 同一商品の複数行（複数工場）は合算される", () => {
  const result = buildProductionRawRequirement([
    { product: "hoso", desiredQuantity: 3000 },
    { product: "hoso", desiredQuantity: 2000 },
    { product: "pd", desiredQuantity: 1000 },
  ]);
  assert.equal(result.plannedProductionByProduct.hoso, 5000);
  assert.equal(result.plannedProductionTotalTons, 6000);
});

// PROC-REQ-3: 負値・NaNは0として扱う（捏造しない）
test("PROC-REQ-3: 負値・NaNの入力は0として扱われる", () => {
  const result = buildProductionRawRequirement([
    { product: "hoso", desiredQuantity: -100 },
    { product: "pd", desiredQuantity: Number.NaN },
    { product: "vap", desiredQuantity: 500 },
  ]);
  assert.equal(result.plannedProductionByProduct.hoso, 0);
  assert.equal(result.plannedProductionByProduct.pd, 0);
  assert.equal(result.requiredRawMaterialTons, 500);
});

// PROC-REQ-4: Available This Quarter は status=available のロットを含む
test("PROC-REQ-4: 当期利用可能量は手持ち在庫(status=available)を含む", () => {
  const lots = [lot({ remainingQuantity: hosoEqTons(1200), status: "available" })];
  const available = buildAvailableRawMaterialThisQuarter(lots, COMPANY, CURRENT);
  assert.equal(available.carriedInventoryTons, 1200);
  assert.equal(available.confirmedAvailableTons, 1200);
  assert.equal(available.totalIncludingExpectedTons, 1200);
});

// PROC-REQ-5: 当期到着の輸入・当期収穫の養殖は当期利用可能量へ含まれる
test("PROC-REQ-5: 到着期・収穫期が当期以前の輸入・養殖ロットは当期利用可能量へ含まれる", () => {
  const lots = [
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(500), availableFromPeriod: CURRENT }),
    lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(300), availableFromPeriod: CURRENT }),
  ];
  const available = buildAvailableRawMaterialThisQuarter(lots, COMPANY, CURRENT);
  assert.equal(available.confirmedImportArrivalTons, 500);
  assert.equal(available.expectedAquacultureHarvestTons, 300);
  // confirmedAvailableTonsは輸入到着のみ（養殖の期待収穫は含まない）。
  assert.equal(available.confirmedAvailableTons, 500);
  assert.equal(available.totalIncludingExpectedTons, 800);
  assert.equal(available.pipelineBeyondThisQuarterTons, 0);
});

// PROC-REQ-6: 将来到着の輸入・養殖は当期利用可能量から除外され、pipelineへ計上される
test("PROC-REQ-6: 到着期・収穫期が将来の輸入・養殖ロットは当期利用可能量に含めない", () => {
  const future = period(2026, 3); // Q+1
  const lots = [
    lot({ source: "import", status: "inTransitImport", remainingQuantity: hosoEqTons(700), availableFromPeriod: future }),
    lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(400), availableFromPeriod: future }),
  ];
  const available = buildAvailableRawMaterialThisQuarter(lots, COMPANY, CURRENT);
  assert.equal(available.confirmedImportArrivalTons, 0);
  assert.equal(available.expectedAquacultureHarvestTons, 0);
  assert.equal(available.totalIncludingExpectedTons, 0);
  assert.equal(available.pipelineBeyondThisQuarterTons, 1100);
});

// PROC-REQ-7: 他社ロット・remainingQuantity<=0のロットは除外される
test("PROC-REQ-7: 他社のロット・残数量0以下のロットは集計から除外される", () => {
  const lots = [
    lot({ companyId: "MASS", remainingQuantity: hosoEqTons(9999), status: "available" }),
    lot({ remainingQuantity: hosoEqTons(0), status: "available" }),
    lot({ remainingQuantity: hosoEqTons(200), status: "available" }),
  ];
  const available = buildAvailableRawMaterialThisQuarter(lots, COMPANY, CURRENT);
  assert.equal(available.totalIncludingExpectedTons, 200);
});

// PROC-REQ-8: 過不足（Shortage/Surplus）の判定（楽観値＝totalIncludingExpectedTons基準）
test("PROC-REQ-8: 必要量に対する過不足（shortage/surplus）とcoverageRatioを正しく算出する", () => {
  const shortageVm = buildProcurementRequirementViewModel({
    productionPlanRows: [{ product: "hoso", desiredQuantity: 24600 }],
    rawMaterialLots: [lot({ remainingQuantity: hosoEqTons(21900), status: "available" })],
    companyId: COMPANY,
    currentPeriod: CURRENT,
  });
  assert.equal(shortageVm.requirement.requiredRawMaterialTons, 24600);
  assert.equal(shortageVm.available.totalIncludingExpectedTons, 21900);
  assert.equal(shortageVm.balanceTons, -2700);
  assert.equal(shortageVm.shortageTons, 2700);
  assert.equal(shortageVm.surplusTons, 0);
  assert.equal(shortageVm.isShortage, true);
  assert.ok(Math.abs((shortageVm.coverageRatio ?? 0) - 21900 / 24600) < 1e-9);

  const surplusVm = buildProcurementRequirementViewModel({
    productionPlanRows: [{ product: "hoso", desiredQuantity: 1000 }],
    rawMaterialLots: [lot({ remainingQuantity: hosoEqTons(1500), status: "available" })],
    companyId: COMPANY,
    currentPeriod: CURRENT,
  });
  assert.equal(surplusVm.balanceTons, 500);
  assert.equal(surplusVm.shortageTons, 0);
  assert.equal(surplusVm.surplusTons, 500);
  assert.equal(surplusVm.isShortage, false);
});

// PROC-REQ-9: 必要量0のときcoverageRatioはundefined（0除算を捏造しない）
test("PROC-REQ-9: 必要原料量が0のときcoverageRatio・confirmedCoverageRatioはundefined", () => {
  const vm = buildProcurementRequirementViewModel({
    productionPlanRows: [],
    rawMaterialLots: [],
    companyId: COMPANY,
    currentPeriod: CURRENT,
  });
  assert.equal(vm.requirement.requiredRawMaterialTons, 0);
  assert.equal(vm.coverageRatio, undefined);
  assert.equal(vm.confirmedCoverageRatio, undefined);
});

// PROC-REQ-12: 養殖の期待収穫は「確定available」に合算されない（Confirmed / Expectedの分離）
test("PROC-REQ-12: 養殖の期待収穫量はconfirmedAvailableTonsへ合算されず、totalIncludingExpectedTonsにのみ含まれる", () => {
  const lots = [
    lot({ status: "available", remainingQuantity: hosoEqTons(1000) }),
    lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(5000), availableFromPeriod: CURRENT }),
  ];
  const available = buildAvailableRawMaterialThisQuarter(lots, COMPANY, CURRENT);
  assert.equal(available.carriedInventoryTons, 1000);
  assert.equal(available.expectedAquacultureHarvestTons, 5000);
  // 確定量は在庫のみ。疾病等で養殖が目減りしても、この値は変わらない。
  assert.equal(available.confirmedAvailableTons, 1000);
  assert.equal(available.totalIncludingExpectedTons, 6000);
});

// PROC-REQ-13: confirmed基準の不足判定は、養殖の期待収穫を一切勘定に入れない
test("PROC-REQ-13: confirmedShortageTons/isConfirmedShortageは養殖の期待収穫を除いた保守的な残高で判定される", () => {
  // 必要量5000t、養殖の期待収穫だけを見れば足りるが、確定分（在庫1000）だけでは大幅に不足。
  const vm = buildProcurementRequirementViewModel({
    productionPlanRows: [{ product: "hoso", desiredQuantity: 5000 }],
    rawMaterialLots: [
      lot({ status: "available", remainingQuantity: hosoEqTons(1000) }),
      lot({ source: "aquaculture", status: "growingAquaculture", remainingQuantity: hosoEqTons(4500), availableFromPeriod: CURRENT }),
    ],
    companyId: COMPANY,
    currentPeriod: CURRENT,
  });
  // 楽観値（養殖の期待収穫を含む）では足りている（1000+4500=5500 >= 5000）。
  assert.equal(vm.balanceTons, 500);
  assert.equal(vm.isShortage, false);
  // 保守値（養殖の期待収穫を含まない）では大幅な不足として現れる。
  assert.equal(vm.confirmedBalanceTons, 1000 - 5000);
  assert.equal(vm.confirmedShortageTons, 4000);
  assert.equal(vm.isConfirmedShortage, true);
  assert.ok(Math.abs((vm.confirmedCoverageRatio ?? 0) - 1000 / 5000) < 1e-9);
});

// ---------------------------------------------------------------------
// Future Contract Obligations（(B)。(A)への加算禁止の確認を含む）
// ---------------------------------------------------------------------

function contract(overrides: Partial<SalesContract>): SalesContract {
  return {
    contractId: overrides.contractId ?? `c-${Math.random()}`,
    companyId: COMPANY,
    market: "US",
    product: "hoso",
    contractedPeriod: CURRENT,
    dueDate: CURRENT,
    originalQuantity: hosoEqTons(1000),
    outstandingQuantity: hosoEqTons(1000),
    unitPrice: usdPerHosoEqKg(5),
    status: "open",
    ...overrides,
  } as SalesContract;
}

// PROC-REQ-10: 将来納品義務は納期別に集計され、当期必要量とは独立している
test("PROC-REQ-10: Future Contract Obligationsは納期別に集計され、Production Raw Requirementへ混入しない", () => {
  const q1 = period(2026, 3);
  const contracts = [
    contract({ dueDate: CURRENT, product: "hoso", outstandingQuantity: hosoEqTons(500) }),
    contract({ dueDate: q1, product: "pd", outstandingQuantity: hosoEqTons(300) }),
    contract({ dueDate: q1, product: "vap", outstandingQuantity: hosoEqTons(100) }),
    contract({ status: "fulfilled", outstandingQuantity: hosoEqTons(0) }),
  ];
  const obligations = buildFutureContractObligations(contracts, COMPANY, CURRENT);
  assert.equal(obligations.totalTons, 900);
  assert.equal(obligations.entries.length, 2);
  const q1Entry = obligations.entries.find((e) => e.dueDate === q1);
  assert.ok(q1Entry);
  assert.equal(q1Entry!.totalTons, 400);
  assert.equal(q1Entry!.quarterOffset, 1);

  // (A)は生産計画だけから求まり、(B)の値は一切混入しない。
  const requirement = buildProductionRawRequirement([{ product: "hoso", desiredQuantity: 24600 }]);
  assert.equal(requirement.requiredRawMaterialTons, 24600);
});

// PROC-REQ-11: 納期超過の契約はisOverdue=trueとしてマークされる
test("PROC-REQ-11: 納期が当期より前の契約はisOverdue=trueとしてマークされる", () => {
  const past = period(2026, 1);
  const contracts = [contract({ dueDate: past, status: "overdue", outstandingQuantity: hosoEqTons(200) })];
  const obligations = buildFutureContractObligations(contracts, COMPANY, CURRENT);
  assert.equal(obligations.entries.length, 1);
  assert.equal(obligations.entries[0].isOverdue, true);
  assert.equal(obligations.overdueTons, 200);
});
