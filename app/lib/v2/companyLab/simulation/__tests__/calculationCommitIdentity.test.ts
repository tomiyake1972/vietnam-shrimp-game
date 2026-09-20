// ShrimpX V2 — Run Calculation Commit Identity のテスト（BALANCE-PROFILE-1 受入前修正）
//
// 「アプリ現在版」と「Run実計算版」が分離されていることを実測する。
// 実Git checkoutは変えず、sourceCommitを注入してdeployまたぎのresumeを再現する。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurn, advanceSimulationTurns } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import type { SimulationSession } from "../types";
import {
  UNKNOWN_SOURCE_COMMIT,
  isSingleCalculationCommit,
  latestRecordedCommit,
  resolveCalculationCommitForTurn,
  withCalculationCommitRecorded,
} from "../calculationCommit";
import {
  balanceCalibrationLogToCsv,
  balanceCalibrationLogToJson,
  buildBalanceCalibrationLog,
} from "../../manualBalance/calibrationLog";

const TS = "2026-01-01T00:00:00.000Z";
const COMMIT_A = "aaaaaaa1111";
const COMMIT_B = "bbbbbbb2222";
const COMMIT_C_EXPORT_TIME = "ccccccc3333";

function newSession(runId: string, sourceCommit: string | undefined, turns = 8): SimulationSession {
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: "baseline",
    seed: "calc-commit-seed",
    requestedTurns: turns,
    startedAt: TS,
    ...(sourceCommit !== undefined ? { sourceCommit } : {}),
  });
}

/** 保存→復元を挟む（deployをまたいだresumeと同じ経路を通す）。 */
function saveAndRestore(session: SimulationSession): SimulationSession {
  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
  return restoreSessionFromResumePayload(session.run, payload);
}

// ------------------------------------------------------------------ CCI-1〜4
test("CCI-1/2/3/4: commit AでTurn1-4、resume後commit BでTurn5-8を計算した履歴が区間として残る", () => {
  // 1. commit A でRunを作り、Turn1-4を計算する。
  let session = newSession("cci-ab", COMMIT_A);
  session = advanceSimulationTurns({ session, turns: 4, timestamp: TS, sourceCommit: COMMIT_A });
  assert.equal(session.run.completedTurns, 4);

  // 2. 保存して、commit B 相当としてresumeする。
  const restored = saveAndRestore(session);
  // 3. 次のTurnから commit B で進める。
  const advanced = advanceSimulationTurns({ session: restored, turns: 4, timestamp: TS, sourceCommit: COMMIT_B });
  assert.equal(advanced.run.completedTurns, 8);

  // 4. 履歴が A: Turn1〜 / B: Turn5〜 として区別できる。
  const history = advanced.run.calculationCommitHistory;
  assert.ok(history !== undefined);
  assert.deepEqual(
    history.map((e) => ({ from: e.effectiveFromTurn, commit: e.sourceCommit })),
    [
      { from: 1, commit: COMMIT_A },
      { from: 5, commit: COMMIT_B },
    ]
  );

  // Turn単位で引ける。
  for (const turn of [1, 2, 3, 4]) {
    assert.equal(resolveCalculationCommitForTurn(history, turn), COMMIT_A, `turn=${turn}`);
  }
  for (const turn of [5, 6, 7, 8]) {
    assert.equal(resolveCalculationCommitForTurn(history, turn), COMMIT_B, `turn=${turn}`);
  }
  assert.equal(isSingleCalculationCommit(history), false, "複数commitなのに単一と判定されている");
});

// ------------------------------------------------------------------- CCI-5
test("CCI-5: 同じcommitでresumeしても履歴entryは増えない", () => {
  let session = newSession("cci-same", COMMIT_A);
  // 作成しただけでは計算履歴は作られない（作成commitは別metadata）。
  assert.equal(session.run.calculationCommitHistory, undefined);
  assert.equal(session.run.runCreatedByCommit, COMMIT_A);

  session = advanceSimulationTurns({ session, turns: 3, timestamp: TS, sourceCommit: COMMIT_A });
  assert.equal(session.run.calculationCommitHistory?.length, 1);

  const restored = saveAndRestore(session);
  const advanced = advanceSimulationTurns({ session: restored, turns: 3, timestamp: TS, sourceCommit: COMMIT_A });

  assert.equal(advanced.run.calculationCommitHistory?.length, 1, "同じcommitなのにentryが増えている");
  assert.equal(advanced.run.calculationCommitHistory?.[0].effectiveFromTurn, 1, "過去entryが書き換わっている");
  assert.equal(advanced.run.calculationCommitHistory?.[0].sourceCommit, COMMIT_A);
  assert.equal(isSingleCalculationCommit(advanced.run.calculationCommitHistory), true);
});

// ------------------------------------------------------------------- CCI-6
test("CCI-6: 履歴が無い古いRunはUNKNOWNであり、現在アプリのcommitで捏造しない", () => {
  let session = newSession("cci-legacy", COMMIT_A);
  session = advanceSimulationTurns({ session, turns: 3, timestamp: TS, sourceCommit: COMMIT_A });

  // この機能より前に作られたRun（履歴フィールド自体が無い）を模す。
  const legacy: SimulationSession = { ...session, run: { ...session.run, calculationCommitHistory: undefined } };

  for (const turn of [1, 2, 3]) {
    assert.equal(resolveCalculationCommitForTurn(legacy.run.calculationCommitHistory, turn), UNKNOWN_SOURCE_COMMIT);
  }
  assert.equal(latestRecordedCommit(undefined), null);
  assert.equal(isSingleCalculationCommit(undefined), false);

  // Calibration Logも、Export時点のアプリcommitを過去Turnの計算commitにしない。
  const log = buildBalanceCalibrationLog(legacy, TS, COMMIT_C_EXPORT_TIME);
  assert.equal(log.header.exportAppCommit, COMMIT_C_EXPORT_TIME);
  assert.equal(log.header.runCalculationCommit, null, "履歴が無いのに単一commitを断定している");
  for (const row of log.rows) {
    assert.equal(row.calculationSourceCommit, UNKNOWN_SOURCE_COMMIT, `turn=${row.turn} がExport時点のcommitで埋められている`);
    assert.notEqual(row.calculationSourceCommit, COMMIT_C_EXPORT_TIME);
  }
});

// ------------------------------------------------------------------- CCI-7
test("CCI-7: Calibration CSV/JSONで各Turnの計算commitを追跡できる", () => {
  let session = newSession("cci-log", COMMIT_A);
  session = advanceSimulationTurns({ session, turns: 4, timestamp: TS, sourceCommit: COMMIT_A });
  session = advanceSimulationTurns({ session: saveAndRestore(session), turns: 4, timestamp: TS, sourceCommit: COMMIT_B });

  // Export時点では、A・Bのどちらとも違うcommit C でアプリが動いている。
  const log = buildBalanceCalibrationLog(session, TS, COMMIT_C_EXPORT_TIME);

  // headerはExport時点のアプリcommitとして持つだけで、Runの計算commitにはしない。
  assert.equal(log.header.exportAppCommit, COMMIT_C_EXPORT_TIME);
  assert.equal(log.header.runCalculationCommit, null, "複数commitなのに単一値へ潰している");
  assert.equal(log.header.calculationCommitHistory.length, 2);

  // 行ごとに計算commitが出る。
  const byTurn = new Map(log.rows.map((r) => [r.turn, r.calculationSourceCommit]));
  assert.equal(byTurn.get(1), COMMIT_A);
  assert.equal(byTurn.get(4), COMMIT_A);
  assert.equal(byTurn.get(5), COMMIT_B);
  assert.equal(byTurn.get(8), COMMIT_B);
  for (const commit of byTurn.values()) {
    assert.notEqual(commit, COMMIT_C_EXPORT_TIME, "Export時点のcommitが計算commitとして出力されている");
  }

  // CSVの各行にも計算commitが入る。
  const csv = balanceCalibrationLogToCsv(log);
  const lines = csv.split("\n");
  const cols = lines[0].split(",");
  const commitIndex = cols.indexOf("calculationSourceCommit");
  assert.ok(commitIndex >= 0, "CSVにcalculationSourceCommit列が無い");
  assert.equal(lines[1].split(",")[commitIndex], COMMIT_A, "Turn1行の計算commitが違う");
  assert.equal(lines[5].split(",")[commitIndex], COMMIT_B, "Turn5行の計算commitが違う");
  // ヘッダ側はExport時点のアプリcommitという別名で出る。
  assert.ok(cols.includes("exportAppCommit"));
  assert.ok(!cols.includes("sourceCommit"), "紛らわしい sourceCommit 列が残っている");

  // JSONにも履歴がそのまま入る。
  const parsed = JSON.parse(balanceCalibrationLogToJson(log)) as typeof log;
  assert.equal(parsed.header.calculationCommitHistory.length, 2);
  assert.equal(parsed.header.calculationCommitHistory[1].effectiveFromTurn, 5);
  assert.equal(parsed.rows[0].calculationSourceCommit, COMMIT_A);
});

// ------------------------------------------------------------------- CCI-8
test("CCI-8: 単一commitで計算したRunはheaderに単一commitが出る", () => {
  let session = newSession("cci-single", COMMIT_A);
  session = advanceSimulationTurns({ session, turns: 3, timestamp: TS, sourceCommit: COMMIT_A });

  const log = buildBalanceCalibrationLog(session, TS, COMMIT_C_EXPORT_TIME);
  assert.equal(log.header.runCalculationCommit, COMMIT_A, "単一commitのRunなのに単一値が出ていない");
  assert.equal(log.header.exportAppCommit, COMMIT_C_EXPORT_TIME, "Export時点のアプリcommitと混ざっている");
  for (const row of log.rows) {
    assert.equal(row.calculationSourceCommit, COMMIT_A);
  }
});

// ------------------------------------------------------------------- CCI-9
test("CCI-9: 純粋関数の規約（重複追加しない・過去を上書きしない・区間解決）", () => {
  const h1 = withCalculationCommitRecorded(undefined, 1, COMMIT_A);
  assert.deepEqual(h1, [{ effectiveFromTurn: 1, sourceCommit: COMMIT_A }]);

  // 同じcommitなら増えない（同じ配列参照をそのまま返す）。
  const h2 = withCalculationCommitRecorded(h1, 5, COMMIT_A);
  assert.equal(h2, h1);

  // 違うcommitなら追記し、過去entryは残る。
  const h3 = withCalculationCommitRecorded(h2, 5, COMMIT_B);
  assert.equal(h3.length, 2);
  assert.deepEqual(h3[0], { effectiveFromTurn: 1, sourceCommit: COMMIT_A }, "過去entryが書き換わっている");

  // 区間の解決。
  assert.equal(resolveCalculationCommitForTurn(h3, 4), COMMIT_A);
  assert.equal(resolveCalculationCommitForTurn(h3, 5), COMMIT_B);
  // 最初の区間より前のTurnは不明（捏造しない）。
  assert.equal(resolveCalculationCommitForTurn([{ effectiveFromTurn: 3, sourceCommit: COMMIT_A }], 2), UNKNOWN_SOURCE_COMMIT);

  assert.equal(latestRecordedCommit(h3), COMMIT_B);
});

// ------------------------------------------------------------------ CCI-10
test("CCI-10: 計算commitの記録はゲームの経済結果を変えない", () => {
  const withA = advanceSimulationTurns({ session: newSession("cci-econ", COMMIT_A), turns: 5, timestamp: TS, sourceCommit: COMMIT_A });
  const withB = advanceSimulationTurns({ session: newSession("cci-econ", COMMIT_B), turns: 5, timestamp: TS, sourceCommit: COMMIT_B });

  // commitが違っても state（＝経済結果）は完全に一致する。
  assert.equal(
    JSON.stringify(withA.state),
    JSON.stringify(withB.state),
    "計算commitの違いで経済結果が変わっている（metadataのはずが計算へ influence している）"
  );
  // 記録側だけが違う。
  assert.notEqual(
    JSON.stringify(withA.run.calculationCommitHistory),
    JSON.stringify(withB.run.calculationCommitHistory)
  );
});

// ------------------------------------------------------- CCI-11（Turn1境界）
test("CCI-11: Run作成後に1Turnも計算せずcommitが変わった場合、Turn1の計算commitは実際に計算した方になる", () => {
  // A. commit A でRunを作成する
  const created = newSession("cci-turn1-boundary", COMMIT_A);
  // B. 1Turnも進めない
  assert.equal(created.run.completedTurns, 0);
  // 作成commitは別metadataとして残るが、計算履歴は空のまま
  // （作成しただけのcommitがTurn1の計算commitとして残ってはいけない）。
  assert.equal(created.run.runCreatedByCommit, COMMIT_A);
  assert.equal(created.run.calculationCommitHistory, undefined, "計算していないのに計算履歴が作られている");

  // C. 保存・resume
  const restored = saveAndRestore(created);
  assert.equal(restored.run.runCreatedByCommit, COMMIT_A, "作成commitがresumeで失われた");
  assert.equal(restored.run.calculationCommitHistory, undefined);

  // D. commit B相当でTurn1を実行
  const advanced = advanceSimulationTurns({ session: restored, turns: 1, timestamp: TS, sourceCommit: COMMIT_B });
  assert.equal(advanced.run.completedTurns, 1);

  // E. Turn1の計算commitがB
  assert.equal(resolveCalculationCommitForTurn(advanced.run.calculationCommitHistory, 1), COMMIT_B);
  assert.deepEqual(advanced.run.calculationCommitHistory, [{ effectiveFromTurn: 1, sourceCommit: COMMIT_B }]);

  // F. AがTurn1の計算commitとして残らない
  assert.ok(
    !JSON.stringify(advanced.run.calculationCommitHistory).includes(COMMIT_A),
    "作成commitが計算履歴へ混入している"
  );

  // Calibration Logでも同じ（作成commitは別項目として出るが、Turn行はB）。
  const log = buildBalanceCalibrationLog(advanced, TS, COMMIT_C_EXPORT_TIME);
  assert.equal(log.rows[0].calculationSourceCommit, COMMIT_B);
  assert.equal(log.header.runCreatedByCommit, COMMIT_A);
  assert.equal(log.header.exportAppCommit, COMMIT_C_EXPORT_TIME);
  assert.equal(log.header.runCalculationCommit, COMMIT_B, "単一commitで計算されたのに単一値が出ていない");
});

// ------------------------------------------------------- CCI-12（同値の後勝ち）
test("CCI-12: 同じeffectiveFromTurnが並んだ場合、後から記録した方を計算commitとする", () => {
  // 構造上は作られないが、解決器そのものの規約を固定しておく
  // （`>` のままだと古い方が残り、作成commitや失敗前のcommitを返してしまう）。
  const history = [
    { effectiveFromTurn: 1, sourceCommit: COMMIT_A },
    { effectiveFromTurn: 1, sourceCommit: COMMIT_B },
  ];
  assert.equal(resolveCalculationCommitForTurn(history, 1), COMMIT_B);
  assert.equal(latestRecordedCommit(history), COMMIT_B);
});

// ------------------------------------------------------- CCI-13（失敗Turn）
test("CCI-13: 失敗したTurnでは計算履歴へ記録しない", () => {
  const session = newSession("cci-fail", COMMIT_A, 2);
  // 壊れたstateを渡して計算を失敗させる（isCompleteではない経路で例外にする）。
  const broken: SimulationSession = {
    ...session,
    state: { ...session.state, scenarioState: { ...session.state.scenarioState, definition: null as never } },
  };
  const outcome = advanceSimulationTurn(broken, TS, undefined, COMMIT_B);
  assert.equal(outcome.advanced, false, "テスト前提: このTurnは失敗すること");
  assert.equal(outcome.session.run.calculationCommitHistory, undefined, "失敗Turnが計算履歴へ記録されている");
});
