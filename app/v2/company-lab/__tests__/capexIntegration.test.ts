// ShrimpX V2 — 会社経営統合テスト環境 設備投資UI 統合テスト（Phase 8B-3）
//
// 「プレイヤーが案件を選び、投資判断を提出し、その後の進捗・完成・操業効果まで
// 確認できる」という実装指示§2の一通り動く縦断フローを、モック無しの実際の
// companyLabランナー（initializeCompanyLab・advanceCompanyLabQuarter）を通して
// 検証する。UI層のview-model（capexViewModel.ts）が算出するプレビュー値と、
// エンジンが実際に計算した値が同じ計算式（capex/depreciation.ts・
// capex/capacityEffect.ts）を共有していることも、実行結果の数値一致で確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPeriod, PeriodV2 } from "../../../lib/v2/core/period";
import {
  advanceCompanyLabQuarter,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  CompanyDecisionInput,
  CompanyFixture,
  CompanyLabConfig,
  CompanyLabState,
  generateAutoPolicyDecision,
  initializeCompanyLab,
} from "../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1, applyCapexCapacityToFactories } from "../../../lib/v2/capex";
import { computeOperationalStartPeriod } from "../../../lib/v2/capex/capacityEffect";
import { buildDecisionInputFromDraft, buildInitialDraft } from "../decisionDraft";
import { addCapexCancelRequestToDraft, addCapexProposalToDraft } from "../capexDraftActions";
import { buildCapexPortfolioViewModel } from "../capexViewModel";

const PLAYER = "BAL";

function baseConfig(seed: string): CompanyLabConfig {
  return { scenarioId: "baseline-v0.1", mode: "canonical", seed, turns: 12 };
}

/** 1ターンぶん、プレイヤー会社は指定decisionOverride（無ければ自動方針そのまま）、他社は自動方針で進める。 */
function stepOnce(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  decisionOverrideForPlayer?: (auto: CompanyDecisionInput) => CompanyDecisionInput
): CompanyLabState {
  const publicInfo = buildPublicMarketInfo(state);
  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    const ownState = buildCompanyOwnState(state, f);
    const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    decisionsByCompanyId[f.companyId] = f.companyId === PLAYER && decisionOverrideForPlayer ? decisionOverrideForPlayer(auto) : auto;
  }
  return advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
}

test("INT-1（実装指示§2の縦断フロー）: coldStorageExpansionを提出→着工→完成→稼働開始まで、実エンジンを通して一気通貫で確認する", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("capex-ui-integration-001"));
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;
  assert.ok(playerFixture, "BALのfixtureが存在する");

  // --- 1. 提出前: 現金・案件候補プレビューを確認する（実装指示§4・§6） ---
  const ownState0 = buildCompanyOwnState(initialState, playerFixture);
  const cashBefore = ownState0.financeState.cash as number;
  assert.ok(cashBefore > 0, "BALの初期現金が正の値であること");
  assert.equal(ownState0.capexState.portfolio.projects.length, 0, "投資案件ゼロ件から開始する（回帰防止・空の一覧表示）");

  // --- 2. 1ターン目: coldStorageExpansionをドラフトへ追加して提出する ---
  const publicInfo0 = buildPublicMarketInfo(initialState);
  const auto0 = generateAutoPolicyDecision(playerFixture, ownState0, publicInfo0, initialState.currentPeriod, 1);
  const draft0 = addCapexProposalToDraft(buildInitialDraft(playerFixture, auto0), "coldStorageExpansion");
  assert.equal(draft0.capexDecision.newProjectProposals.length, 1);

  const decisionsByCompanyId1: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    if (f.companyId === PLAYER) {
      decisionsByCompanyId1[f.companyId] = buildDecisionInputFromDraft(draft0, f, initialState.currentPeriod);
    } else {
      const ownState = buildCompanyOwnState(initialState, f);
      decisionsByCompanyId1[f.companyId] = generateAutoPolicyDecision(f, ownState, publicInfo0, initialState.currentPeriod, 1);
    }
  }
  let state = advanceCompanyLabQuarter(initialState, fixtures, decisionsByCompanyId1);

  // --- 3. 提出直後: 次の四半期の案件一覧に、この提案が現れているか（実装指示§2「進捗をプロジェクト一覧で確認」） ---
  let ownState = buildCompanyOwnState(state, playerFixture);
  assert.equal(ownState.capexState.portfolio.projects.length, 1, "新規案件がポートフォリオへ登録されている");
  let project = ownState.capexState.portfolio.projects[0];
  assert.equal(project.projectType, "coldStorageExpansion");
  assert.equal(project.approvedBudgetUsd, CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion.standardBudgetUsd);
  assert.ok(
    project.status === "approved" || project.status === "underConstruction",
    `1ターン目終了時点で承認済み・建設中いずれかのはず（実際: ${project.status}）`
  );

  // --- 4. 完成するまで自動方針のみで進める（最大10ターン。標準工期は2四半期のため十分な猶予）---
  let guard = 0;
  while (project.status !== "completed" && project.status !== "cancelled" && guard < 10) {
    state = stepOnce(state, fixtures);
    ownState = buildCompanyOwnState(state, playerFixture);
    const found = ownState.capexState.portfolio.projects.find((p) => p.projectId === project.projectId);
    assert.ok(found, "案件IDが四半期をまたいで維持される（複数案件が独立して進行する設計の一部として、単一案件でも同一IDで追跡できることの確認）");
    project = found!;
    guard++;
  }
  assert.equal(project.status, "completed", `${guard}ターン以内に完成するはず（資金は十分。実際のstatus: ${project.status}）`);
  assert.equal(project.capitalizedAmountUsd, 2_500_000, "完成時の資産計上額が投資総額と一致する");
  const completedPeriod = project.completedPeriod as PeriodV2;

  // --- 5. 稼働開始四半期の算出（実装指示§7「completedPeriodとoperationalStartPeriodを区別」） ---
  const template = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const operationalStartPeriod = computeOperationalStartPeriod(completedPeriod, template.postCompletionReadinessQuarters);
  assert.notEqual(operationalStartPeriod, completedPeriod, "稼働開始四半期は完成四半期そのものではない");

  // completedPeriod時点ではまだ稼働開始前（isCapacityReflected=false）のはず。
  const rowsAtCompletion = buildCapexPortfolioViewModel(ownState.capexState.portfolio.projects, CAPEX_PARAMETERS_V1, state.currentPeriod);
  const rowAtCompletion = rowsAtCompletion.find((r) => r.projectId === project.projectId)!;

  // --- 6. 稼働開始四半期に到達するまで進める ---
  guard = 0;
  while (state.currentPeriod !== operationalStartPeriod && guard < 10) {
    state = stepOnce(state, fixtures);
    guard++;
  }
  assert.equal(state.currentPeriod, operationalStartPeriod, "稼働開始四半期に到達しているはず");

  ownState = buildCompanyOwnState(state, playerFixture);
  project = ownState.capexState.portfolio.projects.find((p) => p.projectId === project.projectId)!;

  // --- 7. 稼働開始四半期の能力増加・保守費・減価償却を、UIのプレビュー計算と突き合わせる（実装指示§12・§16） ---
  const rowsAtOperationalStart = buildCapexPortfolioViewModel(ownState.capexState.portfolio.projects, CAPEX_PARAMETERS_V1, state.currentPeriod);
  const rowAtOperationalStart = rowsAtOperationalStart.find((r) => r.projectId === project.projectId)!;
  assert.equal(rowAtOperationalStart.displayStatus, "operating", "稼働開始四半期からは「稼働中」と表示される");
  assert.equal(rowAtCompletion.displayStatus, "completedPreparing", "完成四半期時点ではまだ「完成・操業準備中」と表示されていたはず");
  assert.equal(rowAtOperationalStart.isCapacityReflected, true);

  assert.ok(Math.abs(rowAtOperationalStart.quarterlyBuildingDepreciationUsd - 10_000) < 1e-6, `建物減価償却が10,000USD/四半期のはず（実際: ${rowAtOperationalStart.quarterlyBuildingDepreciationUsd}）`);
  assert.ok(Math.abs(rowAtOperationalStart.quarterlyMachineryDepreciationUsd - 37_500) < 1e-6, `機械減価償却が37,500USD/四半期のはず（実際: ${rowAtOperationalStart.quarterlyMachineryDepreciationUsd}）`);
  assert.ok(Math.abs(rowAtOperationalStart.quarterlyDepreciationUsd - 47_500) < 1e-6, `合計減価償却が47,500USD/四半期のはず（実際: ${rowAtOperationalStart.quarterlyDepreciationUsd}）`);
  assert.ok(Math.abs(rowAtOperationalStart.quarterlyMaintenanceCostUsd - 2_500_000 * template.maintenanceRatePerQuarter) < 1e-6);

  // --- 8. 実際にfactoriesへ能力増加が反映されているか（applyCapexCapacityToFactories、実際のエンジン関数を直接使って確認） ---
  const effectiveFactories = applyCapexCapacityToFactories(playerFixture.factories, state.capexState, state.currentPeriod);
  const originalFactory = playerFixture.factories.find((f) => f.factoryId === effectiveFactories[0].factoryId)!;
  const capacityIncrease = (effectiveFactories[0].freezingPackagingCapacity as unknown as number) - (originalFactory.freezingPackagingCapacity as unknown as number);
  assert.ok(Math.abs(capacityIncrease - 500) < 1e-6, `冷凍保管能力が500トン/四半期増加しているはず（実際の増分: ${capacityIncrease}）`);

  // --- 9. 稼働開始四半期そのものを実際に確定させ（もう1ターン進める）、その実績値がUIプレビューと
  //        一致することを確認する（実装指示§12「プレビューと実績が同一ロジック」）。
  //        rowAtOperationalStartはこの直前の状態（=稼働開始四半期の意思決定入力時点）でのプレビューであり、
  //        ここではそれを実際に確定させた結果と突き合わせる。 ---
  state = stepOnce(state, fixtures);
  const lastRecord = state.history[state.history.length - 1];
  assert.equal(lastRecord.period, operationalStartPeriod, "直近確定四半期が稼働開始四半期そのものであるはず");
  const capexResult = lastRecord.capexResults.find((r) => r.companyId === PLAYER)!;
  assert.ok(Math.abs(capexResult.capexAssetsDepreciationUsd - rowAtOperationalStart.quarterlyDepreciationUsd) < 1e-6, "実績の減価償却費とUIプレビューが一致する");
  assert.ok(Math.abs(capexResult.capexMaintenanceCostUsd - rowAtOperationalStart.quarterlyMaintenanceCostUsd) < 1e-6, "実績の保守費とUIプレビューが一致する");
});

test("INT-2（実装指示§9の取消フロー）: 支払実績のない案件は、UIドラフト経由の取消要求が実際にエンジンへ反映される", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("capex-ui-integration-002"));
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;

  // qualityControlEquipment・environmentalEquipmentは、標準予算に対して最低現金準備控除後の
  // 資金でも複数同時申請すると同時進行上限(3件)に達しうるため、単純化のため1件だけ申請する。
  const ownState0 = buildCompanyOwnState(initialState, playerFixture);
  const publicInfo0 = buildPublicMarketInfo(initialState);
  const auto0 = generateAutoPolicyDecision(playerFixture, ownState0, publicInfo0, initialState.currentPeriod, 1);
  const draft0 = addCapexProposalToDraft(buildInitialDraft(playerFixture, auto0), "environmentalEquipment");

  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    if (f.companyId === PLAYER) {
      decisionsByCompanyId[f.companyId] = buildDecisionInputFromDraft(draft0, f, initialState.currentPeriod);
    } else {
      const os = buildCompanyOwnState(initialState, f);
      decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, os, publicInfo0, initialState.currentPeriod, 1);
    }
  }
  const stateAfterSubmit = advanceCompanyLabQuarter(initialState, fixtures, decisionsByCompanyId);
  const ownStateAfterSubmit = buildCompanyOwnState(stateAfterSubmit, playerFixture);
  const project = ownStateAfterSubmit.capexState.portfolio.projects[0];
  assert.ok(project, "案件が登録されている");

  if (project.cumulativePaidUsd > 0) {
    // 資金繰りの結果、初回支払が同一ターン内で成功していた場合は取消不可（エンジンの正当な仕様）。
    // このテストの主眼は「取消可能な場合にUIの取消操作が実際にエンジンへ届くこと」の確認なので、
    // 支払成功済みでcumulativePaidUsd>0の場合はcancellableでないことを確認して終える。
    const rows = buildCapexPortfolioViewModel(ownStateAfterSubmit.capexState.portfolio.projects, CAPEX_PARAMETERS_V1, stateAfterSubmit.currentPeriod);
    assert.equal(rows[0].cancellable, false, "支払実績がある案件はUI上も取消不可と表示される");
    return;
  }

  // --- 支払が見送られ、cumulativePaidUsd===0のまま(approved)の場合、取消要求を提出する ---
  const draft1 = addCapexCancelRequestToDraft(buildInitialDraft(playerFixture, generateAutoPolicyDecision(playerFixture, ownStateAfterSubmit, buildPublicMarketInfo(stateAfterSubmit), stateAfterSubmit.currentPeriod, 2)), project.projectId);
  const decisionsByCompanyId2: Record<string, CompanyDecisionInput> = {};
  const publicInfo1 = buildPublicMarketInfo(stateAfterSubmit);
  for (const f of fixtures) {
    if (f.companyId === PLAYER) {
      decisionsByCompanyId2[f.companyId] = buildDecisionInputFromDraft(draft1, f, stateAfterSubmit.currentPeriod);
    } else {
      const os = buildCompanyOwnState(stateAfterSubmit, f);
      decisionsByCompanyId2[f.companyId] = generateAutoPolicyDecision(f, os, publicInfo1, stateAfterSubmit.currentPeriod, 2);
    }
  }
  const stateAfterCancel = advanceCompanyLabQuarter(stateAfterSubmit, fixtures, decisionsByCompanyId2);
  const ownStateAfterCancel = buildCompanyOwnState(stateAfterCancel, playerFixture);
  const cancelledProject = ownStateAfterCancel.capexState.portfolio.projects.find((p) => p.projectId === project.projectId)!;
  assert.equal(cancelledProject.status, "cancelled", "UIドラフト経由の取消要求が、実際のエンジン状態遷移として反映される");
});

test("INT-4（補足確認§3「エンジンのvalidation error/却下が画面を落とさず理解可能に表示される」）: 同時進行中案件数の上限(3件)を超える新規申請は、例外を投げずに理由つきで却下され、UIが参照するCapexQuarterResult.rejectedProposalsへ現れる", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("capex-ui-integration-004"));
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;

  // 実際にUI上で「今期の意思決定へ追加」を4回（4種類）クリックした状況を再現する。
  // maxConcurrentActiveProjectsPerCompany=3のため、4件目は同一四半期内での承認処理順で
  // 上限に達し却下されるはず（evaluateProposalは例外を投げず、rejected結果を返す設計）。
  const ownState0 = buildCompanyOwnState(initialState, playerFixture);
  const publicInfo0 = buildPublicMarketInfo(initialState);
  const auto0 = generateAutoPolicyDecision(playerFixture, ownState0, publicInfo0, initialState.currentPeriod, 1);
  let draft = buildInitialDraft(playerFixture, auto0);
  draft = addCapexProposalToDraft(draft, "hosoLineExpansion");
  draft = addCapexProposalToDraft(draft, "pdLineExpansion");
  draft = addCapexProposalToDraft(draft, "vapLineExpansion");
  draft = addCapexProposalToDraft(draft, "coldStorageExpansion");
  assert.equal(draft.capexDecision.newProjectProposals.length, 4);

  const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
  for (const f of fixtures) {
    if (f.companyId === PLAYER) {
      decisionsByCompanyId[f.companyId] = buildDecisionInputFromDraft(draft, f, initialState.currentPeriod);
    } else {
      const os = buildCompanyOwnState(initialState, f);
      decisionsByCompanyId[f.companyId] = generateAutoPolicyDecision(f, os, publicInfo0, initialState.currentPeriod, 1);
    }
  }

  let nextState: CompanyLabState | undefined;
  assert.doesNotThrow(() => {
    nextState = advanceCompanyLabQuarter(initialState, fixtures, decisionsByCompanyId);
  }, "上限超過の新規申請が混ざっていても、advanceCompanyLabQuarterは例外を投げない（画面が落ちないことの直接的な保証）");

  const capexResult = nextState!.history[nextState!.history.length - 1].capexResults.find((r) => r.companyId === PLAYER)!;
  assert.equal(capexResult.rejectedProposals.length, 1, "4件中1件が同時進行上限超過で却下されるはず");
  assert.equal(capexResult.rejectedProposals[0].projectType, "coldStorageExpansion", "最後に追加した案件が却下されるはず（承認順に上限へ到達するため）");
  assert.match(capexResult.rejectedProposals[0].reasons[0], /上限/, "却下理由が日本語で理解可能な文言であること");

  const ownStateAfter = buildCompanyOwnState(nextState!, playerFixture);
  assert.equal(ownStateAfter.capexState.portfolio.projects.length, 3, "却下された案件はポートフォリオへ登録されない（3件のみ登録）");
});

test("INT-3（8ターン一括実行の安定性）: 設備投資の意思決定を挟んでも、8ターンのcompanyLab実行が例外なく完走する（回帰防止）", () => {
  const { state: initialState, fixtures } = initializeCompanyLab(baseConfig("capex-ui-integration-003"));
  const playerFixture = fixtures.find((f) => f.companyId === PLAYER)!;
  let state = initialState;

  for (let turn = 1; turn <= 8; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisionsByCompanyId: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      const auto = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, turn);
      if (f.companyId === PLAYER && turn === 1) {
        const draft = addCapexProposalToDraft(buildInitialDraft(f, auto), "hosoLineExpansion");
        decisionsByCompanyId[f.companyId] = buildDecisionInputFromDraft(draft, f, state.currentPeriod);
      } else {
        decisionsByCompanyId[f.companyId] = auto;
      }
    }
    assert.doesNotThrow(() => {
      state = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
    }, `ターン${turn}が例外なく完了するはず`);
  }

  assert.equal(state.history.length, 8);
  const finalOwnState = buildCompanyOwnState(state, playerFixture);
  assert.equal(finalOwnState.capexState.portfolio.projects.length, 1, "8ターン通しても案件数が意図せず増減していない");

  // period()の等価性チェック用に、少なくとも1四半期先まで進んでいることも確認する（回帰防止の一環）。
  assert.notEqual(state.currentPeriod, nextPeriod(initialState.currentPeriod), "8ターン進めた後のcurrentPeriodは1四半期分だけ進んだ状態ではない");
});
