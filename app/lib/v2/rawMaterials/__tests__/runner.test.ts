import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { initializeSalesState, advanceSalesQuarter } from "../../sales/runner";
import { CompanySalesPlanEntry } from "../../sales/types";
import { initializeRawMaterialsState, advanceRawMaterialsQuarter, runRawMaterialsQuartersForTesting } from "../runner";
import { DomesticPurchasePlanEntry, ImportOrderInput, AquacultureStockingPlanEntry, RawMaterialsQuarterInput } from "../types";
import { INITIAL_PERIOD_V2, PeriodV2 } from "../../core/period";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { SalesContract } from "../../sales/types";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number) {
  return runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "raw-materials-runner-fixture", turns }).quarters;
}

function buildSalesPlans(seedOffset: number): CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  let i = 0;
  let marketGroupIndex = 0;
  for (const companyId of COMPANIES) {
    for (const market of DEMAND_MARKET_IDS) {
      // 【SAI-2追加作業: 市場別営業配置】同一市場のHOSO/PD/VAPは同じ営業人員数を
      // 共有する必要があるため、headcountは会社×市場の組ごとに1つだけ決める。
      const salesForceHeadcount = (marketGroupIndex + seedOffset) % 12;
      for (const product of PRODUCTS) {
        plans.push({
          companyId,
          market,
          product,
          desiredQuantity: hosoEqTons(500 + ((i + seedOffset) % 7) * 50),
          priceAdjustmentUsdPerHosoEqKg: (((i + seedOffset) % 5) - 2) * 0.05,
          salesForceHeadcount,
        });
        i++;
      }
      marketGroupIndex++;
    }
  }
  return plans;
}

function buildDomesticPlans(seedOffset: number, marketPrice: number): DomesticPurchasePlanEntry[] {
  return COMPANIES.map((companyId, i) => ({
    companyId,
    desiredQuantity: hosoEqTons(200 + ((i + seedOffset) % 5) * 40),
    // 提示価格の許容範囲（市場価格の0.5〜2.0倍）を四半期を通じて確実に満たすよう、
    // 固定の$金額ではなく市場価格に対する小さな比率（±10%以内）で調整する。
    priceAdjustmentUsdPerHosoEqKg: (((i + seedOffset) % 3) - 1) * 0.1 * marketPrice,
    procurementHeadcount: (i + seedOffset) % 10,
  }));
}

function buildImportOrders(period: PeriodV2, seedOffset: number): ImportOrderInput[] {
  const origins = ["EC", "IN", "ID"] as const;
  return COMPANIES.map((companyId, i) => ({
    companyId,
    originCountry: origins[(i + seedOffset) % origins.length],
    orderedQuantity: hosoEqTons(50 + ((i + seedOffset) % 4) * 20),
    orderedPeriod: period,
  }));
}

function buildAquaculturePlans(period: PeriodV2, seedOffset: number): AquacultureStockingPlanEntry[] {
  return COMPANIES.map((companyId, i) => ({
    companyId,
    aquacultureCapacity: hosoEqTons(500),
    plannedStockingQuantity: hosoEqTons(100 + ((i + seedOffset) % 4) * 30),
    aquacultureIntensity: ratio(((i + seedOffset) % 5) / 5),
    bioSecurityLevel: ratio(((i + seedOffset + 2) % 5) / 5),
    stockingPeriod: period,
  }));
}

function buildRawMaterialsInput(quarter: ReturnType<typeof industryQuarters>[number], seedOffset: number): RawMaterialsQuarterInput {
  const originHosoFobPrice = Object.fromEntries(
    Object.entries(quarter.marketResult.hosoPrices).map(([country, r]) => [country, r.price])
  ) as RawMaterialsQuarterInput["originHosoFobPrice"];
  const originExportableSupply = Object.fromEntries(
    Object.entries(quarter.marketResult.hosoPrices).map(([country, r]) => [country, r.exportableSupply])
  ) as RawMaterialsQuarterInput["originExportableSupply"];

  return {
    domesticPurchasePlans: buildDomesticPlans(seedOffset, unwrapUnit(quarter.marketResult.vietnamDomestic.price)),
    importOrders: buildImportOrders(quarter.marketResult.period, seedOffset),
    aquacultureStockingPlans: buildAquaculturePlans(quarter.marketResult.period, seedOffset),
    vietnamDomesticPrice: quarter.marketResult.vietnamDomestic.price,
    vietnamDomesticSupply: quarter.marketResult.vietnamDomestic.supply,
    originHosoFobPrice,
    originExportableSupply,
    diseasePressure: quarter.scenarioTurnInput.countries.VN.diseasePressure,
  };
}

test("initializeRawMaterialsState: 空のロット・履歴を持つ", () => {
  const state = initializeRawMaterialsState(INITIAL_PERIOD_V2);
  assert.equal(state.lots.length, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.currentPeriod, INITIAL_PERIOD_V2);
});

test("advanceRawMaterialsQuarter: 呼ぶたびにcurrentPeriodが1つ進む", () => {
  const quarters = industryQuarters(2);
  let state = initializeRawMaterialsState(INITIAL_PERIOD_V2);
  state = advanceRawMaterialsQuarter(state, buildRawMaterialsInput(quarters[0], 0), []);
  assert.equal(state.currentPeriod, "2015Q2");
  state = advanceRawMaterialsQuarter(state, buildRawMaterialsInput(quarters[1], 1), []);
  assert.equal(state.currentPeriod, "2015Q3");
});

test("advanceRawMaterialsQuarterは入力stateを変更しない（不変更新）", () => {
  const quarters = industryQuarters(1);
  const state = initializeRawMaterialsState(INITIAL_PERIOD_V2);
  const before = JSON.stringify(state);
  advanceRawMaterialsQuarter(state, buildRawMaterialsInput(quarters[0], 0), []);
  assert.equal(JSON.stringify(state), before);
});

test("約定残から必要原料量が納期別・商品別に正しく集計される", () => {
  const quarters = industryQuarters(1);
  let salesState = initializeSalesState(INITIAL_PERIOD_V2);
  salesState = advanceSalesQuarter(salesState, { plans: buildSalesPlans(0), marketResult: quarters[0].marketResult, marketInput: quarters[0].marketInput });

  const rmState = advanceRawMaterialsQuarter(
    initializeRawMaterialsState(INITIAL_PERIOD_V2),
    buildRawMaterialsInput(quarters[0], 0),
    salesState.contracts
  );

  const record = rmState.history[0];
  assert.ok(record.requirements.length > 0);
  const totalRequired = record.requirements.reduce((s, r) => s + unwrapUnit(r.requiredQuantity), 0);
  const totalOutstanding = salesState.contracts.reduce((s, c) => s + unwrapUnit(c.outstandingQuantity), 0);
  assert.ok(Math.abs(totalRequired - totalOutstanding) < 0.1);
  // すべて次四半期（dueDate=2015Q2）を納期とする。
  for (const r of record.requirements) {
    assert.equal(r.dueDate, "2015Q2");
  }
});

test("必要原料量の集計は調達に一切反映されない（自動発注されない）", () => {
  const quarters = industryQuarters(1);
  let salesState = initializeSalesState(INITIAL_PERIOD_V2);
  salesState = advanceSalesQuarter(salesState, { plans: buildSalesPlans(0), marketResult: quarters[0].marketResult, marketInput: quarters[0].marketInput });

  const inputWithNoDomesticPurchase: RawMaterialsQuarterInput = { ...buildRawMaterialsInput(quarters[0], 0), domesticPurchasePlans: [], importOrders: [], aquacultureStockingPlans: [] };
  const rmState = advanceRawMaterialsQuarter(initializeRawMaterialsState(INITIAL_PERIOD_V2), inputWithNoDomesticPurchase, salesState.contracts);

  // 必要量は集計されるが、買付計画が空なら実際の調達（ロット）は一切発生しない。
  assert.ok(rmState.history[0].requirements.length > 0);
  assert.equal(rmState.lots.length, 0);
});

test("5社×複数四半期を完走する", () => {
  const turns = 5;
  const quarters = industryQuarters(turns);

  let salesState = initializeSalesState(INITIAL_PERIOD_V2);
  let rmState = initializeRawMaterialsState(INITIAL_PERIOD_V2);

  for (let i = 0; i < turns; i++) {
    salesState = advanceSalesQuarter(salesState, { plans: buildSalesPlans(i), marketResult: quarters[i].marketResult, marketInput: quarters[i].marketInput });
    rmState = advanceRawMaterialsQuarter(rmState, buildRawMaterialsInput(quarters[i], i), salesState.contracts);
  }

  assert.equal(rmState.history.length, turns);
  assert.ok(rmState.lots.length > 0);
  const sources = new Set(rmState.lots.map((l) => l.source));
  assert.ok(sources.has("domestic"));
  assert.ok(sources.has("import"));
  assert.ok(sources.has("aquaculture"));
});

test("同一入力なら完全に同じ結果になる（再現性）", () => {
  const quarters = industryQuarters(3);
  let salesState = initializeSalesState(INITIAL_PERIOD_V2);
  const inputs: { input: RawMaterialsQuarterInput; contracts: readonly SalesContract[] }[] = [];
  for (let i = 0; i < 3; i++) {
    salesState = advanceSalesQuarter(salesState, { plans: buildSalesPlans(i), marketResult: quarters[i].marketResult, marketInput: quarters[i].marketInput });
    inputs.push({ input: buildRawMaterialsInput(quarters[i], i), contracts: salesState.contracts });
  }

  const stateA = runRawMaterialsQuartersForTesting(INITIAL_PERIOD_V2, inputs);
  const stateB = runRawMaterialsQuartersForTesting(INITIAL_PERIOD_V2, inputs);
  assert.deepEqual(stateA, stateB);
});

test("輸入ロットは到着四半期まで在庫化されず、養殖ロットも収穫四半期まで在庫化されない", () => {
  const turns = 3;
  const quarters = industryQuarters(turns);
  let salesState = initializeSalesState(INITIAL_PERIOD_V2);
  let rmState = initializeRawMaterialsState(INITIAL_PERIOD_V2);

  for (let i = 0; i < turns; i++) {
    salesState = advanceSalesQuarter(salesState, { plans: buildSalesPlans(i), marketResult: quarters[i].marketResult, marketInput: quarters[i].marketInput });
    rmState = advanceRawMaterialsQuarter(rmState, buildRawMaterialsInput(quarters[i], i), salesState.contracts);
  }

  // 輸入・養殖ロットのうち、availableFromPeriod > inboundPeriod のものは、
  // inboundPeriod時点ではavailableでなかったはず（in_transit/growing経由）。
  const delayed = rmState.lots.filter((l) => (l.source === "import" || l.source === "aquaculture") && l.availableFromPeriod !== l.inboundPeriod);
  assert.ok(delayed.length > 0, "テストの前提として輸入または養殖のロットが少なくとも1件、到着/収穫が入庫四半期より後になっているはず");
});

test("金額（売上・利益・PL）フィールドが状態のどこにも存在しない", () => {
  const quarters = industryQuarters(1);
  const rmState = advanceRawMaterialsQuarter(initializeRawMaterialsState(INITIAL_PERIOD_V2), buildRawMaterialsInput(quarters[0], 0), []);
  const serialized = JSON.stringify(rmState);
  for (const forbidden of ["revenue", "profit", "cogs", "accountsPayable", "\"pl\"", "balanceSheet"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
  }
});
