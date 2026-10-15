// ShrimpX V2 — FOT-1: 保存の送信量削減（圧縮・再利用・差分追記）のテスト
//
// 【このテスト群が守る因果】
// 2026-10-12、staging の自動テストプレイで Vercel Fast Origin Transfer
// （ブラウザ→サーバーの送信量）が1日8.2GB・30日累計15.4GBに達し、Hobby 上限
// 10GB を超えてアカウントが停止した。原因は保存のたびに dataset / resume / pack を
// 丸ごと・無圧縮で送っていたこと（実測: 5社PLAYER×32Turn の1Runで 979.96 MB）。
//
// 対策は「送り方」だけを変えるもので、Redis の保存形式は一切変えていない。
// したがってこのテスト群が守るべき核心は次の2点である。
//   A. 送り方を軽くしても、**保存される中身は従来と完全に同一**であること
//   B. 土台（基準revision）がずれているときは、軽い送り方を**正本化しない**こと
//      （黙って欠けた正本を作ると、あとで AI Analysis Pack が出せなくなる）

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { handleSaveSimulationRun, handleSaveSimulationRunPart } from "../../../../../api/v2/simulation-runs/_lib/handlers";
import { parseJsonBody } from "../../../../../api/v2/simulation-runs/_lib/context";
import { createInMemorySimulationRunRepository } from "../persistence/repository";
import {
  SIMULATION_RUN_BODY_ENCODING_GZIP,
  SIMULATION_RUN_BODY_ENCODING_HEADER,
  SIMULATION_RUN_DELTA_BASE_MISMATCH,
  isAppendableSimulationRunPart,
  maxTurnOfSimulationRunPart,
  mergePackCaptures,
  parseSimulationRunPartSource,
  sliceSimulationRunPartAfterTurn,
} from "../persistence/partWire";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";
import type { NextRequest } from "next/server";

const RUN_ID = "fot1-run";
const SAVED_AT = "2026-10-15T00:00:00.000Z";

function runMetadata(completedTurns: number) {
  return {
    simulationRunId: RUN_ID,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "seed",
    gameParameterVersion: "v1",
    standardAiVersion: "v1",
    strategyProfileVersion: "v1",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns,
    startedAt: SAVED_AT,
    completedAt: null,
    stopReason: "running" as const,
    errorMessage: null,
    failedAtTurn: null,
  };
}

/** turn 1..n ぶんの行を持つ、最小構成の dataset。 */
function datasetThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    schemaVersion: "simulationAnalytics-v1",
    turns,
    companies: [{ companyId: "BAL", displayName: "BAL", color: "#000" }],
    companyMetrics: turns.map((turn) => ({ turn, companyId: "BAL", metric: "revenue", value: turn * 100 })),
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
  };
}

/**
 * turn 1..n ぶんの行を持つ pack。
 *
 * 【完全な PackCompanyTurnCapture を作らない理由】このテストが確かめるのは
 * 「turn キーでのマージ・再利用で中身が変わらないこと」だけであり、
 * 行の中身の意味は一切使わない。実際の型を満たす巨大な fixture を手で作ると、
 * 型が増えるたびにテストが壊れるのに、守っている因果は増えない。
 * マージ対象として必要な `turn` だけを持つ最小の行にし、型は境界でキャストする。
 */
function packThrough(maxTurn: number) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return {
    companyTurns: turns.map((turn) => ({ turn, companyId: "BAL", marker: `c${turn}` })),
    worldTurns: turns.map((turn) => ({ turn, marker: `w${turn}` })),
  };
}

type PackLike = ReturnType<typeof packThrough>;

function attemptFor(expectedBaseRevision: number, token: string) {
  return { expectedBaseRevision, writeToken: token };
}

/** dataset/resume/pack を全量で保存し、manifest を commit する（＝1回ぶんの保存）。 */
async function saveFull(
  repository: ReturnType<typeof createInMemorySimulationRunRepository>,
  options: { readonly base: number; readonly token: string; readonly maxTurn: number }
) {
  const revision = options.base + 1;
  const attempt = attemptFor(options.base, options.token);
  for (const [part, value] of [
    ["dataset", datasetThrough(options.maxTurn)],
    ["resume", { marker: `resume-${options.maxTurn}` }],
    ["pack", packThrough(options.maxTurn)],
  ] as const) {
    const result = await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part, value, ...attempt });
    assert.equal(result.status, 200, `${part} の全量保存が失敗した: ${JSON.stringify(result.body)}`);
  }
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(options.maxTurn),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, `manifest commit が失敗した: ${JSON.stringify(commit.body)}`);
  return revision;
}

function errorCodeOf(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | undefined)?.error?.code;
}

// ---------------------------------------------------------------------
// 送り方の判定（純粋関数）
// ---------------------------------------------------------------------

test("FOT-1: value / reuse / append は排他で、どれも無ければ不正", () => {
  assert.deepEqual(parseSimulationRunPartSource("dataset", { value: { turns: [] } }), { kind: "value", value: { turns: [] } });
  assert.deepEqual(parseSimulationRunPartSource("dataset", { reuseFromRevision: 3 }), { kind: "reuse", fromRevision: 3 });

  // 何も指定しない
  assert.ok("error" in parseSimulationRunPartSource("dataset", {}));
  // reuse と value の同時指定（どちらを信じるべきか決められない）
  assert.ok("error" in parseSimulationRunPartSource("dataset", { reuseFromRevision: 1, value: {} }));
  // reuse と append の同時指定
  assert.ok("error" in parseSimulationRunPartSource("dataset", { reuseFromRevision: 1, appendFromRevision: 1, value: {} }));
  // append に expectedMaxTurn が無い（土台ずれを検知できなくなる）
  assert.ok("error" in parseSimulationRunPartSource("pack", { appendFromRevision: 1, value: {} }));
  // 負数・非整数の revision
  assert.ok("error" in parseSimulationRunPartSource("dataset", { reuseFromRevision: -1 }));
  assert.ok("error" in parseSimulationRunPartSource("dataset", { reuseFromRevision: 1.5 }));
});

test("FOT-2: resume は差分追記できない（turn を持たないため）", () => {
  assert.equal(isAppendableSimulationRunPart("dataset"), true);
  assert.equal(isAppendableSimulationRunPart("pack"), true);
  assert.equal(isAppendableSimulationRunPart("resume"), false);
  assert.ok("error" in parseSimulationRunPartSource("resume", { appendFromRevision: 1, expectedMaxTurn: 2, value: {} }));
});

test("FOT-3: 差分抽出は turn を持つ配列だけを絞り、持たない配列（companies）は丸ごと残す", () => {
  const full = datasetThrough(3);
  const delta = sliceSimulationRunPartAfterTurn("dataset", full, 2) as typeof full;

  assert.deepEqual(delta.turns, [3], "turns は 2 より後だけになる");
  assert.deepEqual(
    delta.companyMetrics.map((f) => f.turn),
    [3],
    "turn を持つ行は絞られる"
  );
  /**
   * 【これが欠けるとマージ結果が壊れる】mergeAnalyticsDatasets は companies と
   * schemaVersion を差分（next）側から採用する。差分側で companies を絞ってしまうと
   * マージ後の正本から会社が消える。
   */
  assert.deepEqual(delta.companies, full.companies, "companies は絞らない");
  assert.equal(delta.schemaVersion, full.schemaVersion, "schemaVersion は保つ");
});

test("FOT-4: pack の差分マージは、全量ビルドと完全に一致する", () => {
  const full = packThrough(5);
  const base = packThrough(3);
  const delta = sliceSimulationRunPartAfterTurn("pack", full, 3) as PackLike;
  const merged = mergePackCaptures(base as never, delta as never) as unknown as PackLike;
  assert.equal(JSON.stringify(merged), JSON.stringify(full));
  assert.equal(maxTurnOfSimulationRunPart("pack", merged), 5);
});

// ---------------------------------------------------------------------
// 保存される中身が従来と同一であること（A）
// ---------------------------------------------------------------------

test("FOT-5: reuse で送ったパートは、公開済みの値がそのまま正本になる", async () => {
  const repository = createInMemorySimulationRunRepository();
  const firstRevision = await saveFull(repository, { base: 0, token: "t1", maxTurn: 4 });

  // 2回目: dataset と pack は変わっていないので送らない。resume だけ全量。
  const revision = firstRevision + 1;
  const attempt = attemptFor(firstRevision, "t2");
  for (const part of ["dataset", "pack"] as const) {
    const result = await handleSaveSimulationRunPart(repository, {
      simulationRunId: RUN_ID,
      revision,
      part,
      reuseFromRevision: firstRevision,
      ...attempt,
    });
    assert.equal(result.status, 200, `${part} の reuse が失敗した: ${JSON.stringify(result.body)}`);
  }
  const resumeResult = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision,
    part: "resume",
    value: { marker: "resume-updated" },
    ...attempt,
  });
  assert.equal(resumeResult.status, 200);
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(4),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  const stored = await repository.loadRun(RUN_ID);
  assert.ok(stored);
  // 送っていない dataset / pack が、送った場合と同一のまま正本に入っている。
  assert.equal(JSON.stringify(stored.dataset), JSON.stringify(datasetThrough(4)));
  assert.equal(JSON.stringify(stored.packCapture), JSON.stringify(packThrough(4)));
  // resume だけが更新されている。
  assert.deepEqual(stored.resumePayload, { marker: "resume-updated" } as never);
  assert.equal(stored.persistenceRevision, revision);
});

test("FOT-6: append で送った pack は、全量を送った場合と同一の正本になる", async () => {
  const repository = createInMemorySimulationRunRepository();
  const firstRevision = await saveFull(repository, { base: 0, token: "t1", maxTurn: 3 });

  const revision = firstRevision + 1;
  const attempt = attemptFor(firstRevision, "t2");
  const fullPack = packThrough(5);
  const appendResult = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision,
    part: "pack",
    value: sliceSimulationRunPartAfterTurn("pack", fullPack, 3),
    appendFromRevision: firstRevision,
    expectedMaxTurn: 5,
    ...attempt,
  });
  assert.equal(appendResult.status, 200, JSON.stringify(appendResult.body));

  for (const [part, value] of [
    ["dataset", datasetThrough(5)],
    ["resume", { marker: "resume-5" }],
  ] as const) {
    const r = await handleSaveSimulationRunPart(repository, { simulationRunId: RUN_ID, revision, part, value, ...attempt });
    assert.equal(r.status, 200);
  }
  const commit = await handleSaveSimulationRun(repository, {
    manifestOnly: true,
    run: runMetadata(5),
    savedAt: SAVED_AT,
    persistenceRevision: revision,
    hasResumePayload: true,
    hasPackCapture: true,
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    ...attempt,
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));

  const stored = await repository.loadRun(RUN_ID);
  assert.ok(stored);
  assert.equal(JSON.stringify(stored.packCapture), JSON.stringify(fullPack), "差分追記の結果が全量と一致しない");
});

// ---------------------------------------------------------------------
// 土台がずれているときは正本化しないこと（B）
// ---------------------------------------------------------------------

test("FOT-7: 公開済みの土台が無い reuse は 409 DELTA_BASE_MISMATCH で拒否される", async () => {
  const repository = createInMemorySimulationRunRepository();
  // まだ1度も保存していないRunに対して reuse を要求する。
  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: 1,
    part: "dataset",
    reuseFromRevision: 0,
    ...attemptFor(0, "t1"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_DELTA_BASE_MISMATCH);
});

test("FOT-8: 基準revisionが古い reuse は拒否される（他のwriterが先に公開していた場合）", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 2 });
  const second = await saveFull(repository, { base: first, token: "t2", maxTurn: 3 });
  assert.equal(second, 2);

  // revision 1 を土台にしようとする（既に revision 2 が公開されている）。
  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: 3,
    part: "dataset",
    reuseFromRevision: 1,
    ...attemptFor(1, "t3"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_DELTA_BASE_MISMATCH);
});

test("FOT-9: append の結果が申告した最大turnと違えば保存しない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const first = await saveFull(repository, { base: 0, token: "t1", maxTurn: 3 });

  const result = await handleSaveSimulationRunPart(repository, {
    simulationRunId: RUN_ID,
    revision: first + 1,
    part: "pack",
    // turn 4 ぶんしか送っていないのに、5 まで揃うと申告する。
    value: sliceSimulationRunPartAfterTurn("pack", packThrough(4), 3),
    appendFromRevision: first,
    expectedMaxTurn: 5,
    ...attemptFor(first, "t2"),
  });
  assert.equal(result.status, 409);
  assert.equal(errorCodeOf(result.body), SIMULATION_RUN_DELTA_BASE_MISMATCH);

  // 正本は revision 1 のまま（部分的な正本を作っていない）。
  const stored = await repository.loadRun(RUN_ID);
  assert.equal(stored?.persistenceRevision, first);
  assert.equal(JSON.stringify(stored?.packCapture), JSON.stringify(packThrough(3)));
});

// ---------------------------------------------------------------------
// 圧縮（後方互換を含む）
// ---------------------------------------------------------------------

function fakeRequest(body: BodyInit, headers: Record<string, string>): NextRequest {
  return new Request("https://example.test/api/v2/simulation-runs", { method: "POST", body, headers }) as unknown as NextRequest;
}

test("FOT-10: gzip ボディは展開して読める。ヘッダが無ければ従来どおり素のJSONとして読める", async () => {
  const payload = { simulationRunId: RUN_ID, revision: 2, part: "dataset", value: datasetThrough(3) };
  const json = JSON.stringify(payload);

  const compressed = await parseJsonBody(
    fakeRequest(gzipSync(Buffer.from(json, "utf8")), {
      "content-type": "application/octet-stream",
      [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP,
    })
  );
  assert.deepEqual(compressed, payload, "gzip ボディを展開できていない");

  const plain = await parseJsonBody(fakeRequest(json, { "content-type": "application/json" }));
  assert.deepEqual(plain, payload, "旧クライアント（無圧縮）の保存が読めなくなっている");
});

test("FOT-11: 壊れた gzip ボディは undefined になり、ハンドラーが 400 を返す", async () => {
  const broken = await parseJsonBody(
    fakeRequest(Buffer.from("not gzip at all"), {
      "content-type": "application/octet-stream",
      [SIMULATION_RUN_BODY_ENCODING_HEADER]: SIMULATION_RUN_BODY_ENCODING_GZIP,
    })
  );
  assert.equal(broken, undefined);

  const repository = createInMemorySimulationRunRepository();
  const result = await handleSaveSimulationRunPart(repository, broken);
  assert.equal(result.status, 400);
});
