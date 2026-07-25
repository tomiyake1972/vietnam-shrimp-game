// ShrimpX V2 — Company Lab プレイヤー画面「財務・資金・設備投資」表示 回帰テスト
//
// 【検証観点（三宅さんの実装承認時の要求事項）】
//   1. 抽出セレクタがcompanyId・対象四半期で正しく1社ぶんのデータだけを取り出すこと
//      （5社分の配列から取り違えない）。
//   2. UIでは一切再計算していないこと（Repositoryから読んだ値と、viewModelが
//      client向けに渡す値が完全に一致する）。
//   3. 初回四半期（turn===1、前期データなし）でもクラッシュせず、
//      previousQuarterFinancialsがnullとして正常に返ること。
//   4. 2ターン目以降は前期（turn-1）ぶんの財務・資金・設備投資が正しく取得できること。
//   5. 保存データの整合性（BS貸借一致・CF期末現金とBS現金の一致・CF直接法/間接法の
//      差額ゼロ）が、実際にターンを進めた結果でも成立していること
//      （エンジン側の既存整合性を、UI抽出後のデータに対しても再確認する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { buildInitialDraft } from "../../../decisionDraft";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";
import { handleCreateLab, handleProcessQuarter, handleSaveDraft, handleSubmitDraft } from "../../../../../api/v2/company-labs/_lib/handlers";
import { loadPlayerScreenViewModel } from "../viewModel";
import { extractCompanyCapexResult, extractCompanyFinancialResult, extractCompanyFinancingResult } from "../financialViewSelectors";

const NOW = "2026-01-01T00:00:00.000Z";
const BALANCE_TOLERANCE_USD = 1;

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

function buildValidPlayerDraftBodyFor(companyId: string): unknown {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "financial-panel-draft-seed", turns: 4 });
  const publicInfo = buildPublicMarketInfo(state);
  const fixture = fixtures.find((f) => f.companyId === companyId);
  if (!fixture) throw new Error(`テスト用フィクスチャに${companyId}が見つかりません`);
  const ownState = buildCompanyOwnState(state, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, 1);
  return buildInitialDraft(fixture, autoDecision);
}

const VALID_PLAYER_DRAFT_BODY = buildValidPlayerDraftBodyFor("BAL");

async function saveAndSubmitDraft(deps: CompanyLabApiDependencies, labId: string) {
  const saveResult = await handleSaveDraft(deps, labId, { draft: VALID_PLAYER_DRAFT_BODY }, NOW);
  assert.equal(saveResult.status, 200, JSON.stringify(saveResult.body));
  const submitResult = await handleSubmitDraft(deps, labId, NOW);
  assert.equal(submitResult.status, 200, JSON.stringify(submitResult.body));
}

async function processQuarter(deps: CompanyLabApiDependencies, labId: string) {
  const result = await handleProcessQuarter(deps, labId, {}, NOW);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

function assertFinancialIntegrity(label: string, financialResult: { readonly balanceSheet: { readonly balanceDifference: number; readonly cash: number }; readonly cashFlow: { readonly closingCash: number; readonly directIndirectDifference: number } }) {
  assert.ok(
    Math.abs(financialResult.balanceSheet.balanceDifference) < BALANCE_TOLERANCE_USD,
    `${label}: BSの貸借差額が許容誤差を超えています（${financialResult.balanceSheet.balanceDifference}）`
  );
  assert.ok(
    Math.abs(financialResult.cashFlow.closingCash - financialResult.balanceSheet.cash) < BALANCE_TOLERANCE_USD,
    `${label}: CF期末現金とBS現金が一致しません（CF=${financialResult.cashFlow.closingCash}, BS=${financialResult.balanceSheet.cash}）`
  );
  assert.ok(
    Math.abs(financialResult.cashFlow.directIndirectDifference) < BALANCE_TOLERANCE_USD,
    `${label}: CF直接法・間接法の差額が許容誤差を超えています（${financialResult.cashFlow.directIndirectDifference}）`
  );
}

// --- 1. セレクタ単体：companyIdで正しく1社だけを取り出す ---

test("extractCompanyFinancialResult/extractCompanyFinancingResult/extractCompanyCapexResult: 5社ぶんの配列からcompanyIdで正しい1件だけを取り出す", async () => {
  const deps = makeDeps();
  const labId = "selector-lab";
  await handleCreateLab(deps, { scenarioId: "baseline", mode: "canonical", seed: "selector-seed", turns: 2, playerCompanyId: "BAL", labId }, NOW);
  await saveAndSubmitDraft(deps, labId);
  await processQuarter(deps, labId);

  const entry = await deps.repository.loadHistoryEntry(labId, 1);
  const record = entry.record;
  assert.ok(record.financialResults.length >= 2, "複数社ぶんの財務結果が記録されているはず");

  const balFinancial = extractCompanyFinancialResult(record, "BAL");
  assert.ok(balFinancial);
  assert.equal(balFinancial?.companyId, "BAL");

  const otherCompanyId = record.financialResults.find((r) => r.companyId !== "BAL")?.companyId;
  assert.ok(otherCompanyId, "BAL以外の会社の財務結果が存在するはず");
  const otherFinancial = extractCompanyFinancialResult(record, otherCompanyId as string);
  assert.ok(otherFinancial);
  assert.notEqual(otherFinancial?.companyId, "BAL");
  assert.notDeepEqual(otherFinancial, balFinancial, "会社ごとに異なる財務結果が返るべき（取り違え防止）");

  assert.equal(extractCompanyFinancialResult(record, "__no_such_company__"), null);
  assert.equal(extractCompanyFinancingResult(record, "__no_such_company__"), null);
  assert.equal(extractCompanyCapexResult(record, "__no_such_company__"), null);

  const balFinancing = extractCompanyFinancingResult(record, "BAL");
  assert.ok(balFinancing);
  assert.equal(balFinancing?.companyId, "BAL");

  const balCapex = extractCompanyCapexResult(record, "BAL");
  assert.ok(balCapex);
  assert.equal(balCapex?.companyId, "BAL");
});

// --- 2〜5. viewModel経由の一連の検証（初回四半期・2期目・再計算なし・整合性） ---

test("loadPlayerScreenViewModel: turn1（初回四半期）は財務・資金・設備投資データが取得でき、previousQuarterFinancialsはnull、保存データの整合性も成立する", async () => {
  const deps = makeDeps();
  const labId = "financial-panel-turn1-lab";
  await handleCreateLab(deps, { scenarioId: "baseline", mode: "canonical", seed: "turn1-seed", turns: 4, playerCompanyId: "BAL", labId }, NOW);
  await saveAndSubmitDraft(deps, labId);
  await processQuarter(deps, labId);

  const result = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const vm = result.viewModel;

  assert.ok(vm.lastQuarterResult);
  assert.equal(vm.lastQuarterResult?.turn, 1);
  assert.ok(vm.lastQuarterResult?.financialResult, "turn1の財務結果が取得できているべき");
  assert.ok(vm.lastQuarterResult?.financingResult, "turn1の資金繰り結果が取得できているべき");
  assert.ok(vm.lastQuarterResult?.capexResult, "turn1の設備投資結果が取得できているべき");
  assert.equal(vm.lastQuarterResult?.financialResult?.companyId, "BAL");
  assert.equal(vm.lastQuarterResult?.financingResult?.companyId, "BAL");
  assert.equal(vm.lastQuarterResult?.capexResult?.companyId, "BAL");

  // 初回四半期：前期データは存在しない。捏造せず、正常にnullとして返る（クラッシュしない）。
  assert.equal(vm.previousQuarterFinancials, null);

  // 保存データの整合性（BS貸借一致・CF期末現金=BS現金・CF直接法/間接法差額ゼロ）。
  assert.ok(vm.lastQuarterResult?.financialResult);
  if (vm.lastQuarterResult?.financialResult) {
    assertFinancialIntegrity("turn1", vm.lastQuarterResult.financialResult);
  }

  // 再計算なし：Repositoryから直接読んだ値と、viewModelが返す値が完全に一致する。
  const rawEntry = await deps.repository.loadHistoryEntry(labId, 1);
  const rawFinancial = extractCompanyFinancialResult(rawEntry.record, "BAL");
  assert.deepEqual(vm.lastQuarterResult?.financialResult, rawFinancial);
});

test("loadPlayerScreenViewModel: turn2では前期（turn1）ぶんの財務・資金・設備投資が正しく取得でき、Repositoryの生データと完全一致する（再計算なし）", async () => {
  const deps = makeDeps();
  const labId = "financial-panel-turn2-lab";
  await handleCreateLab(deps, { scenarioId: "baseline", mode: "canonical", seed: "turn2-seed", turns: 4, playerCompanyId: "BAL", labId }, NOW);

  await saveAndSubmitDraft(deps, labId);
  await processQuarter(deps, labId);
  await saveAndSubmitDraft(deps, labId);
  await processQuarter(deps, labId);

  const result = await loadPlayerScreenViewModel(deps, labId);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const vm = result.viewModel;

  assert.equal(vm.lastQuarterResult?.turn, 2);
  assert.ok(vm.lastQuarterResult?.financialResult);
  if (vm.lastQuarterResult?.financialResult) {
    assertFinancialIntegrity("turn2（当期）", vm.lastQuarterResult.financialResult);
  }

  assert.ok(vm.previousQuarterFinancials, "turn2では前期（turn1）ぶんのデータが取得できているべき");
  assert.equal(vm.previousQuarterFinancials?.turn, 1);
  assert.ok(vm.previousQuarterFinancials?.financialResult);
  if (vm.previousQuarterFinancials?.financialResult) {
    assertFinancialIntegrity("turn1（前期）", vm.previousQuarterFinancials.financialResult);
  }

  // 前期データがRepositoryの生データと完全一致すること（UI側での再計算がないことの確認）。
  const rawEntryTurn1 = await deps.repository.loadHistoryEntry(labId, 1);
  const rawFinancialTurn1 = extractCompanyFinancialResult(rawEntryTurn1.record, "BAL");
  const rawFinancingTurn1 = extractCompanyFinancingResult(rawEntryTurn1.record, "BAL");
  const rawCapexTurn1 = extractCompanyCapexResult(rawEntryTurn1.record, "BAL");
  assert.deepEqual(vm.previousQuarterFinancials?.financialResult, rawFinancialTurn1);
  assert.deepEqual(vm.previousQuarterFinancials?.financingResult, rawFinancingTurn1);
  assert.deepEqual(vm.previousQuarterFinancials?.capexResult, rawCapexTurn1);

  // 当期（turn2）もRepositoryの生データと完全一致すること。
  const rawEntryTurn2 = await deps.repository.loadHistoryEntry(labId, 2);
  const rawFinancialTurn2 = extractCompanyFinancialResult(rawEntryTurn2.record, "BAL");
  assert.deepEqual(vm.lastQuarterResult?.financialResult, rawFinancialTurn2);
});
