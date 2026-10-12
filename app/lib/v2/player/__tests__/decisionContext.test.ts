// ShrimpX V2 — Independent Player Flow: buildPlayerDecisionContextのテスト
//
// 【最重要】ここは「Player cannot inspect competitor private state」というセキュリティ
// 要件そのものを守る場所。resumePayload/StoredSimulationRunはGM向け全知state（5社の
// 真の内部状態を丸ごと持つ）だが、buildPlayerDecisionContextが返す形はそれとは別の、
// 自社視点だけに絞られた構造であることを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceSimulationTurn, createSimulationSession } from "../../companyLab/simulation/engine";
import { buildResumePayload } from "../../companyLab/simulation/persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../../companyLab/simulation/persistence/types";
import { buildDatasetFromSession } from "../../companyLab/simulation/analytics/dataset";
import { buildPlayerDecisionContext, PlayerDecisionContext, PlayerDecisionContextError } from "../decisionContext";
import { StoredSimulationRun } from "../../companyLab/simulation/persistence/types";

/**
 * 【CTX-2/CTX-10共通】lastQuarterSalesAllocationsが、market・product・basePrice
 * だけの最小DTOであり、他社の非公開情報（companies配列・askPrice等）を一切含まない
 * ことを、構造（キー集合）とシリアライズ結果の両方で検証するヘルパー。
 */
function assertNoCompetitorLeakageInSalesAllocations(context: PlayerDecisionContext): void {
  const allocations = context.lastQuarterSalesAllocations;
  if (!allocations) return;
  assert.ok(allocations.length > 0, "このテストの前提として、少なくとも1件のmarket×product基準価格が存在するはず");
  const forbiddenSubstrings = [
    "companies",
    "companyId",
    "askPrice",
    "allocatedQuantity",
    "processingCapacity",
    "competitivenessWeight",
    "competitivenessBreakdown",
    "targetDemand",
    "externalOptionQuantity",
  ];
  for (const entry of allocations) {
    // 【UI-CLARITY-1 A-8】sourceは出どころの列挙値のみ（他社の非公開情報は含まない）。
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["basePrice", "market", "product", "source"],
      "基準価格DTOはmarket/product/basePrice/source以外のキーを持たない"
    );
  }
  const serialized = JSON.stringify(allocations);
  for (const forbidden of forbiddenSubstrings) {
    assert.ok(!serialized.includes(forbidden), `lastQuarterSalesAllocationsのシリアライズ結果に"${forbidden}"が含まれてはならない`);
  }
}

const AT = "2026-01-01T00:00:00.000Z";

function buildStoredRun(simulationRunId: string, overrides: { readonly gameEndedAt?: string } = {}): StoredSimulationRun {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: "decision-context-test", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const resumePayload = buildResumePayload(session, controlModes, {});
  // 【ManagementConsole.tsx runInternalと同じpersist形】companyControlModesはresumePayloadだけ
  // でなくrun本体にも載せる（buildPlayerDecisionContextはsession.run.companyControlModesを見る）。
  const run = { ...session.run, companyControlModes: controlModes, ...(overrides.gameEndedAt ? { gameEndedAt: overrides.gameEndedAt, gameEndTurn: 1, finalEvaluationSnapshot: [] } : {}) };
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  };
}

test("CTX-1: 自社（fixture/ownState）は要求したcompanyIdだけを指す", () => {
  const stored = buildStoredRun("run-ctx-1");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.companyId, "BAL");
  assert.equal(context.fixture.companyId, "BAL");
  assert.equal(context.ownState.companyId, "BAL");
});

test("CTX-2【競合他社の非公開情報を含まない】: fixture/ownStateは単一会社の形であり、他社の配列・レコードを含まない", () => {
  const stored = buildStoredRun("run-ctx-2");
  const context = buildPlayerDecisionContext(stored, "BAL");
  // PlayerDecisionContextの型自体、fixtureは単一のCompanyFixture・ownStateは単一の
  // CompanyOwnStateであり、5社ぶんの配列（GM向けfixtures/companyStates相当）を
  // 一切持たない。実行時にも、返された値の直下に他社を指す配列フィールドが
  // 混入していないことを確認する（構造的な保証を実測でも裏付ける）。
  assert.equal(Array.isArray(context.fixture), false);
  assert.equal(Array.isArray(context.ownState), false);
  assert.equal("fixtures" in context, false);
  assert.equal("companyStates" in context, false);
  assert.equal("allCompanies" in context, false);
  // 【SALES基準価格参考表示・セキュリティ修正】前四半期データが無いTurn1では
  // lastQuarterSalesAllocationsはundefinedになる（ここでは早期returnするだけ）。
  // 実データありのケースはCTX-10で検証する。
  assertNoCompetitorLeakageInSalesAllocations(context);
});

test("CTX-3【ゲーム進行中はfinishedViewを一切含まない】: gameEndedAtが未設定ならfinishedViewはnull", () => {
  const stored = buildStoredRun("run-ctx-3");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.gameEndedAt, null);
  assert.equal(context.finishedView, null);
});

test("CTX-4【ゲーム終了後だけ5社比較を公開してよい】: gameEndedAt設定後はfinishedViewが5社ぶんのfixturesを持つ", () => {
  const stored = buildStoredRun("run-ctx-4", { gameEndedAt: AT });
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.gameEndedAt, AT);
  assert.ok(context.finishedView);
  assert.ok(context.finishedView.session.fixtures.length >= 2, "Final Resultsは既存Game End機能と同じく5社比較を公開する（進行中とは別の公開範囲）");
});

test("CTX-5: companyControlModesでPLAYERとして扱われていない会社はisPlayerControlled=false", () => {
  const stored = buildStoredRun("run-ctx-5");
  const context = buildPlayerDecisionContext(stored, "MASS");
  assert.equal(context.isPlayerControlled, false);
});

test("CTX-6: PLAYERとして扱われている会社はisPlayerControlled=true", () => {
  const stored = buildStoredRun("run-ctx-6");
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.isPlayerControlled, true);
});

test("CTX-7: 存在しない会社はCOMPANY_NOT_FOUNDで拒否される", () => {
  const stored = buildStoredRun("run-ctx-7");
  assert.throws(
    () => buildPlayerDecisionContext(stored, "ZZZ" as never),
    (e: unknown) => e instanceof PlayerDecisionContextError && e.code === "COMPANY_NOT_FOUND"
  );
});

test("CTX-8: resumePayloadが無い（続きからプレイできない旧形式）RunはNOT_RESUMABLEで拒否される", () => {
  const session = createSimulationSession({ simulationRunId: "run-ctx-8", scenarioId: "baseline", seed: "s", requestedTurns: 32, startedAt: AT });
  const stored: StoredSimulationRun = { schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION, run: session.run, dataset: buildDatasetFromSession(session), savedAt: AT };
  assert.throws(
    () => buildPlayerDecisionContext(stored, "BAL"),
    (e: unknown) => e instanceof PlayerDecisionContextError && e.code === "NOT_RESUMABLE"
  );
});

test("CTX-9: hasSubmittedThisTurnはconfirmedPlayerDecisions[companyId]の有無だけで決まる（GMの提出済み判定と同じ信号）", () => {
  const session = createSimulationSession({ simulationRunId: "run-ctx-9", scenarioId: "baseline", seed: "decision-context-test", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const decision = { placeholder: true } as never;
  const resumePayload = buildResumePayload(session, controlModes, { BAL: decision });
  const stored: StoredSimulationRun = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: session.run,
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  };
  const context = buildPlayerDecisionContext(stored, "BAL");
  assert.equal(context.hasSubmittedThisTurn, true);
  const otherContext = buildPlayerDecisionContext(stored, "MASS");
  assert.equal(otherContext.hasSubmittedThisTurn, false);
});

test("CTX-10【SALES基準価格参考表示・セキュリティ修正・Release Critical再発防止】: Turnを1期進めて実際の市場×商品配分結果（他社askPrice等を含む）が確定した後も、PlayerDecisionContextへは市場全体のbasePriceだけの最小DTOしか渡らず、他社の非公開情報は一切含まれない", () => {
  const session = createSimulationSession({ simulationRunId: "run-ctx-10", scenarioId: "baseline", seed: "decision-context-ctx10", requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  // Turn1を実際にEngineで進める（Standard AI 5社の意思決定のみ。playerDecisionsは渡さない）。
  const outcome = advanceSimulationTurn(session, AT);
  assert.equal(outcome.advanced, true, "テストの前提としてTurn1が正常に確定しているはず");
  const advancedSession = outcome.session;

  // 進行後のsessionからresumePayloadを組み立て、Turn2時点のStoredSimulationRunを作る
  // （submit.test.ts等と同じ、実Redis不要のin-memory相当の組み立て方）。
  const resumePayload = buildResumePayload(advancedSession, controlModes, {});
  const run = { ...advancedSession.run, companyControlModes: controlModes };
  const stored: StoredSimulationRun = {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run,
    dataset: buildDatasetFromSession(advancedSession),
    packCapture: { companyTurns: advancedSession.packCompanyTurns, worldTurns: advancedSession.packWorldTurns },
    resumePayload,
    savedAt: AT,
    persistenceRevision: 1,
  };

  // 進行前提として、実際にhistoryへ他社ぶんのaskPrice等を含む配分結果が
  // 記録されていることを確認する（このテスト自体が無意味にならないための前提確認）。
  const rawAllocations = advancedSession.state.history[advancedSession.state.history.length - 1]?.salesRecord.allocations ?? [];
  assert.ok(rawAllocations.some((a) => a.companies.length > 0), "前提: 実データにcompanies配列（他社askPrice等）が存在するはず");

  const context = buildPlayerDecisionContext(stored, "BAL");
  assertNoCompetitorLeakageInSalesAllocations(context);
});

// ---------------------------------------------------------------------------
// PLAYER-SURFACE-1: Overview / Market / Inventory の3ビュー
//
// 受講者が実際に使う /v2/play/workspace には、これまで意思決定タブしか無かった。
// Overview / Market / Inventory は GM コンソール側の PlayerWorkspace にしか存在せず、
// あちらは GM のブラウザタブ内キャッシュを正本にしているため受講者の端末からは
// 原理的に開けない。3ビューをサーバー側で組み立てて返すようにしたぶんについて、
// 「出るべきものが出る」ことと「他社の非公開値が混ざらない」ことを固定する。
// ---------------------------------------------------------------------------

/** 1Turn進めたStoredSimulationRunを作る（CTX-10と同じ組み立て方）。 */
function buildStoredRunAfterOneTurn(simulationRunId: string): StoredSimulationRun {
  const session = createSimulationSession({ simulationRunId, scenarioId: "baseline", seed: `${simulationRunId}-seed`, requestedTurns: 32, startedAt: AT });
  const controlModes = { BAL: "PLAYER" as const };
  const outcome = advanceSimulationTurn(session, AT);
  assert.equal(outcome.advanced, true, "テストの前提としてTurn1が正常に確定しているはず");
  const advanced = outcome.session;
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: { ...advanced.run, companyControlModes: controlModes },
    dataset: buildDatasetFromSession(advanced),
    packCapture: { companyTurns: advanced.packCompanyTurns, worldTurns: advanced.packWorldTurns },
    resumePayload: buildResumePayload(advanced, controlModes, {}),
    savedAt: AT,
    persistenceRevision: 1,
  };
}

test("PS-1: Turnを1期進めると Overview（前Turnのふりかえり）が自社ぶんだけ返る", () => {
  const context = buildPlayerDecisionContext(buildStoredRunAfterOneTurn("run-ps-1"), "BAL");
  assert.notEqual(context.lastTurnReview, null, "1Turn確定後はふりかえりが返るはず");
  assert.equal(context.lastTurnReview?.companyId, "BAL");
});

test("PS-2: 1Turnも確定していなければ Overview・Inventory は null（0で埋めない）", () => {
  const context = buildPlayerDecisionContext(buildStoredRun("run-ps-2"), "BAL");
  assert.equal(context.lastTurnReview, null);
  assert.equal(context.inventoryView, null);
});

test("PS-3: Inventory は自社の確定サマリーの値を返し、稼働率は取得できなければ null になる", () => {
  const context = buildPlayerDecisionContext(buildStoredRunAfterOneTurn("run-ps-3"), "BAL");
  const inventory = context.inventoryView;
  assert.notEqual(inventory, null, "1Turn確定後は在庫ビューが返るはず");
  for (const key of ["backlogTons", "overdueTons", "finishedGoodsInventoryTons", "rawMaterialInventoryTons"] as const) {
    assert.equal(typeof inventory![key], "number", `${key} は数値であるはず`);
    assert.ok(Number.isFinite(inventory![key]), `${key} が有限値でない: ${inventory![key]}`);
  }
  for (const key of ["equipmentUtilizationRate", "laborUtilizationRate"] as const) {
    const value = inventory![key];
    assert.ok(value === null || Number.isFinite(value), `${key} は null か有限値であるはず: ${value}`);
  }
});

test("PS-4: Market は Turn 1 でも15マスの基準価格を返す（A-8 の開始時市場情報へフォールバックする）", () => {
  const context = buildPlayerDecisionContext(buildStoredRun("run-ps-4"), "BAL");
  const priced = context.marketView.cells.filter((c) => c.basePriceUsdPerKg !== null);
  assert.equal(priced.length, 15, `Turn1で基準価格が出るのは15マスのはず: ${priced.length}`);
  assert.ok(
    priced.every((c) => c.basePriceSource === "GAME_START_MARKET_INFORMATION"),
    "Turn1の基準価格はすべてゲーム開始時の市場情報が出所であるはず"
  );
});

test("PS-5【情報境界】: Market の需要は遅行公開値であり、当期の真の需要（trueWorld）を含まない", () => {
  const stored = buildStoredRunAfterOneTurn("run-ps-5");
  const context = buildPlayerDecisionContext(stored, "BAL");
  const view = context.marketView;

  // 出所（どのTurnの実績か）を必ず添えていること。これが無いと受講者は
  // 当期の確定需要だと誤解する。
  assert.ok(
    view.observedDemandSourceQuarter === null || Number.isFinite(view.observedDemandSourceQuarter),
    "需要の基準Turnは null か数値であるはず"
  );
  assert.ok(view.sourceNote.length > 0, "出所の説明文を必ず添えるはず");

  // dataset.marketMetrics（trueWorld）の当期需要そのものが混ざっていないこと。
  const trueWorldDemands = (stored.dataset?.marketMetrics ?? [])
    .filter((f) => f.visibility === "trueWorld" && f.metric === "demandQuantity" && f.turn === 1)
    .map((f) => f.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  const exposedDemands = view.cells.map((c) => c.observedDemandTons).filter((v): v is number => v !== null && v > 0);
  if (trueWorldDemands.length > 0 && exposedDemands.length > 0) {
    const leaked = exposedDemands.filter((v) => trueWorldDemands.some((t) => Math.abs(t - v) < 1e-6));
    assert.equal(leaked.length, 0, `当期のtrueWorld需要がそのまま露出している: ${leaked.slice(0, 3).join(", ")}`);
  }
});

test("PS-6【情報境界】: Market が公開するのはTSVランキングまでで、他社の内部数値は含まない", () => {
  const context = buildPlayerDecisionContext(buildStoredRunAfterOneTurn("run-ps-6"), "BAL");
  const rows = context.marketView.tsvRanking;
  assert.ok(rows.length >= 2, "5社ぶんのランキングが返るはず");
  assert.equal(rows.filter((r) => r.isOwnCompany).length, 1, "自社の行はちょうど1つであるはず");

  // 各行が持ってよいキーを固定する。現金・利益・原価・在庫などが
  // 将来うっかり足されたらこのテストが落ちる。
  const allowed = ["companyId", "displayName", "totalShareholderValueUsd", "isOwnCompany"];
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...allowed].sort(), `TSV行のキーが増えている: ${Object.keys(row).join(", ")}`);
  }

  // 市場セルについても同様に固定する。
  const allowedCellKeys = ["market", "product", "observedDemandTons", "basePriceUsdPerKg", "basePriceSource"];
  for (const cell of context.marketView.cells) {
    for (const key of Object.keys(cell)) {
      assert.ok(allowedCellKeys.includes(key), `市場セルに想定外のキーがある: ${key}`);
    }
  }
});
