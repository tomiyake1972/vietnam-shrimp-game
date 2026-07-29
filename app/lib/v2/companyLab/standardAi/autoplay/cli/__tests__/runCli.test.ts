// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI 実行オーケストレーションのテスト
//
// runAutoplayCli自体はfsに触れない純粋関数のため、返り値（stdout/stderr/
// exitCode/files/outputDir）だけを検証する。実際のファイル書き出しは
// scripts/sai3aAutoplay.ts側の責務であり、ここではテストしない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCli } from "../runCli";

test("runAutoplayCli: --helpは使用方法を表示してexitCode 0を返し、filesは無い", () => {
  const result = runAutoplayCli(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /SAI-3A/);
  assert.equal(result.files, undefined);
});

test("runAutoplayCli: 引数エラー時はexitCode 1でstderrにエラー内容が入る", () => {
  const result = runAutoplayCli(["--quarters", "4"]); // --seeds/--seed-countが無い
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /引数エラー/);
});

test("runAutoplayCli: 正常実行時は7種類のファイル内容とoutputDirを返す", () => {
  const result = runAutoplayCli(["--seed-count", "1", "--quarters", "2", "--companies", "BAL", "--run-id", "sai3a-cli-test-001", "--out-dir", "artifacts/sai3a"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.files);
  const fileNames = Object.keys(result.files!).sort();
  assert.deepEqual(fileNames, [
    "adjustment-trace.csv",
    "case-summary.csv",
    "decision-trace.jsonl",
    "manifest.json",
    "quarter-summary.csv",
    "run-summary.json",
    "warnings.csv",
  ]);
  assert.equal(result.outputDir, "artifacts/sai3a/sai3a-cli-test-001");

  const manifest = JSON.parse(result.files!["manifest.json"]);
  assert.equal(manifest.runId, "sai3a-cli-test-001");
  assert.equal(manifest.quarters, 2);
  assert.deepEqual(manifest.companyIds, ["BAL"]);
  assert.deepEqual(manifest.seeds, ["sai3a-001"]);

  const caseSummaryLines = result.files!["case-summary.csv"].split("\n").filter((l) => l.length > 0);
  assert.equal(caseSummaryLines.length, 2); // header + 1 company
});

test("runAutoplayCli: executedAtIso/appCommitIdをoptionsで渡すと、manifestへそのまま反映される（副作用は呼び出し元が担う）", () => {
  const result = runAutoplayCli(["--seed-count", "1", "--quarters", "1", "--companies", "BAL"], {
    executedAtIso: "2026-01-01T00:00:00.000Z",
    appCommitId: "deadbeef",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const manifest = JSON.parse(result.files!["manifest.json"]);
  assert.equal(manifest.executedAtIso, "2026-01-01T00:00:00.000Z");
  assert.equal(manifest.appCommitId, "deadbeef");
});
