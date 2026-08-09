// ShrimpX V2 — Vision 駆動の戦略成長：UI と記録の配線テスト
//
// 【このテスト群が守ること】
//  (a) 経営の「志」と、志に対する現在地が画面から見える
//  (b) 「建てなかった理由」も記録され、画面・Pack の双方から追える
//  (c) Vision を設定するのは人間の経営者だ、という役割分担が文言として出ている
//  (d) 既定画面を重くしない（詳細は折りたたみ／独立URL）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { advanceSimulationTurns, createSimulationSession } from "../engine";
import { buildDatasetFromSession } from "../analytics/dataset";
import { buildAiAnalysisPackContext } from "../aiPack/context";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION, StoredSimulationRun } from "../persistence/types";
import { listScenarioAliases } from "../../../industryLab/cli/scenarioAliases";

const AT = "2026-01-01T00:00:00.000Z";
const MANAGEMENT_DIR = path.join(process.cwd(), "app/v2/management");
const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

function runTurns(turns: number) {
  const session = createSimulationSession({
    simulationRunId: "vision-ui-test",
    scenarioId: "baseline",
    seed: "phase5-test",
    requestedTurns: turns,
    startedAt: AT,
  });
  return advanceSimulationTurns({ session, turns, timestamp: AT });
}

function stored(turns: number, requestedTurns = turns): StoredSimulationRun {
  const session = runTurns(turns);
  return {
    schemaVersion: CURRENT_SIMULATION_RUN_PERSISTED_VERSION,
    run: { ...session.run, requestedTurns },
    dataset: buildDatasetFromSession(session),
    packCapture: { companyTurns: session.packCompanyTurns, worldTurns: session.packWorldTurns },
    savedAt: AT,
  };
}

// ---------------------------------------------------------------------
// 1. 記録される内容
// ---------------------------------------------------------------------

test("UI-1: 全会社・全ターンに Vision と新工場の判断が記録される（提案しなかった四半期も）", () => {
  const session = runTurns(4);
  assert.equal(session.packCompanyTurns.length, 4 * 5);
  for (const row of session.packCompanyTurns) {
    assert.ok(row.strategy.vision, `${row.companyId} Q${row.turn} の Vision が無い`);
    assert.equal(row.strategy.availability, "AVAILABLE");
    assert.ok(row.strategy.growthPressure !== null, "成長圧力が記録されていない");
    assert.ok(row.strategy.newFactory !== null, "新工場の検討結果が記録されていない");
    assert.ok(row.strategy.newFactory.reasonCodes.length > 0, "理由コードが1件も無い（建てなかった理由が残らない）");
    assert.ok(row.strategy.newFactory.gates.length > 0, "ゲートの評価が残っていない");
  }
});

test("UI-2: ゲートは合否・値・閾値を持ち、単一の不透明なスコアではない", () => {
  const session = runTurns(20);
  const late = session.packCompanyTurns.filter((r) => r.turn === 20);
  for (const row of late) {
    for (const gate of row.strategy.newFactory?.gates ?? []) {
      assert.ok(typeof gate.passed === "boolean");
      assert.ok(typeof gate.keyValues === "object" && gate.keyValues !== null);
    }
    // 判断を止めたゲートには必ず人間向けの説明がある。
    const failed = row.strategy.newFactory?.gates.find((g) => !g.passed);
    if (failed) assert.ok(failed.note.length > 0, `${row.companyId}: 止まったゲートの説明が空`);
  }
});

test("UI-3: Pack にも Vision・戦略ギャップ・新工場判断が入る", () => {
  const context = buildAiAnalysisPackContext({ stored: stored(3), exportedAt: AT });
  for (const company of Object.values(context.companies)) {
    const last = company.turns[company.turns.length - 1];
    assert.ok(last.strategy.vision, "Pack に Vision が無い");
    assert.ok(last.strategy.newFactory, "Pack に新工場の判断が無い");
    assert.ok(last.strategy.strategicScaleGapTons !== null, "Pack に戦略ギャップが無い");
  }
  // Vision は quota ではないことが reading guide に明記されている。
  assert.ok(context.readingGuide.some((g) => g.includes("aspiration, not a quota")));
});

test("UI-4: 途中実行は PARTIAL RUN として強く示され、残りをゼロで埋めない", () => {
  const context = buildAiAnalysisPackContext({ stored: stored(6, 32), exportedAt: AT });
  assert.equal(context.run.isPartialRun, true);
  assert.match(context.run.runCompletenessLabel, /^PARTIAL RUN — 6 \/ 32 quarters$/);
  for (const company of Object.values(context.companies)) {
    assert.equal(company.turns.length, 6, "存在しない四半期が作られている");
  }

  const complete = buildAiAnalysisPackContext({ stored: stored(3, 3), exportedAt: AT });
  assert.equal(complete.run.isPartialRun, false);
  assert.match(complete.run.runCompletenessLabel, /^COMPLETE RUN/);
});

// ---------------------------------------------------------------------
// 2. 画面（役割分担の文言・既定の軽さ・独立URL）
// ---------------------------------------------------------------------

test("UI-5: /v2/management/analysis/strategy が独立した route として存在する", () => {
  assert.ok(fs.existsSync(path.join(MANAGEMENT_DIR, "analysis/strategy/page.tsx")));
  assert.ok(fs.existsSync(path.join(MANAGEMENT_DIR, "analysis/strategy/StrategyView.tsx")));
});

test("UI-6: Analysis Home の索引と Quick Navigation から strategy へ辿れる", async () => {
  const { ANALYSIS_CATEGORIES, QUICK_NAVIGATION } = await import("../../../../../v2/management/analysis/catalog");
  const paths = ANALYSIS_CATEGORIES.flatMap((c) => c.items.map((i) => i.path));
  assert.ok(paths.includes("/v2/management/analysis/strategy"));
  assert.ok(QUICK_NAVIGATION.some((q) => q.path === "/v2/management/analysis/strategy"));
});

test("UI-7: Vision を決めるのは人間の経営者だ、という役割分担が画面の文言にある", () => {
  const inspector = read("app/v2/management/components/CompanyInspector.tsx");
  const strategyView = read("app/v2/management/analysis/strategy/StrategyView.tsx");
  const summary = read("app/v2/management/components/StrategySummary.tsx");
  for (const [name, text] of [
    ["CompanyInspector", inspector],
    ["StrategyView", strategyView],
    ["StrategySummary", summary],
  ] as const) {
    assert.ok(text.includes("人間の経営者"), `${name} に役割分担の文言が無い`);
  }
  // 「達成義務ではない」ことも画面に出す。
  assert.ok(inspector.includes("達成義務ではありません"));
  assert.ok(strategyView.includes("達成できないことは異常ではありません"));
});

test("UI-8: Vision Card と Strategic Outlook は常に表示、Investment Thinking は折りたたみ", () => {
  const inspector = read("app/v2/management/components/CompanyInspector.tsx");
  assert.match(inspector, /<AlwaysSection title="Vision（経営者の志）">/);
  assert.match(inspector, /<AlwaysSection title="Strategic Outlook（志に対する現在地）">/);
  assert.match(inspector, /<Section title="Investment Thinking/);
});

test("UI-9: Console の5社サマリーは折りたたみに置かれ、既定画面を重くしない", () => {
  const console_ = read("app/v2/management/components/ManagementConsole.tsx");
  assert.match(console_, /<Collapsible title="Vision と成長圧力（5社サマリー）"/);
  const collapsible = read("app/v2/management/components/Collapsible.tsx");
  assert.match(collapsible, /defaultOpen = false/);
});

test("UI-10: Vision の記録が無い実行では、架空の Vision を作らずその旨を出す", () => {
  const strategyView = read("app/v2/management/analysis/strategy/StrategyView.tsx");
  assert.ok(strategyView.includes("記録がありません"));
  assert.ok(strategyView.includes("推測で補完することはしません"));
});

// ---------------------------------------------------------------------
// 3. シナリオの切替（別シナリオで同じテストができること）
// ---------------------------------------------------------------------

test("UI-11: 登録済みの全シナリオが 32Q を完走し、Vision・新工場判断も記録される", () => {
  for (const { alias } of listScenarioAliases()) {
    const session = advanceSimulationTurns({
      session: createSimulationSession({
        simulationRunId: `scenario-${alias}`,
        scenarioId: alias,
        seed: "phase5-test",
        requestedTurns: 32,
        startedAt: AT,
      }),
      turns: 32,
      timestamp: AT,
    });
    assert.equal(session.run.completedTurns, 32, `${alias} が 32Q を完走しない`);
    assert.equal(session.run.stopReason, "completed");
    assert.equal(session.run.scenarioId, alias, "実行に選んだシナリオIDが残らない");
    const last = session.packCompanyTurns.filter((c) => c.turn === 32);
    assert.equal(last.length, 5);
    for (const row of last) {
      assert.ok(row.strategy.vision, `${alias} / ${row.companyId}: Vision が無い`);
      assert.ok(row.strategy.newFactory, `${alias} / ${row.companyId}: 新工場の判断が無い`);
    }
  }
});

test("UI-12: Console のシナリオ選択肢は登録簿から生成し、一覧を画面側へ書き写さない", () => {
  const console_ = read("app/v2/management/components/ManagementConsole.tsx");
  assert.ok(console_.includes("listScenarioAliases()"), "シナリオ一覧を登録簿から読んでいない");
  assert.match(console_, /data-testid="scenario-selector"/);
  assert.match(console_, /data-testid="seed-input"/);
  // シナリオIDを画面へハードコードした一覧が無いこと（baseline の既定値1つを除く）。
  for (const id of ["ecuador-early-expansion", "global-disease-crisis", "global-demand-boom"]) {
    assert.ok(!console_.includes(id), `${id} が画面側へ書き写されている`);
  }
});

test("UI-13: シナリオ・seed を変えたら、途中の実行を引き継がず新しい実行として始める", () => {
  const console_ = read("app/v2/management/components/ManagementConsole.tsx");
  assert.ok(console_.includes("liveMatchesSettings"), "設定変更時に実行を作り直す分岐が無い");
  assert.match(console_, /live\.run\.scenarioId === scenarioId && live\.run\.seed === seed/);
});
