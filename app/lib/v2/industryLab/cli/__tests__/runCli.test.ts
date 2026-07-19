import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../runCli";
import { runIndustrySimulation } from "../../simulationRunner";
import { ALL_SCENARIO_DEFINITIONS } from "../../../scenario";
import { compareIndustrySimulations } from "../../ui/comparison";

// ---------------------------------------------------------------------
// 正常系: 出力形式
// ---------------------------------------------------------------------

test("--format json: 標準出力はJSON.parseできる文字列のみ（余計な行を含まない）", () => {
  const { stdout, stderr, exitCode } = runCli(["--scenario", "baseline", "--seed", "s1", "--turns", "5", "--format", "json"]);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test("--format csv: ヘッダーと全データ行の列数が一致する", () => {
  const { stdout, exitCode } = runCli(["--scenario", "baseline", "--seed", "s1", "--turns", "6", "--format", "csv"]);
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n");
  const header = lines[0].split(",");
  assert.equal(lines.length, 7); // header + 6 quarters
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length);
  }
});

test("--format summary: 人間可読なテキストを返す", () => {
  const { stdout, exitCode } = runCli(["--scenario", "baseline", "--seed", "s1", "--turns", "4", "--format", "summary"]);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("summary"));
  assert.ok(stdout.includes("baseline-v0.1"));
});

test("--format省略時はsummary相当のテキストになる", () => {
  const { stdout, exitCode } = runCli(["--scenario", "baseline", "--seed", "s1", "--turns", "4"]);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("summary"));
});

// ---------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------

test("--help: 終了コード0で使用方法を返す", () => {
  const { stdout, stderr, exitCode } = runCli(["--help"]);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.ok(stdout.includes("使い方"));
  assert.ok(stdout.includes("--scenario"));
});

// ---------------------------------------------------------------------
// 5シナリオすべてが32ターン完走する
// ---------------------------------------------------------------------

test("5シナリオすべてが32ターン完走する（--format json）", () => {
  for (const def of ALL_SCENARIO_DEFINITIONS) {
    const alias = def.scenarioId.replace(/-v[\d.]+$/i, "");
    const { stdout, exitCode } = runCli(["--scenario", alias, "--seed", "sweep-001", "--turns", "32", "--format", "json"]);
    assert.equal(exitCode, 0, `${alias} should exit 0`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.quarters.length, 32, `${alias} should produce 32 quarters`);
  }
});

// ---------------------------------------------------------------------
// UIとCLIの同一性・再現性・Variation差異・Canonical不変性
// ---------------------------------------------------------------------

test("CLIのJSON出力は、UIが直接呼び出すrunIndustrySimulation()の結果と完全に一致する", () => {
  const direct = runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "identity-check", turns: 9 });
  const { stdout } = runCli(["--scenario", "baseline", "--seed", "identity-check", "--turns", "9", "--format", "json"]);
  const cliParsed = JSON.parse(stdout);
  assert.deepEqual(cliParsed.quarters, JSON.parse(JSON.stringify(direct.quarters)));
});

test("同一シード・同一設定なら完全に再現可能（バイト単位で同一出力）", () => {
  const args = ["--scenario", "baseline", "--seed", "repro-seed", "--turns", "12", "--format", "json"];
  const run1 = runCli(args);
  const run2 = runCli(args);
  assert.equal(run1.stdout, run2.stdout);
});

test("Variationモードでは異なるシードにより結果が変わる", () => {
  const base = ["--scenario", "baseline", "--mode", "variation", "--turns", "10", "--format", "json"];
  const runA = runCli([...base, "--seed", "seed-alpha"]);
  const runB = runCli([...base, "--seed", "seed-beta"]);
  assert.notEqual(runA.stdout, runB.stdout);
});

test("Canonicalモードでは異なるシードでもシナリオのイベントスケジュールは変わらない", () => {
  const base = ["--scenario", "global-disease-crisis", "--mode", "canonical", "--turns", "14", "--format", "json"];
  const runA = runCli([...base, "--seed", "seed-alpha"]);
  const runB = runCli([...base, "--seed", "seed-beta"]);
  const parsedA = JSON.parse(runA.stdout);
  const parsedB = JSON.parse(runB.stdout);
  const scheduleOf = (parsed: { quarters: { activeEvents: { eventType: string; resolvedStartTurn: number }[] }[] }) =>
    parsed.quarters.map((q) => q.activeEvents.map((e) => `${e.eventType}@${e.resolvedStartTurn}`));
  assert.deepEqual(scheduleOf(parsedA), scheduleOf(parsedB));
});

// ---------------------------------------------------------------------
// シナリオ比較
// ---------------------------------------------------------------------

test("--compare: 比較結果は既存compareIndustrySimulationsと一致する", () => {
  const a = runIndustrySimulation({ scenarioId: "baseline-v0.1", mode: "canonical", seed: "cmp-seed", turns: 10 });
  const b = runIndustrySimulation({ scenarioId: "global-demand-boom-v0.1", mode: "canonical", seed: "cmp-seed", turns: 10 });
  const expected = compareIndustrySimulations(a, b);

  const { stdout, exitCode } = runCli([
    "--scenario",
    "baseline",
    "--seed",
    "cmp-seed",
    "--turns",
    "10",
    "--compare",
    "global-demand-boom",
    "--format",
    "json",
  ]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.comparison, JSON.parse(JSON.stringify(expected)));
});

test("--compare --format csv: 比較のCSVも列数が一致する", () => {
  const { stdout, exitCode } = runCli([
    "--scenario",
    "baseline",
    "--seed",
    "cmp-seed-2",
    "--turns",
    "8",
    "--compare",
    "global-disease-crisis",
    "--format",
    "csv",
  ]);
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n");
  const header = lines[0].split(",");
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length);
  }
});

// ---------------------------------------------------------------------
// 異常系: 非ゼロ終了コード
// ---------------------------------------------------------------------

const INVALID_CASES: readonly { readonly name: string; readonly argv: readonly string[] }[] = [
  { name: "存在しないシナリオ", argv: ["--scenario", "nope", "--seed", "s", "--turns", "5"] },
  { name: "不正なmode", argv: ["--scenario", "baseline", "--mode", "weird", "--seed", "s", "--turns", "5"] },
  { name: "不正なformat", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "5", "--format", "xml"] },
  { name: "turns=0", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "0"] },
  { name: "turnsが非整数", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "abc"] },
  { name: "turnsがシナリオの上限超過", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "999"] },
  { name: "--scenario省略", argv: ["--seed", "s", "--turns", "5"] },
  { name: "--seed省略", argv: ["--scenario", "baseline", "--turns", "5"] },
  { name: "--turns省略", argv: ["--scenario", "baseline", "--seed", "s"] },
  { name: "未知の引数", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "5", "--bogus", "x"] },
  { name: "存在しない比較シナリオ", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "5", "--compare", "nope"] },
];

for (const { name, argv } of INVALID_CASES) {
  test(`不正な入力（${name}）は非ゼロ終了コードとエラーメッセージを返す`, () => {
    const { stdout, stderr, exitCode } = runCli(argv);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.length > 0);
    assert.equal(stdout, "");
  });
}

test("turnsがシナリオの上限を超える場合、既存のIndustrySimulationErrorメッセージがそのまま伝わる", () => {
  const { stderr } = runCli(["--scenario", "baseline", "--seed", "s", "--turns", "999"]);
  assert.ok(stderr.includes("durationTurns"));
});
