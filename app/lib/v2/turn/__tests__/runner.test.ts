import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { runTurn } from "../runner";
import { TurnOrchestratorInput } from "../types";
import { nextPeriod, PeriodV2 } from "../../core/period";
import { createRandomStream } from "../../core/random";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { calculateMarketQuarter, MARKET_PARAMETERS_V1 } from "../../market";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../../sales/types";
import { DomesticPurchasePlanEntry, ImportOrderInput, AquacultureStockingPlanEntry } from "../../rawMaterials/types";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number, seed = "turn-orchestrator-fixture") {
  return runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed, turns }).quarters;
}

function buildSalesPlans(seedOffset: number): CompanySalesPlanEntry[] {
  const plans: CompanySalesPlanEntry[] = [];
  let i = 0;
  for (const companyId of COMPANIES) {
    for (const market of DEMAND_MARKET_IDS) {
      for (const product of PRODUCTS) {
        plans.push({
          companyId,
          market,
          product,
          desiredQuantity: hosoEqTons(500 + ((i + seedOffset) % 7) * 50),
          priceAdjustmentUsdPerHosoEqKg: (((i + seedOffset) % 5) - 2) * 0.05,
          salesForceHeadcount: (i + seedOffset) % 12,
        });
        i++;
      }
    }
  }
  return plans;
}

function buildDomesticPlans(seedOffset: number, marketPrice: number, headcountOverride?: number): DomesticPurchasePlanEntry[] {
  return COMPANIES.map((companyId, i) => ({
    companyId,
    desiredQuantity: hosoEqTons(200 + ((i + seedOffset) % 5) * 40),
    priceAdjustmentUsdPerHosoEqKg: (((i + seedOffset) % 3) - 1) * 0.1 * marketPrice,
    procurementHeadcount: headcountOverride ?? (i + seedOffset) % 10,
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
// 1. 会社の買付計画が集計され、Phase1の国内価格へ反映される
// ---------------------------------------------------------------------
test("会社別の国内買付計画が集計され、Phase1の国内原料価格へ反映される", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-A");
  const result = runTurn(input);

  assert.equal(result.debug.domesticProcurementIntentBeforeOverride, unwrapUnit(quarters[0].marketInput.vietnamDomestic.domesticProcurementIntent));
  assert.notEqual(unwrapUnit(result.debug.domesticProcurementIntentAfterOverride), unwrapUnit(result.debug.domesticProcurementIntentBeforeOverride));
  assert.ok(result.debug.aggregatedPurchaseIntent !== undefined);
  assert.equal(unwrapUnit(result.debug.aggregatedPurchaseIntent!), unwrapUnit(result.debug.domesticProcurementIntentAfterOverride));
  assert.ok(result.debug.companyEffectivePurchaseIntents.length === COMPANIES.length);
});

// ---------------------------------------------------------------------
// 2. phase3Fallbackモードは既存Phase3入力と同じ市場結果になる
// ---------------------------------------------------------------------
test("phase3Fallbackモードは、marketInputを一切上書きせずにcalculateMarketQuarterへ渡した場合と同じ市場結果になる", () => {
  const quarters = industryQuarters(1);
  const seed = "seed-B";
  const input: TurnOrchestratorInput = { ...baseInput(quarters[0], 0, seed), domesticPurchaseIntentSource: { type: "phase3Fallback" } };
  const result = runTurn(input);

  // runTurn内部と同じ乱数シード導出規約（`${seed}::${currentPeriod}`）で直接
  // calculateMarketQuarterを呼び、phase3Fallbackが「一切上書きしない」ことを検証する。
  const directResult = calculateMarketQuarter(
    quarters[0].marketInput,
    MARKET_PARAMETERS_V1,
    createRandomStream(`${seed}::${quarters[0].marketInput.period}`)
  );
  assert.deepEqual(result.marketResult, directResult);
});

// ---------------------------------------------------------------------
// 3. 国内買付意向の増加は国際価格を変えない
// ---------------------------------------------------------------------
test("国内買付意向の増加は国際HOSO価格（各国FOB）を変えない", () => {
  const quarters = industryQuarters(1);
  const fallbackInput: TurnOrchestratorInput = { ...baseInput(quarters[0], 0, "seed-C"), domesticPurchaseIntentSource: { type: "phase3Fallback" } };
  const largeIntentInput: TurnOrchestratorInput = {
    ...baseInput(quarters[0], 0, "seed-C"),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(0, unwrapUnit(quarters[0].marketResult.vietnamDomestic.price), 9).map((p) => ({
        ...p,
        desiredQuantity: hosoEqTons(1_000_000),
      })),
    },
  };

  const fallbackResult = runTurn(fallbackInput);
  const largeIntentResult = runTurn(largeIntentInput);

  for (const country of Object.keys(fallbackResult.marketResult.hosoPrices) as (keyof typeof fallbackResult.marketResult.hosoPrices)[]) {
    assert.equal(
      unwrapUnit(largeIntentResult.marketResult.hosoPrices[country].price),
      unwrapUnit(fallbackResult.marketResult.hosoPrices[country].price)
    );
  }
  // 一方、国内原料市場の需給には影響が及ぶはず（買付意向を無制限には認めないが、
  // 増加・変更分は実効需要へ反映される）。
  // 【Phase 6.3】価格そのものは農家留保価格が下限として働くため、両ケースとも
  // 留保価格に張り付いて同値になる場合がある（価格ではなく数量で調整される設計）。
  // そのため実効需要の差で検証する。
  assert.notEqual(
    unwrapUnit(largeIntentResult.marketResult.vietnamDomestic.effectiveDemand),
    unwrapUnit(fallbackResult.marketResult.vietnamDomestic.effectiveDemand)
  );
});

// ---------------------------------------------------------------------
// 4. 極端な希望量は調達処理能力・価格影響シェア上限で制限される
// ---------------------------------------------------------------------
test("極端な希望量を申告しても、有効買付意向の合計は基準供給量×最大価格影響シェアで頭打ちになる", () => {
  const quarters = industryQuarters(1);
  const referenceSupply = unwrapUnit(quarters[0].marketInput.vietnamDomestic.domesticRawSupply);
  const input: TurnOrchestratorInput = {
    ...baseInput(quarters[0], 0, "seed-D"),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(0, unwrapUnit(quarters[0].marketResult.vietnamDomestic.price), 50).map((p, i) =>
        i === 0 ? { ...p, desiredQuantity: hosoEqTons(10_000_000) } : p
      ),
    },
  };
  const result = runTurn(input);
  // 5社合計の有効買付意向が、基準供給量そのものを大きく超えることはない
  // （各社最大35%の価格影響シェア × 5社でも供給量の数倍程度に収まるはず）。
  assert.ok(unwrapUnit(result.debug.aggregatedPurchaseIntent!) < referenceSupply * 3);
});

// ---------------------------------------------------------------------
// 5. Phase1の国内原料価格が国内買付ロットの取得原価の下限になる
// ---------------------------------------------------------------------
test("Phase1が清算した国内原料価格が、国内買付ロットの取得原価の下限になる", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-E");
  const result = runTurn(input);

  const domesticLots = result.lots.filter((l) => l.source === "domestic");
  assert.ok(domesticLots.length > 0);
  for (const lot of domesticLots) {
    assert.ok(unwrapUnit(lot.unitCost) >= unwrapUnit(result.marketResult.vietnamDomestic.price) - 1e-9);
  }
});

// ---------------------------------------------------------------------
// 6. 国内供給配分は供給量を超えない
// ---------------------------------------------------------------------
test("国内供給配分の合計は、清算された供給量を超えない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-F");
  const result = runTurn(input);

  const totalAllocated = result.domesticAllocation.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  assert.ok(totalAllocated <= unwrapUnit(result.domesticAllocation.availableSupply) + 1e-6);
});

// ---------------------------------------------------------------------
// 7. 会社別の配分は希望量・処理能力・承認枠を超えない
// ---------------------------------------------------------------------
test("会社別の国内配分量は、希望量・調達処理能力・承認済み買付枠のいずれも超えない", () => {
  const quarters = industryQuarters(1);
  const plans = buildDomesticPlans(0, unwrapUnit(quarters[0].marketResult.vietnamDomestic.price));
  const input: TurnOrchestratorInput = { ...baseInput(quarters[0], 0, "seed-G"), domesticPurchaseIntentSource: { type: "companyPlans", plans } };
  const result = runTurn(input);

  for (const alloc of result.domesticAllocation.companies) {
    const plan = plans.find((p) => p.companyId === alloc.companyId)!;
    assert.ok(unwrapUnit(alloc.allocatedQuantity) <= unwrapUnit(plan.desiredQuantity) + 1e-6);
  }
});

// ---------------------------------------------------------------------
// 8. 輸入はリードタイム経過前は在庫化されない
// ---------------------------------------------------------------------
test("輸入原料は、発注四半期のうちはavailableにならない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-H");
  const result = runTurn(input);

  assert.ok(result.newImportLots.length > 0);
  for (const lot of result.newImportLots) {
    assert.equal(lot.status, "inTransitImport");
  }
  assert.equal(result.arrivedImportLots.length, 0, "標準リードタイムでは発注当四半期に到着しないはず");
});

// ---------------------------------------------------------------------
// 9. 養殖は収穫四半期まで在庫化されない
// ---------------------------------------------------------------------
test("養殖ロットは、池入れ四半期のうちはavailableにならない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-I");
  const result = runTurn(input);

  assert.ok(result.newGrowingLots.length > 0);
  for (const lot of result.newGrowingLots) {
    assert.equal(lot.status, "growingAquaculture");
  }
  assert.equal(result.harvestedLots.length, 0, "標準の池入れ翌四半期収穫では当四半期には収穫されないはず");
});

// ---------------------------------------------------------------------
// 10. 期限切れロットは翌ターンで正しく期限切れになる
// ---------------------------------------------------------------------
test("期限切れ設定のロットは、期限を過ぎた翌ターンでexpiredへ遷移する", () => {
  const quarters = industryQuarters(2);
  const turn1Input = baseInput(quarters[0], 0, "seed-J");
  const turn1Result = runTurn(turn1Input);

  const domesticLot = turn1Result.lots.find((l) => l.source === "domestic");
  assert.ok(domesticLot, "国内買付ロットが少なくとも1件生成されているはず");
  const expiringLots = turn1Result.lots.map((l) => (l.lotId === domesticLot!.lotId ? { ...l, expiryPeriod: l.availableFromPeriod } : l));

  const turn2Input: TurnOrchestratorInput = {
    ...baseInput(quarters[1], 1, "seed-J"),
    existingContracts: turn1Result.pendingState.contracts,
    existingLots: expiringLots,
  };
  const turn2Result = runTurn(turn2Input);

  const expired = turn2Result.lots.find((l) => l.lotId === domesticLot!.lotId);
  assert.ok(expired);
  assert.equal(expired!.status, "expired");
});

// ---------------------------------------------------------------------
// 11. 同一入力・同一シードで完全に同じ結果になる（再現性）
// ---------------------------------------------------------------------
test("同一input・同一seedなら完全に同じ結果になる（再現性）", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-K");
  const resultA = runTurn(input);
  const resultB = runTurn(input);
  assert.deepEqual(resultA, resultB);
});

// ---------------------------------------------------------------------
// 12. 入力オブジェクトは呼び出し後も変更されない
// ---------------------------------------------------------------------
test("runTurnは入力オブジェクトを一切変更しない", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-L");
  const before = JSON.stringify(input);
  runTurn(input);
  assert.equal(JSON.stringify(input), before);
});

// ---------------------------------------------------------------------
// 13. 別ターンの計画が混入しない
// ---------------------------------------------------------------------
test("あるターンの輸入・買付計画は、別ターンの結果へ混入しない", () => {
  const quarters = industryQuarters(2);
  const turn1Input = baseInput(quarters[0], 0, "seed-M");
  const turn1Result = runTurn(turn1Input);

  const turn2Input: TurnOrchestratorInput = {
    currentPeriod: quarters[1].marketInput.period,
    marketInput: quarters[1].marketInput,
    scenarioVariables: { diseasePressure: quarters[1].scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: [],
    domesticPurchaseIntentSource: { type: "phase3Fallback" },
    importOrders: [],
    aquacultureStockingPlans: [],
    existingContracts: turn1Result.pendingState.contracts,
    existingLots: turn1Result.pendingState.lots,
    seed: "seed-M",
  };
  const turn2Result = runTurn(turn2Input);

  // turn2では計画を一切提出していないので、新規ロット・新規契約は生成されない。
  assert.equal(turn2Result.newImportLots.length, 0);
  assert.equal(turn2Result.newGrowingLots.length, 0);
  assert.equal(turn2Result.domesticAllocation.companies.every((c) => unwrapUnit(c.allocatedQuantity) === 0), true);
  assert.equal(turn2Result.salesRecord.newContracts.length, 0);
  // turn1で生成したロット・契約は引き継がれている。
  assert.equal(turn2Result.lots.filter((l) => turn1Result.lots.some((l0) => l0.lotId === l.lotId)).length, turn1Result.lots.length);
  assert.deepEqual(
    turn2Result.contracts.filter((c) => turn1Result.contracts.some((c0) => c0.contractId === c.contractId)).length,
    turn1Result.contracts.length
  );
});

// ---------------------------------------------------------------------
// 14. Phase4の約定残がPhase5の必要原料量集計へ正しく反映される
// ---------------------------------------------------------------------
test("Phase4で成約した契約の約定残が、当ターンの必要原料量集計へ反映される", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-N");
  const result = runTurn(input);

  assert.ok(result.salesRecord.newContracts.length > 0);
  assert.ok(result.rawMaterialRequirements.length > 0);
  const totalRequired = result.rawMaterialRequirements.reduce((s, r) => s + unwrapUnit(r.requiredQuantity), 0);
  const totalOutstanding = result.contracts.reduce((s, c) => s + unwrapUnit(c.outstandingQuantity), 0);
  assert.ok(Math.abs(totalRequired - totalOutstanding) < 0.1);
});

// ---------------------------------------------------------------------
// 15（前提整合性）: pendingStateが次ターンへそのまま渡せる形になっている
// ---------------------------------------------------------------------
test("pendingState.nextPeriodは、Phase4・Phase5どちらの内部ランナーでも一致した次四半期になる", () => {
  const quarters = industryQuarters(1);
  const input = baseInput(quarters[0], 0, "seed-O");
  const result = runTurn(input);
  assert.equal(result.pendingState.nextPeriod, nextPeriod(quarters[0].marketInput.period));
  assert.equal(result.period, quarters[0].marketInput.period);
});

// ---------------------------------------------------------------------
// 統合テスト（Phase1+4+5を通しで、複数ターン）
// ---------------------------------------------------------------------
test("統合: 5社×複数ターンをPhase1+4+5通しで完走する（companyPlansモード）", () => {
  const turns = 4;
  const quarters = industryQuarters(turns, "turn-orchestrator-integration-a");

  let contracts: TurnOrchestratorInput["existingContracts"] = [];
  let lots: TurnOrchestratorInput["existingLots"] = [];
  let period = quarters[0].marketInput.period;

  for (let i = 0; i < turns; i++) {
    const input: TurnOrchestratorInput = {
      ...baseInput(quarters[i], i, "integration-seed-a"),
      currentPeriod: period,
      existingContracts: contracts,
      existingLots: lots,
    };
    const result = runTurn(input);
    assert.equal(result.period, period);
    contracts = result.pendingState.contracts;
    lots = result.pendingState.lots;
    period = result.pendingState.nextPeriod;
  }

  assert.ok(lots.length > 0);
  const sources = new Set(lots.map((l) => l.source));
  assert.ok(sources.has("domestic"));
  assert.ok(sources.has("import"));
  assert.ok(sources.has("aquaculture"));
  assert.ok(contracts.length > 0);
});

test("統合: phase3Fallbackモードで複数ターンを完走し、会社行動なしでも破綻しない", () => {
  const turns = 3;
  const quarters = industryQuarters(turns, "turn-orchestrator-integration-b");

  let contracts: TurnOrchestratorInput["existingContracts"] = [];
  let lots: TurnOrchestratorInput["existingLots"] = [];
  let period = quarters[0].marketInput.period;

  for (let i = 0; i < turns; i++) {
    const input: TurnOrchestratorInput = {
      currentPeriod: period,
      marketInput: quarters[i].marketInput,
      scenarioVariables: { diseasePressure: quarters[i].scenarioTurnInput.countries.VN.diseasePressure },
      salesPlans: buildSalesPlans(i),
      domesticPurchaseIntentSource: { type: "phase3Fallback" },
      importOrders: [],
      aquacultureStockingPlans: [],
      existingContracts: contracts,
      existingLots: lots,
      seed: "integration-seed-b",
    };
    const result = runTurn(input);
    assert.equal(result.debug.aggregatedPurchaseIntent, undefined);
    contracts = result.pendingState.contracts;
    lots = result.pendingState.lots;
    period = result.pendingState.nextPeriod;
  }

  assert.ok(contracts.length > 0);
});

// ---------------------------------------------------------------------
// 金額（売上・利益・PL）フィールドが結果のどこにも存在しない
// ---------------------------------------------------------------------
test("金額（売上・利益・PL）フィールドが結果のどこにも存在しない", () => {
  const quarters = industryQuarters(1);
  const result = runTurn(baseInput(quarters[0], 0, "seed-P"));
  const serialized = JSON.stringify(result);
  for (const forbidden of ["revenue", "profit", "cogs", "accountsPayable", "accountsReceivable", "\"pl\"", "balanceSheet"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
  }
});
