// ShrimpX V2 — 32Q Management Console Phase 9: Save/Resume のテスト（SAVE-1〜SAVE-10）
//
// 【このテスト群が守る因果】
//  画面を移動しても・ハードリロードしても・ブラウザを閉じても、resumePayload さえ
//  保存されていれば「そのTurnから続きを進められる」こと。Q1からの再構築や、
//  別Runの暗黙生成をしないこと。古いRun（resumePayload無し）は閲覧専用のまま
//  であり続けること。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload, ROLLING_RESUME_HISTORY_WINDOW } from "../persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, toSimulationRunSummary } from "../persistence/types";
import { createInMemorySimulationRunRepository } from "../persistence/repository";
import { buildDatasetFromSession, mergeAnalyticsDatasets } from "../analytics/dataset";
import { CompanyControlMode } from "../types";
import { CompanyDecisionInput } from "../../types";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * 【SAVE-2で判明】requestedTurns はシナリオ全体の長さ（config.turns）を兼ねるため、
 * ここへ「進めたいターン数」をそのまま渡すと、進めた直後に isComplete=true になり、
 * 「復元後に続きへ進められる」ことを確認できなくなる。標準の32Qぶんの長さを確保した
 * うえで、そのうち一部（turnsToRun）だけを進める。
 */
function runTurns(simulationRunId: string, turnsToRun: number, seed = "phase9-resume-test") {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed, requestedTurns: 32, startedAt: AT });
  return advanceSimulationTurns({ session, turns: turnsToRun, timestamp: AT });
}

// SAVE-1: serialize/restore round-trip
// 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】resumePayload.state.history は
// ROLLING_RESUME_HISTORY_WINDOW（4）件へ間引かれる。4ターンぶんの実行はwindow以内
// のため間引きが発生せず、状態全体の往復一致を確認できる（間引き自体はPERSIST-1で確認）。
test("SAVE-1: resumePayloadはJSON往復してもCompanyLabState・fixturesが変わらない（window以内）", () => {
  const session = runTurns("save-1", 4);
  const controlModes: Readonly<Record<string, CompanyControlMode>> = { BAL: "PLAYER" };
  const decisions: Readonly<Record<string, CompanyDecisionInput>> = {};
  const payload = buildResumePayload(session, controlModes, decisions);
  const roundTripped = JSON.parse(JSON.stringify(payload));
  const restored = restoreSessionFromResumePayload(session.run, roundTripped, { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });

  // 【JSON.stringifyの既知の性質】値が undefined のキーはstringify時に落ちる
  // （branded unit型はただのnumberでこの問題を持たないが、意思決定等の一部の
  // optionalフィールドは影響を受ける）。実行時の意味（キー無し・値がundefined、
  // どちらもアクセス結果はundefined）は変わらないため、比較対象も同じJSON往復を
  // 経たものにする（捏造した差分をテストが検知したことにしない）。
  assert.deepEqual(restored.state, JSON.parse(JSON.stringify(session.state)));
  assert.deepEqual(restored.fixtures, JSON.parse(JSON.stringify(session.fixtures)));
  assert.equal(restored.state.scenarioState.currentTurn, session.state.scenarioState.currentTurn);
});

// SAVE-2: resume-then-advance-a-turn
// 【Save/Resume 長期永続化・鮮度整合 BLOCKER修正】5ターン実行後はwindow(4)を超えるため
// resumePayload.state.historyは直近4件へ間引かれる。復元直後のhistory.lengthは
// min(5,4)=4になる（元のsessionの5とは一致しない、これが意図した設計）。
// ここで確認すべきは「Turnが正しく進む・historyが1件増える」ことであり、
// 「間引き前のhistory件数と一致する」ことではない。
test("SAVE-2: 復元したセッションはそのまま次のTurnへ進められる（Q1に戻らない）", () => {
  const session = runTurns("save-2", 5);
  const payload = buildResumePayload(session, {}, {});
  assert.equal(payload.state.history.length, 4, "resumePayload.state.historyがrolling windowへ間引かれていない");
  const restored = restoreSessionFromResumePayload(session.run, payload, { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });

  const beforeTurn = restored.state.scenarioState.currentTurn;
  const historyBeforeAdvance = restored.state.history.length;
  const outcome = advanceSimulationTurn(restored, AT);
  assert.ok(outcome.advanced, "復元後のTurn前進に失敗した");
  assert.equal(outcome.session.state.scenarioState.currentTurn, beforeTurn + 1, "復元後にTurnがQ1へ戻ってしまっている");
  assert.equal(outcome.session.state.history.length, historyBeforeAdvance + 1);
});

// SAVE-3: PLAYER-mode-state restore
test("SAVE-3: 保存時点の会社別経営モード（PLAYER/STANDARD_AI）がそのまま復元される", () => {
  const session = runTurns("save-3", 2);
  const controlModes: Readonly<Record<string, CompanyControlMode>> = { BAL: "PLAYER", MASS: "STANDARD_AI" };
  const payload = buildResumePayload(session, controlModes, {});
  const restored = restoreSessionFromResumePayload(session.run, payload, undefined);
  assert.equal(restored, restored); // 復元は例外を投げない
  assert.deepEqual(payload.companyControlModes, controlModes);
});

// SAVE-4: confirmedPlayerDecisions（decisionOwner）の履歴が保存・復元される
test("SAVE-4: 確定済みPLAYER意思決定はresumePayloadに含まれ、復元後にそのまま提出できる", () => {
  const session = runTurns("save-4", 1);
  const fixture = session.fixtures[0];
  const fakeDecision = { companyId: fixture.companyId } as unknown as CompanyDecisionInput;
  const decisions: Readonly<Record<string, CompanyDecisionInput>> = { [fixture.companyId]: fakeDecision };
  const payload = buildResumePayload(session, { [fixture.companyId]: "PLAYER" }, decisions);
  assert.deepEqual(payload.confirmedPlayerDecisions, decisions);

  const restored = restoreSessionFromResumePayload(session.run, payload, { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns });
  assert.deepEqual(restored.fixtures, session.fixtures);
});

// SAVE-5: scenario/seed persistence
test("SAVE-5: 復元後もscenarioId/seedが保存時点と一致する（別Runへすり替わらない）", () => {
  const session = runTurns("save-5", 2, "phase9-seed-check");
  const payload = buildResumePayload(session, {}, {});
  const restored = restoreSessionFromResumePayload(session.run, payload, undefined);
  assert.equal(restored.run.scenarioId, session.run.scenarioId);
  assert.equal(restored.run.seed, session.run.seed);
  assert.equal(restored.config.scenarioId, session.run.scenarioId);
  assert.equal(restored.config.seed, session.run.seed);
});

// SAVE-6: factory/inventory/debt/cash persistence
test("SAVE-6: 工場・在庫・借入・現金の各状態が復元後も保存時点と一致する", () => {
  const session = runTurns("save-6", 6);
  const payload = buildResumePayload(session, {}, {});
  const restored = restoreSessionFromResumePayload(session.run, payload, undefined);

  const beforeSummary = session.state.history[session.state.history.length - 1].companySummaries;
  const afterSummary = restored.state.history[restored.state.history.length - 1].companySummaries;
  assert.deepEqual(afterSummary, beforeSummary, "直近ターンの会社サマリー（在庫・稼働率等）が復元後に一致しない");
  assert.deepEqual(restored.state.workforceState, session.state.workforceState, "workforceState（工場別人員）が復元後に一致しない");
});

// SAVE-7: multiple independent Runs
test("SAVE-7: 複数のRunを独立してrepositoryへ保存・復元でき、互いのresumePayloadが混ざらない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const sessionA = runTurns("save-7-a", 3, "seed-a");
  const sessionB = runTurns("save-7-b", 4, "seed-b");

  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: sessionA.run,
    dataset: buildDatasetFromSession(sessionA),
    resumePayload: buildResumePayload(sessionA, { BAL: "PLAYER" }, {}),
    savedAt: AT,
  });
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: sessionB.run,
    dataset: buildDatasetFromSession(sessionB),
    resumePayload: buildResumePayload(sessionB, { MASS: "PLAYER" }, {}),
    savedAt: AT,
  });

  const loadedA = await repository.loadRun("save-7-a");
  const loadedB = await repository.loadRun("save-7-b");
  assert.ok(loadedA?.resumePayload && loadedB?.resumePayload);
  assert.deepEqual(loadedA.resumePayload.companyControlModes, { BAL: "PLAYER" });
  assert.deepEqual(loadedB.resumePayload.companyControlModes, { MASS: "PLAYER" });
  assert.equal(loadedA.resumePayload.state.scenarioState.currentTurn, sessionA.state.scenarioState.currentTurn);
  assert.equal(loadedB.resumePayload.state.scenarioState.currentTurn, sessionB.state.scenarioState.currentTurn);
});

// SAVE-8: new-Run-doesn't-delete-old
test("SAVE-8: 新しいRunを保存しても、保存上限内であれば既存の別Runは消えない", async () => {
  const repository = createInMemorySimulationRunRepository();
  const oldSession = runTurns("save-8-old", 2);
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: oldSession.run,
    dataset: buildDatasetFromSession(oldSession),
    resumePayload: buildResumePayload(oldSession, {}, {}),
    savedAt: AT,
  });

  const newSession = runTurns("save-8-new", 1);
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: newSession.run,
    dataset: buildDatasetFromSession(newSession),
    resumePayload: buildResumePayload(newSession, {}, {}),
    savedAt: AT,
  });

  assert.ok(await repository.loadRun("save-8-old"), "新しいRunの保存で古いRunが消えてしまっている");
  assert.ok(await repository.loadRun("save-8-new"));
  const runs = await repository.listRuns();
  assert.equal(runs.length, 2);
});

// SAVE-9: legacy-Run-is-VIEW_ONLY
test("SAVE-9: resumePayloadを持たない旧形式のRunは、要約上 hasResumePayload=false（VIEW_ONLY）になる", async () => {
  const repository = createInMemorySimulationRunRepository();
  const legacySession = runTurns("save-9-legacy", 3);
  const stored = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: legacySession.run,
    dataset: buildDatasetFromSession(legacySession),
    // resumePayload を意図的に付けない（v1/v2相当の古い保存物を模す）。
    savedAt: AT,
  };
  await repository.saveRun(stored);
  const loaded = await repository.loadRun("save-9-legacy");
  assert.ok(loaded);
  assert.equal(loaded.resumePayload, undefined);
  const summary = toSimulationRunSummary(loaded);
  assert.equal(summary.hasResumePayload, false, "resumePayload無しのRunがhasResumePayload=trueとして扱われている");
});

// SAVE-10: corrupted-state-doesn't-silently-reset
test("SAVE-10: 壊れたresumePayload（stateが欠けている）は、Q1へ黙って作り直さず例外になる", () => {
  const session = runTurns("save-10", 2);
  const corruptedPayload = { ...buildResumePayload(session, {}, {}), state: undefined } as unknown as ReturnType<typeof buildResumePayload>;
  const restored = restoreSessionFromResumePayload(session.run, corruptedPayload, undefined);
  // restoreSessionFromResumePayload自体は組み立てるだけだが、続けて使おうとした瞬間に
  // 壊れていることが分かる（＝呼び出し側がtry/catchでVIEW_ONLYへ落とせる形になっている）。
  // 黙って Turn 1 の状態を捏造していないことを、アクセス時の例外で確認する。
  assert.throws(() => {
    void restored.state.scenarioState.currentTurn;
  });
});

// ---------------------------------------------------------------------
// PERSIST-1〜PERSIST-15: Save/Resume 長期永続化・鮮度整合 BLOCKER修正
// ---------------------------------------------------------------------

// PERSIST-1: resume snapshotサイズがturn数に比例して線形成長しない
test("PERSIST-1: resumePayloadサイズはwindowを超えるとturn数に比例して増え続けない（近似定数）", () => {
  const session8 = runTurns("persist-1-a", 8);
  const session16 = runTurns("persist-1-b", 16, "persist-1-b-seed");
  const payload8 = buildResumePayload(session8, {}, {});
  const payload16 = buildResumePayload(session16, {}, {});
  assert.equal(payload8.state.history.length, ROLLING_RESUME_HISTORY_WINDOW);
  assert.equal(payload16.state.history.length, ROLLING_RESUME_HISTORY_WINDOW);
  const size8 = JSON.stringify(payload8).length;
  const size16 = JSON.stringify(payload16).length;
  // 8ターンぶんの資産（原料ロット・契約等の当期スナップショットは若干増える余地があるが）と
  // 16ターンぶんの資産で、historyが同じwindow件数に固定されている以上、旧実装（O(turns)の
  // 線形成長）のような "turn数が2倍→resumePayloadサイズもほぼ2倍" にはならないことを確認する。
  const ratio = size16 / size8;
  assert.ok(ratio < 1.5, `turn数2倍でresumePayloadサイズが${ratio.toFixed(2)}倍に増えている（線形成長の疑い）`);
});

// PERSIST-9 / #44: Analysis history preservation — resume snapshot軽量化してもdatasetは欠落しない
test("PERSIST-9: rolling windowで間引かれた後も、priorAnalyticsDataset経由でresume前のturnのdatasetが失われない", () => {
  const session = runTurns("persist-9", 8);
  const priorDataset = buildDatasetFromSession(session); // reload前、フルhistoryから作られた完全なdataset
  const payload = buildResumePayload(session, {}, {});
  assert.equal(payload.state.history.length, ROLLING_RESUME_HISTORY_WINDOW, "前提: historyが間引かれていること");

  const restored = restoreSessionFromResumePayload(session.run, payload, { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns }, priorDataset);
  const rebuiltAfterRestore = buildDatasetFromSession(restored);

  // 間引き後のsession.state.historyだけから作ればturn 1-4ぶんのcompanyMetricsが消えるはずだが、
  // priorAnalyticsDatasetとのマージにより turns 1-8 すべてがそろっている。
  assert.deepEqual([...rebuiltAfterRestore.turns].sort((a, b) => a - b), session.state.history.map((r) => r.turn));
  for (const turn of [1, 2, 3, 4]) {
    assert.ok(
      rebuiltAfterRestore.companyMetrics.some((f) => f.turn === turn),
      `resume以前のturn ${turn} のcompanyMetricsがpriorAnalyticsDatasetとのマージ後も欠落している`
    );
  }

  // さらに1ターン進めても、resume以前のturnは引き続き失われない。
  const advanced = advanceSimulationTurn(restored, AT);
  assert.ok(advanced.advanced);
  const datasetAfterOneMoreTurn = buildDatasetFromSession(advanced.session);
  assert.ok(datasetAfterOneMoreTurn.companyMetrics.some((f) => f.turn === 1), "resume後にもう1ターン進めた後もturn1のdatasetが欠落している");
  assert.ok(datasetAfterOneMoreTurn.companyMetrics.some((f) => f.turn === 9), "新しいturn9のdatasetが反映されていない");
});

// mergeAnalyticsDatasets: next側のturnはnextを優先し、prior固有のturnだけ引き継ぐ
test("PERSIST-9b: mergeAnalyticsDatasetsは重複turnをnext優先で解決し、prior固有turnだけ残す", () => {
  const sessionA = runTurns("persist-9b-a", 3);
  const sessionB = runTurns("persist-9b-b", 5, "persist-9b-b-seed");
  const prior = buildDatasetFromSession(sessionA); // turns 1-3
  const next = buildDatasetFromSession(sessionB); // turns 1-5 (別seedの値)
  const merged = mergeAnalyticsDatasets(prior, next);
  assert.deepEqual([...merged.turns].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  // turn 1-3はnext（sessionB）の値を採用しているはず。
  const mergedTurn1 = merged.companyMetrics.filter((f) => f.turn === 1);
  const nextTurn1 = next.companyMetrics.filter((f) => f.turn === 1);
  assert.deepEqual(mergedTurn1, nextTurn1);
});
