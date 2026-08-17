// ShrimpX V2 — Simulation Run 経路の AI Management Meeting のテスト
//
// 実Redis・実Claude・環境変数なしで検証する（Repository はインメモリ、Claude は
// 呼ばずに snapshot 組み立てまでを直接確かめる）。
//
// 【何を守るテストか】
//  A. Simulation Run の会社状態が、そのまま AI会議 context になること（別Labの初期状態を
//     参照していないこと）。
//  B. BAL の会議に MASS の private state が混ざらないこと。
//  C. 別turnの状態を取り違えないこと。
//  D. News がそのturn時点の公開済みぶんだけ入り、未来の確報は入らないこと。
//  E. 内部メタデータ（signalClass等）が AI context へ入らないこと。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySimulationRunRepository, SimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { initializeCompanyLab } from "../../../../lib/v2/companyLab/runner";
import { CompanyFixture, CompanyLabState } from "../../../../lib/v2/companyLab/types";
import { buildAiMeetingScenarioNews } from "../../../../lib/v2/companyLab/aiManagementMeeting/scenarioNews";
import { buildExecutiveBriefingPacket } from "../../../../lib/v2/companyLab/aiManagementMeeting/briefing";
import { buildExplanationContext } from "../../../../lib/v2/companyLab/aiExplanation/buildExplanationContext";
import { DYNAMIC_SCENARIO_1 } from "../../../../lib/v2/scenario/definitions/dynamicScenario1";
import { DS1_NEWS_SPECS } from "../../../../lib/v2/scenario/definitions/dynamicScenario1News";
import { buildSnapshotFromSimulationRun, handlePostRunAiMeetingMessage } from "../[simulationRunId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";
import { CompanyLabRedisClient } from "../../../../lib/v2/redis/companyLabTypes";
import { AnthropicMessagesClient } from "../../../../lib/v2/companyLab/aiManagementMeeting/claudeClient";

const AT = "2026-01-01T00:00:00.000Z";
const SCENARIO_ID = DYNAMIC_SCENARIO_1.scenarioId;

function storedRunFrom(simulationRunId: string, state: CompanyLabState, fixtures: readonly CompanyFixture[]): StoredSimulationRun {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: {
      simulationRunId,
      scenarioId: SCENARIO_ID,
      scenarioVersion: DYNAMIC_SCENARIO_1.version,
      seed: "test-seed",
      gameParameterVersion: "g",
      standardAiVersion: "a",
      strategyProfileVersion: "sp",
      startingTurn: 1,
      requestedTurns: 32,
      completedTurns: state.scenarioState.currentTurn - 1,
      startedAt: AT,
      completedAt: null,
      stopReason: "running",
      errorMessage: null,
      failedAtTurn: null,
    },
    dataset: {
      schemaVersion: "simulationAnalytics-v1",
      turns: [],
      companies: [],
      companyMetrics: [],
      marketMetrics: [],
      producerCountryMetrics: [],
      bottlenecks: [],
      aiTrace: [],
      salesTrace: [],
      hiringTrace: [],
      investmentTrace: [],
      contribution: [],
      fixedCosts: [],
      salesAllocation: [],
    },
    resumePayload: {
      state,
      fixtures,
      companyControlModes: { BAL: "PLAYER" },
      confirmedPlayerDecisions: {},
      aiTurnTraces: [],
      observedDemand: [],
      salesHeadcountByTurn: [],
      capacityByTurn: [],
      latestQuarterPreProcessingSnapshot: null,
    },
    savedAt: AT,
  };
}

function inMemoryRedisClient(): CompanyLabRedisClient {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    del: async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    eval: async () => {
      throw new Error("未使用");
    },
    zrange: async () => [],
  };
}

/**
 * 呼ばれたこと自体を例外で知らせるClaudeクライアント。turn不一致の要求が
 * 「Claudeを呼ぶ前に」弾かれていることを確かめるために使う。
 */
function throwingAnthropicClient(): AnthropicMessagesClient {
  return {
    messages: {
      create: async () => {
        throw new Error("CLAUDE_WAS_CALLED");
      },
    },
  } as unknown as AnthropicMessagesClient;
}

async function seedRun(simulationRunId: string): Promise<SimulationRunRepository> {
  const repository = createInMemorySimulationRunRepository();
  const { state, fixtures } = initializeCompanyLab({ scenarioId: SCENARIO_ID, mode: "canonical", seed: "test-seed", turns: 32 });
  await repository.saveRun(storedRunFrom(simulationRunId, state, fixtures));
  return repository;
}

// ---------------------------------------------------------------------
// A. Context — BAL / Turn1 / dynamic-scenario-1 がそのまま入る
// ---------------------------------------------------------------------

test("RUN-AMM-A: Simulation Run の BAL / Turn1 / dynamic-scenario-1 がAI会議contextへ正しく入る", async () => {
  const repository = await seedRun("run-a");
  const built = await buildSnapshotFromSimulationRun(repository, "run-a", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(built.snapshot.companyId, "BAL");
  assert.equal(built.snapshot.currentTurn, 1);
  assert.equal(built.snapshot.scenarioId, SCENARIO_ID);
  assert.equal(built.snapshot.fixture.companyId, "BAL");
  // contextId は会話の名前空間であり、labId ではない（裏Labを作っていないことの表明）。
  assert.equal(built.snapshot.contextId, "simrun:run-a");
  // 会社状態が実体を伴っていること（別Labの空状態を掴んでいない）。
  assert.ok(built.snapshot.ownState.financeState.cash > 0);
});

test("RUN-AMM-A2: 保存されていないRun・存在しない会社は404相当で返る（状態を捏造しない）", async () => {
  const repository = await seedRun("run-a2");
  const missingRun = await buildSnapshotFromSimulationRun(repository, "no-such-run", "BAL");
  assert.equal(missingRun.ok, false);
  if (!missingRun.ok) assert.equal(missingRun.result.status, 404);

  const missingCompany = await buildSnapshotFromSimulationRun(repository, "run-a2", "NOPE");
  assert.equal(missingCompany.ok, false);
  if (!missingCompany.ok) assert.equal(missingCompany.result.status, 404);
});

// ---------------------------------------------------------------------
// B. Cross-company isolation
// ---------------------------------------------------------------------

test("RUN-AMM-B: BALの会議contextにMASSのprivate stateが混入しない", async () => {
  const repository = await seedRun("run-b");
  const bal = await buildSnapshotFromSimulationRun(repository, "run-b", "BAL");
  const mass = await buildSnapshotFromSimulationRun(repository, "run-b", "MASS");
  assert.equal(bal.ok && mass.ok, true);
  if (!bal.ok || !mass.ok) return;

  assert.equal(bal.snapshot.fixture.companyId, "BAL");
  assert.equal(mass.snapshot.fixture.companyId, "MASS");

  // BAL の briefing を JSON 化して、MASS の識別子が一切現れないことを確かめる
  // （private state は company 単位で切り出されており、他社ぶんは入らない）。
  const balPacket = buildExecutiveBriefingPacket({
    context: buildExplanationContext({
      labId: bal.snapshot.contextId,
      companyId: bal.snapshot.companyId,
      turn: bal.snapshot.currentTurn,
      period: bal.snapshot.period,
      scenarioId: bal.snapshot.scenarioId,
      fixture: bal.snapshot.fixture,
      ownState: bal.snapshot.ownState,
      publicInfo: bal.snapshot.publicInfo,
      diagnostics: bal.snapshot.diagnostics,
    }),
    previousQuarter: bal.snapshot.previousQuarter,
    playerDraft: bal.snapshot.playerDraft,
    scenarioNews: bal.snapshot.scenarioNews,
  });
  assert.equal(balPacket.common.companyId, "BAL");
  assert.equal(JSON.stringify(balPacket).includes("MASS"), false);

  // ownState そのものが会社ごとに切り出されている（同じ塊を使い回していない）。
  // Turn1では初期現金が5社とも同額なので、金額ではなく帰属で確かめる。
  assert.equal(bal.snapshot.ownState.companyId, "BAL");
  assert.equal(mass.snapshot.ownState.companyId, "MASS");
  assert.equal(JSON.stringify(mass.snapshot.ownState).includes('"BAL"'), false);
});

// ---------------------------------------------------------------------
// C. Turn isolation
// ---------------------------------------------------------------------

test("RUN-AMM-C: 保存状態のturnと異なるturnのsnapshotを作らない（turn2の要求はturn1状態を名乗らない）", async () => {
  const repository = await seedRun("run-c");
  const built = await buildSnapshotFromSimulationRun(repository, "run-c", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(built.snapshot.currentTurn, 1);
});

test("RUN-AMM-C2: 保存状態がturn1のときturn2の会議要求は404（古い状態で会議が成立しない）", async () => {
  const repository = await seedRun("run-c2");
  const deps = { repository, redisClient: inMemoryRedisClient() };

  // turn2 を要求 → snapshot.currentTurn(1) と一致しないので Claude を呼ぶ前に 404。
  const mismatched = await handlePostRunAiMeetingMessage(deps, "run-c2", "BAL", "2", { playerMessage: "現金は足りてる？" }, throwingAnthropicClient());
  assert.equal(mismatched.status, 404);

  // turn1 なら Claude 呼び出しまで到達する（＝turn一致の判定だけが弾いていた）。
  // Claude が失敗しても 500 にはせず、HTTP 200 ＋ available:false で返る
  // （company-labs 経路と同じフォールバック。ゲーム状態には影響しない）。
  const matched = await handlePostRunAiMeetingMessage(deps, "run-c2", "BAL", "1", { playerMessage: "現金は足りてる？" }, throwingAnthropicClient());
  assert.equal(matched.status, 200);
  assert.equal((matched.body as { available: boolean }).available, false);
  // プレイヤー発言だけは会話へ残る（送信済みだが応答が得られなかったことを表示できる）。
  assert.equal((matched.body as { messages: readonly { speaker: string }[] }).messages[0].speaker, "PLAYER");
});

// ---------------------------------------------------------------------
// D. News — そのturn時点の公開済みだけが入る
// ---------------------------------------------------------------------

const DISEASE_RUMOR_ID = "ds1-t6-disease-rumor";
const SHOCK_CONFIRMED_ID = "ds1-t7-shock";

test("RUN-AMM-D: T6で疾病予兆Newsが入り、T7の確報はまだ入らない", () => {
  const t6 = buildAiMeetingScenarioNews(DYNAMIC_SCENARIO_1, 6);
  const ids = t6.map((n) => n.informationId);
  assert.ok(ids.includes(DISEASE_RUMOR_ID), `T6に${DISEASE_RUMOR_ID}が入っていること。実際: ${ids.join(", ")}`);
  assert.equal(ids.includes(SHOCK_CONFIRMED_ID), false, "T6時点でT7の確報が先読みできてはいけない");
  // 未来の記事が1件も混ざっていない。
  assert.equal(
    t6.every((n) => n.availableFromTurn <= 6),
    true
  );
});

test("RUN-AMM-D2: T7で初めてshock確報が入る", () => {
  const t7 = buildAiMeetingScenarioNews(DYNAMIC_SCENARIO_1, 7);
  const ids = t7.map((n) => n.informationId);
  assert.ok(ids.includes(SHOCK_CONFIRMED_ID), `T7に${SHOCK_CONFIRMED_ID}が入っていること。実際: ${ids.join(", ")}`);
  assert.ok(ids.includes(DISEASE_RUMOR_ID), "T6の噂もT7では引き続き読める");
  assert.equal(
    t7.every((n) => n.availableFromTurn <= 7),
    true
  );
});

test("RUN-AMM-D3: InformationReleaseを持たないシナリオでは空配列（シナリオID分岐を持たない）", () => {
  assert.deepEqual(buildAiMeetingScenarioNews(null, 1), []);
  assert.deepEqual(buildAiMeetingScenarioNews({ ...DYNAMIC_SCENARIO_1, informationReleases: [] }, 7), []);
});

// ---------------------------------------------------------------------
// E. Hidden metadata
// ---------------------------------------------------------------------

const ALLOWED_NEWS_KEYS = ["informationId", "headline", "body", "isRumor", "availableFromTurn", "facts", "estimateRange", "confidence"];
const FORBIDDEN_KEYS = ["signalClass", "scale", "market", "product", "origin", "futureEffectTurn", "hiddenImportance", "scenarioRelevance", "internalModifier", "postGameTruth", "informationLevel", "relatedEventId"];

test("RUN-AMM-E: AI contextのNewsは公開フィールドのみ（内部メタデータが入らない）", () => {
  const t7 = buildAiMeetingScenarioNews(DYNAMIC_SCENARIO_1, 7);
  assert.ok(t7.length > 0);
  for (const item of t7) {
    assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_NEWS_KEYS].sort(), `News ${item.informationId} のキーが allowlist と一致すること`);
  }
  const serialized = JSON.stringify(t7);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `${forbidden} がAI contextへ現れてはいけない`);
  }
});

test("RUN-AMM-E2: dev専用のsignalClassはシナリオ定義のInformationReleaseにそもそも載っていない", () => {
  // DS1のNews原稿（NewsSpec）はsignalClassを持つが、InformationReleaseへ写す時点で落ちている。
  assert.ok(DS1_NEWS_SPECS.some((s) => s.signalClass !== undefined), "原稿側にはsignalClassがある前提のテスト");
  const serialized = JSON.stringify(DYNAMIC_SCENARIO_1.informationReleases);
  assert.equal(serialized.includes("signalClass"), false);
});

test("RUN-AMM-E3: briefing packetのcommonへNewsが載る（AI役員が人間と同じ記事を読む）", async () => {
  const repository = await seedRun("run-e3");
  const built = await buildSnapshotFromSimulationRun(repository, "run-e3", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const packet = buildExecutiveBriefingPacket({
    context: buildExplanationContext({
      labId: built.snapshot.contextId,
      companyId: built.snapshot.companyId,
      turn: built.snapshot.currentTurn,
      period: built.snapshot.period,
      scenarioId: built.snapshot.scenarioId,
      fixture: built.snapshot.fixture,
      ownState: built.snapshot.ownState,
      publicInfo: built.snapshot.publicInfo,
      diagnostics: built.snapshot.diagnostics,
    }),
    previousQuarter: built.snapshot.previousQuarter,
    playerDraft: built.snapshot.playerDraft,
    scenarioNews: built.snapshot.scenarioNews,
  });
  assert.equal(packet.common.scenarioNews.length, built.snapshot.scenarioNews.length);
  assert.ok(packet.common.scenarioNews.length > 0, "DS1のTurn1では既に読めるNewsがある");
});
