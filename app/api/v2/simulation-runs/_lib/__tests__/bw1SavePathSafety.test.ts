// ShrimpX V2 — BW-1: 保存経路を軽量化しても安全装置が維持されること
//
// BW-1 で、保存のたびに走る2つの検査を「manifest だけ読む」ように変えた。
//   - checkNotAlreadyFinished            … run.gameEndedAt だけを見る
//   - checkPlayerSeatsSubmittedForAdvance … run.completedTurns だけを見る
// どちらの値も manifest に入っているので dataset / resumePayload / packCapture は
// 読む必要がない（PLAYER 提出1回で全パートを4回読んでいた分の転送量が消える）。
//
// ここで固定する契約
//   1. 読み込みは本当に軽くなっている（loadRun へ渡る include が全パート false）。
//   2. それでも終了済み Run の保護は効く（part 保存・manifest commit の両方）。
//   3. それでも Turn 進行の PLAYER 提出 gate は効く。
//   4. 保存競合対策（CAS）は効く（古い expectedBaseRevision は 409 で拒否）。
// 1 と 2〜4 を同じテストで見ることが要点。軽くしたうえで守れていることを示す。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInMemorySimulationRunRepository,
  SimulationRunLoadOptions,
  SimulationRunRepository,
  createSimulationRunWriteToken,
} from "../../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../../../lib/v2/companyLab/simulation/persistence/types";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../handlers";
import { createInMemoryPlayerRepository } from "../../../../../lib/v2/player/repository";
import { createPlayerSeatSubmissionGate } from "../../../../../lib/v2/player/turnAdvanceGate";

const AT = "2026-10-08T00:00:00.000Z";
const EMPTY_DATASET = {
  schemaVersion: "simulationAnalytics-v1",
  turns: [1],
  companies: [],
  companyMetrics: [],
  marketMetrics: [],
  producerCountryMetrics: [],
  bottlenecks: [],
  aiTrace: [],
  salesTrace: [],
  hiringTrace: [],
  investmentTrace: [],
};

function run(simulationRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    simulationRunId,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "s",
    gameParameterVersion: "g",
    standardAiVersion: "a",
    strategyProfileVersion: "sp",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns: 8,
    startedAt: AT,
    completedAt: null,
    stopReason: "completed",
    errorMessage: null,
    failedAtTurn: null,
    ...overrides,
  };
}

function legacyBody(simulationRunId: string, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: run(simulationRunId, overrides), dataset: EMPTY_DATASET, savedAt: AT };
}

/** loadRun に渡された include を記録する包み。保存経路が本当に軽いかを見る。 */
function recordingRepository(inner: SimulationRunRepository): {
  readonly repository: SimulationRunRepository;
  readonly loads: SimulationRunLoadOptions[];
  reset(): void;
} {
  const loads: SimulationRunLoadOptions[] = [];
  const repository: SimulationRunRepository = {
    ...inner,
    loadRun: (id, options) => {
      loads.push(options ?? {});
      return inner.loadRun(id, options);
    },
  };
  return { repository, loads, reset: () => void (loads.length = 0) };
}

function errorCode(result: { readonly body: unknown }): string {
  return (result.body as { error?: { code?: string } }).error?.code ?? "";
}

test("BW1-SV1: 保存経路の検査は manifest だけを読む（大きいパートを読まない）", async () => {
  const inner = createInMemorySimulationRunRepository();
  const { repository, loads, reset } = recordingRepository(inner);
  await handleSaveSimulationRun(repository, legacyBody("run-sv1"));

  reset();
  const part = await handleSaveSimulationRunPart(repository, { simulationRunId: "run-sv1", revision: 2, part: "resume", value: { marker: "r" } });
  assert.equal(part.status, 200);
  assert.ok(loads.length >= 1, "part 保存で検査の読み込みが行われていない");
  for (const options of loads) {
    assert.equal(options.include?.dataset, false, "part 保存の検査が dataset を読んでいる");
    assert.equal(options.include?.resume, false, "part 保存の検査が resumePayload を読んでいる");
    assert.equal(options.include?.pack, false, "part 保存の検査が packCapture を読んでいる");
  }
});

test("BW1-SV2: 軽い読み込みでも終了済み Run の part 保存は 409 で拒否される", async () => {
  const inner = createInMemorySimulationRunRepository();
  const { repository, loads, reset } = recordingRepository(inner);
  await handleSaveSimulationRun(repository, legacyBody("run-sv2", { gameEndedAt: AT, gameEndTurn: 8, finalEvaluationSnapshot: [] }));

  reset();
  const rejected = await handleSaveSimulationRunPart(repository, { simulationRunId: "run-sv2", revision: 2, part: "resume", value: { marker: "r" } });
  assert.equal(rejected.status, 409, "終了済み Run への part 保存が通ってしまっている");
  assert.equal(errorCode(rejected), "GAME_FINISHED");
  // 拒否の判断に大きいパートを読んでいないこと。
  for (const options of loads) assert.equal(options.include?.dataset, false);
});

test("BW1-SV3: 軽い読み込みでも終了済み Run の manifest commit は 409 で拒否される", async () => {
  const inner = createInMemorySimulationRunRepository();
  const { repository } = recordingRepository(inner);
  await handleSaveSimulationRun(repository, legacyBody("run-sv3", { gameEndedAt: AT, gameEndTurn: 8, finalEvaluationSnapshot: [] }));

  const rejected = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: run("run-sv3", { gameEndedAt: AT, gameEndTurn: 8, completedTurns: 9 }),
    savedAt: AT,
    persistenceRevision: 2,
    hasResumePayload: false,
    hasPackCapture: false,
  });
  assert.equal(rejected.status, 409, "終了済み Run の manifest commit が通ってしまっている");
  assert.equal(errorCode(rejected), "GAME_FINISHED");
});

test("BW1-SV4: 軽い読み込みでも Turn 進行の PLAYER 提出 gate は効く", async () => {
  const inner = createInMemorySimulationRunRepository();
  const { repository } = recordingRepository(inner);
  const playerRepository = createInMemoryPlayerRepository();
  const gate = createPlayerSeatSubmissionGate(playerRepository);

  await handleSaveSimulationRun(repository, legacyBody("run-sv4", { completedTurns: 8, companyControlModes: { BAL: "PLAYER" } }));
  await playerRepository.issueJoinCredential("run-sv4", "BAL", AT);

  // completedTurns が増える保存（＝Turn進行）は、PLAYER 未提出なら止まる。
  const blocked = await handleSaveSimulationRun(
    repository,
    { ...legacyBody("run-sv4", { completedTurns: 9, companyControlModes: { BAL: "PLAYER" } }) },
    gate
  );
  assert.equal(blocked.status, 409, "PLAYER 未提出なのに Turn が進められている");
  assert.equal(errorCode(blocked), "PLAYER_SUBMISSION_REQUIRED");

  // completedTurns が変わらない保存（経営モード変更等）はブロックしない。
  const allowed = await handleSaveSimulationRun(
    repository,
    { ...legacyBody("run-sv4", { completedTurns: 8, companyControlModes: { BAL: "PLAYER" } }) },
    gate
  );
  assert.equal(allowed.status, 200, "Turn 進行ではない保存までブロックしている");
});

test("BW1-SV5: 軽い読み込みでも CAS（古い expectedBaseRevision）は 409 で拒否される", async () => {
  const inner = createInMemorySimulationRunRepository();
  const { repository } = recordingRepository(inner);
  await handleSaveSimulationRun(repository, legacyBody("run-sv5"));
  const published = await repository.currentPublishedRevision("run-sv5");

  // 正しい基準での保存は通る。
  const token = createSimulationRunWriteToken("sv5-ok");
  const okPart = await handleSaveSimulationRunPart(repository, {
    simulationRunId: "run-sv5", revision: published + 1, part: "dataset", value: EMPTY_DATASET,
    expectedBaseRevision: published, writeToken: token,
  });
  assert.equal(okPart.status, 200);
  const okCommit = await handleSaveSimulationRun(repository, {
    manifestOnly: true, run: run("run-sv5"), savedAt: AT, persistenceRevision: published + 1,
    hasResumePayload: false, hasPackCapture: false, expectedBaseRevision: published, writeToken: token,
  });
  assert.equal(okCommit.status, 200);

  // 古い基準（同じ expectedBaseRevision をもう一度）での commit は拒否される。
  const staleToken = createSimulationRunWriteToken("sv5-stale");
  await handleSaveSimulationRunPart(repository, {
    simulationRunId: "run-sv5", revision: published + 1, part: "dataset", value: EMPTY_DATASET,
    expectedBaseRevision: published, writeToken: staleToken,
  });
  const stale = await handleSaveSimulationRun(repository, {
    manifestOnly: true, run: run("run-sv5"), savedAt: AT, persistenceRevision: published + 1,
    hasResumePayload: false, hasPackCapture: false, expectedBaseRevision: published, writeToken: staleToken,
  });
  assert.equal(stale.status, 409, "古い基準での commit が通ってしまっている（CAS が効いていない）");
  assert.equal(errorCode(stale), "STALE_PERSISTENCE_REVISION");
  assert.equal(await repository.currentPublishedRevision("run-sv5"), published + 1, "拒否されたのに公開 revision が動いている");
});
