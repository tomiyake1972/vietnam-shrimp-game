import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../industryLab/simulationRunner";
import { hosoEqTons, ratio, unwrapUnit } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { DEMAND_MARKET_IDS, Product } from "../../market/types";
import { CompanySalesPlanEntry } from "../../sales/types";
import { DomesticPurchasePlanEntry, ImportOrderInput, AquacultureStockingPlanEntry } from "../../rawMaterials/types";
import { ExternalTurnInput, createInitialPersistedGameState, encodePersistedGameState } from "../../persistence";
import { createGameStateRepository } from "../repository";
import { V2RedisClient, GameStateRepositoryDependencies } from "../types";
import { GameNotFoundError, DuplicateTurnExecutionError, PersistenceError, SerializationError } from "../errors";
import { gameKeyV2 } from "../redisKeys";

const COMPANIES = ["C1", "C2", "C3", "C4", "C5"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function industryQuarters(turns: number, seed = "v2-redis-fixture") {
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

/**
 * V2RedisClientのインメモリfake実装。実際のRedis接続・環境変数は一切不要。
 * Upstashの挙動（`get`はキー未存在ならnullを返す、`exists`は件数を返す）を
 * 忠実に模倣する。`asStoredObject`をtrueにすると、値をJSON文字列ではなく
 * 既にパース済みのプレーンオブジェクトとして返す（Upstashの自動deserializeを
 * 再現し、decodePersistedGameStateFromStoredの両対応を検証するため）。
 */
function createFakeV2RedisClient(options: { asStoredObject?: boolean } = {}): V2RedisClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<unknown> {
      const value = store.get(key);
      if (value === undefined) return null;
      return options.asStoredObject ? JSON.parse(value) : value;
    },
    async set(key: string, value: string): Promise<unknown> {
      store.set(key, value);
      return "OK";
    },
    async exists(key: string): Promise<number> {
      return store.has(key) ? 1 : 0;
    },
    async del(key: string): Promise<unknown> {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    },
  };
}

function makeDeps(overrides: Partial<GameStateRepositoryDependencies> = {}): GameStateRepositoryDependencies {
  return {
    client: createFakeV2RedisClient(),
    appVersion: "v2",
    appEnv: "staging",
    ...overrides,
  };
}

// ===========================================================================
// Repository: save / load / exists / delete
// ===========================================================================

test("save: saveGameStateで保存した内容がRedis（fake）に書き込まれる", async () => {
  const deps = makeDeps();
  const repo = createGameStateRepository(deps);
  const state = createInitialPersistedGameState({
    gameId: "game-save",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-save",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  const key = gameKeyV2("staging", "game-save");
  assert.ok((deps.client as ReturnType<typeof createFakeV2RedisClient>).store.has(key));
});

test("load: saveGameStateで保存した状態をloadGameStateで正しく読み込める", async () => {
  const repo = createGameStateRepository(makeDeps());
  const state = createInitialPersistedGameState({
    gameId: "game-load",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-load",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  const loaded = await repo.loadGameState("game-load");
  assert.equal(loaded.gameId, "game-load");
  assert.equal(loaded.seed, "seed-load");
  assert.equal(loaded.currentPeriod, "2015Q1");
});

test("exists: 保存前はfalse、保存後はtrueを返す", async () => {
  const repo = createGameStateRepository(makeDeps());
  assert.equal(await repo.gameExists("game-exists"), false);
  const state = createInitialPersistedGameState({
    gameId: "game-exists",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-exists",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  assert.equal(await repo.gameExists("game-exists"), true);
});

test("delete: 削除後はexistsがfalseになり、loadはGameNotFoundErrorになる", async () => {
  const repo = createGameStateRepository(makeDeps());
  const state = createInitialPersistedGameState({
    gameId: "game-delete",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-delete",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  await repo.deleteGame("game-delete");
  assert.equal(await repo.gameExists("game-delete"), false);
  await assert.rejects(() => repo.loadGameState("game-delete"), GameNotFoundError);
});

test("delete: 本番環境（appEnv=production）ではdeleteGameが拒否される", async () => {
  const repo = createGameStateRepository(makeDeps({ appEnv: "production" }));
  await assert.rejects(() => repo.deleteGame("game-prod-delete"), PersistenceError);
});

// ===========================================================================
// encode/decode（Repository経由でも往復一致）
// ===========================================================================

test("encode/decode: Repository経由で保存・読み込みしても、encodeした文字列と完全一致する", async () => {
  const repo = createGameStateRepository(makeDeps());
  const state = createInitialPersistedGameState({
    gameId: "game-codec",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-codec",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  const loaded = await repo.loadGameState("game-codec");
  assert.equal(encodePersistedGameState(loaded), encodePersistedGameState(state));
});

test("encode/decode: Redisクライアントが既にパース済みのオブジェクトを返す場合も正しく読み込める", async () => {
  const deps = makeDeps({ client: createFakeV2RedisClient({ asStoredObject: true }) });
  const repo = createGameStateRepository(deps);
  const state = createInitialPersistedGameState({
    gameId: "game-preparsed",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-preparsed",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);
  const loaded = await repo.loadGameState("game-preparsed");
  assert.equal(loaded.gameId, "game-preparsed");
});

// ===========================================================================
// applyTurn
// ===========================================================================

test("applyTurn: 正常にターンを実行し、状態を更新・保存する", async () => {
  const quarters = industryQuarters(1);
  const repo = createGameStateRepository(makeDeps());
  const initial = createInitialPersistedGameState({
    gameId: "game-apply",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-apply",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(initial);

  const outcome = await repo.applyTurn("game-apply", externalInput(quarters[0], 0), "exec-1", "2026-01-02T00:00:00.000Z");
  assert.equal(outcome.state.currentPeriod, "2015Q2");
  assert.equal(outcome.state.execution.completedTurnCount, 1);
  assert.equal(outcome.turnResult.period, "2015Q1");

  const reloaded = await repo.loadGameState("game-apply");
  assert.equal(reloaded.currentPeriod, "2015Q2");
  assert.equal(reloaded.execution.lastTurnExecutionId, "exec-1");
});

// ===========================================================================
// duplicate execution
// ===========================================================================

test("duplicate execution: 同一turnExecutionIdの再適用はDuplicateTurnExecutionErrorで拒否される", async () => {
  const quarters = industryQuarters(2);
  const repo = createGameStateRepository(makeDeps());
  const initial = createInitialPersistedGameState({
    gameId: "game-dup",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-dup",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(initial);

  await repo.applyTurn("game-dup", externalInput(quarters[0], 0), "exec-dup", "2026-01-02T00:00:00.000Z");
  await assert.rejects(
    () => repo.applyTurn("game-dup", externalInput(quarters[1], 1), "exec-dup", "2026-01-03T00:00:00.000Z"),
    DuplicateTurnExecutionError
  );

  // 二重反映が実際に起きていないこと（completedTurnCountが2にならず1のまま）を確認する。
  const reloaded = await repo.loadGameState("game-dup");
  assert.equal(reloaded.execution.completedTurnCount, 1);
});

// ===========================================================================
// game not found
// ===========================================================================

test("game not found: 存在しないgameIdへのload/applyTurnは正しく失敗する", async () => {
  const quarters = industryQuarters(1);
  const repo = createGameStateRepository(makeDeps());
  await assert.rejects(() => repo.loadGameState("no-such-game"), GameNotFoundError);
  await assert.rejects(
    () => repo.applyTurn("no-such-game", externalInput(quarters[0], 0), "exec-x", "2026-01-02T00:00:00.000Z"),
    GameNotFoundError
  );
});

// ===========================================================================
// schema version（不正データ拒否）
// ===========================================================================

test("schema version: 不正・未対応なschemaVersionを持つ保存データはSerializationErrorとして拒否される", async () => {
  const deps = makeDeps();
  const repo = createGameStateRepository(deps);
  const state = createInitialPersistedGameState({
    gameId: "game-badversion",
    scenarioId: "baseline-v0.1",
    initialPeriod: "2015Q1" as PeriodV2,
    seed: "seed-badversion",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.saveGameState(state);

  // fakeクライアントのstoreを直接書き換えて、保存済みJSONのschemaVersionを破壊する。
  const key = gameKeyV2("staging", "game-badversion");
  const client = deps.client as ReturnType<typeof createFakeV2RedisClient>;
  const corrupted = JSON.parse(client.store.get(key)!);
  corrupted.schemaVersion = 999;
  client.store.set(key, JSON.stringify(corrupted));

  await assert.rejects(() => repo.loadGameState("game-badversion"), SerializationError);
});

// ===========================================================================
// immutable（入力変更なし）
// ===========================================================================

test("immutable: saveGameState/applyTurnは渡した入力オブジェクトを変更しない", async () => {
  const quarters = industryQuarters(1);
  const repo = createGameStateRepository(makeDeps());
  const initial = createInitialPersistedGameState({
    gameId: "game-immutable",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-immutable",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const beforeInitial = JSON.stringify(initial);
  await repo.saveGameState(initial);
  assert.equal(JSON.stringify(initial), beforeInitial);

  const ext = externalInput(quarters[0], 0);
  const beforeExt = JSON.stringify(ext);
  await repo.applyTurn("game-immutable", ext, "exec-immutable", "2026-01-02T00:00:00.000Z");
  assert.equal(JSON.stringify(ext), beforeExt);
});

// ===========================================================================
// integration: create → save → load → runTurn(applyTurn) → load → runTurn(applyTurn)
// ===========================================================================

test("integration: create → save → load → applyTurn → load → applyTurn の2ターンが成功する", async () => {
  const quarters = industryQuarters(2, "v2-redis-integration");
  const repo = createGameStateRepository(makeDeps());

  // create
  const initial = createInitialPersistedGameState({
    gameId: "game-e2e",
    scenarioId: "baseline-v0.1",
    initialPeriod: quarters[0].marketInput.period,
    seed: "seed-e2e",
    initialContracts: [],
    initialRawMaterialLots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  // save
  await repo.saveGameState(initial);

  // load
  const loaded0 = await repo.loadGameState("game-e2e");
  assert.equal(loaded0.currentPeriod, "2015Q1");

  // applyTurn（内部でrunTurnを実行する）— ターン1
  const outcome1 = await repo.applyTurn("game-e2e", externalInput(quarters[0], 0), "exec-e2e-1", "2026-01-02T00:00:00.000Z");
  assert.equal(outcome1.state.currentPeriod, "2015Q2");
  assert.equal(outcome1.state.execution.completedTurnCount, 1);

  // load
  const loaded1 = await repo.loadGameState("game-e2e");
  assert.equal(loaded1.currentPeriod, "2015Q2");

  // applyTurn — ターン2
  const outcome2 = await repo.applyTurn("game-e2e", externalInput(quarters[1], 1), "exec-e2e-2", "2026-01-03T00:00:00.000Z");
  assert.equal(outcome2.state.currentPeriod, "2015Q3");
  assert.equal(outcome2.state.execution.completedTurnCount, 2);

  assert.ok(outcome2.state.contracts.length > 0);
  assert.ok(outcome2.state.rawMaterialLots.length > 0);
  const sources = new Set(outcome2.state.rawMaterialLots.map((l) => l.source));
  assert.ok(sources.has("domestic") || sources.has("import") || sources.has("aquaculture"));
});
