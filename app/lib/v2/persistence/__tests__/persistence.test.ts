import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { runTurn } from "../../turn/runner";
import { TurnOrchestratorInput } from "../../turn/types";
import { PeriodV2 } from "../../core/period";
import { hosoEqTons, ratio, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { CompanySalesPlanEntry, SalesContract } from "../../sales/types";
import { DomesticPurchasePlanEntry, ImportOrderInput, AquacultureStockingPlanEntry, RawMaterialLot } from "../../rawMaterials/types";
import {
  createInitialPersistedGameState,
  applyTurnResultToPersistedState,
  hydrateTurnInputFromPersistedState,
} from "../builder";
import { encodePersistedGameState, decodePersistedGameState } from "../codec";
import { validatePersistedGameState } from "../schema";
import { ExternalTurnInput, PersistedGameStateV2 } from "../types";
import {
  PersistedStateParseError,
  PersistedStateTransitionError,
  PersistedStateValidationError,
  UnsupportedPersistedStateVersionError,
} from "../errors";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number, seed = "persistence-fixture") {
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

function externalInput(quarter: ReturnType<typeof industryQuarters>[number], seedOffset: number): ExternalTurnInput {
  return {
    marketInput: quarter.marketInput,
    scenarioVariables: { diseasePressure: quarter.scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: buildSalesPlans(seedOffset),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: buildDomesticPlans(seedOffset, unwrapUnit(quarter.marketResult.vietnamDomestic.price)),
    },
    importOrders: buildImportOrders(quarter.marketInput.period, seedOffset),
    aquacultureStockingPlans: buildAquaculturePlans(quarter.marketInput.period, seedOffset),
  };
}

function makeContract(overrides: Partial<SalesContract> = {}): SalesContract {
  return {
    contractId: "CT-1",
    companyId: "C1",
    market: "CN",
    product: "hoso",
    contractedPeriod: "2015Q1" as PeriodV2,
    dueDate: "2015Q2" as PeriodV2,
    originalQuantity: hosoEqTons(100),
    outstandingQuantity: hosoEqTons(100),
    unitPrice: usdPerHosoEqKg(3),
    status: "open",
    ...overrides,
  };
}

function makeLot(overrides: Partial<RawMaterialLot> = {}): RawMaterialLot {
  return {
    lotId: "L-1",
    companyId: "C1",
    source: "domestic",
    originCountry: "VN",
    inboundPeriod: "2015Q1" as PeriodV2,
    originalQuantity: hosoEqTons(50),
    remainingQuantity: hosoEqTons(50),
    unitCost: usdPerHosoEqKg(3),
    availableFromPeriod: "2015Q1" as PeriodV2,
    status: "available",
    ...overrides,
  };
}

function initialStateWithData(): PersistedGameStateV2 {
  return createInitialPersistedGameState({
    gameId: "game-1",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "persistence-seed",
    initialContracts: [makeContract({ contractId: "CT-1" }), makeContract({ contractId: "CT-2", companyId: "C2", status: "fulfilled", outstandingQuantity: hosoEqTons(0) })],
    initialRawMaterialLots: [
      makeLot({ lotId: "L-1", status: "available" }),
      makeLot({ lotId: "L-2", status: "inTransitImport", source: "import" }),
      makeLot({
        lotId: "L-3",
        status: "growingAquaculture",
        source: "aquaculture",
        pendingAquacultureIntensity: ratio(0.4),
        pendingBioSecurityLevel: ratio(0.6),
        pendingPlannedStockingQuantity: hosoEqTons(40),
      }),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

// ===========================================================================
// Encode / Decode
// ===========================================================================

test("1: 初期状態をencodeしてdecodeすると元の状態と一致する", () => {
  // JSONは「キーが存在し値がundefined」と「キーが存在しない」を区別できない
  // （どちらもJSON上では単にキーが出力されない）。そのため往復の一致判定は
  // 「もう一度encodeした結果が、最初のencode結果と完全一致するか」で行う
  // （JSONとして表現可能な情報がすべて正しく往復していることを保証する、
  // JSONベースのcodecにとって本質的な不変条件）。
  const state = initialStateWithData();
  const serialized = encodePersistedGameState(state);
  const decoded = decodePersistedGameState(serialized);
  assert.equal(encodePersistedGameState(decoded), serialized);
  // ブランド型・列挙値等、意味のある値そのものも直接確認する。
  assert.equal(decoded.gameId, state.gameId);
  assert.equal(decoded.contracts.length, state.contracts.length);
  assert.equal(decoded.rawMaterialLots.length, state.rawMaterialLots.length);
});

test("2: ターン完了後の状態も往復一致する", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-2",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-2",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const input = hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0));
  const result = runTurn(input);
  const state1 = applyTurnResultToPersistedState(state0, result, "exec-1", "2026-01-02T00:00:00.000Z");

  const serialized = encodePersistedGameState(state1);
  const decoded = decodePersistedGameState(serialized);
  assert.equal(encodePersistedGameState(decoded), serialized);
  assert.equal(decoded.currentPeriod, state1.currentPeriod);
  assert.equal(decoded.execution.completedTurnCount, state1.execution.completedTurnCount);
});

test("3: 同一状態のencode結果が完全一致する", () => {
  const state = initialStateWithData();
  const a = encodePersistedGameState(state);
  const b = encodePersistedGameState({ ...state });
  assert.equal(a, b);
});

test("4: 契約・ロットの配列順序が保持される", () => {
  const state = initialStateWithData();
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded.contracts.map((c) => c.contractId), state.contracts.map((c) => c.contractId));
  assert.deepEqual(decoded.rawMaterialLots.map((l) => l.lotId), state.rawMaterialLots.map((l) => l.lotId));
});

test("5: 入力オブジェクトが変更されない（encode/decode）", () => {
  const state = initialStateWithData();
  const before = JSON.stringify(state);
  const serialized = encodePersistedGameState(state);
  decodePersistedGameState(serialized);
  assert.equal(JSON.stringify(state), before);
});

// ===========================================================================
// JSON不正
// ===========================================================================

test("6: 不正JSONをparse errorとして拒否する", () => {
  assert.throws(() => decodePersistedGameState("{not valid json"), PersistedStateParseError);
});

test("7: nullを拒否する", () => {
  assert.throws(() => decodePersistedGameState("null"), PersistedStateValidationError);
});

test("8: 配列をトップレベル状態として拒否する", () => {
  assert.throws(() => decodePersistedGameState("[]"), PersistedStateValidationError);
});

test("8b: costSnapshot付き契約がラウンドトリップで保持される（schemaVersion 2、Phase 6.3）", () => {
  const state = createInitialPersistedGameState({
    gameId: "game-cs",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "cs-seed",
    initialContracts: [
      makeContract({
        contractId: "CT-CS",
        costSnapshot: {
          expectedRawMaterialPriceUsdPerHosoEqKg: 2.5,
          expectedProcessingCostUsdPerHosoEqKg: 0.75,
          minimumAcceptablePriceUsdPerHosoEqKg: 3.4,
          expectedContributionMarginUsdPerHosoEqKg: 1.06,
        },
      }),
    ],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const decoded = decodePersistedGameState(encodePersistedGameState(state));
  assert.deepEqual(decoded.contracts[0].costSnapshot, {
    expectedRawMaterialPriceUsdPerHosoEqKg: 2.5,
    expectedProcessingCostUsdPerHosoEqKg: 0.75,
    minimumAcceptablePriceUsdPerHosoEqKg: 3.4,
    expectedContributionMarginUsdPerHosoEqKg: 1.06,
  });
});

test("8c: schemaVersion 1（costSnapshotなし）の旧データもそのまま読める（後方互換）", () => {
  const dto = JSON.parse(encodePersistedGameState(initialStateWithData())) as Record<string, unknown>;
  dto.schemaVersion = 1;
  const decoded = decodePersistedGameState(JSON.stringify(dto));
  assert.equal(decoded.schemaVersion, 1);
  assert.equal(decoded.contracts[0].costSnapshot, undefined);
});

test("9: schemaVersion欠落を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  delete dto.schemaVersion;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("10: 将来の未対応versionを専用エラーで拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.schemaVersion = 999;
  assert.throws(() => validatePersistedGameState(dto), UnsupportedPersistedStateVersionError);
});

// ===========================================================================
// 数値・型
// ===========================================================================

test("11: NaN相当・不正文字列・nullの数量を拒否する", () => {
  const state = initialStateWithData();
  for (const bad of [NaN, "abc", null]) {
    const dto = JSON.parse(encodePersistedGameState(state));
    dto.rawMaterialLots[0].originalQuantity = bad;
    assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
  }
});

test("12: 負の数量を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.rawMaterialLots[0].originalQuantity = -1;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("13: remainingQuantityがoriginalQuantityを超えるロットを拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.rawMaterialLots[0].remainingQuantity = dto.rawMaterialLots[0].originalQuantity + 100;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("14: 負のunitCostを拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.rawMaterialLots[0].unitCost = -0.5;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("15: completedTurnCountの小数を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.execution.completedTurnCount = 1.5;
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

// ===========================================================================
// 列挙値・期間
// ===========================================================================

test("16: 不正なcontract statusを拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.contracts[0].status = "notAStatus";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("17: 不正なlot statusを拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.rawMaterialLots[0].status = "notAStatus";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("18: 不正なlot sourceを拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.rawMaterialLots[0].source = "notASource";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("19: 不正なPeriodV2を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.currentPeriod = "not-a-period";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("20: statusとlot固有フィールドの不整合を拒否する", () => {
  const state = initialStateWithData();
  // (a) inTransitImportなのにsourceがdomestic
  const dtoA = JSON.parse(encodePersistedGameState(state));
  dtoA.rawMaterialLots[1].source = "domestic";
  assert.throws(() => validatePersistedGameState(dtoA), PersistedStateValidationError);

  // (b) growingAquacultureなのにpending系フィールドが欠落
  const dtoB = JSON.parse(encodePersistedGameState(state));
  delete dtoB.rawMaterialLots[2].pendingAquacultureIntensity;
  assert.throws(() => validatePersistedGameState(dtoB), PersistedStateValidationError);

  // (c) availableなのにpending系フィールドが混入
  const dtoC = JSON.parse(encodePersistedGameState(state));
  dtoC.rawMaterialLots[0].pendingAquacultureIntensity = 0.5;
  assert.throws(() => validatePersistedGameState(dtoC), PersistedStateValidationError);
});

// ===========================================================================
// Timestamp
// ===========================================================================

test("21: 不正な日時文字列を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.metadata.createdAt = "not-a-date";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

test("22: createdAtよりupdatedAtが前の場合を拒否する", () => {
  const state = initialStateWithData();
  const dto = JSON.parse(encodePersistedGameState(state));
  dto.metadata.createdAt = "2026-01-05T00:00:00.000Z";
  dto.metadata.updatedAt = "2026-01-01T00:00:00.000Z";
  assert.throws(() => validatePersistedGameState(dto), PersistedStateValidationError);
});

// ===========================================================================
// State transition
// ===========================================================================

test("23: applyTurnResultToPersistedStateがperiodを正しく進める", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-23",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-23",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const result = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  const state1 = applyTurnResultToPersistedState(state0, result, "exec-23", "2026-01-02T00:00:00.000Z");
  assert.equal(state1.currentPeriod, "2015Q2");
});

test("24: contractsとlotsをpendingStateから更新する", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-24",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-24",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const result = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  const state1 = applyTurnResultToPersistedState(state0, result, "exec-24", "2026-01-02T00:00:00.000Z");
  assert.deepEqual(state1.contracts, result.pendingState.contracts);
  assert.deepEqual(state1.rawMaterialLots, result.pendingState.lots);
});

test("25: completedTurnCountを1増やす", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-25",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-25",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const result = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  const state1 = applyTurnResultToPersistedState(state0, result, "exec-25", "2026-01-02T00:00:00.000Z");
  assert.equal(state0.execution.completedTurnCount, 0);
  assert.equal(state1.execution.completedTurnCount, 1);
});

test("26: createdAtを維持してupdatedAtだけ更新する", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-26",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-26",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const result = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  const state1 = applyTurnResultToPersistedState(state0, result, "exec-26", "2026-01-02T00:00:00.000Z");
  assert.equal(state1.metadata.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(state1.metadata.updatedAt, "2026-01-02T00:00:00.000Z");
});

test("27: previousStateを変更しない", () => {
  const quarters = industryQuarters(1);
  const state0 = createInitialPersistedGameState({
    gameId: "game-27",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-27",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const before = JSON.stringify(state0);
  const result = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  applyTurnResultToPersistedState(state0, result, "exec-27", "2026-01-02T00:00:00.000Z");
  assert.equal(JSON.stringify(state0), before);
});

test("28: period不一致を拒否する", () => {
  const quarters = industryQuarters(2);
  const state0 = createInitialPersistedGameState({
    gameId: "game-28",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-28",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  // quarters[1]（別ターン）の入力からrunTurnした結果を、state0（quarters[0]時点）へ適用しようとする。
  const unrelatedInput: TurnOrchestratorInput = hydrateTurnInputFromPersistedState(
    { ...state0, currentPeriod: quarters[1].marketInput.period },
    externalInput(quarters[1], 1)
  );
  const unrelatedResult = runTurn(unrelatedInput);
  assert.throws(() => applyTurnResultToPersistedState(state0, unrelatedResult, "exec-28", "2026-01-02T00:00:00.000Z"), PersistedStateTransitionError);
});

test("29: 同一turnExecutionIdの再適用を拒否する", () => {
  const quarters = industryQuarters(2);
  const state0 = createInitialPersistedGameState({
    gameId: "game-29",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-29",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const result0 = runTurn(hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0)));
  const state1 = applyTurnResultToPersistedState(state0, result0, "exec-dup", "2026-01-02T00:00:00.000Z");

  const result1 = runTurn(hydrateTurnInputFromPersistedState(state1, externalInput(quarters[1], 1)));
  assert.throws(() => applyTurnResultToPersistedState(state1, result1, "exec-dup", "2026-01-03T00:00:00.000Z"), PersistedStateTransitionError);
});

// ===========================================================================
// Hydration
// ===========================================================================

test("30: 永続状態と外部入力から正しいTurnOrchestratorInputを生成する", () => {
  const quarters = industryQuarters(1);
  const state = initialStateWithData();
  const ext = externalInput(quarters[0], 0);
  const turnInput = hydrateTurnInputFromPersistedState(state, ext);

  assert.equal(turnInput.currentPeriod, state.currentPeriod);
  assert.equal(turnInput.seed, state.seed);
  assert.deepEqual(turnInput.existingContracts, state.contracts);
  assert.deepEqual(turnInput.existingLots, state.rawMaterialLots);
  assert.deepEqual(turnInput.marketInput, ext.marketInput);
  assert.deepEqual(turnInput.salesPlans, ext.salesPlans);
});

test("31: currentPeriod、seed、contracts、lotsが永続状態由来である", () => {
  const quarters = industryQuarters(1);
  const state = initialStateWithData();
  const ext = externalInput(quarters[0], 0);
  const turnInput = hydrateTurnInputFromPersistedState(state, ext);

  assert.equal(turnInput.currentPeriod, state.currentPeriod);
  assert.equal(turnInput.seed, state.seed);
  // externalTurnInput型自体にcurrentPeriod/seed/existingContracts/existingLotsが
  // 存在しないため、型レベルで永続状態側からのみ注入されることが保証される。
  assert.ok(!("currentPeriod" in ext));
  assert.ok(!("seed" in ext));
  assert.ok(!("existingContracts" in ext));
  assert.ok(!("existingLots" in ext));
});

test("32: 毎ターン計画が外部入力由来である", () => {
  const quarters = industryQuarters(1);
  const state = initialStateWithData();
  const ext = externalInput(quarters[0], 0);
  const turnInput = hydrateTurnInputFromPersistedState(state, ext);

  assert.deepEqual(turnInput.salesPlans, ext.salesPlans);
  assert.deepEqual(turnInput.domesticPurchaseIntentSource, ext.domesticPurchaseIntentSource);
  assert.deepEqual(turnInput.importOrders, ext.importOrders);
  assert.deepEqual(turnInput.aquacultureStockingPlans, ext.aquacultureStockingPlans);
});

test("33: debug・過去結果が混入しない", () => {
  const quarters = industryQuarters(1);
  const state = initialStateWithData();
  const ext = externalInput(quarters[0], 0);
  const turnInput = hydrateTurnInputFromPersistedState(state, ext);
  assert.ok(!Object.prototype.hasOwnProperty.call(turnInput, "debug"));
  assert.ok(!Object.prototype.hasOwnProperty.call(turnInput, "pendingState"));
});

test("34: hydration後にrunTurnを実行できる", () => {
  const quarters = industryQuarters(1);
  const state = createInitialPersistedGameState({
    gameId: "game-34",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-34",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const turnInput = hydrateTurnInputFromPersistedState(state, externalInput(quarters[0], 0));
  const result = runTurn(turnInput);
  assert.equal(result.period, quarters[0].marketInput.period);
  assert.ok(result.contracts.length > 0);
});

// ===========================================================================
// End-to-end（2ターンのSave/Load往復、Phase1+4+5を通過する統合テスト）
// ===========================================================================

test("35-42: create → hydrate → runTurn → apply → encode → decode → 次ターンhydrate → runTurn の2ターン往復（統合）", () => {
  const quarters = industryQuarters(2, "persistence-e2e");
  const seed = "e2e-seed";

  function runTwoTurns() {
    // 35. create initial state
    const state0 = createInitialPersistedGameState({
      gameId: "game-e2e",
      scenarioId: "baseline-v0.1",
      initialPeriod: quarters[0].marketInput.period,
      seed,
      initialContracts: [],
      initialRawMaterialLots: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // 36. hydrate / 37. runTurn
    const input1 = hydrateTurnInputFromPersistedState(state0, externalInput(quarters[0], 0));
    const result1 = runTurn(input1);

    // 38. apply result
    const state1 = applyTurnResultToPersistedState(state0, result1, "turn-1", "2026-01-02T00:00:00.000Z");

    // 39. encode / 40. decode
    const serialized = encodePersistedGameState(state1);
    const decodedState1 = decodePersistedGameState(serialized);
    assert.equal(encodePersistedGameState(decodedState1), serialized);

    // 41. 次ターンをhydrate / 42. runTurn
    const input2 = hydrateTurnInputFromPersistedState(decodedState1, externalInput(quarters[1], 1));
    const result2 = runTurn(input2);
    const state2 = applyTurnResultToPersistedState(decodedState1, result2, "turn-2", "2026-01-03T00:00:00.000Z");

    return { state0, result1, state1, decodedState1, result2, state2 };
  }

  const a = runTwoTurns();
  const b = runTwoTurns();

  // 2ターン完走の確認
  assert.equal(a.state1.currentPeriod, "2015Q2");
  assert.equal(a.state2.currentPeriod, "2015Q3");
  assert.equal(a.state2.execution.completedTurnCount, 2);
  assert.ok(a.result1.contracts.length > 0);
  assert.ok(a.result2.lots.length > 0);
  // Phase1+4+5を通過していること（市場結果・成約・原料ロットのいずれも生成されている）。
  const sources = new Set(a.state2.rawMaterialLots.map((l) => l.source));
  assert.ok(sources.has("domestic") || sources.has("import") || sources.has("aquaculture"));

  // 同一seed・同一入力なら、2回実行した結果が完全に一致する。
  assert.deepEqual(a.state1, b.state1);
  assert.deepEqual(a.state2, b.state2);
  assert.deepEqual(a.result1, b.result1);
  assert.deepEqual(a.result2, b.result2);
});
