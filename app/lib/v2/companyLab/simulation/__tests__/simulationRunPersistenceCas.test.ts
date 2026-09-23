// ShrimpX V2 — O1: 保存の並行性契約（expectedBaseRevision による CAS）
//
// 【この契約が何を守るか】GM の Turn 保存と、別端末の PLAYER 提出が、同じ Run の
// resumePayload を並行に read-modify-write する。以前は後から書いた方が無条件に勝ち、
// PLAYER の提出が storage 実体から消えていた。
// ここでは「読んだ正本の revision を申告し、commit 時に食い違えば拒否する」
// という契約を、インメモリ実装と Redis 実装の**両方**で同じ意味論として固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationRunRepository,
  SimulationRunStaleRevisionError,
  createInMemorySimulationRunRepository,
  createSimulationRunWriteToken,
} from "../persistence/repository";
import { assertValidSimulationRunWriteToken } from "../../../redis/simulationRunRedisKeys";
import { SIMULATION_RUN_STAGING_TTL_MS } from "../persistence/redisRepository";
import { createRedisSimulationRunRepository } from "../persistence/redisRepository";
import { SIMULATION_RUN_SAVE_MANIFEST_SCRIPT } from "../persistence/redisRepository";
import { createFakeSimulationRunRedisClient } from "./fakeSimulationRunRedisClient";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRunManifest, manifestToSimulationRunSummary } from "../persistence/types";
import { SimulationRun } from "../types";

const AT = "2026-09-23T00:00:00.000Z";

function fakeRun(id: string, completedTurns: number): SimulationRun {
  return {
    simulationRunId: id,
    scenarioId: "baseline",
    scenarioVersion: "v1",
    seed: "seed",
    gameParameterVersion: "v1",
    standardAiVersion: "v1",
    strategyProfileVersion: "v1",
    startingTurn: 1,
    requestedTurns: 32,
    completedTurns,
    startedAt: AT,
    completedAt: null,
    stopReason: "completed",
    errorMessage: null,
    failedAtTurn: null,
  };
}

function manifestFor(id: string, revision: number, completedTurns: number): StoredSimulationRunManifest {
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: fakeRun(id, completedTurns),
    persistenceRevision: revision,
    savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString(),
    hasResumePayload: true,
    hasPackCapture: false,
  };
}

const DATASET = { turns: [1], marker: "ds" } as never;

/** 1回の保存attempt（part保存 → manifest commit）をまとめて行う。 */
async function saveAttempt(
  repo: SimulationRunRepository,
  id: string,
  opts: { expectedBaseRevision: number; writeToken: string; revision: number; completedTurns: number; resumeMarker: string }
): Promise<void> {
  const attempt = { expectedBaseRevision: opts.expectedBaseRevision, writeToken: opts.writeToken };
  await repo.saveRunPart(id, attempt, "dataset", { ...(DATASET as object), marker: opts.resumeMarker });
  await repo.saveRunPart(id, attempt, "resume", { marker: opts.resumeMarker });
  const manifest = manifestFor(id, opts.revision, opts.completedTurns);
  await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);
}

/** インメモリ実装とRedis実装（フェイククライアント）を同じ契約テストへ流す。 */
const implementations: readonly { readonly name: string; readonly create: () => SimulationRunRepository }[] = [
  { name: "in-memory", create: () => createInMemorySimulationRunRepository() },
  { name: "redis", create: () => createRedisSimulationRunRepository({ client: createFakeSimulationRunRedisClient(), appEnv: "staging" }) },
];

for (const impl of implementations) {
  test(`O1-02 (${impl.name}): 古いexpectedBaseRevisionでのcommitは拒否され、公開状態は変わらない`, async () => {
    const repo = impl.create();
    const id = "o1-02";
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "first" });
    await saveAttempt(repo, id, { expectedBaseRevision: 1, writeToken: "w2", revision: 2, completedTurns: 2, resumeMarker: "second" });

    const before = await repo.loadRun(id);
    assert.equal(before?.persistenceRevision, 2);

    // 正本は2なのに「0を読んだ」と主張する保存 → 拒否。
    await assert.rejects(
      () => saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w3", revision: 1, completedTurns: 1, resumeMarker: "stale" }),
      (e: unknown) => e instanceof SimulationRunStaleRevisionError
    );

    const after = await repo.loadRun(id);
    assert.equal(after?.persistenceRevision, 2, "拒否されたのにrevisionが変わっている");
    assert.deepEqual(after?.resumePayload, before?.resumePayload, "拒否されたのに公開中の内容が変わっている");
    assert.equal((after?.dataset as unknown as { marker: string }).marker, "second", "拒否されたwriterのdatasetが正本になっている");
  });

  test(`O1-03 (${impl.name}): 同じbaseを読んだ2 writerのうち、commitに成功するのは1つだけ`, async () => {
    const repo = impl.create();
    const id = "o1-03";
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w0", revision: 1, completedTurns: 1, resumeMarker: "base" });

    // どちらも revision 1 を読んだ状態から、同じ revision 2 を作ろうとする。
    const attemptA = { expectedBaseRevision: 1, writeToken: "A" };
    const attemptB = { expectedBaseRevision: 1, writeToken: "B" };
    await repo.saveRunPart(id, attemptA, "dataset", { marker: "A" });
    await repo.saveRunPart(id, attemptA, "resume", { marker: "A" });
    await repo.saveRunPart(id, attemptB, "dataset", { marker: "B" });
    await repo.saveRunPart(id, attemptB, "resume", { marker: "B" });

    const manifest = manifestFor(id, 2, 2);
    await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attemptA);
    await assert.rejects(
      () => repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attemptB),
      (e: unknown) => e instanceof SimulationRunStaleRevisionError,
      "2人目のwriterもcommitできてしまっている（last-writer-wins）"
    );

    const loaded = await repo.loadRun(id);
    assert.equal(loaded?.persistenceRevision, 2);
    assert.equal((loaded?.resumePayload as unknown as { marker: string }).marker, "A", "勝者Aの内容になっていない");
  });

  test(`O1-04 (${impl.name}): 敗者のパートが勝者のパートを壊さない`, async () => {
    const repo = impl.create();
    const id = "o1-04";
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w0", revision: 1, completedTurns: 1, resumeMarker: "base" });

    const winner = { expectedBaseRevision: 1, writeToken: "winner" };
    const loser = { expectedBaseRevision: 1, writeToken: "loser" };

    // 【順序が要点】勝者がパートを書く → 敗者が同じrevisionを狙ってパートを書く → 勝者がcommit。
    // パートの置き場がattemptごとに分かれていなければ、ここで勝者のパートは敗者の内容に化ける。
    await repo.saveRunPart(id, winner, "dataset", { marker: "winner" });
    await repo.saveRunPart(id, winner, "resume", { marker: "winner" });
    await repo.saveRunPart(id, loser, "dataset", { marker: "loser" });
    await repo.saveRunPart(id, loser, "resume", { marker: "loser" });

    const manifest = manifestFor(id, 2, 2);
    await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), winner);

    const loaded = await repo.loadRun(id);
    assert.equal((loaded?.dataset as unknown as { marker: string }).marker, "winner", "勝者のdatasetが敗者に壊されている");
    assert.equal((loaded?.resumePayload as unknown as { marker: string }).marker, "winner", "勝者のresumeが敗者に壊されている");

    // 敗者はcommitできない。
    await assert.rejects(
      () => repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), loser),
      (e: unknown) => e instanceof SimulationRunStaleRevisionError
    );
    const after = await repo.loadRun(id);
    assert.equal((after?.resumePayload as unknown as { marker: string }).marker, "winner", "敗者のcommit失敗後に内容が変わっている");
  });

  test(`O1-13 (${impl.name}): revisionを持たない旧Runは公開revision 0として扱える`, async () => {
    const repo = impl.create();
    const id = "o1-13";
    assert.equal(await repo.currentPublishedRevision(id), 0, "保存物が無いのに0以外を返している");
    // 旧Run相当（revision無し）から、新方式の最初の保存でrevision 1へ正規化される。
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "legacy-normalized" });
    assert.equal(await repo.currentPublishedRevision(id), 1);
    const loaded = await repo.loadRun(id);
    assert.equal(loaded?.persistenceRevision, 1);
  });

  test(`O1-17 (${impl.name}): 低revisionのwriterが高revisionの正本を巻き戻せない`, async () => {
    const repo = impl.create();
    const id = "o1-17";
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "r1" });
    await saveAttempt(repo, id, { expectedBaseRevision: 1, writeToken: "w2", revision: 2, completedTurns: 2, resumeMarker: "r2" });
    await saveAttempt(repo, id, { expectedBaseRevision: 2, writeToken: "w3", revision: 3, completedTurns: 3, resumeMarker: "r3" });

    // revision 5 を名乗っても、基準（expectedBaseRevision）が合っていなければ通らない。
    await assert.rejects(
      () => saveAttempt(repo, id, { expectedBaseRevision: 1, writeToken: "w4", revision: 5, completedTurns: 1, resumeMarker: "rollback" }),
      (e: unknown) => e instanceof SimulationRunStaleRevisionError
    );
    const loaded = await repo.loadRun(id);
    assert.equal(loaded?.persistenceRevision, 3);
    assert.equal(loaded?.run.completedTurns, 3, "Turnが巻き戻っている");
  });

  test(`O1-contract (${impl.name}): currentPublishedRevision が公開中の値を返す`, async () => {
    const repo = impl.create();
    const id = "o1-cur";
    assert.equal(await repo.currentPublishedRevision(id), 0);
    await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "a" });
    assert.equal(await repo.currentPublishedRevision(id), 1);
    await saveAttempt(repo, id, { expectedBaseRevision: 1, writeToken: "w2", revision: 7, completedTurns: 2, resumeMarker: "b" });
    assert.equal(await repo.currentPublishedRevision(id), 7, "commitした値がそのまま公開revisionになっていない");
  });
}

test("O1-contract: 未公開パートが揃っていないcommitは正本化されない（in-memory/redisとも）", async () => {
  for (const impl of implementations) {
    const repo = impl.create();
    const id = `o1-missing-${impl.name}`;
    const attempt = { expectedBaseRevision: 0, writeToken: "w1" };
    // datasetだけ書いてresumeを書かずにcommitする。
    await repo.saveRunPart(id, attempt, "dataset", { marker: "only-dataset" });
    const manifest = manifestFor(id, 1, 1); // hasResumePayload: true
    await assert.rejects(() => repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt));
    assert.equal(await repo.loadRun(id), null, `${impl.name}: パート欠落のまま正本化されている`);
  }
});

// ---------------------------------------------------------------------
// Luaスクリプト本文の静的契約
// ---------------------------------------------------------------------

test("O1-lua: manifest保存Luaが「読む→比較する→書く」を1スクリプト内で行っている", () => {
  const script = SIMULATION_RUN_SAVE_MANIFEST_SCRIPT;
  const getIndex = script.indexOf("redis.call('GET', manifestKey)");
  const compareIndex = script.indexOf("if published ~= expectedBase then");
  const setIndex = script.indexOf("redis.call('SET', manifestKey, manifestJson)");
  assert.ok(getIndex > 0, "現在のmanifestをGETしていない");
  assert.ok(compareIndex > getIndex, "GETより前に比較している（順序が不正）");
  assert.ok(setIndex > compareIndex, "比較より前にmanifestをSETしている（CASになっていない）");
  // 比較に失敗したら何も書かずに返ること。
  const conflictReturn = script.indexOf("return { 'CONFLICT', tostring(published) }");
  assert.ok(conflictReturn > compareIndex && conflictReturn < setIndex, "CONFLICT時にSETより前で返していない");
  // stagingから正規キーへの昇格を行っていること。
  assert.ok(script.includes("redis.call('RENAME', KEYS[4], KEYS[7])"), "datasetのstaging→正規キー昇格が無い");
  assert.ok(script.includes("if hasResume then redis.call('RENAME', KEYS[5], KEYS[8]) end"), "resumeの昇格が無い");
  assert.ok(script.includes("if hasPack then redis.call('RENAME', KEYS[6], KEYS[9]) end"), "packの昇格が無い");
  // 無条件SETが比較の前に無いこと（旧実装の回帰防止）。
  const beforeCompare = script.slice(0, compareIndex);
  assert.ok(!beforeCompare.includes("redis.call('SET'"), "比較より前に無条件SETが残っている");

  /**
   * 【Redis Luaに自動rollbackは無い】スクリプトが途中でエラーになっても、
   * それまでの書き込みは巻き戻らない。したがって「書き込みを始めたあとにエラーになり得る要素」は、
   * 書き込みが1つも起きていない位置で先に弾いておく必要がある。
   * 引数検査が最初のredis.callより前にあることを固定する。
   */
  const argCheckIndex = script.indexOf("if score == nil or limit == nil or expectedBase == nil then");
  const firstRedisCall = script.indexOf("redis.call(");
  assert.ok(argCheckIndex > 0, "書き込み前の引数検査が無い");
  assert.ok(argCheckIndex < firstRedisCall, "引数検査が最初のredis.callより後にある（書き込み後に失敗し得る）");
  const writeSection = script.slice(script.indexOf("redis.call('RENAME'"));
  assert.ok(!writeSection.includes("tonumber("), "RENAME以降でtonumber変換をしている（書き込み後に失敗し得る）");
});

// ---------------------------------------------------------------------
// staging key の性質（writeTokenの一意性・孤児の寿命・書き込み前検査）
// ---------------------------------------------------------------------

test("O1-18: writeTokenはattemptごとに一意で、キーに使える文字だけで構成される", () => {
  // 【revision番号をtokenにしない】同じ正本を読んだ2 writerは同じ「基準+1」を選ぶため、
  // revision由来のtokenは必ず衝突し、part collision防止が成立しなくなる。
  const tokens = new Set<string>();
  for (let i = 0; i < 2000; i += 1) tokens.add(createSimulationRunWriteToken("sub"));
  assert.equal(tokens.size, 2000, "同一プロセス内でwriteTokenが衝突している");

  // 別のprefix（別経路）とも混ざらない。
  const gmTokens = new Set([...Array(500)].map(() => createSimulationRunWriteToken("gm")));
  for (const t of gmTokens) assert.ok(!tokens.has(t), "prefixが違うtokenが衝突している");

  // Redisキーへ埋め込むため、英数字とハイフンのみ（キーガードと同じ制約）。
  for (const t of [...tokens].slice(0, 50)) {
    assert.match(t, /^[A-Za-z0-9-]{1,64}$/, `キーに使えない文字が含まれている: ${t}`);
    assert.doesNotThrow(() => assertValidSimulationRunWriteToken(t));
  }
});

test("O1-19: 未公開stagingキーにはTTLが付き、昇格後の正規キーには残らない", async () => {
  const client = createFakeSimulationRunRedisClient();
  const repo = createRedisSimulationRunRepository({ client, appEnv: "staging" });
  const id = "o1-19";
  const attempt = { expectedBaseRevision: 0, writeToken: "ttlcheck" };

  await repo.saveRunPart(id, attempt, "dataset", { marker: "d" });
  await repo.saveRunPart(id, attempt, "resume", { marker: "r" });

  const stagingKeys = [...client.ttls().keys()].filter((k) => k.includes(":staging:ttlcheck:"));
  assert.equal(stagingKeys.length, 2, "stagingキーにTTLが設定されていない");
  for (const key of stagingKeys) {
    assert.equal(client.ttls().get(key), SIMULATION_RUN_STAGING_TTL_MS, `${key} のTTLが想定と違う`);
  }

  const manifest = manifestFor(id, 1, 1);
  await repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), attempt);

  // 昇格後、stagingキーは消え、正規キーにTTLは残らない（公開正本が勝手に消えては困る）。
  assert.equal([...client.dump().keys()].filter((k) => k.includes(":staging:")).length, 0, "昇格後もstagingキーが残っている");
  for (const [key, ttl] of client.ttls()) {
    assert.ok(!key.includes(":dataset:") && !key.includes(":resume:") && !key.includes(":pack:"), `正規キーにTTLが付いている: ${key} (${ttl})`);
  }
});

test("O1-20: 孤児stagingが残っても公開正本は読めて、内容も変わらない", async () => {
  const client = createFakeSimulationRunRedisClient();
  const repo = createRedisSimulationRunRepository({ client, appEnv: "staging" });
  const id = "o1-20";
  await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "published" });

  // 失敗するattempt（古い基準）が、パートだけ書いてcommitに失敗する。
  const orphan = { expectedBaseRevision: 0, writeToken: "orphan" };
  await repo.saveRunPart(id, orphan, "dataset", { marker: "orphan" });
  await repo.saveRunPart(id, orphan, "resume", { marker: "orphan" });
  const manifest = manifestFor(id, 2, 2);
  await assert.rejects(
    () => repo.commitRunManifest(manifest, manifestToSimulationRunSummary(manifest), orphan),
    (e: unknown) => e instanceof SimulationRunStaleRevisionError
  );

  // 孤児は残っている（TTLで消えるまで）。
  const orphanKeys = [...client.dump().keys()].filter((k) => k.includes(":staging:orphan:"));
  assert.equal(orphanKeys.length, 2, "孤児stagingが想定と違う");
  for (const key of orphanKeys) assert.equal(client.ttls().get(key), SIMULATION_RUN_STAGING_TTL_MS, "孤児にTTLが無く、無制限に残る");

  // それでも公開正本は無傷。
  const loaded = await repo.loadRun(id);
  assert.equal(loaded?.persistenceRevision, 1);
  assert.equal((loaded?.resumePayload as unknown as { marker: string }).marker, "published", "孤児が公開正本へ混ざっている");
});

test("O1-21: 不正な引数のcommitは、書き込みを1つも行わずに失敗する", async () => {
  const client = createFakeSimulationRunRedisClient();
  const repo = createRedisSimulationRunRepository({ client, appEnv: "staging" });
  const id = "o1-21";
  await saveAttempt(repo, id, { expectedBaseRevision: 0, writeToken: "w1", revision: 1, completedTurns: 1, resumeMarker: "published" });
  const before = new Map(client.dump());

  // savedAtがISO8601として解釈できない＝scoreがNaNになる経路。
  const attempt = { expectedBaseRevision: 1, writeToken: "bad" };
  await repo.saveRunPart(id, attempt, "dataset", { marker: "bad" });
  await repo.saveRunPart(id, attempt, "resume", { marker: "bad" });
  const broken = { ...manifestFor(id, 2, 2), savedAt: "not-a-date" };
  await assert.rejects(() => repo.commitRunManifest(broken, manifestToSimulationRunSummary(manifestFor(id, 2, 2)), attempt));

  // manifest / summary / 正規パートのいずれも変わっていない。
  const loaded = await repo.loadRun(id);
  assert.equal(loaded?.persistenceRevision, 1);
  assert.equal((loaded?.resumePayload as unknown as { marker: string }).marker, "published");
  for (const [key, value] of before) {
    if (key.includes(":staging:")) continue;
    assert.equal(client.dump().get(key), value, `公開側のキーが書き換わっている: ${key}`);
  }
});
