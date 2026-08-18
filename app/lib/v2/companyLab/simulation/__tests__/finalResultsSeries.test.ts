// ShrimpX V2 — Game End / Final Results（END-3）: finalResultsSeries.ts のユニットテスト
//
// 【新しい計算をしない】TSV系列は既存computeCompanyEvaluationSnapshotの
// 呼び出し結果と一致することだけを確認する（値そのものの正しさは
// evaluationSemantics.test.tsの責務）。配当系列は確定実績
// （dividendResults[].appliedDividendUsd）をそのまま取り出しているかだけ確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { computeCompanyEvaluationSnapshot } from "../../evaluation/evaluationSemantics";
import { buildDividendSeries, buildTsvSeries } from "../analytics/finalResultsSeries";

const AT = "2026-01-01T00:00:00.000Z";

function makeSession(turns: number) {
  const session = createSimulationSession({ simulationRunId: "final-series-test", scenarioId: "baseline", seed: "final-series-test", requestedTurns: turns, startedAt: AT });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

test("FRS-1: buildTsvSeriesの各点は、既存computeCompanyEvaluationSnapshot(history, companyId, turn)と一致する", () => {
  const session = makeSession(3);
  const series = buildTsvSeries(session.state.history, session.fixtures, 3);
  for (const s of series) {
    for (const point of s.points) {
      const expected = computeCompanyEvaluationSnapshot(session.state.history, s.companyId, point.turn).totalShareholderValueUsd;
      assert.equal(point.value, expected, `company=${s.companyId} turn=${point.turn}`);
    }
  }
});

test("FRS-2: buildTsvSeries/buildDividendSeriesの点数は、渡したgameEndTurn（32固定ではない）に一致する", () => {
  const session = makeSession(2);
  const tsv = buildTsvSeries(session.state.history, session.fixtures, 2);
  const dividend = buildDividendSeries(session.state.history, session.fixtures, 2);
  for (const s of tsv) assert.equal(s.points.length, 2);
  for (const s of dividend) assert.equal(s.points.length, 2);

  const tsv5 = buildTsvSeries(session.state.history, session.fixtures, 5);
  for (const s of tsv5) assert.equal(s.points.length, 5, "Turn3〜5は確定実績が無いのでnullで埋まるが、点自体は5個ある");
});

test("FRS-3: buildDividendSeriesは配当を実施していないTurnはnull、実施したTurnはappliedDividendUsdをそのまま返す", () => {
  const session = makeSession(3);
  const targetCompanyId = session.fixtures[0].companyId;
  const series = buildDividendSeries(session.state.history, session.fixtures, 3).find((s) => s.companyId === targetCompanyId)!;
  for (const point of series.points) {
    const record = session.state.history.find((r) => r.turn === point.turn);
    const result = record?.dividendResults?.find((d) => d.companyId === targetCompanyId) ?? null;
    assert.equal(point.value, result ? result.appliedDividendUsd : null, `turn=${point.turn}`);
  }
});

test("FRS-4: 全会社ぶんの系列が返る（5社が揃っている）", () => {
  const session = makeSession(1);
  const tsv = buildTsvSeries(session.state.history, session.fixtures, 1);
  const dividend = buildDividendSeries(session.state.history, session.fixtures, 1);
  assert.equal(tsv.length, session.fixtures.length);
  assert.equal(dividend.length, session.fixtures.length);
});
