import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SCENARIO_DEFINITIONS } from "../../../scenario";
import { listScenarioAliases, resolveScenarioDefinition, shortScenarioAlias } from "../scenarioAliases";

test("shortScenarioAlias: バージョン接尾辞を取り除く", () => {
  assert.equal(shortScenarioAlias("baseline-v0.1"), "baseline");
  assert.equal(shortScenarioAlias("ecuador-early-expansion-v0.1"), "ecuador-early-expansion");
  assert.equal(shortScenarioAlias("no-version-here"), "no-version-here");
});

test("listScenarioAliases: 選択可能なシナリオをすべて列挙する", () => {
  const entries = listScenarioAliases();
  assert.equal(entries.length, ALL_SCENARIO_DEFINITIONS.length);
  // Testplay 用に Dynamic Scenario 1・2 を加えて7本。
  assert.equal(entries.length, 7);
  assert.ok(entries.some((e) => e.alias === "dynamic-scenario-1"));
  assert.ok(entries.some((e) => e.alias === "dynamic-scenario-2"));
});

test("resolveScenarioDefinition: 完全なscenarioIdで解決できる", () => {
  const def = resolveScenarioDefinition("baseline-v0.1");
  assert.ok(def);
  assert.equal(def?.scenarioId, "baseline-v0.1");
});

test("resolveScenarioDefinition: 短縮形（バージョン接尾辞なし）でも解決できる", () => {
  const def = resolveScenarioDefinition("baseline");
  assert.ok(def);
  assert.equal(def?.scenarioId, "baseline-v0.1");
});

test("resolveScenarioDefinition: 存在しないIDはundefinedを返す", () => {
  assert.equal(resolveScenarioDefinition("does-not-exist"), undefined);
});

test("resolveScenarioDefinition: 5シナリオすべてが短縮形で解決できる", () => {
  for (const def of ALL_SCENARIO_DEFINITIONS) {
    const alias = shortScenarioAlias(def.scenarioId);
    const resolved = resolveScenarioDefinition(alias);
    assert.equal(resolved?.scenarioId, def.scenarioId, `alias "${alias}" should resolve to "${def.scenarioId}"`);
  }
});
