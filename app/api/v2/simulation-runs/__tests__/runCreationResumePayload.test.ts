// ShrimpX V2 — Simulation Run「作成直後」のresumePayload保存のテスト
//
// 【直したバグ】以前はSetupScreen.tsxのhandleStartがdataset単体だけをsaveSimulationRunで
// 保存しており、resumePayloadはPLAYER意思決定確定・Turn進行まで存在しなかった。この
// ため、ゲーム開始直後（Turn1・まだ何も確定していない状態）はAI Management Meetingが
// 「resumePayloadが保存されていません」で使えなかった（成功条件：ゲーム開始直後、
// まだ一度も意思決定を確定していないTurn 1でAI経営会議を使えること）。
//
// 【このテストが直接見るもの】SetupScreen.tsxのhandleStartが実際に呼ぶ
// createSimulationSession（＝実際のRun作成と同一の初期化経路。AI会議専用の別の
// 初期化ロジックは使わない）とpersistResumableRun（＝Console・PLAYER Workspaceの
// 両方が既に使っている唯一の保存関数）と全く同じ組み合わせで作ったresumePayloadを
// repositoryへ保存し、buildSnapshotFromSimulationRunが正しくAI会議contextへ
// 変換できることを確認する。persistResumableRun自体はブラウザ側の
// simulationRunStore.ts（localStorage/fetch）に依存するため、ここではその内部で
// 呼ばれる純粋関数（buildResumePayload・buildDatasetFromSession）を同じ入力で
// 直接呼び、repository.saveRunへ渡す（既存のSAVE-7/8と同じ「repositoryへ直接保存」
// パターン）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSimulationSession } from "../../../../lib/v2/companyLab/simulation/engine";
import { buildResumePayload } from "../../../../lib/v2/companyLab/simulation/persistence/resume";
import { buildDatasetFromSession } from "../../../../lib/v2/companyLab/simulation/analytics/dataset";
import { createInMemorySimulationRunRepository, SimulationRunRepository } from "../../../../lib/v2/companyLab/simulation/persistence/repository";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../../../lib/v2/companyLab/simulation/persistence/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../lib/v2/companyLab/autoPolicy";
import { CompanyControlMode } from "../../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../../lib/v2/companyLab/types";
import { buildSnapshotFromSimulationRun } from "../[simulationRunId]/companies/[companyId]/turns/[turn]/ai-meeting/messages/_lib/handlers";

const AT = "2026-01-01T00:00:00.000Z";

/**
 * SetupScreen.tsxのhandleStartが実際に行う手順（createSimulationSession →
 * persistResumableRunが内部で呼ぶbuildDatasetFromSession/buildResumePayload）を
 * そのまま再現し、in-memory repositoryへ保存してから返す。fake state・AI会議専用の
 * 別の初期化は一切行わない。
 */
async function createRunAsSetupScreenDoes(
  simulationRunId: string,
  scenarioId: string,
  companyControlModes: Readonly<Record<string, CompanyControlMode>> = {}
): Promise<{ readonly repository: SimulationRunRepository; readonly session: ReturnType<typeof createSimulationSession> }> {
  const session = createSimulationSession({
    simulationRunId,
    scenarioId,
    seed: "run-creation-resume-payload-test",
    requestedTurns: 32,
    startedAt: AT,
    companyControlModes,
  });
  const repository = createInMemorySimulationRunRepository();
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload: buildResumePayload(session, companyControlModes, {}),
    savedAt: AT,
  });
  return { repository, session };
}

// ---------------------------------------------------------------------
// A. 新規Run作成直後・意思決定未確定でもresumePayloadが存在する
// ---------------------------------------------------------------------

test("RUN-CREATE-A: 新規Simulation Runを作成した直後（意思決定を一度も確定していない）でもresumePayloadが存在する", async () => {
  const { repository } = await createRunAsSetupScreenDoes("run-create-a", "dynamic-scenario-1", { BAL: "PLAYER" });
  const stored = await repository.loadRun("run-create-a");
  assert.ok(stored, "保存したRunがloadRunで読めること");
  assert.ok(stored!.resumePayload, "作成直後からresumePayloadが存在すること（これが今回のバグ修正の核心）");
  assert.deepEqual(stored!.resumePayload!.confirmedPlayerDecisions, {}, "意思決定はまだ何も確定していない");
  assert.equal(stored!.resumePayload!.state.scenarioState.currentTurn, 1, "作成直後はTurn1");
});

// ---------------------------------------------------------------------
// B. その状態でBAL / Turn1のAI Management Meeting context生成成功
// ---------------------------------------------------------------------

test("RUN-CREATE-B: 作成直後のRunでBAL / Turn1のAI Management Meeting context生成が成功する（以前は404だった）", async () => {
  const { repository } = await createRunAsSetupScreenDoes("run-create-b", "dynamic-scenario-1", { BAL: "PLAYER" });
  const built = await buildSnapshotFromSimulationRun(repository, "run-create-b", "BAL");
  assert.equal(built.ok, true, "resumePayloadが作成直後から存在するため、以前のような404にならない");
  if (!built.ok) return;
  assert.equal(built.snapshot.companyId, "BAL");
  assert.equal(built.snapshot.currentTurn, 1);
  assert.equal(built.snapshot.playerDraft?.hasDraft, false, "未確定draftの扱いは変更していない（確定済み意思決定が無ければhasDraft:false）");
});

// ---------------------------------------------------------------------
// C. Turn1 Newsが入る（future Newsは従来どおり入らない）
// ---------------------------------------------------------------------

test("RUN-CREATE-C: 作成直後のRunのAI会議contextに、Turn1で公開済みのScenario Newsが入る", async () => {
  const { repository } = await createRunAsSetupScreenDoes("run-create-c", "dynamic-scenario-1", { BAL: "PLAYER" });
  const built = await buildSnapshotFromSimulationRun(repository, "run-create-c", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(built.snapshot.scenarioNews.length > 0, "dynamic-scenario-1のTurn1では既に読めるNewsがある");
  assert.ok(
    built.snapshot.scenarioNews.every((n) => n.availableFromTurn <= 1),
    "Turn1時点で未来の記事が混ざっていない"
  );
});

// ---------------------------------------------------------------------
// D. 会社初期stateがPlayer Workspace表示値と一致する
// ---------------------------------------------------------------------

test("RUN-CREATE-D: AI会議contextの会社初期stateは、PLAYER Workspaceが表示するのと同じ導出（buildCompanyOwnState/buildPublicMarketInfo）から作られる", async () => {
  const { repository, session } = await createRunAsSetupScreenDoes("run-create-d", "dynamic-scenario-1", { BAL: "PLAYER" });
  const built = await buildSnapshotFromSimulationRun(repository, "run-create-d", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // PlayerWorkspace.tsxがブラウザ側で行っているのと同じ、session.stateから直接導出した
  // ownState/publicInfo（SSoT：AI会議専用の別計算を行っていないことの確認）。
  const fixture = session.fixtures.find((f) => f.companyId === "BAL")!;
  const expectedOwnState = buildCompanyOwnState(session.state, fixture);
  const expectedPublicInfo = buildPublicMarketInfo(session.state);

  assert.deepEqual(JSON.parse(JSON.stringify(built.snapshot.ownState)), JSON.parse(JSON.stringify(expectedOwnState)));
  assert.deepEqual(JSON.parse(JSON.stringify(built.snapshot.publicInfo)), JSON.parse(JSON.stringify(expectedPublicInfo)));
  assert.deepEqual(JSON.parse(JSON.stringify(built.snapshot.fixture)), JSON.parse(JSON.stringify(fixture)));
});

// ---------------------------------------------------------------------
// E. 意思決定確定後・Turn進行後の既存保存処理を壊さない
// ---------------------------------------------------------------------

test("RUN-CREATE-E: 作成直後のresumePayload保存の後、意思決定確定相当の再保存でresumePayloadが正しく更新される（既存の保存処理を壊さない）", async () => {
  const { repository, session } = await createRunAsSetupScreenDoes("run-create-e", "dynamic-scenario-1", { BAL: "PLAYER" });

  // 意思決定確定相当（PlayerWorkspace.tsx の handleConfirm と同じ形の再保存）。
  // 決定の中身自体は他テストの対象外だが、buildPlayerDraftSummaryが実際に読む
  // フィールド（salesPlans等）を持つ、本物の自動方針の出力を使う（fakeな空objectにしない）。
  const fixture = session.fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(session.state, fixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const decision: CompanyDecisionInput = generateAutoPolicyDecision(fixture, ownState, publicInfo, session.state.currentPeriod, 1);
  const confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>> = { BAL: decision };
  await repository.saveRun({
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload: buildResumePayload(session, { BAL: "PLAYER" }, confirmedPlayerDecisions),
    savedAt: AT,
  });

  const stored = await repository.loadRun("run-create-e");
  assert.ok(stored?.resumePayload, "再保存後もresumePayloadが存在する");
  assert.deepEqual(stored!.resumePayload!.confirmedPlayerDecisions.BAL, decision, "意思決定確定後の再保存が正しく上書きされる（作成時保存が後続の保存を妨げていない）");

  const built = await buildSnapshotFromSimulationRun(repository, "run-create-e", "BAL");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.snapshot.playerDraft?.hasDraft, true, "意思決定確定後はhasDraft:trueになる");
});

// ---------------------------------------------------------------------
// F. 他Scenario（baseline）でもRun作成直後stateが正常
// ---------------------------------------------------------------------

test("RUN-CREATE-F: dynamic-scenario-1以外（baseline）でもRun作成直後からresumePayloadが存在し、AI会議contextが作れる", async () => {
  const { repository } = await createRunAsSetupScreenDoes("run-create-f", "baseline", { BAL: "PLAYER" });
  const stored = await repository.loadRun("run-create-f");
  assert.ok(stored?.resumePayload, "baselineシナリオでも作成直後からresumePayloadが存在する");

  const built = await buildSnapshotFromSimulationRun(repository, "run-create-f", "BAL");
  assert.equal(built.ok, true, "baselineシナリオでもAI会議context生成が成功する（シナリオ固有の分岐を作っていない）");
  if (!built.ok) return;
  assert.equal(built.snapshot.currentTurn, 1);
  assert.equal(built.snapshot.scenarioId, "baseline");
});
