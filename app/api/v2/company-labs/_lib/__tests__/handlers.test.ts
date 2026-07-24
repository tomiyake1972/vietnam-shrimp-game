// ShrimpX V2 — 会社ラボ API ハンドラー結合テスト（Phase 8C-3A §11）
//
// NextRequest/NextResponseを一切使わず、handlers.tsの各関数をin-memory Repository＋
// 実際のCompanyLabQuarterFlowServiceに対して直接呼び出す（withApiContext・
// dependencies.ts＝実Redis接続は経由しない）。これにより、実Upstash認証情報が
// 無い本テスト実行環境でも、API層の主要経路をエンドツーエンドで検証できる
// （指示§11「route handlerへ依存関係を注入し、実Upstash認証情報なしでもAPIの
// 主要経路を検証できるようにする」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { buildInitialDraft } from "../../../../../v2/company-lab/decisionDraft";
import { CompanyLabApiDependencies } from "../dependencies";
import {
  handleCreateLab,
  handleGetHistoryEntry,
  handleGetHistoryPage,
  handleGetLabState,
  handleListLabs,
  handleProcessQuarter,
  handleSaveDraft,
  handleSubmitDraft,
} from "../handlers";

const NOW = "2026-01-01T00:00:00.000Z";

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

function baseCreateBody(overrides: Partial<{ labId: string; turns: number; seed: string }> = {}) {
  return { scenarioId: "baseline", mode: "canonical", seed: "handlers-test-001", turns: 4, ...overrides };
}

/**
 * decisionsProviderが実際にhandleProcessQuarter経由で呼ばれるため（本番相当の配線を
 * そのまま使う設計。decisionsProvider.test.ts参照）、テスト用のdraft本体も
 * handlers.tsのDEFAULT_PLAYER_COMPANY_ID（"BAL"）向けの妥当なCompanyDecisionDraft
 * である必要がある。turn・periodに依存しない構造のため、1回だけ生成して使い回す
 * （どのturnで使っても構造検証・エンジン実行には成功する。値の意味は問わない）。
 */
function buildValidPlayerDraftBody(): unknown {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "draft-fixture-seed", turns: 4 });
  const publicInfo = buildPublicMarketInfo(state);
  const fixture = fixtures.find((f) => f.companyId === "BAL");
  if (!fixture) throw new Error("テスト用フィクスチャにBALが見つかりません");
  const ownState = buildCompanyOwnState(state, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return buildInitialDraft(fixture, autoDecision);
}

const VALID_PLAYER_DRAFT_BODY = buildValidPlayerDraftBody();

/** draft保存→提出、を1回ぶん実行するヘルパー（handleProcessQuarterが実際にdecisionsProviderを
 * 通すため、draft本体はBAL向けの妥当なCompanyDecisionDraftを使う）。 */
async function saveAndSubmitDraft(deps: CompanyLabApiDependencies, labId: string) {
  const saveResult = await handleSaveDraft(deps, labId, { draft: VALID_PLAYER_DRAFT_BODY }, NOW);
  assert.equal(saveResult.status, 200, JSON.stringify(saveResult.body));
  const submitResult = await handleSubmitDraft(deps, labId, NOW);
  assert.equal(submitResult.status, 200, JSON.stringify(submitResult.body));
}

// -------------------------------------------------------------------
// 正常系
// -------------------------------------------------------------------

test("handleCreateLab: labId省略時はサーバーが生成し、201でラボ要約を返す", async () => {
  const deps = makeDeps();
  const result = await handleCreateLab(deps, baseCreateBody(), NOW);
  assert.equal(result.status, 201);
  const body = result.body as { lab: { labId: string; revision: number; currentTurn: number; isComplete: boolean } };
  assert.ok(body.lab.labId.length > 0);
  assert.equal(body.lab.revision, 0);
  assert.equal(body.lab.currentTurn, 1);
  assert.equal(body.lab.isComplete, false);
});

test("handleCreateLab: labIdを指定した場合はそのlabIdで作成される", async () => {
  const deps = makeDeps();
  const result = await handleCreateLab(deps, baseCreateBody({ labId: "my-explicit-lab" }), NOW);
  assert.equal(result.status, 201);
  const body = result.body as { lab: { labId: string } };
  assert.equal(body.lab.labId, "my-explicit-lab");
});

test("handleCreateLab: 不正なリクエストボディは400になる", async () => {
  const deps = makeDeps();
  const result = await handleCreateLab(deps, { scenarioId: "" }, NOW);
  assert.equal(result.status, 400);
});

test("handleCreateLab: 実在しないscenarioIdはCompanyLabError経由で400になる", async () => {
  const deps = makeDeps();
  const result = await handleCreateLab(deps, baseCreateBody({ labId: "lab-bad-scenario" }), NOW);
  // まず正しいscenarioIdで動作確認したうえで、不正値を試す
  assert.equal(result.status, 201);
  const badResult = await handleCreateLab(deps, { scenarioId: "no-such-scenario-xyz", mode: "canonical", seed: "s", turns: 1 }, NOW);
  assert.equal(badResult.status, 400);
});

test("handleListLabs / handleGetLabState: 作成したラボが一覧・単体取得の両方に現れる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-list-1" }), NOW);
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-list-2" }), NOW);

  const listResult = await handleListLabs(deps);
  assert.equal(listResult.status, 200);
  const listBody = listResult.body as { labs: { labId: string }[] };
  assert.deepEqual(
    listBody.labs.map((l) => l.labId).sort(),
    ["lab-list-1", "lab-list-2"]
  );

  const stateResult = await handleGetLabState(deps, "lab-list-1");
  assert.equal(stateResult.status, 200);
  const stateBody = stateResult.body as { lab: { labId: string; draft: unknown } };
  assert.equal(stateBody.lab.labId, "lab-list-1");
  assert.equal(stateBody.lab.draft, null);
});

test("handleSaveDraft → handleSubmitDraft → handleProcessQuarter: turn 1を最初から最後まで処理できる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-full-flow" }), NOW);

  const saveResult = await handleSaveDraft(deps, "lab-full-flow", { draft: VALID_PLAYER_DRAFT_BODY }, NOW);
  assert.equal(saveResult.status, 200);
  const saveBody = saveResult.body as { draft: { turnId: string; submittedAt: string | null } };
  assert.equal(saveBody.draft.turnId, "turn-1");
  assert.equal(saveBody.draft.submittedAt, null);

  const submitResult = await handleSubmitDraft(deps, "lab-full-flow", NOW);
  assert.equal(submitResult.status, 200);
  const submitBody = submitResult.body as { draft: { submittedAt: string | null } };
  assert.notEqual(submitBody.draft.submittedAt, null);

  const processResult = await handleProcessQuarter(deps, "lab-full-flow", {}, NOW);
  assert.equal(processResult.status, 200, JSON.stringify(processResult.body));
  const processBody = processResult.body as { status: string; revision: number; turn: number; turnId: string };
  assert.equal(processBody.status, "processed");
  assert.equal(processBody.revision, 1);
  assert.equal(processBody.turn, 1);
  assert.equal(processBody.turnId, "turn-1");

  const stateResult = await handleGetLabState(deps, "lab-full-flow");
  const stateBody = stateResult.body as { lab: { revision: number; currentTurn: number; draft: unknown } };
  assert.equal(stateBody.lab.revision, 1);
  assert.equal(stateBody.lab.currentTurn, 2);
  assert.equal(stateBody.lab.draft, null, "処理成功後はdraftが削除されているべき");
});

test("turn 1・turn 2を連続処理でき、current・履歴ページングが正しく更新される", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-two-turns" }), NOW);
  await saveAndSubmitDraft(deps, "lab-two-turns");
  const p1 = await handleProcessQuarter(deps, "lab-two-turns", {}, NOW);
  assert.equal(p1.status, 200);

  await saveAndSubmitDraft(deps, "lab-two-turns");
  const p2 = await handleProcessQuarter(deps, "lab-two-turns", {}, NOW);
  assert.equal(p2.status, 200);
  const p2Body = p2.body as { turn: number; turnId: string };
  assert.equal(p2Body.turn, 2);
  assert.equal(p2Body.turnId, "turn-2");

  const historyResult = await handleGetHistoryPage(deps, "lab-two-turns", new URLSearchParams("limit=10"));
  assert.equal(historyResult.status, 200);
  const historyBody = historyResult.body as { entries: { turn: number; turnId: string }[]; nextAfterTurn: number | null };
  assert.deepEqual(
    historyBody.entries.map((e) => e.turn),
    [1, 2]
  );
  assert.equal(historyBody.nextAfterTurn, null);

  const entryResult = await handleGetHistoryEntry(deps, "lab-two-turns", "1");
  assert.equal(entryResult.status, 200);
  const entryBody = entryResult.body as { entry: { turn: number; record: { turn: number } } };
  assert.equal(entryBody.entry.turn, 1);
  assert.equal(entryBody.entry.record.turn, 1);
});

test("handleGetHistoryPage: limitによるページングが正しく機能する", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-paging", turns: 3 }), NOW);
  for (let i = 0; i < 3; i++) {
    await saveAndSubmitDraft(deps, "lab-paging");
    const r = await handleProcessQuarter(deps, "lab-paging", {}, NOW);
    assert.equal(r.status, 200);
  }
  const page1 = await handleGetHistoryPage(deps, "lab-paging", new URLSearchParams("limit=2"));
  const page1Body = page1.body as { entries: { turn: number }[]; nextAfterTurn: number | null };
  assert.deepEqual(
    page1Body.entries.map((e) => e.turn),
    [1, 2]
  );
  assert.equal(page1Body.nextAfterTurn, 2);

  const page2 = await handleGetHistoryPage(deps, "lab-paging", new URLSearchParams(`afterTurn=${page1Body.nextAfterTurn}&limit=2`));
  const page2Body = page2.body as { entries: { turn: number }[]; nextAfterTurn: number | null };
  assert.deepEqual(
    page2Body.entries.map((e) => e.turn),
    [3]
  );
  assert.equal(page2Body.nextAfterTurn, null);
});

// -------------------------------------------------------------------
// 冪等性
// -------------------------------------------------------------------

test("handleProcessQuarter: 同一turnIdでの再試行はalreadyProcessedを200で返し、revision・履歴が二重にならない", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-idempotent" }), NOW);
  await saveAndSubmitDraft(deps, "lab-idempotent");
  const first = await handleProcessQuarter(deps, "lab-idempotent", {}, NOW);
  assert.equal(first.status, 200);
  const firstBody = first.body as { status: string; revision: number };
  assert.equal(firstBody.status, "processed");
  assert.equal(firstBody.revision, 1);

  // draftは既に削除済みだが、同じ（サーバー導出される）turnIdでの再送はエラーにならない
  const retry = await handleProcessQuarter(deps, "lab-idempotent", {}, NOW);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const retryBody = retry.body as { status: string; revision: number };
  assert.equal(retryBody.status, "alreadyProcessed");
  assert.equal(retryBody.revision, 1);

  const historyResult = await handleGetHistoryPage(deps, "lab-idempotent", new URLSearchParams("limit=10"));
  const historyBody = historyResult.body as { entries: unknown[] };
  assert.equal(historyBody.entries.length, 1, "再試行によって履歴が二重作成されている");
});

test("handleProcessQuarter: 明示的turnIdを指定した再試行も同様に冪等になる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-idempotent-explicit" }), NOW);
  await saveAndSubmitDraft(deps, "lab-idempotent-explicit");
  const first = await handleProcessQuarter(deps, "lab-idempotent-explicit", { turnId: "turn-1" }, NOW);
  assert.equal(first.status, 200);
  const retry = await handleProcessQuarter(deps, "lab-idempotent-explicit", { turnId: "turn-1" }, NOW);
  assert.equal(retry.status, 200);
  const retryBody = retry.body as { status: string };
  assert.equal(retryBody.status, "alreadyProcessed");
});

// -------------------------------------------------------------------
// 競合・入力異常
// -------------------------------------------------------------------

test("存在しないlabIdへの各操作は404になる", async () => {
  const deps = makeDeps();
  assert.equal((await handleGetLabState(deps, "no-such-lab")).status, 404);
  assert.equal((await handleSaveDraft(deps, "no-such-lab", { draft: {} }, NOW)).status, 404);
  assert.equal((await handleSubmitDraft(deps, "no-such-lab", NOW)).status, 404);
  assert.equal((await handleProcessQuarter(deps, "no-such-lab", {}, NOW)).status, 404);
  assert.equal((await handleGetHistoryPage(deps, "no-such-lab", new URLSearchParams())).status, 404);
  assert.equal((await handleGetHistoryEntry(deps, "no-such-lab", "1")).status, 404);
});

test("重複labIdでのラボ作成は409になる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-dup" }), NOW);
  const dup = await handleCreateLab(deps, baseCreateBody({ labId: "lab-dup", seed: "different-seed" }), NOW);
  assert.equal(dup.status, 409);
});

test("draftなし・未提出draftでの四半期処理はそれぞれ409になる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-draft-guard" }), NOW);

  const noDraftResult = await handleProcessQuarter(deps, "lab-draft-guard", {}, NOW);
  assert.equal(noDraftResult.status, 409);

  await handleSaveDraft(deps, "lab-draft-guard", { draft: {} }, NOW);
  const unsubmittedResult = await handleProcessQuarter(deps, "lab-draft-guard", {}, NOW);
  assert.equal(unsubmittedResult.status, 409);
});

test("process-quarterで、現在処理対象のturnと異なるturnIdを明示指定すると409（TURN_MISMATCH）になる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-turn-mismatch" }), NOW);
  await saveAndSubmitDraft(deps, "lab-turn-mismatch");
  const result = await handleProcessQuarter(deps, "lab-turn-mismatch", { turnId: "turn-99" }, NOW);
  assert.equal(result.status, 409);
  const body = result.body as { error: { code: string } };
  assert.equal(body.error.code, "TURN_MISMATCH");
  // 状態が変更されていないことも確認する
  const stateResult = await handleGetLabState(deps, "lab-turn-mismatch");
  const stateBody = stateResult.body as { lab: { revision: number } };
  assert.equal(stateBody.lab.revision, 0);
});

test("draft保存で、現在処理対象のturnと異なるturnIdを明示指定すると409（TURN_MISMATCH）になる", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-save-turn-mismatch" }), NOW);
  const result = await handleSaveDraft(deps, "lab-save-turn-mismatch", { draft: {}, turnId: "turn-99" }, NOW);
  assert.equal(result.status, 409);
});

test("完了済みラボの四半期処理・draft保存・draft提出は409になり、状態は変更されない", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-done", turns: 1 }), NOW);
  await saveAndSubmitDraft(deps, "lab-done");
  const processResult = await handleProcessQuarter(deps, "lab-done", {}, NOW);
  assert.equal(processResult.status, 200);
  const stateAfter = await handleGetLabState(deps, "lab-done");
  const stateAfterBody = stateAfter.body as { lab: { isComplete: boolean } };
  assert.equal(stateAfterBody.lab.isComplete, true);

  const saveAfterDone = await handleSaveDraft(deps, "lab-done", { draft: {} }, NOW);
  assert.equal(saveAfterDone.status, 409);

  const submitAfterDone = await handleSubmitDraft(deps, "lab-done", NOW);
  // saveを拒否しているためdraftが存在せずDraftNotFound(409)になるが、いずれにせよ409で拒否される
  assert.equal(submitAfterDone.status, 409);
});

test("入力形式が不正な場合は400になる（labId不正・draft本体欠落等）", async () => {
  const deps = makeDeps();
  await handleCreateLab(deps, baseCreateBody({ labId: "lab-bad-input" }), NOW);
  assert.equal((await handleSaveDraft(deps, "lab-bad-input", {}, NOW)).status, 400);
  assert.equal((await handleSaveDraft(deps, "has:colon", { draft: {} }, NOW)).status, 400);
  assert.equal((await handleGetHistoryPage(deps, "lab-bad-input", new URLSearchParams("limit=0"))).status, 400);
  assert.equal((await handleGetHistoryEntry(deps, "lab-bad-input", "not-a-number")).status, 400);
});

test("内部エラー応答はRedisキー・スタックトレース等の内部詳細を含まない", async () => {
  const deps = makeDeps();
  // わざとRepositoryにエラーを起こさせて、応答に内部詳細が漏れないことを確認する。
  const brokenDeps: CompanyLabApiDependencies = {
    ...deps,
    repository: {
      ...deps.repository,
      loadCurrentState: async () => {
        throw new Error("internal redis connection string leaked: rediss://user:secret@host:1234");
      },
    },
  };
  const result = await handleGetLabState(brokenDeps, "any-lab");
  assert.equal(result.status, 500);
  const body = result.body as { error: { message: string } };
  assert.ok(!body.error.message.includes("secret"), "内部エラー詳細がAPI応答に漏れている");
});
