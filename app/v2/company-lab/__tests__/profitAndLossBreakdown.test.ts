// ShrimpX V2 — 前期PL費用内訳の検算テスト
//
// 【このテストが守るもの】画面に出す内訳の合計が、エンジンが確定させた
// 営業利益・当期純利益と一致すること。内訳を1行足し引きしたときに、
// 合計がずれたまま気づかずに出荷されることを防ぐ。
//
// 入力は実エンジン（closeFinancialQuarter 由来の CompanyFinancialQuarterResult）
// ではなく、同じ型のフィクスチャを使う。検算対象は「ビューモデルが
// どの確定値を拾い、どう束ねるか」であって、エンジンの計算そのものではないため。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildProfitAndLossBreakdown } from "../profitAndLossBreakdownViewModel";
import type { CompanyFinancialQuarterResult, CostRecord } from "../../../lib/v2/finance/types";

const usd = (v: number) => v as unknown as CompanyFinancialQuarterResult["profitAndLoss"]["netRevenue"];

function costRecord(account: CostRecord["account"], fixed: number, variable: number): CostRecord {
  return {
    account,
    behavior: "fixed",
    fixedPortion: usd(fixed),
    variablePortion: usd(variable),
    driver: "none",
    driverQuantity: 0,
    driverUnitRate: 0,
    period: "2015Q1",
    shortTermReducibility: "committed",
    sourceRef: "test",
  } as unknown as CostRecord;
}

/**
 * 内訳の各項目が足し合わさって各段の確定値になるよう組んだフィクスチャ。
 * 数値はテストの検算のためのもので、実Runの値ではない。
 */
function buildResult(): CompanyFinancialQuarterResult {
  const costOfSales = {
    rawMaterialCost: usd(5_000_000),
    processingCost: usd(1_200_000),
    laborCost: usd(900_000),
    factoryFixedCost: usd(700_000),
    reworkCost: usd(40_000),
    discardLoss: usd(60_000),
    unabsorbedFixedManufacturingCost: usd(30_000),
    idleLaborCost: usd(20_000),
    capexMaintenanceCost: usd(10_000),
    factoryLifecycleCarryingCost: usd(0),
  };
  const totalCostOfSales = 5_000_000 + 1_200_000 + 900_000 + 700_000 + 40_000 + 60_000 + 30_000 + 20_000 + 10_000;
  const netRevenue = 12_000_000;
  const grossProfit = netRevenue - totalCostOfSales;
  const sellingGeneralAdmin = 400_000 + 250_000 + 90_000 + 160_000; // 営業 + 物流 + 調達 + 一般管理
  const operatingProfit = grossProfit - sellingGeneralAdmin;
  const interestExpense = 1_100_000;
  const assetDisposalGainLoss = 0;
  const profitBeforeTax = operatingProfit + assetDisposalGainLoss - interestExpense;
  const incomeTax = profitBeforeTax > 0 ? profitBeforeTax * 0.2 : 0;
  const netIncome = profitBeforeTax - incomeTax;

  return {
    companyId: "BAL",
    period: "2015Q1",
    profitAndLoss: {
      companyId: "BAL",
      period: "2015Q1",
      grossRevenue: usd(netRevenue + 100_000),
      qualitySalesDeduction: usd(100_000),
      netRevenue: usd(netRevenue),
      costOfSales,
      totalCostOfSales: usd(totalCostOfSales),
      grossProfit: usd(grossProfit),
      sellingGeneralAdmin: usd(sellingGeneralAdmin),
      operatingProfit: usd(operatingProfit),
      assetDisposalGainLoss: usd(assetDisposalGainLoss),
      interestExpense: usd(interestExpense),
      profitBeforeTax: usd(profitBeforeTax),
      incomeTax: usd(incomeTax),
      netIncome: usd(netIncome),
    },
    manufacturingCost: {
      domesticRawMaterialCost: usd(3_000_000),
      importedRawMaterialCost: usd(1_500_000),
      aquacultureRawMaterialCost: usd(800_000),
      regularLaborCost: usd(700_000),
      productiveRegularLaborCost: usd(680_000),
      idleLaborCost: usd(20_000),
      temporaryWorkerCost: usd(150_000),
      overtimeCost: usd(70_000),
      hosoProcessingCost: usd(0),
      pdAdditionalProcessingCost: usd(0),
      vapAdditionalProcessingCost: usd(0),
      factoryFixedCost: usd(0),
      utilityFixedCost: usd(0),
      utilityVariableCost: usd(0),
    },
    qualityLoss: {
      qualityDiscardLoss: usd(30_000),
      rawMaterialExpiryLoss: usd(10_000),
      finishedGoodsWriteOffLoss: usd(20_000),
      reworkCost: usd(40_000),
      downgradeSalesDeduction: usd(100_000),
      discardQuantityTons: 5,
      reworkQuantityTons: 3,
      downgradeQuantitySoldTons: 8,
    },
    costRecords: [
      costRecord("salesForceSalary", 400_000, 0),
      costRecord("sellingLogistics", 0, 250_000),
      costRecord("procurementSalary", 90_000, 0),
      costRecord("adminFixed", 160_000, 0),
      costRecord("depreciation", 500_000, 0),
    ],
    balanceSheet: {} as CompanyFinancialQuarterResult["balanceSheet"],
    cashFlow: {} as CompanyFinancialQuarterResult["cashFlow"],
    contributionMargin: {} as CompanyFinancialQuarterResult["contributionMargin"],
    absorptionVariableReconciliation: {} as CompanyFinancialQuarterResult["absorptionVariableReconciliation"],
    cashShortfall: false,
    cashShortfallAmount: usd(0),
    negativeEquity: false,
  } as unknown as CompanyFinancialQuarterResult;
}

const amount = (vm: ReturnType<typeof buildProfitAndLossBreakdown>, key: string): number => {
  const row = vm.rows.find((r) => r.key === key);
  assert.ok(row, `行 ${key} が見つかりません`);
  assert.notEqual(row.amountUsd, null, `行 ${key} が「未実装」になっています`);
  return row.amountUsd as number;
};

test("PL-1: 売上原価の内訳の合計が、確定値の売上原価合計と一致する", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  const keys = [
    "cos-raw",
    "cos-processing",
    "cos-labor",
    "cos-factory-fixed",
    "cos-rework",
    "cos-discard",
    "cos-unabsorbed",
    "cos-idle-labor",
    "cos-capex-maintenance",
    "cos-factory-lifecycle",
  ];
  const sum = keys.reduce((acc, k) => acc + amount(vm, k), 0);
  assert.ok(Math.abs(sum - vm.totals.totalCostOfSalesUsd) < 0.01, `内訳合計 ${sum} ≠ 売上原価 ${vm.totals.totalCostOfSalesUsd}`);
  assert.ok(Math.abs(amount(vm, "cost-of-sales") - vm.totals.totalCostOfSalesUsd) < 0.01);
});

test("PL-2: 純売上 − 売上原価 = 売上総利益", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  assert.ok(Math.abs(vm.totals.netRevenueUsd - vm.totals.totalCostOfSalesUsd - vm.totals.grossProfitUsd) < 0.01);
  assert.ok(Math.abs(amount(vm, "gross-profit") - vm.totals.grossProfitUsd) < 0.01);
});

test("PL-3: 販管費の内訳の合計が、確定値の販管費と一致する（差分行を含む）", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  const sum = vm.rows.filter((r) => r.key.startsWith("sga-")).reduce((acc, r) => acc + (r.amountUsd ?? 0), 0);
  assert.ok(Math.abs(sum - vm.totals.sellingGeneralAdminUsd) < 0.01, `販管費内訳 ${sum} ≠ ${vm.totals.sellingGeneralAdminUsd}`);
  // このフィクスチャでは勘定科目で全額を説明できるので、差分行は出ない。
  assert.equal(vm.rows.find((r) => r.key === "sga-residual"), undefined);
});

test("PL-4: 売上総利益 − 販管費 = 営業利益", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  assert.ok(Math.abs(vm.totals.grossProfitUsd - vm.totals.sellingGeneralAdminUsd - vm.totals.operatingProfitUsd) < 0.01);
  assert.ok(Math.abs(amount(vm, "operating-profit") - vm.totals.operatingProfitUsd) < 0.01);
});

test("PL-5: 営業利益 ＋ 営業外 − 法人税 = 当期純利益", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  const computed = vm.totals.operatingProfitUsd + amount(vm, "asset-disposal") - amount(vm, "interest") - amount(vm, "income-tax");
  assert.ok(Math.abs(computed - vm.totals.netIncomeUsd) < 0.01, `${computed} ≠ ${vm.totals.netIncomeUsd}`);
  assert.ok(Math.abs(amount(vm, "net-income") - vm.totals.netIncomeUsd) < 0.01);
});

test("PL-6: 説明できない販管費があるときは「差分」行として明示し、合計は一致したままになる", () => {
  const base = buildResult();
  const withResidual = {
    ...base,
    costRecords: base.costRecords.filter((r) => r.account !== "adminFixed"),
  } as CompanyFinancialQuarterResult;
  const vm = buildProfitAndLossBreakdown({ result: withResidual });
  const residual = vm.rows.find((r) => r.key === "sga-residual");
  assert.ok(residual, "差分行が出ていません");
  assert.ok(Math.abs((residual.amountUsd as number) - 160_000) < 0.01);
  const sum = vm.rows.filter((r) => r.key.startsWith("sga-")).reduce((acc, r) => acc + (r.amountUsd ?? 0), 0);
  assert.ok(Math.abs(sum - vm.totals.sellingGeneralAdminUsd) < 0.01);
});

test("PL-7: 商品別の純売上は未実装として出し、推計値を作らない", () => {
  const vm = buildProfitAndLossBreakdown({ result: buildResult() });
  const row = vm.rows.find((r) => r.key === "revenue-by-product");
  assert.ok(row);
  assert.equal(row.amountUsd, null);
  assert.ok(vm.unavailableItems.some((i) => i.includes("商品別")));
});

test("PL-8: 販売数量が渡されればkgあたり指標を出し、渡されなければ算定不可にする", () => {
  const withQuantity = buildProfitAndLossBreakdown({ result: buildResult(), soldQuantityHosoEqTons: 2_000 });
  const price = withQuantity.perKilogram.find((m) => m.key === "price");
  assert.ok(price);
  // 12,000,000 USD ÷ (2,000t × 1,000kg) = 6.00 USD/kg
  assert.ok(Math.abs((price.valueUsdPerKg as number) - 6) < 1e-9);

  const withoutQuantity = buildProfitAndLossBreakdown({ result: buildResult() });
  assert.equal(withoutQuantity.perKilogram.find((m) => m.key === "price")?.valueUsdPerKg, null);
  assert.ok(withoutQuantity.unavailableItems.some((i) => i.includes("kgあたり")));
});
