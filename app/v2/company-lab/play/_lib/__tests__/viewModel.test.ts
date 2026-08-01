// ShrimpX V2 — feature/v2-persist-standard-ai-proposal（Phase A）
// loadPlayerScreenViewModel / coerceDraftOrRebuild の回帰テスト。
//
// 【背景となるバグ】Test14用branchの手動観察テストで、新しいturnを開くと表示される
// 「Standard AIの提案（実行前プレビュー）」が、下書きを一度保存してブラウザを
// リロードすると消える不具合が見つかった。原因はcoerceDraftOrRebuildが、既存の
// 保存済みdraftが見つかった場合に診断情報を無条件でnullにしていたこと（AI原案自体を
// 永続化していなかったこと）。本テストは、companyLabQuarterFlowService.saveDraftが
// 永続化したaiProposalDiagnosticsを、loadPlayerScreenViewModelが正しく読み戻すことを
// 確認する（指示§A-7の回帰テスト一覧に対応）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../../../lib/v2/sales/types";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService, CompanyLabDecisionsProvider } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyDecisionInput } from "../../../../../lib/v2/companyLab/types";
import { buildCompanyOwnState } from "../../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../../lib/v2/companyLab/autoPolicy";
import { loadPlayerScreenViewModel } from "../viewModel";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";

/** isPlausibleCompanyDecisionDraftを満たす最小限のプレイヤードラフト（UI型・構造チェックのみ）。 */
function minimalPlausibleDraft(companyId: string, note: string) {
  return {
    companyId,
    note,
    salesPlans: [],
    domesticPurchase: {},
    importOrders: [],
    aquacultureStockingPlans: [],
    productionPlans: [],
    workerAssignments: [],
    financingRequest: {},
    capexDecision: {},
  };
}

const autoPolicyProvider: CompanyLabDecisionsProvider = ({ restoredState, fixtures, publicInfo, period, turn }) => {
  const decisions: Record<CompanyId, CompanyDecisionInput> = {};
  for (const fixture of fixtures) {
    const ownState = buildCompanyOwnState(restoredState, fixture);
    decisions[fixture.companyId] = generateAutoPolicyDecision(fixture, ownState, publicInfo, period, turn);
  }
  return decisions;
};

function makeDeps() {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  const deps: CompanyLabApiDependencies = { repository, service };
  return { deps, repository, service };
}

test("loadPlayerScreenViewModel: 新しいturnを開いた初回表示では、draft保存前でもAI原案・diagnosticsが表示される", async () => {
  const { deps, service } = makeDeps();
  await service.createLab({
    labId: "vm-first-view",
    config: { scenarioId: "baseline", mode: "canonical", seed: "vm-seed-001", turns: 6 },
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  const result = await loadPlayerScreenViewModel(deps, "vm-first-view");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.viewModel.phase, "editing");
  assert.ok(result.viewModel.draft, "初回表示でdraftが組み立てられていません");
  assert.ok(result.viewModel.aiProposalDiagnostics, "初回表示でAI原案のdiagnosticsが表示されていません");
  assert.equal(result.viewModel.aiProposalDiagnostics!.turn, 1);
});

test("loadPlayerScreenViewModel: draftを保存してから再読込しても、AI原案・diagnosticsは表示され続ける（旧バグの回帰確認）", async () => {
  const { deps, service } = makeDeps();
  await service.createLab({
    labId: "vm-reload-keeps-proposal",
    config: { scenarioId: "baseline", mode: "canonical", seed: "vm-seed-002", turns: 6 },
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  await service.saveDraft({
    labId: "vm-reload-keeps-proposal",
    turnId: "turn-1",
    draftBody: minimalPlausibleDraft(PLAYER_COMPANY_ID, "v1"),
    now: NOW,
  });

  // ブラウザのリロード＝新しいloadPlayerScreenViewModel呼び出しを模す。
  const reloaded = await loadPlayerScreenViewModel(deps, "vm-reload-keeps-proposal");
  assert.equal(reloaded.kind, "ok");
  if (reloaded.kind !== "ok") return;
  assert.ok(reloaded.viewModel.aiProposalDiagnostics, "下書き保存後のリロードでAI原案が消えています（修正前の不具合の再発）");
});

test("loadPlayerScreenViewModel: draftを数値変更して再保存・再読込しても、AI原案の値自体は初回生成時のまま変化しない。一方、現在の入力（draft）は変更後の値になる", async () => {
  const { deps, service } = makeDeps();
  await service.createLab({
    labId: "vm-proposal-frozen",
    config: { scenarioId: "baseline", mode: "canonical", seed: "vm-seed-003", turns: 6 },
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  await service.saveDraft({
    labId: "vm-proposal-frozen",
    turnId: "turn-1",
    draftBody: minimalPlausibleDraft(PLAYER_COMPANY_ID, "before-edit"),
    now: NOW,
  });
  const firstView = await loadPlayerScreenViewModel(deps, "vm-proposal-frozen");
  assert.equal(firstView.kind, "ok");
  if (firstView.kind !== "ok") return;
  const originalDiagnostics = firstView.viewModel.aiProposalDiagnostics;
  assert.ok(originalDiagnostics);

  // プレイヤーが入力を編集して再保存する。
  await service.saveDraft({
    labId: "vm-proposal-frozen",
    turnId: "turn-1",
    draftBody: minimalPlausibleDraft(PLAYER_COMPANY_ID, "after-edit"),
    now: NOW,
  });
  const secondView = await loadPlayerScreenViewModel(deps, "vm-proposal-frozen");
  assert.equal(secondView.kind, "ok");
  if (secondView.kind !== "ok") return;

  // AI原案（diagnostics.decision含む）は最初に生成された値のまま。
  assert.deepEqual(secondView.viewModel.aiProposalDiagnostics, originalDiagnostics);
  // 現在の入力（draft）は編集後の値になっている。
  assert.equal((secondView.viewModel.draft as unknown as { note: string }).note, "after-edit");
});

test("loadPlayerScreenViewModel: 四半期処理後の次のturnでは、前turnのAI原案を誤って復元せず、新しいAI原案が生成される", async () => {
  const { deps, service } = makeDeps();
  await service.createLab({
    labId: "vm-next-turn-fresh-proposal",
    config: { scenarioId: "baseline", mode: "canonical", seed: "vm-seed-004", turns: 6 },
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  await service.saveDraft({
    labId: "vm-next-turn-fresh-proposal",
    turnId: "turn-1",
    draftBody: minimalPlausibleDraft(PLAYER_COMPANY_ID, "turn1"),
    now: NOW,
  });
  const turn1View = await loadPlayerScreenViewModel(deps, "vm-next-turn-fresh-proposal");
  assert.equal(turn1View.kind, "ok");
  if (turn1View.kind !== "ok") return;
  const turn1Diagnostics = turn1View.viewModel.aiProposalDiagnostics;
  assert.ok(turn1Diagnostics);

  await service.submitDraft({ labId: "vm-next-turn-fresh-proposal", turnId: "turn-1", now: NOW });
  await service.processQuarter({
    labId: "vm-next-turn-fresh-proposal",
    turnId: "turn-1",
    lockToken: "lock-1",
    now: NOW,
    decisionsProvider: autoPolicyProvider,
  });

  // turn 2の最初の表示（draft保存前）。coerceDraftOrRebuildの「draft無し」分岐で新規生成される。
  const turn2View = await loadPlayerScreenViewModel(deps, "vm-next-turn-fresh-proposal");
  assert.equal(turn2View.kind, "ok");
  if (turn2View.kind !== "ok") return;
  assert.equal(turn2View.viewModel.currentTurn, 2);
  assert.ok(turn2View.viewModel.aiProposalDiagnostics);
  assert.equal(turn2View.viewModel.aiProposalDiagnostics!.turn, 2, "turn2のAI原案のturn番号が2になっていません");
  assert.notDeepEqual(turn2View.viewModel.aiProposalDiagnostics, turn1Diagnostics);

  // turn 2で保存した場合も、turn1のAI原案が誤って引き継がれない。
  await service.saveDraft({
    labId: "vm-next-turn-fresh-proposal",
    turnId: "turn-2",
    draftBody: minimalPlausibleDraft(PLAYER_COMPANY_ID, "turn2"),
    now: NOW,
  });
  const turn2AfterSave = await loadPlayerScreenViewModel(deps, "vm-next-turn-fresh-proposal");
  assert.equal(turn2AfterSave.kind, "ok");
  if (turn2AfterSave.kind !== "ok") return;
  assert.equal(turn2AfterSave.viewModel.aiProposalDiagnostics!.turn, 2);
  assert.notDeepEqual(turn2AfterSave.viewModel.aiProposalDiagnostics, turn1Diagnostics);
});

test("loadPlayerScreenViewModel: 【後方互換】aiProposalDiagnosticsを持たない旧形式のdraft envelopeでも、draftの表示自体は壊れず、ベストエフォートでAI原案を再現する", async () => {
  const { deps, repository } = makeDeps();
  const service = createCompanyLabQuarterFlowService({ repository });
  await service.createLab({
    labId: "vm-legacy-envelope",
    config: { scenarioId: "baseline", mode: "canonical", seed: "vm-seed-005", turns: 6 },
    playerCompanyId: PLAYER_COMPANY_ID,
    now: NOW,
  });

  // feature/v2-persist-standard-ai-proposal導入前に保存されたenvelopeを模して、
  // aiProposalDiagnosticsフィールドを持たない状態を直接Repositoryへ注入する。
  const stored = await repository.loadCurrentState("vm-legacy-envelope");
  await repository.saveDraft({
    labId: "vm-legacy-envelope",
    period: stored.currentState.runtime.currentPeriod,
    turnId: "turn-1",
    revision: stored.currentState.revision,
    draft: minimalPlausibleDraft(PLAYER_COMPANY_ID, "legacy-draft"),
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: null,
    // aiProposalDiagnosticsを意図的に含めない（旧形式のenvelopeを再現）。
  });

  const result = await loadPlayerScreenViewModel(deps, "vm-legacy-envelope");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal((result.viewModel.draft as unknown as { note: string }).note, "legacy-draft");
  assert.ok(result.viewModel.aiProposalDiagnostics, "旧形式envelopeでのベストエフォート再現ができていません");
  assert.equal(result.viewModel.aiProposalDiagnostics!.turn, 1);
});
