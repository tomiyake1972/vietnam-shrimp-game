// ShrimpX V2 — ラボ作成フォームのターン数モデル・回帰テスト（ターン数整合性修正）
//
// 「ターン数の唯一の正は選択中シナリオのdurationTurns」という方針の回帰テスト。
//   1. baseline選択時の初期値・上限が32になる（従来はUIに40がハードコードされ、
//      初期表示のまま作成するとサーバー側で拒否されていた）。
//   2. 初期表示のまま（フォームモデルの導出値のまま）baselineラボを正常に作成できる。
//   3. durationTurnsを超える値はサーバー側でも拒否される（入力検証層・Application Service層）。
//   4. 異なるdurationTurnsを持つシナリオへ変更すると入力値・上限が追随する。
//   5. 将来の40ターンシナリオを想定したfixtureでも40を正常に設定できる。
//   6. 保存済みラボの総ターン数は再開（viewModel再読込）後も変わらない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { listScenarioOptionsForNewLab, turnBoundsForScenario, NewLabScenarioOption } from "../newLabFormModel";
import { loadPlayerScreenViewModel } from "../viewModel";
import { ALL_SCENARIO_DEFINITIONS } from "../../../../../lib/v2/scenario";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabError } from "../../../../../lib/v2/companyLab/types";
import { CompanyLabApiDependencies } from "../../../../../api/v2/company-labs/_lib/dependencies";
import { handleCreateLab } from "../../../../../api/v2/company-labs/_lib/handlers";

const NOW = "2026-01-01T00:00:00.000Z";
const BASELINE_SCENARIO_ID = "baseline-v0.1";

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

/** 将来の10年間＝40四半期シナリオを想定した選択肢fixture（シナリオ定義全体は不要。フォームモデルはdurationTurnsしか参照しない）。 */
const FUTURE_40_TURN_OPTION: NewLabScenarioOption = {
  scenarioId: "future-10year-v0.1",
  title: "（テスト用）10年間シナリオ",
  durationTurns: 40,
};

// --- 1. baseline選択時の初期値・上限 ---

test("turnBoundsForScenario: baseline選択時の初期値・上限はどちらも32（durationTurns由来）になる", () => {
  const options = listScenarioOptionsForNewLab();
  const bounds = turnBoundsForScenario(options, BASELINE_SCENARIO_ID);
  assert.ok(bounds);
  assert.equal(bounds.defaultTurns, 32);
  assert.equal(bounds.maxTurns, 32);
});

test("listScenarioOptionsForNewLab: 全選択肢がALL_SCENARIO_DEFINITIONSのdurationTurnsを正確に反映する（UI側ハードコードの排除）", () => {
  const options = listScenarioOptionsForNewLab();
  assert.equal(options.length, ALL_SCENARIO_DEFINITIONS.length);
  for (const definition of ALL_SCENARIO_DEFINITIONS) {
    const option = options.find((o) => o.scenarioId === definition.scenarioId);
    assert.ok(option, `シナリオ${definition.scenarioId}が選択肢に存在しません`);
    assert.equal(option.durationTurns, definition.durationTurns);
    assert.equal(option.title, definition.title);
  }
});

// --- 2. 初期表示のままbaselineラボを正常に作成できる ---

test("handleCreateLab: フォーム初期値（baselineのdurationTurns）のまま、baselineラボを201で正常に作成できる", async () => {
  const deps = makeDeps();
  const options = listScenarioOptionsForNewLab();
  const bounds = turnBoundsForScenario(options, BASELINE_SCENARIO_ID);
  assert.ok(bounds);
  // フォームが送信するのと同じ組み合わせ（scenarioId=完全ID・turns=導出初期値）で作成する。
  const result = await handleCreateLab(
    deps,
    { labId: "default-turns-lab", scenarioId: BASELINE_SCENARIO_ID, mode: "canonical", seed: "form-default-seed", turns: bounds.defaultTurns, playerCompanyId: "MASS" },
    NOW
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const lab = (result.body as { lab: { totalTurns: number } }).lab;
  assert.equal(lab.totalTurns, 32);
});

// --- 3. durationTurns超過はサーバー側でも拒否される ---

test("handleCreateLab: durationTurnsを超えるturns（baselineで33）は400で拒否される（入力検証層）", async () => {
  const deps = makeDeps();
  const result = await handleCreateLab(
    deps,
    { labId: "over-turns-lab", scenarioId: BASELINE_SCENARIO_ID, mode: "canonical", seed: "s", turns: 33, playerCompanyId: "MASS" },
    NOW
  );
  assert.equal(result.status, 400);
  const message = (result.body as { error: { message: string } }).error.message;
  assert.match(message, /durationTurns/);
  assert.match(message, /32/);
});

test("Application Service: 入力検証をバイパスして直接createLabを呼んでも、durationTurns超過はCompanyLabErrorで拒否される（多層防御）", async () => {
  const deps = makeDeps();
  await assert.rejects(
    deps.service.createLab({
      labId: "bypass-over-turns-lab",
      config: { scenarioId: BASELINE_SCENARIO_ID, mode: "canonical", seed: "s", turns: 33 },
      playerCompanyId: "MASS",
      now: NOW,
    }),
    (e: unknown) => e instanceof CompanyLabError && /durationTurns/.test((e as Error).message)
  );
});

// --- 4. シナリオ変更時の追随 ---

test("turnBoundsForScenario: 異なるdurationTurnsを持つシナリオへ変更すると、入力値・上限が新しいシナリオのdurationTurnsへ追随する", () => {
  // 実在の全シナリオは現在32ターンのため、durationTurnsが異なる将来シナリオをfixtureで加える。
  const options: readonly NewLabScenarioOption[] = [...listScenarioOptionsForNewLab(), FUTURE_40_TURN_OPTION];
  const before = turnBoundsForScenario(options, BASELINE_SCENARIO_ID);
  assert.ok(before);
  assert.equal(before.defaultTurns, 32);
  // NewLabForm.handleScenarioChangeはこの導出値をそのまま入力値・上限に反映する。
  const after = turnBoundsForScenario(options, FUTURE_40_TURN_OPTION.scenarioId);
  assert.ok(after);
  assert.equal(after.defaultTurns, 40);
  assert.equal(after.maxTurns, 40);
});

test("turnBoundsForScenario: 未知のscenarioIdにはnullを返す（防御的挙動）", () => {
  assert.equal(turnBoundsForScenario(listScenarioOptionsForNewLab(), "no-such-scenario"), null);
});

// --- 6. 保存済みラボの総ターン数は再開後も変わらない ---

test("loadPlayerScreenViewModel: 保存済みラボの総ターン数は、作成時の値（例: 8）のままで、現在のシナリオ定義のdurationTurns（32）を読み直しても変化しない", async () => {
  const deps = makeDeps();
  const created = await handleCreateLab(
    deps,
    { labId: "turns-keep-lab", scenarioId: BASELINE_SCENARIO_ID, mode: "canonical", seed: "keep-seed", turns: 8, playerCompanyId: "MASS" },
    NOW
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // 再開1回目（作成後の再読込に相当）。
  const first = await loadPlayerScreenViewModel(deps, "turns-keep-lab");
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  assert.equal(first.viewModel.totalTurns, 8);
  assert.equal(first.viewModel.currentTurn, 1);
  // 8 ≠ 32（baselineのdurationTurns）であることが、「保存済みconfig.turnsが唯一の源であり、
  // シナリオ定義の読み直しでは決まらない」ことの直接の証明になる。
  assert.notEqual(first.viewModel.totalTurns, 32);

  // 再開2回目（ブラウザの再読込・別セッションからのResumeに相当）。値は変わらない。
  const second = await loadPlayerScreenViewModel(deps, "turns-keep-lab");
  assert.equal(second.kind, "ok");
  if (second.kind !== "ok") return;
  assert.equal(second.viewModel.totalTurns, 8);
});
