// ShrimpX V2 — Game End / Final Results（END-1）: gameEnd.ts のユニットテスト
//
// 【新しい計算をしない】ここではTSVの値そのものを検証しない（既存
// evaluationSemantics.test.tsがその責務を持つ）。ここで確認するのは、
// gameEnd.tsがcomputeAllCompaniesEvaluationSnapshot/rankCompaniesByTotalShareholderValue
// を正しく1回だけ呼び、その結果をrunへ非破壊で焼き込むことだけ。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";
import { computeAllCompaniesEvaluationSnapshot } from "../../../../lib/v2/companyLab/evaluation/evaluationSemantics";
import { buildGameEndedRun, computeFinalEvaluationSnapshot, isGameFinished, lastCompletedTurn, rankFinalSnapshot } from "../gameEnd";

const AT = "2026-01-01T00:00:00.000Z";

function makeSession(turns: number) {
  const session = createSimulationSession({ simulationRunId: "game-end-test", scenarioId: "baseline", seed: "game-end-test", requestedTurns: turns, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

test("GAMEEND-1: computeFinalEvaluationSnapshotは、既存computeAllCompaniesEvaluationSnapshotと同じ結果を返す（新しい計算式を持たない）", () => {
  const session = makeSession(3);
  const got = computeFinalEvaluationSnapshot(session);
  const expected = computeAllCompaniesEvaluationSnapshot(
    session.state.history,
    session.fixtures.map((f) => f.companyId),
    session.run.completedTurns
  );
  assert.deepEqual(got, expected);
});

test("GAMEEND-2: buildGameEndedRunは既存runフィールドを一切変更せず、Game End関連の3フィールドだけを追加する", () => {
  const session = makeSession(2);
  const snapshot = computeFinalEvaluationSnapshot(session);
  const endedRun = buildGameEndedRun(session.run, 2, "2026-03-01T00:00:00.000Z", snapshot);

  // 既存フィールドはすべて元のまま。
  for (const key of Object.keys(session.run) as (keyof typeof session.run)[]) {
    assert.deepEqual(endedRun[key], session.run[key], `既存フィールド ${String(key)} が変わってはいけない`);
  }
  assert.equal(endedRun.gameEndedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(endedRun.gameEndTurn, 2);
  assert.deepEqual(endedRun.finalEvaluationSnapshot, snapshot);
});

test("GAMEEND-3: isGameFinishedはgameEndedAt未設定ならfalse、設定済みならtrueを返す", () => {
  const session = makeSession(1);
  assert.equal(isGameFinished(session.run), false);
  assert.equal(isGameFinished(null), false);
  assert.equal(isGameFinished(undefined), false);
  const ended = buildGameEndedRun(session.run, 1, AT, []);
  assert.equal(isGameFinished(ended), true);
});

test("GAMEEND-4: 任意Turn（Turn32固定ではない）でGame Endできる — Turn2で終了したケース", () => {
  const session = makeSession(2);
  assert.equal(session.run.completedTurns, 2, "前提: Turn2まで完了した");
  const endTurn = lastCompletedTurn(session);
  assert.equal(endTurn, 2);
  const snapshot = computeFinalEvaluationSnapshot(session);
  const endedRun = buildGameEndedRun(session.run, endTurn, AT, snapshot);
  assert.equal(endedRun.gameEndTurn, 2);
  assert.equal(snapshot.length, session.fixtures.length, "5社ぶんのsnapshotが揃っている");
});

test("GAMEEND-6: lastCompletedTurnは、次に処理予定のscenarioState.currentTurn（N+1）ではなく、実際に確定したcompletedTurns（N）を返す", () => {
  const session = makeSession(2);
  // engine.tsの仕様上、2Turn処理し終えた直後はcurrentTurnが3（次に処理するTurn）を指す。
  // Game End Turnとして使ってよいのはcompletedTurns=2の方であることを固定する回帰テスト。
  assert.equal(session.state.scenarioState.currentTurn, 3);
  assert.equal(lastCompletedTurn(session), 2);
});

test("GAMEEND-5: rankFinalSnapshotはTotal Shareholder Value降順で並ぶ", () => {
  const session = makeSession(3);
  const snapshot = computeFinalEvaluationSnapshot(session);
  const ranked = rankFinalSnapshot(snapshot);
  for (let i = 1; i < ranked.length; i++) {
    const prev = ranked[i - 1].totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY;
    const curr = ranked[i].totalShareholderValueUsd ?? Number.NEGATIVE_INFINITY;
    assert.ok(prev >= curr, `ranked[${i - 1}]=${prev} は ranked[${i}]=${curr} 以上のはず`);
  }
});
