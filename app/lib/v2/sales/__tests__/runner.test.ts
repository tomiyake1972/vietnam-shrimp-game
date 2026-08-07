import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { initializeSalesState, advanceSalesQuarter, runSalesQuartersForTesting } from "../runner";
import { applyFulfillments, updateContractStatusesForQuarterEnd } from "../backlog";
import { CompanySalesPlanEntry, SalesQuarterInput } from "../types";
import { INITIAL_PERIOD_V2 } from "../../core/period";
import { hosoEqTons, unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function buildPlans(seedOffset: number): CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  let i = 0;
  let marketGroupIndex = 0;
  for (const companyId of COMPANIES) {
    for (const market of DEMAND_MARKET_IDS) {
      // 【SAI-2追加作業: 市場別営業配置】同一市場のHOSO/PD/VAPは同じ営業人員数を
      // 共有する必要があるため、headcountは会社×市場の組ごとに1つだけ決める
      // （商品ごとにずらさない）。
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

function industryQuarters(turns: number) {
  return runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "sales-runner-fixture", turns }).quarters;
}

test("initializeSalesState: 空の契約・履歴を持つ", () => {
  const state = initializeSalesState(INITIAL_PERIOD_V2);
  assert.equal(state.contracts.length, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.currentPeriod, INITIAL_PERIOD_V2);
});

test("advanceSalesQuarter: 呼ぶたびにcurrentPeriodが1つ進む", () => {
  const quarters = industryQuarters(2);
  let state = initializeSalesState(INITIAL_PERIOD_V2);
  const input1: SalesQuarterInput = { plans: buildPlans(0), marketResult: quarters[0].marketResult, marketInput: quarters[0].marketInput };
  state = advanceSalesQuarter(state, input1);
  assert.equal(state.currentPeriod, "2015Q2");
  const input2: SalesQuarterInput = { plans: buildPlans(1), marketResult: quarters[1].marketResult, marketInput: quarters[1].marketInput };
  state = advanceSalesQuarter(state, input2);
  assert.equal(state.currentPeriod, "2015Q3");
});

test("advanceSalesQuarterは入力stateを変更しない（不変更新）", () => {
  const quarters = industryQuarters(1);
  const state = initializeSalesState(INITIAL_PERIOD_V2);
  const before = JSON.stringify(state);
  advanceSalesQuarter(state, { plans: buildPlans(0), marketResult: quarters[0].marketResult, marketInput: quarters[0].marketInput });
  assert.equal(JSON.stringify(state), before);
});

test("5社×5市場×3商品×複数四半期を完走する", () => {
  const turns = 6;
  const quarters = industryQuarters(turns);
  const inputs: SalesQuarterInput[] = quarters.map((q, i) => ({
    plans: buildPlans(i),
    marketResult: q.marketResult,
    marketInput: q.marketInput,
  }));

  const finalState = runSalesQuartersForTesting(INITIAL_PERIOD_V2, inputs);

  assert.equal(finalState.history.length, turns);
  for (const record of finalState.history) {
    assert.equal(record.allocations.length, DEMAND_MARKET_IDS.length * PRODUCTS.length);
  }
  assert.ok(finalState.contracts.length > 0);
  // 5社すべてが少なくとも1件は契約を獲得している（十分な四半期・市場・商品の組み合わせがあるため）。
  const companyIdsWithContracts = new Set(finalState.contracts.map((c) => c.companyId));
  assert.equal(companyIdsWithContracts.size, COMPANIES.length);
});

test("同一入力（同一シナリオ・同一販売計画）なら完全に同じ結果になる（再現性）", () => {
  const quarters = industryQuarters(3);
  const inputs: SalesQuarterInput[] = quarters.map((q, i) => ({
    plans: buildPlans(i),
    marketResult: q.marketResult,
    marketInput: q.marketInput,
  }));

  const stateA = runSalesQuartersForTesting(INITIAL_PERIOD_V2, inputs);
  const stateB = runSalesQuartersForTesting(INITIAL_PERIOD_V2, inputs);

  assert.deepEqual(stateA, stateB);
});

test("advanceSalesQuarterはPhase3のmarketResult/marketInputを変更しない", () => {
  const quarters = industryQuarters(1);
  const beforeResult = JSON.stringify(quarters[0].marketResult);
  const beforeInput = JSON.stringify(quarters[0].marketInput);
  advanceSalesQuarter(initializeSalesState(INITIAL_PERIOD_V2), {
    plans: buildPlans(0),
    marketResult: quarters[0].marketResult,
    marketInput: quarters[0].marketInput,
  });
  assert.equal(JSON.stringify(quarters[0].marketResult), beforeResult);
  assert.equal(JSON.stringify(quarters[0].marketInput), beforeInput);
});

test("契約は成約四半期の翌四半期を納期とする約定残になる", () => {
  const quarters = industryQuarters(1);
  const state = advanceSalesQuarter(initializeSalesState(INITIAL_PERIOD_V2), {
    plans: buildPlans(0),
    marketResult: quarters[0].marketResult,
    marketInput: quarters[0].marketInput,
  });
  assert.ok(state.contracts.length > 0);
  for (const c of state.contracts) {
    assert.equal(c.contractedPeriod, "2015Q1");
    assert.equal(c.dueDate, "2015Q2");
  }
});

test("履行実績の適用はadvanceSalesQuarterの外側で明示的に行う必要がある（自動履行されない）", () => {
  const quarters = industryQuarters(1);
  const state = advanceSalesQuarter(initializeSalesState(INITIAL_PERIOD_V2), {
    plans: buildPlans(0),
    marketResult: quarters[0].marketResult,
    marketInput: quarters[0].marketInput,
  });
  // advanceSalesQuarter直後は、生成された契約は全て"open"のまま（履行は別関数呼び出しが必要）。
  for (const c of state.contracts) {
    assert.equal(c.status, "open");
    assert.equal(unwrapUnit(c.outstandingQuantity), unwrapUnit(c.originalQuantity));
  }
});

test("履行実績を約定残へ適用し、四半期末に状態更新する一連の流れが動作する", () => {
  const quarters = industryQuarters(2);
  let state = advanceSalesQuarter(initializeSalesState(INITIAL_PERIOD_V2), {
    plans: buildPlans(0),
    marketResult: quarters[0].marketResult,
    marketInput: quarters[0].marketInput,
  });

  const someContract = state.contracts[0];
  const fulfilledContracts = applyFulfillments(state.contracts, [
    { kind: "explicit", contractId: someContract.contractId, quantity: someContract.originalQuantity },
  ]);
  const afterQuarterEnd = updateContractStatusesForQuarterEnd(fulfilledContracts, state.currentPeriod);

  const updated = afterQuarterEnd.find((c) => c.contractId === someContract.contractId)!;
  assert.equal(updated.status, "fulfilled");

  state = { ...state, contracts: afterQuarterEnd };
  state = advanceSalesQuarter(state, { plans: buildPlans(1), marketResult: quarters[1].marketResult, marketInput: quarters[1].marketInput });
  assert.ok(state.contracts.length >= afterQuarterEnd.length);
});

test("金額（売上・利益・売掛金）フィールドが状態のどこにも存在しない", () => {
  const quarters = industryQuarters(1);
  const state = advanceSalesQuarter(initializeSalesState(INITIAL_PERIOD_V2), {
    plans: buildPlans(0),
    marketResult: quarters[0].marketResult,
    marketInput: quarters[0].marketInput,
  });
  const serialized = JSON.stringify(state.contracts) + JSON.stringify(state.history.map((h) => h.allocations));
  for (const forbidden of ["revenue", "profit", "cogs", "accountsReceivable"]) {
    assert.ok(!serialized.includes(forbidden), `state should not contain "${forbidden}"`);
  }
});
