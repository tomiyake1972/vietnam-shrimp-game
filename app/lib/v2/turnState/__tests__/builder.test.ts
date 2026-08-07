import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { runTurn } from "../../turn/runner";
import { TurnOrchestratorInput } from "../../turn/types";
import { buildNextTurnInput } from "../builder";
import { TurnStateValidationError } from "../types";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../../sales/types";
import { DomesticPurchasePlanEntry, ImportOrderInput, AquacultureStockingPlanEntry } from "../../rawMaterials/types";
import { PeriodV2 } from "../../core/period";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number, seed = "turn-state-fixture") {
  return runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed, turns }).quarters;
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

function baseInput(quarter: ReturnType<typeof industryQuarters>[number], seedOffset: number, seed: string): TurnOrchestratorInput {
  return {
    currentPeriod: quarter.marketInput.period,
    marketInput: quarter.marketInput,
    scenarioVariables: { diseasePressure: quarter.scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: buildSalesPlans(seedOffset),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(seedOffset, unwrapUnit(quarter.marketResult.vietnamDomestic.price)),
    },
    importOrders: buildImportOrders(quarter.marketInput.period, seedOffset),
    aquacultureStockingPlans: buildAquaculturePlans(quarter.marketInput.period, seedOffset),
    existingContracts: [],
    existingLots: [],
    seed,
  };
}

// ---------------------------------------------------------------------
// 1. Periodを1ターン進める
// ---------------------------------------------------------------------
test("buildNextTurnInputはPeriodを1ターン進める", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-1");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  assert.equal(next.currentPeriod, "2015Q2");
  assert.equal(next.marketInput.period, "2015Q2");
});

// ---------------------------------------------------------------------
// 2. 販売契約が正しく引き継がれる
// ---------------------------------------------------------------------
test("販売契約（約定残）が次ターン入力へそのまま引き継がれる", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-2");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  assert.ok(result.contracts.length > 0);
  assert.deepEqual(next.existingContracts, result.pendingState.contracts);
  assert.deepEqual(next.existingContracts, result.contracts);
});

// ---------------------------------------------------------------------
// 3. availableロットが保持される
// ---------------------------------------------------------------------
test("availableな原料ロットは次ターン入力へ保持される", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-3");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  const availableInResult = result.lots.filter((l) => l.status === "available");
  assert.ok(availableInResult.length > 0);
  const availableInNext = next.existingLots.filter((l) => l.status === "available");
  assert.equal(availableInNext.length, availableInResult.length);
  for (const lot of availableInResult) {
    assert.ok(next.existingLots.some((l) => l.lotId === lot.lotId && l.status === "available"));
  }
});

// ---------------------------------------------------------------------
// 4. 輸入中ロットが保持される
// ---------------------------------------------------------------------
test("inTransitImport（輸送中）の原料ロットは次ターン入力へ保持される", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-4");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  const inTransitInResult = result.lots.filter((l) => l.status === "inTransitImport");
  assert.ok(inTransitInResult.length > 0);
  for (const lot of inTransitInResult) {
    assert.ok(next.existingLots.some((l) => l.lotId === lot.lotId && l.status === "inTransitImport"));
  }
});

// ---------------------------------------------------------------------
// 5. 養殖中ロットが保持される
// ---------------------------------------------------------------------
test("growingAquaculture（養殖中）の原料ロットは次ターン入力へ保持される", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-5");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  const growingInResult = result.lots.filter((l) => l.status === "growingAquaculture");
  assert.ok(growingInResult.length > 0);
  for (const lot of growingInResult) {
    assert.ok(next.existingLots.some((l) => l.lotId === lot.lotId && l.status === "growingAquaculture"));
  }
});

// ---------------------------------------------------------------------
// 6. consumedが復活しない
// ---------------------------------------------------------------------
test("consumed（消費済み）のロットは次ターン入力へ引き継がれず、復活もしない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-6");
  const result = runTurn(input);

  const domesticLot = result.lots.find((l) => l.source === "domestic" && l.status === "available");
  assert.ok(domesticLot, "国内買付ロットが少なくとも1件生成されているはず");
  const consumedLots = result.lots.map((l) => (l.lotId === domesticLot!.lotId ? { ...l, status: "consumed" as const, remainingQuantity: hosoEqTons(0) } : l));
  const resultWithConsumed = { ...result, lots: consumedLots, pendingState: { ...result.pendingState, lots: consumedLots } };

  const next = buildNextTurnInput(input, resultWithConsumed);
  assert.ok(!next.existingLots.some((l) => l.lotId === domesticLot!.lotId));
});

// ---------------------------------------------------------------------
// 7. expiredが復活しない
// ---------------------------------------------------------------------
test("expired（期限切れ）のロットは次ターン入力へ引き継がれず、復活もしない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-7");
  const result = runTurn(input);

  const domesticLot = result.lots.find((l) => l.source === "domestic" && l.status === "available");
  assert.ok(domesticLot);
  const expiredLots = result.lots.map((l) => (l.lotId === domesticLot!.lotId ? { ...l, status: "expired" as const } : l));
  const resultWithExpired = { ...result, lots: expiredLots, pendingState: { ...result.pendingState, lots: expiredLots } };

  const next = buildNextTurnInput(input, resultWithExpired);
  assert.ok(!next.existingLots.some((l) => l.lotId === domesticLot!.lotId));
});

// ---------------------------------------------------------------------
// 8. 販売計画がコピーされない
// ---------------------------------------------------------------------
test("販売計画は次ターン入力へコピーされない（空配列にリセットされる）", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-8");
  assert.ok(input.salesPlans.length > 0);
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  assert.equal(next.salesPlans.length, 0);
});

// ---------------------------------------------------------------------
// 9. 国内買付計画がコピーされない
// ---------------------------------------------------------------------
test("国内買付計画は次ターン入力へコピーされない（空のcompanyPlansにリセットされる）", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-9");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  assert.equal(next.domesticPurchaseIntentSource.type, "companyPlans");
  assert.equal(
    next.domesticPurchaseIntentSource.type === "companyPlans" ? next.domesticPurchaseIntentSource.plans.length : -1,
    0
  );
  assert.equal(next.importOrders.length, 0);
  assert.equal(next.aquacultureStockingPlans.length, 0);
});

// ---------------------------------------------------------------------
// 10. debug情報が残らない
// ---------------------------------------------------------------------
test("次ターン入力にdebug情報は一切含まれない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-10");
  const result = runTurn(input);
  const next = buildNextTurnInput(input, result);

  assert.equal((next as unknown as Record<string, unknown>).debug, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(next, "debug"));
});

// ---------------------------------------------------------------------
// 11. builderが入力を書き換えない
// ---------------------------------------------------------------------
test("buildNextTurnInputはpreviousInput・turnResultのいずれも変更しない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-11");
  const result = runTurn(input);
  const beforeInput = JSON.stringify(input);
  const beforeResult = JSON.stringify(result);

  buildNextTurnInput(input, result);

  assert.equal(JSON.stringify(input), beforeInput);
  assert.equal(JSON.stringify(result), beforeResult);
});

// ---------------------------------------------------------------------
// 12. runTurn → buildNextTurnInput → runTurn の2ターン統合テスト
// ---------------------------------------------------------------------
test("統合: runTurn → buildNextTurnInput → runTurnで2ターンを完走する", () => {
  const quarters = industryQuarters(2, "turn-state-integration");
  const seed = "integration-seed";

  const turn1Input = baseInput(quarters[0], 0, seed);
  const turn1Result = runTurn(turn1Input);

  const skeleton = buildNextTurnInput(turn1Input, turn1Result);
  const turn2Input: TurnOrchestratorInput = {
    ...skeleton,
    marketInput: quarters[1].marketInput,
    scenarioVariables: { diseasePressure: quarters[1].scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: buildSalesPlans(1),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(1, unwrapUnit(quarters[1].marketResult.vietnamDomestic.price)),
    },
    importOrders: buildImportOrders(quarters[1].marketInput.period, 1),
    aquacultureStockingPlans: buildAquaculturePlans(quarters[1].marketInput.period, 1),
  };

  assert.equal(turn2Input.currentPeriod, "2015Q2");
  assert.deepEqual(turn2Input.existingContracts, turn1Result.contracts);

  const turn2Result = runTurn(turn2Input);
  assert.equal(turn2Result.period, "2015Q2");
  assert.ok(turn2Result.contracts.length >= turn1Result.contracts.length);
  // 1ターン目のavailableロットが2ターン目でも消えていない（引き継がれている）。
  const turn1Available = turn1Result.lots.filter((l) => l.status === "available");
  for (const lot of turn1Available) {
    assert.ok(turn2Result.lots.some((l) => l.lotId === lot.lotId));
  }
});

// ---------------------------------------------------------------------
// 13. 同一seedなら2ターン実行結果が一致する
// ---------------------------------------------------------------------
test("同一seedで2ターンを実行すると、2回とも完全に同じ結果になる", () => {
  const quarters = industryQuarters(2, "turn-state-repro");
  const seed = "repro-seed";

  function runTwoTurns() {
    const turn1Input = baseInput(quarters[0], 0, seed);
    const turn1Result = runTurn(turn1Input);
    const skeleton = buildNextTurnInput(turn1Input, turn1Result);
    const turn2Input: TurnOrchestratorInput = {
      ...skeleton,
      marketInput: quarters[1].marketInput,
      scenarioVariables: { diseasePressure: quarters[1].scenarioTurnInput.countries.VN.diseasePressure },
      salesPlans: buildSalesPlans(1),
      domesticPurchaseIntentSource: {
        type: "companyPlans",
        plans: buildDomesticPlans(1, unwrapUnit(quarters[1].marketResult.vietnamDomestic.price)),
      },
      importOrders: buildImportOrders(quarters[1].marketInput.period, 1),
      aquacultureStockingPlans: buildAquaculturePlans(quarters[1].marketInput.period, 1),
    };
    const turn2Result = runTurn(turn2Input);
    return { turn1Result, turn2Result };
  }

  const a = runTwoTurns();
  const b = runTwoTurns();
  assert.deepEqual(a.turn1Result, b.turn1Result);
  assert.deepEqual(a.turn2Result, b.turn2Result);
});

// ---------------------------------------------------------------------
// 追加: previousInputとturnResultの組み合わせが誤っている場合は例外を投げる
// ---------------------------------------------------------------------
test("previousInput.currentPeriodとturnResult.periodが一致しない場合は例外を投げる", () => {
  const quarters = industryQuarters(2, "turn-state-mismatch");
  const turn1Input = baseInput(quarters[0], 0, "seed-mismatch");
  const turn1Result = runTurn(turn1Input);
  const unrelatedInput = baseInput(quarters[1], 1, "seed-mismatch-2");

  assert.throws(() => buildNextTurnInput(unrelatedInput, turn1Result), TurnStateValidationError);
});

// ---------------------------------------------------------------------
// 14. 異なるseedでは必要な箇所のみ差異が出る
// ---------------------------------------------------------------------
test("異なるseedでは、乱数に依存する国際HOSO価格のショックのみに差異が出る（国内配分ロジック自体は変わらない）", () => {
  const quarters = industryQuarters(1, "turn-state-seed-diff");
  const inputA = baseInput(quarters[0], 0, "seed-X");
  const inputB = baseInput(quarters[0], 0, "seed-Y");

  const resultA = runTurn(inputA);
  const resultB = runTurn(inputB);

  // 乱数（HOSO価格ショック）に依存する国際価格は、seedが違えば異なりうる。
  const pricesDiffer = (Object.keys(resultA.marketResult.hosoPrices) as (keyof typeof resultA.marketResult.hosoPrices)[]).some(
    (country) => unwrapUnit(resultA.marketResult.hosoPrices[country].price) !== unwrapUnit(resultB.marketResult.hosoPrices[country].price)
  );
  assert.ok(pricesDiffer, "異なるseedなら、乱数依存のHOSO価格ショックに差異が出るはず");

  // 一方、同一の会社別計画・同一の市場入力から決定論的に計算される国内配分の
  // 会社一覧・件数自体は、乱数の影響を受けないため一致するはず。
  assert.equal(resultA.domesticAllocation.companies.length, resultB.domesticAllocation.companies.length);
  assert.deepEqual(
    resultA.domesticAllocation.companies.map((c) => c.companyId),
    resultB.domesticAllocation.companies.map((c) => c.companyId)
  );
});
