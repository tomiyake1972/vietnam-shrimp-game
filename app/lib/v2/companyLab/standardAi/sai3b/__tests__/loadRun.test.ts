// ShrimpX V2 — Phase SAI-3B-1: loadRun.ts のユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSai3aRun, SAI3A_REQUIRED_RUN_FILES } from "../loadRun";
import { Sai3bInputError } from "../schema";
import { buildFixtureRunFiles } from "./testFixtures";

function baseFiles() {
  return buildFixtureRunFiles({ runId: "r1", headcount: 80, quarters: 2, cases: [{ seed: "s1", companyId: "BAL", quarters: 2, headcount: 80 }] });
}

test("loadSai3aRun: 正常なrunを読み込める（単一run）", () => {
  const files = baseFiles();
  const run = loadSai3aRun({ runLabel: "r1", sourceDir: "/tmp/fixture", files });
  assert.equal(run.manifest.runId, "r1");
  assert.equal(run.caseSummaryRows.length, 1);
  assert.equal(run.quarterSummaryRows.length, 2);
  assert.equal(run.decisionTraceLines.length, 2);
  assert.equal(run.loadWarnings.length, 0);
});

test("loadSai3aRun: 必須ファイル欠落時に分かりやすく失敗する", () => {
  const files = baseFiles();
  delete (files as Record<string, string | undefined>)["quarter-summary.csv"];
  assert.throws(
    () => loadSai3aRun({ runLabel: "r1", sourceDir: "/tmp/fixture", files }),
    (e: unknown) => e instanceof Sai3bInputError && /quarter-summary\.csv/.test((e as Error).message)
  );
});

test("loadSai3aRun: 対応外のschema versionはエラーにする", () => {
  const files = baseFiles();
  const manifest = JSON.parse(files["manifest.json"]);
  manifest.schemaVersion = "9.9.9";
  files["manifest.json"] = JSON.stringify(manifest);
  assert.throws(() => loadSai3aRun({ runLabel: "r1", sourceDir: "/tmp/fixture", files }), Sai3bInputError);
});

test("loadSai3aRun: run-summary.jsonにエラーケースが記録されている場合は読み込み警告を出す", () => {
  const files = baseFiles();
  const runSummary = JSON.parse(files["run-summary.json"]);
  runSummary.errors = [{ seed: "s2", companyIds: ["BAL"], errorMessage: "boom" }];
  files["run-summary.json"] = JSON.stringify(runSummary);
  const run = loadSai3aRun({ runLabel: "r1", sourceDir: "/tmp/fixture", files });
  assert.equal(run.loadWarnings.length, 1);
  assert.match(run.loadWarnings[0], /s2/);
});

test("SAI3A_REQUIRED_RUN_FILES: 7ファイルすべてを列挙している", () => {
  assert.equal(SAI3A_REQUIRED_RUN_FILES.length, 7);
  for (const f of ["manifest.json", "case-summary.csv", "quarter-summary.csv", "decision-trace.jsonl", "adjustment-trace.csv", "warnings.csv", "run-summary.json"]) {
    assert.ok(SAI3A_REQUIRED_RUN_FILES.includes(f));
  }
});
