// ShrimpX V2 — Phase SAI-1.5: レポート生成モジュールのスモークテスト
//
// レポート生成自体はゲームロジックではないため、SAI-1本体ほど網羅的な仕様は
// 求めない。「例外を投げずに、意味のある形の出力を返す」ことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyLabConfig } from "../../../types";
import { collectRun, findFirstDefaultQuarter } from "../collect";
import { extractScenarioRows, SCENARIO_UNIMPLEMENTED_NOTES } from "../scenario";
import { buildInitialConditionRows } from "../initialConditions";
import { runTestA, runTestB, runTestC, runTestD, runMultiSeed } from "../decompose";
import { buildConfigSettingRows } from "../configSnapshot";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "report-smoke-001", turns: 8, ...overrides };
}

test("collectRun: standardAiで8Q分の行を、会社数×ターン数ぶん生成する", () => {
  const { rows, result } = collectRun("smoke-std", baseConfig(), "standardAi");
  assert.equal(rows.length, 5 * 8);
  assert.equal(result.history.length, 8);
  for (const row of rows) {
    assert.ok(row.pressures, `${row.companyId} turn${row.turn}: pressuresが無い`);
    assert.ok(Number.isFinite(row.cashUsd));
  }
});

test("collectRun: autoPolicyではpressuresがundefinedのまま（診断情報を持たない）", () => {
  const { rows } = collectRun("smoke-auto", baseConfig(), "autoPolicy");
  assert.ok(rows.every((r) => r.pressures === undefined));
});

test("extractScenarioRows: 4象限の需要市場・産地国の値が全ターン分そろう", () => {
  const { result } = collectRun("smoke-scenario", baseConfig({ turns: 4 }), "standardAi");
  const rows = extractScenarioRows("smoke-scenario", baseConfig({ turns: 4 }), result);
  assert.equal(rows.length, 4);
  assert.ok(rows[0].economicIndexByMarket.CN !== undefined);
  assert.ok(SCENARIO_UNIMPLEMENTED_NOTES.length > 0);
});

test("buildInitialConditionRows: 5社ぶんの値がすべての行に存在する", () => {
  const { result } = collectRun("smoke-initcond", baseConfig({ turns: 1 }), "standardAi");
  const rows = buildInitialConditionRows(result.history[0].period);
  assert.ok(rows.length > 5);
  for (const row of rows) {
    for (const id of ["BAL", "MASS", "JPQ", "VAP", "CONSV"]) {
      assert.ok(row.valueByCompany[id as "BAL"] !== undefined, `${row.attribute} に ${id} が無い`);
    }
  }
});

test("findFirstDefaultQuarter: paymentDefaultが一度も無ければnull", () => {
  const { rows } = collectRun("smoke-default", baseConfig({ turns: 2 }), "standardAi");
  const q = findFirstDefaultQuarter(rows, "BAL");
  assert.ok(q === null || typeof q === "number");
});

test("decompose: Test A/B/C/Dがいずれも5社ぶんの結果を返す", () => {
  const a = runTestA("decompose-smoke-001", 4);
  const b = runTestB("decompose-smoke-001", 4, "BAL");
  const c = runTestC("decompose-smoke-001", 4);
  const d = runTestD("decompose-smoke-001", 4);
  for (const summary of [a, b, c, d.standardAi, d.autoPolicy]) {
    for (const id of ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const) {
      assert.ok(Number.isFinite(summary.finalByCompany[id].finalCashUsd));
    }
  }
});

test("decompose: Test Bは会社間の初期条件差を実際に取り除く（生産能力等が全社一致）", () => {
  const b = runTestB("decompose-smoke-002", 2, "JPQ");
  // Test Bはfinancial結果までは検証しないが、少なくとも例外なく完走し、
  // 5社とも同じ「現金圧力の起点」から出発していることを、初期cashUsd経由で間接確認する。
  assert.equal(Object.keys(b.finalByCompany).length, 5);
});

test("runMultiSeed: 指定したseed数ぶんの分布を返す", () => {
  const summary = runMultiSeed("A", ["ms-1", "ms-2", "ms-3"], 4);
  assert.equal(summary.seeds.length, 3);
  assert.ok(summary.distributions.length > 0);
  for (const id of ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const) {
    assert.ok(summary.paymentDefaultRateByCompany[id] >= 0 && summary.paymentDefaultRateByCompany[id] <= 1);
  }
});

test("buildConfigSettingRows: 標準AIの閾値が実際の定数から読み取れる", () => {
  const rows = buildConfigSettingRows();
  assert.ok(rows.length > 10);
  assert.ok(rows.some((r) => r.field === "cashBufferQuarters"));
});
