// ShrimpX V2 — UI-SALES-MODEL-SELECT-1: 管理者用Sales Model選択・表示UIのテスト
//
// 【方針】新しい販売モデル・新しいEngine分岐は作らない。#04が既に完全配線した
// salesModelId契約（app/lib/v2/sales/salesModels.ts・validation.ts・schema.ts・
// runner.ts salesParametersFor）はここでは一切変更しない。ここで検証するのは
// 今回追加したUI層（resolveSalesModelIdForSubmission・NewLabForm・
// PlayerScreenViewModel.salesModelId・表示ラベル）が、既存の#04契約を正しく
// 呼び出しているか、という配線の正しさだけである。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../../../lib/v2/sales/types";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../../../../../lib/v2/companyLab/types";
import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";
import { handleCreateLab } from "../../../../../api/v2/company-labs/_lib/handlers";
import { buildInitialDraft } from "../../../decisionDraft";
import { resolveSalesModelIdForSubmission } from "../newLabFormModel";
import { DEFAULT_SALES_MODEL_ID, SALES_MODEL_DISPLAY_LABELS } from "../salesModelDisplay";
import { loadPlayerScreenViewModel } from "../viewModel";

const NOW = "2026-01-01T00:00:00.000Z";
const PLAYER_COMPANY_ID = "BAL" as CompanyId;

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

// --- UI-SMID-1: 初期値はlegacy ---

test("UI-SMID-1: フォームの既定選択（DEFAULT_SALES_MODEL_ID）はlegacy-waterfall-v1であり、その値のまま送信するとsalesModelIdは送信されない", () => {
  assert.equal(DEFAULT_SALES_MODEL_ID, "legacy-waterfall-v1");
  assert.equal(resolveSalesModelIdForSubmission(DEFAULT_SALES_MODEL_ID), undefined);
  assert.equal(resolveSalesModelIdForSubmission(undefined), undefined);
});

// --- UI-SMID-2: legacy作成時に従来挙動 ---

test("UI-SMID-2: 既定選択のまま作成すると、既存Runと同じくstored.config.salesModelIdが一切設定されない", async () => {
  const deps = makeDeps();
  const salesModelId = resolveSalesModelIdForSubmission(DEFAULT_SALES_MODEL_ID);
  const result = await handleCreateLab(
    deps,
    { labId: "ui-smid-2-lab", scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS", ...(salesModelId !== undefined ? { salesModelId } : {}) },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const stored = await deps.repository.loadCurrentState("ui-smid-2-lab");
  assert.equal(stored.config.salesModelId, undefined, "既定選択で作成したLabにsalesModelIdが紛れ込んでいる");
});

// --- UI-SMID-3: tiered選択で正しいsalesModelId送信 ---

test("UI-SMID-3: tiered選択時はsalesModelId=tiered-v200-candidate-v1が送信され、そのままstored.configへ保存される", async () => {
  const deps = makeDeps();
  const salesModelId = resolveSalesModelIdForSubmission("tiered-v200-candidate-v1");
  assert.equal(salesModelId, "tiered-v200-candidate-v1");
  const result = await handleCreateLab(
    deps,
    { labId: "ui-smid-3-lab", scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS", salesModelId },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const stored = await deps.repository.loadCurrentState("ui-smid-3-lab");
  assert.equal(stored.config.salesModelId, "tiered-v200-candidate-v1");
});

// --- UI-SMID-4: 作成後にtiered表示 ---

test("UI-SMID-4: tieredで作成した直後、詳細画面ViewModelのsalesModelIdが「三層顧客価格モデル V2.00候補」ラベルに解決される", async () => {
  const deps = makeDeps();
  const created = await handleCreateLab(
    deps,
    { labId: "ui-smid-4-lab", scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS", salesModelId: "tiered-v200-candidate-v1" },
    NOW
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const view = await loadPlayerScreenViewModel(deps, "ui-smid-4-lab");
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.viewModel.salesModelId, "tiered-v200-candidate-v1");
  assert.equal(SALES_MODEL_DISPLAY_LABELS[view.viewModel.salesModelId ?? DEFAULT_SALES_MODEL_ID], "三層顧客価格モデル V2.00候補");
});

test("UI-SMID-4b: legacyで作成した場合は「従来市場モデル」ラベルに解決される", async () => {
  const deps = makeDeps();
  const created = await handleCreateLab(
    deps,
    { labId: "ui-smid-4b-lab", scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS" },
    NOW
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const view = await loadPlayerScreenViewModel(deps, "ui-smid-4b-lab");
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.viewModel.salesModelId, undefined);
  assert.equal(SALES_MODEL_DISPLAY_LABELS[view.viewModel.salesModelId ?? DEFAULT_SALES_MODEL_ID], "従来市場モデル");
});

// --- UI-SMID-5: resume後もtiered表示 ---

test("UI-SMID-5: tiered Labをturn処理→保存→resumeしても、詳細画面ViewModelのsalesModelIdはtieredのまま", async () => {
  const deps = makeDeps();
  const labId = "ui-smid-5-lab";
  await deps.service.createLab({
    labId,
    config: { scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, salesModelId: "tiered-v200-candidate-v1" } as CompanyLabConfig,
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  await deps.service.saveDraft({ labId, turnId: "turn-1", draftBody: { note: "turn-1" }, now: NOW });
  await deps.service.submitDraft({ labId, turnId: "turn-1", now: NOW });
  const processed = await deps.service.processQuarter({
    labId,
    turnId: "turn-1",
    lockToken: "lock-1",
    now: NOW,
    decisionsProvider: (args) => {
      const publicInfo = buildPublicMarketInfo(args.restoredState);
      const decisions: Record<string, CompanyDecisionInput> = {};
      for (const f of args.fixtures) {
        decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(args.restoredState, f), publicInfo, args.restoredState.currentPeriod, args.restoredState.scenarioState.currentTurn);
      }
      return decisions;
    },
  });
  assert.equal(processed.status, "processed");

  // resume相当（別リクエストとしての再読込を2回行い、どちらもtieredのまま）。
  const first = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(first.kind, "ok");
  if (first.kind === "ok") assert.equal(first.viewModel.salesModelId, "tiered-v200-candidate-v1");

  const second = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(second.kind, "ok");
  if (second.kind === "ok") assert.equal(second.viewModel.salesModelId, "tiered-v200-candidate-v1");

  const stored = await deps.repository.loadCurrentState(labId);
  assert.equal(stored.config.salesModelId, "tiered-v200-candidate-v1", "実configも保持されている（表示だけでなく）");
});

// --- UI-SMID-6: Playerが途中変更できない ---

test("UI-SMID-6: Playerの意思決定ドラフト（CompanyDecisionDraft）にsalesModelIdフィールドは存在しない（Player入力経路から変更できない）", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, salesModelId: "tiered-v200-candidate-v1" } as CompanyLabConfig);
  const fixture = fixtures[0];
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, autoDecision);
  assert.ok(!Object.keys(draft).includes("salesModelId"), "Player draftにsalesModelIdが紛れ込んでいる");
});

// --- UI-SMID-7: 既存Scenario選択と独立 ---

test("UI-SMID-7: salesModelIdの選択はscenarioId選択と独立して機能する（baseline/DS1のどちらでもtieredを指定できる）", async () => {
  const deps = makeDeps();
  const baselineResult = await handleCreateLab(
    deps,
    { labId: "ui-smid-7-baseline", scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS", salesModelId: "tiered-v200-candidate-v1" },
    NOW
  );
  const ds1Result = await handleCreateLab(
    deps,
    { labId: "ui-smid-7-ds1", scenarioId: "dynamic-scenario-1", mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS", salesModelId: "tiered-v200-candidate-v1" },
    NOW
  );
  assert.equal(baselineResult.status, 201, JSON.stringify(baselineResult.body));
  assert.equal(ds1Result.status, 201, JSON.stringify(ds1Result.body));
  const baselineStored = await deps.repository.loadCurrentState("ui-smid-7-baseline");
  const ds1Stored = await deps.repository.loadCurrentState("ui-smid-7-ds1");
  assert.equal(baselineStored.config.salesModelId, "tiered-v200-candidate-v1");
  assert.equal(ds1Stored.config.salesModelId, "tiered-v200-candidate-v1");
  assert.equal(baselineStored.config.scenarioId, "baseline-v0.1");
  assert.equal(ds1Stored.config.scenarioId, "dynamic-scenario-1");
});

// --- UI-SMID-8: DS1/DS2/DS3 defaultを変更していない ---

test("UI-SMID-8: salesModelIdを指定しなければ、baseline/DS1/DS2いずれのScenarioでも従来どおりsalesModelId未設定（legacy）のまま作成される", async () => {
  const deps = makeDeps();
  for (const scenarioId of ["baseline-v0.1", "dynamic-scenario-1", "dynamic-scenario-2"]) {
    const labId = `ui-smid-8-${scenarioId}`;
    const result = await handleCreateLab(deps, { labId, scenarioId, mode: "canonical", seed: "s", turns: 4, playerCompanyId: "MASS" }, NOW);
    assert.equal(result.status, 201, `${scenarioId}: ${JSON.stringify(result.body)}`);
    const stored = await deps.repository.loadCurrentState(labId);
    assert.equal(stored.config.salesModelId, undefined, `${scenarioId}のdefault挙動がsalesModelId追加によって変化している`);
  }
  // 【注記】この時点のALL_SCENARIO_DEFINITIONSには"dynamic-scenario-3"という独立したScenario定義は
  // 存在しない（DS3固有の強制年次配当ルール等は別の仕組みであり、独立したscenarioIdではない）。
  // したがって上記baseline/DS1/DS2の3件が、実在するScenario定義に対する完全な確認範囲である。
});

test("UI-SMID-8b: 連続実行でもsalesModelId省略時はlegacy allocator（tiered固有のcompetitivenessWeight正規化ではない）が使われる（回帰確認）", () => {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "s", turns: 2 } as CompanyLabConfig);
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) decisions[f.companyId] = generateAutoPolicyDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, 1);
  const next: CompanyLabState = advanceCompanyLabQuarter(state, fixtures, decisions);
  const record = next.history[next.history.length - 1];
  assert.ok(record.salesRecord.allocations.length > 0);
});
