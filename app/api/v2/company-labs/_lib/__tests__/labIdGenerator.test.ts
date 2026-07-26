// ShrimpX V2 — 会社ラボ API labId生成テスト（Phase 8C-3A §6.1）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository, CompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { generateUniqueLabId } from "../labIdGenerator";
import { validateLabId } from "../validation";

test("generateUniqueLabId: 妥当な形式のlabIdを生成する", async () => {
  const repo = createInMemoryCompanyLabStateRepository();
  const labId = await generateUniqueLabId(repo);
  assert.equal(validateLabId(labId).ok, true);
  assert.ok(labId.startsWith("lab-"));
});

test("generateUniqueLabId: 既存labIdとは異なる値を生成する（衝突時は再試行する）", async () => {
  const repo = createInMemoryCompanyLabStateRepository();
  const first = await generateUniqueLabId(repo);
  await repo.createLab({
    labId: first,
    engineVersion: "test-engine",
    config: { scenarioId: "baseline", mode: "canonical", seed: "s", turns: 4 },
    fixtures: [],
    playerCompanyId: "TEST-PLAYER" as never,
    runtime: {
      currentPeriod: "2026Q1" as never,
      scenarioState: { definition: {}, mode: "canonical", randomSeed: "s", currentTurn: 1, resolvedEvents: [], turnHistory: [] } as never,
      contracts: [],
      rawMaterialLots: [],
      productionState: { currentPeriod: "2026Q1" as never, finishedGoodsLots: [] },
      lastQuarterActualProduction: {},
      qualityState: { qualityByCompanyProduct: [], trustByCompanyMarket: [], rampHistory: [] },
      financeState: { companies: [] },
      financingState: { companies: [] },
      capexState: { companies: [] },
      workforceState: { companies: [] },
      consumerMarketState: {} as never,
      isComplete: false,
    },
    now: "2026-01-01T00:00:00.000Z",
  });
  const second = await generateUniqueLabId(repo);
  assert.notEqual(second, first);
  assert.equal(await repo.labExists(second), false);
});

test("generateUniqueLabId: 常に衝突する場合は既定回数の再試行後に例外を投げる", async () => {
  const alwaysCollidingRepo: CompanyLabStateRepository = {
    ...createInMemoryCompanyLabStateRepository(),
    labExists: async () => true,
  };
  await assert.rejects(() => generateUniqueLabId(alwaysCollidingRepo));
});
