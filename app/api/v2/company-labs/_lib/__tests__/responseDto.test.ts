// ShrimpX V2 — 会社ラボ API 応答DTOテスト（Phase 8C-3A §6.2・§6.6）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { toDraftSummaryDto, toHistoryEntrySummaryDto, toLabStateDto, toLabSummaryDto } from "../responseDto";

function minimalRuntime() {
  return {
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
    isComplete: false,
  };
}

test("toLabSummaryDto / toLabStateDto / toDraftSummaryDto: 巨大なruntime snapshot自体は応答に含まれない", async () => {
  const repo = createInMemoryCompanyLabStateRepository();
  const created = await repo.createLab({
    labId: "lab-dto-test",
    engineVersion: "test-engine",
    config: { scenarioId: "baseline", mode: "canonical", seed: "s", turns: 4 },
    fixtures: [],
    runtime: minimalRuntime(),
    now: "2026-01-01T00:00:00.000Z",
  });

  const summary = toLabSummaryDto(created);
  assert.equal(summary.labId, "lab-dto-test");
  assert.equal(summary.revision, 0);
  assert.equal(summary.currentTurn, 1);
  assert.equal(summary.isComplete, false);
  assert.ok(!("runtime" in summary), "要約DTOに内部runtime snapshotがそのまま含まれている");

  await repo.saveDraft({
    labId: "lab-dto-test",
    period: "2026Q1" as never,
    turnId: "turn-1",
    revision: 0,
    draft: { note: "x" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: null,
  });
  const draft = await repo.loadDraft("lab-dto-test");
  const draftDto = toDraftSummaryDto(draft!);
  assert.equal(draftDto.turnId, "turn-1");
  assert.deepEqual(draftDto.draft, { note: "x" });

  const stateDto = toLabStateDto(created, draft);
  assert.equal(stateDto.draft?.turnId, "turn-1");
});

test("toHistoryEntrySummaryDto: pre/postProcessingStateSnapshot・recordを含まない軽量な要約になる", () => {
  const entry = {
    turnId: "turn-1",
    turn: 1,
    period: "2026Q1" as never,
    engineVersion: "test-engine",
    schemaVersion: 1,
    preProcessingStateSnapshot: minimalRuntime(),
    postProcessingStateSnapshot: minimalRuntime(),
    playerSubmission: {} as never,
    otherCompaniesDecisions: [],
    record: { turn: 1 } as never,
    processedAt: "2026-01-01T00:00:01.000Z",
  };
  const dto = toHistoryEntrySummaryDto(entry);
  assert.deepEqual(dto, {
    turn: 1,
    turnId: "turn-1",
    period: "2026Q1",
    processedAt: "2026-01-01T00:00:01.000Z",
    engineVersion: "test-engine",
  });
  assert.ok(!("preProcessingStateSnapshot" in dto));
  assert.ok(!("record" in dto));
});
