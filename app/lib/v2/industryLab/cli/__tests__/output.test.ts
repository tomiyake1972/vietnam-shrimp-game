import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndustrySimulation } from "../../simulationRunner";
import { compareIndustrySimulations } from "../../ui/comparison";
import { IndustrySimulationConfig } from "../../types";
import {
  formatResultAsSummary,
  formatResultAsJson,
  formatResultAsCsv,
  formatComparisonAsSummary,
  formatComparisonAsJson,
  formatComparisonAsCsv,
} from "../output";

function configFor(scenarioId: string, overrides?: Partial<IndustrySimulationConfig>): IndustrySimulationConfig {
  return { scenarioId, mode: "canonical", seed: "output-test-seed", turns: 8, ...overrides };
}

test("formatResultAsJson: 正当なJSONであり、config・quarters件数が一致する", () => {
  const result = runIndustrySimulation(configFor("baseline-v0.1"));
  const text = formatResultAsJson(result, "ベースライン：緩やかな世界需要拡大");
  const parsed = JSON.parse(text);
  assert.equal(parsed.config.scenarioId, "baseline-v0.1");
  assert.equal(parsed.scenarioTitle, "ベースライン：緩やかな世界需要拡大");
  assert.equal(parsed.quarters.length, result.quarters.length);
  assert.equal(parsed.quarters[0].turn, 1);
});

test("formatResultAsCsv: ヘッダーと全データ行の列数が一致する", () => {
  const result = runIndustrySimulation(configFor("baseline-v0.1"));
  const csv = formatResultAsCsv(result);
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");
  assert.equal(lines.length, result.quarters.length + 1);
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length, `row "${line}" should have ${header.length} columns`);
  }
  assert.ok(header.includes("turn"));
  assert.ok(header.includes("hosoPrice_VN"));
  assert.ok(header.includes("vietnamDomesticPrice"));
});

test("formatResultAsCsv: 数値は生の数値であり、UI向けの通貨記号等は含まない", () => {
  const result = runIndustrySimulation(configFor("baseline-v0.1", { turns: 1 }));
  const csv = formatResultAsCsv(result);
  const dataRow = csv.trim().split("\n")[1];
  assert.ok(!dataRow.includes("$"));
  assert.ok(!dataRow.includes("トン"));
});

test("formatResultAsSummary: シナリオ名・モード・シード・ターン数を含む", () => {
  const result = runIndustrySimulation(configFor("baseline-v0.1"));
  const summary = formatResultAsSummary(result, "ベースライン：緩やかな世界需要拡大");
  assert.ok(summary.includes("ベースライン：緩やかな世界需要拡大"));
  assert.ok(summary.includes("canonical"));
  assert.ok(summary.includes("output-test-seed"));
  assert.ok(summary.includes(`${result.quarters.length} / ${result.config.turns}`));
});

test("formatComparisonAsJson: 正当なJSONであり、既存compareIndustrySimulationsの結果と一致する", () => {
  const a = runIndustrySimulation(configFor("baseline-v0.1"));
  const b = runIndustrySimulation(configFor("global-demand-boom-v0.1"));
  const comparison = compareIndustrySimulations(a, b);
  const text = formatComparisonAsJson(a, b, comparison, {
    scenarioTitleA: "A",
    scenarioTitleB: "B",
  });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.comparison, JSON.parse(JSON.stringify(comparison)));
  assert.equal(parsed.configA.scenarioId, "baseline-v0.1");
  assert.equal(parsed.configB.scenarioId, "global-demand-boom-v0.1");
});

test("formatComparisonAsCsv: ヘッダーと全データ行の列数が一致する", () => {
  const a = runIndustrySimulation(configFor("baseline-v0.1"));
  const b = runIndustrySimulation(configFor("global-demand-boom-v0.1"));
  const comparison = compareIndustrySimulations(a, b);
  const csv = formatComparisonAsCsv(comparison);
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");
  assert.equal(lines.length, comparison.quarters.length + 1);
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length);
  }
});

test("formatComparisonAsSummary: A/Bのシナリオ名とイベント差分を含む", () => {
  const a = runIndustrySimulation(configFor("baseline-v0.1"));
  const b = runIndustrySimulation(configFor("global-disease-crisis-v0.1"));
  const comparison = compareIndustrySimulations(a, b);
  const summary = formatComparisonAsSummary(a, b, comparison, { scenarioTitleA: "基準シナリオ", scenarioTitleB: "比較シナリオ" });
  assert.ok(summary.includes("基準シナリオ"));
  assert.ok(summary.includes("比較シナリオ"));
  assert.ok(summary.includes("イベント"));
});
