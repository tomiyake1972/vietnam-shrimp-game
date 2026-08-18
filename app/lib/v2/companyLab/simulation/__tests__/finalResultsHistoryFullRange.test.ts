// ShrimpX V2 — Final Results履歴修正（FR-1〜7）の回帰テスト
//
// 【再現した不具合】32Turn完走したRunのFinal Resultsで、
//   (A) totalShareholderValueHistory / dividendHistory がTurn29〜32しか無く、
//       Turn1〜28がすべてnull
//   (B) Turn32の履歴TSVが、正式なfinalEvaluationSnapshotのTSVと約15.5M USD食い違う
// が同時に発生していた。どちらも原因は同じで、Final Resultsへ渡していた
// session.state.history が、resume時に ROLLING_RESUME_HISTORY_WINDOW(=4) Turnへ
// 間引かれていたためである（(B)は、直近4Turnぶんの配当しかDividend Valueに
// 入らなかったことによる過小評価）。
//
// 修正は「評価専用の全Turn履歴（evaluationHistory）をresumeで間引かずに持ち回り、
// Final ResultsとGame End Snapshotの両方がそれを唯一の入力にする」こと。
// TSVの式そのもの（evaluationSemantics.ts）は一切変更していない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload, ROLLING_RESUME_HISTORY_WINDOW } from "../persistence/resume";
import { buildDividendSeries, buildTsvSeries } from "../analytics/finalResultsSeries";
import { resolveEvaluationHistory } from "../../evaluation/evaluationHistory";
import { computeCompanyEvaluationSnapshot } from "../../evaluation/evaluationSemantics";
import { SimulationSession } from "../types";

const AT = "2026-01-01T00:00:00.000Z";
const TOTAL_TURNS = 32;

function runTurns(session: SimulationSession, count: number): SimulationSession {
  let current = session;
  for (let i = 0; i < count; i++) {
    const outcome = advanceSimulationTurn(current, AT);
    assert.ok(outcome.advanced, `Turn ${current.state.scenarioState.currentTurn} で停止した: ${outcome.error}`);
    current = outcome.session;
  }
  return current;
}

/** 32Turn完走したうえで一度save/resumeを挟む（＝実際のFinal Results画面と同じ状態）。 */
function completedAndResumedSession(): SimulationSession {
  const fresh = createSimulationSession({
    simulationRunId: "run-final-results-history",
    scenarioId: "dynamic-scenario-2",
    seed: "management-console-32q",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
  });
  const live = runTurns(fresh, TOTAL_TURNS);
  const payload = JSON.parse(JSON.stringify(buildResumePayload(live, {}, {}))) as never;
  return restoreSessionFromResumePayload(live.run, payload);
}

function evaluationHistoryOf(session: SimulationSession) {
  return resolveEvaluationHistory({ evaluationHistory: session.evaluationHistory, stateHistory: session.state.history });
}

/**
 * FR-1: Turn1〜32のrecordがあるRunで、TSV historyが32点すべてnon-nullであること。
 * あわせて「state.historyは間引かれている（＝この修正が実際に効いている状況）」も
 * 前提として確認する。
 */
test("FR-1: resume後もTSV historyがTurn1〜32まで全点non-null", () => {
  const session = completedAndResumedSession();
  assert.equal(
    session.state.history.length,
    ROLLING_RESUME_HISTORY_WINDOW,
    "前提: state.historyはrolling windowへ間引かれていること（この修正が必要な状況）"
  );

  const series = buildTsvSeries(evaluationHistoryOf(session), session.fixtures, TOTAL_TURNS);
  assert.equal(series.length, session.fixtures.length);
  for (const company of series) {
    assert.equal(company.points.length, TOTAL_TURNS, `${company.companyId}: 32点無い`);
    const nulls = company.points.filter((p) => p.value === null).map((p) => p.turn);
    assert.deepEqual(nulls, [], `${company.companyId}: nullのTurnが残っている`);
    assert.deepEqual(
      company.points.map((p) => p.turn),
      Array.from({ length: TOTAL_TURNS }, (_, i) => i + 1)
    );
  }
});

/**
 * FR-2: Turn1〜32のDividend historyが32点存在し、未配当Turnはnullではなく0であること
 * （0は「配当しなかった」という事実であり、欠測ではない）。
 */
test("FR-2: Dividend historyが32点あり、未配当Turnは0（nullにしない）", () => {
  const session = completedAndResumedSession();
  const series = buildDividendSeries(evaluationHistoryOf(session), session.fixtures, TOTAL_TURNS);
  let paidPoints = 0;
  for (const company of series) {
    assert.equal(company.points.length, TOTAL_TURNS);
    for (const point of company.points) {
      assert.notEqual(point.value, null, `${company.companyId} Turn${point.turn}: 記録があるTurnをnullにしてはいけない`);
      assert.equal(Number.isFinite(point.value as number), true);
      assert.ok((point.value as number) >= 0);
      if ((point.value as number) > 0) paidPoints++;
    }
  }
  assert.ok(paidPoints > 0, "前提: このRunでは少なくとも1回は配当が実行されていること");
});

/**
 * FR-3: 複数回配当した会社で、Turn32のTSV履歴が「累積Dividend Value」を使っていること
 * （そのTurn単独の配当額ではない）。修正前はここが単独配当額相当になっていた。
 */
test("FR-3: Turn32のTSVは累積Dividend Valueを含む（当Turn配当だけではない）", () => {
  const session = completedAndResumedSession();
  const history = evaluationHistoryOf(session);
  const dividendSeries = buildDividendSeries(history, session.fixtures, TOTAL_TURNS);

  const multiPayer = dividendSeries.find((s) => s.points.filter((p) => (p.value ?? 0) > 0).length >= 2);
  assert.ok(multiPayer, "前提: 2回以上配当した会社が存在すること");

  const snapshot = computeCompanyEvaluationSnapshot(history, multiPayer.companyId, TOTAL_TURNS);
  const lastTurnDividend = multiPayer.points.find((p) => p.turn === TOTAL_TURNS)?.value ?? 0;
  const paidTurns = multiPayer.points.filter((p) => (p.value ?? 0) > 0);

  // Dividend Value は各配当を15%複利で評価した合計なので、必ず「単純合計以上」かつ
  // 「最終Turn単独の配当額より大きい」。
  const simpleSum = paidTurns.reduce((sum, p) => sum + (p.value ?? 0), 0);
  assert.ok(
    snapshot.currentDividendValueUsd >= simpleSum - 1e-6,
    `Dividend Value(${snapshot.currentDividendValueUsd}) が単純合計(${simpleSum}) を下回っている`
  );
  assert.ok(
    snapshot.currentDividendValueUsd > lastTurnDividend + 1e-6,
    "Dividend Valueが最終Turn単独の配当額と同程度になっている（累積が効いていない）"
  );

  // §13: TSV = DividendValue + CurrentCompanyValue が成立すること。
  assert.ok(snapshot.totalShareholderValueUsd !== null);
  assert.ok(snapshot.currentCompanyValue.currentCompanyValueUsd !== null);
  assert.ok(
    Math.abs(
      (snapshot.totalShareholderValueUsd as number) -
        (snapshot.currentDividendValueUsd + (snapshot.currentCompanyValue.currentCompanyValueUsd as number))
    ) < 1e-6
  );
});

/**
 * FR-4: history[gameEndTurn].TSV === finalEvaluationSnapshot.TSV（5社すべて・§12）。
 * finalEvaluationSnapshotはGame End時に保存される正式値であり、
 * 履歴側と同じ入力・同じevaluation serviceから出ていることを固定する。
 */
test("FR-4: Game End TurnのTSV履歴が5社とも正式Final Snapshotと一致", async () => {
  const { computeFinalEvaluationSnapshot } = await import("../../../../../v2/management/lib/gameEnd");
  const session = completedAndResumedSession();
  const snapshots = computeFinalEvaluationSnapshot(session);
  const series = buildTsvSeries(evaluationHistoryOf(session), session.fixtures, TOTAL_TURNS);

  assert.equal(snapshots.length, session.fixtures.length);
  for (const snapshot of snapshots) {
    const historyValue = series.find((s) => s.companyId === snapshot.companyId)?.points.find((p) => p.turn === TOTAL_TURNS)?.value;
    assert.notEqual(historyValue, null, `${snapshot.companyId}: Game End TurnのTSV履歴がnull`);
    assert.ok(
      Math.abs((historyValue as number) - (snapshot.totalShareholderValueUsd as number)) < 1e-6,
      `${snapshot.companyId}: history=${historyValue} final=${snapshot.totalShareholderValueUsd}`
    );
  }
});

/**
 * FR-5: asOfTurn semantics / future leakage禁止（§11）。
 * Turn10のTSVは、Turn11以降の履歴が増えても変わらない。
 */
test("FR-5: Turn10のTSVはTurn11以降の履歴が増えても変わらない", () => {
  const fresh = createSimulationSession({
    simulationRunId: "run-final-results-leakage",
    scenarioId: "dynamic-scenario-2",
    seed: "management-console-32q",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
  });
  const atTurn10 = runTurns(fresh, 10);
  const atTurn20 = runTurns(atTurn10, 10);

  for (const fixture of fresh.fixtures) {
    const early = computeCompanyEvaluationSnapshot(evaluationHistoryOf(atTurn10), fixture.companyId, 10);
    const later = computeCompanyEvaluationSnapshot(evaluationHistoryOf(atTurn20), fixture.companyId, 10);
    assert.equal(later.currentDividendValueUsd, early.currentDividendValueUsd, `${fixture.companyId}: Dividend Valueが後続Turnで変化した`);
    assert.equal(later.totalShareholderValueUsd, early.totalShareholderValueUsd, `${fixture.companyId}: TSVが後続Turnで変化した`);
  }
});

/**
 * FR-6: Turn1 / Turn2でも正常化CFの既存ルール（min(3, 確定Turn数)平均）が動くこと。
 * 履歴の点数が3未満でもTSVがnullにならない。
 */
test("FR-6: Turn1・Turn2でも正常化CFが1Turn/2Turn平均で成立する", () => {
  const fresh = createSimulationSession({
    simulationRunId: "run-final-results-early",
    scenarioId: "dynamic-scenario-2",
    seed: "management-console-32q",
    requestedTurns: TOTAL_TURNS,
    startedAt: AT,
  });
  const atTurn2 = runTurns(fresh, 2);
  const history = evaluationHistoryOf(atTurn2);
  const series = buildTsvSeries(history, atTurn2.fixtures, 2);
  for (const company of series) {
    assert.deepEqual(
      company.points.map((p) => p.turn),
      [1, 2]
    );
    for (const point of company.points) {
      assert.notEqual(point.value, null, `${company.companyId} Turn${point.turn}: 初期Turnで評価できていない`);
    }
  }
});

/**
 * FR-7: Turn3以降の正常化CFは直近3Turnだけを使うが、Dividend Valueはそれ以前の配当も
 * 保持すること（§10「履歴自体を3Turnへ絞るのではない」）。
 */
test("FR-7: 正常化CFは直近3Turnのみ・Dividend Valueは全期間を保持", () => {
  const session = completedAndResumedSession();
  const history = evaluationHistoryOf(session);
  const dividendSeries = buildDividendSeries(history, session.fixtures, TOTAL_TURNS);

  // rolling window（最終4Turn）より前にも配当している会社を選ぶ。
  const windowStartTurn = TOTAL_TURNS - ROLLING_RESUME_HISTORY_WINDOW + 1;
  const payer = dividendSeries.find((s) => s.points.some((p) => (p.value ?? 0) > 0 && p.turn < windowStartTurn));
  assert.ok(payer, "前提: rolling windowより前にも配当した会社が存在すること");

  const snapshot = computeCompanyEvaluationSnapshot(history, payer.companyId, TOTAL_TURNS);

  // window内の配当だけを15%複利評価した額（＝修正前に見えていたDividend Value相当）。
  const windowOnlyValue = payer.points
    .filter((p) => p.turn >= windowStartTurn && (p.value ?? 0) > 0)
    .reduce((sum, p) => sum + (p.value as number) * Math.pow(1.15, (TOTAL_TURNS - p.turn) / 4), 0);

  assert.ok(
    snapshot.currentDividendValueUsd > windowOnlyValue + 1e-6,
    `rolling windowより前の配当がDividend Valueから落ちている（修正前の不具合）: full=${snapshot.currentDividendValueUsd} windowOnly=${windowOnlyValue}`
  );

  // 正常化CFは最大3Turnぶんの平均であり、履歴全期間の平均ではない。
  const normalized = snapshot.currentCompanyValue.normalizedQuarterlyCashFlowUsd;
  assert.notEqual(normalized, null);
  const last3 = history
    .filter((r) => r.turn > TOTAL_TURNS - 3)
    .map((r) => r.financialResults.find((f) => f.companyId === payer.companyId))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => Number(f.cashFlow.operatingCashFlow));
  assert.equal(last3.length, 3);
  assert.ok(Math.abs((normalized as number) - last3.reduce((a, b) => a + b, 0) / 3) < 1e-6);
});

/**
 * FR-8（§15 既存Run互換）: evaluationHistoryを持たない古い保存物でも例外にならず、
 * これまでどおり state.history から作れるぶんだけを返すこと（推測値を作らない）。
 */
test("FR-8: evaluationHistoryを持たない既存Runは従来どおりstate.historyへフォールバック", () => {
  const session = completedAndResumedSession();
  const legacy = resolveEvaluationHistory({ evaluationHistory: undefined, stateHistory: session.state.history });
  assert.equal(legacy.length, ROLLING_RESUME_HISTORY_WINDOW);

  const series = buildTsvSeries(legacy, session.fixtures, TOTAL_TURNS);
  for (const company of series) {
    const nonNull = company.points.filter((p) => p.value !== null).map((p) => p.turn);
    assert.deepEqual(nonNull, [29, 30, 31, 32], "古い保存物では記録のあるTurnだけが描かれる（捏造しない）");
  }
});
