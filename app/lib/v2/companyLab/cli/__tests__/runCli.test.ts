import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompanyLabCli } from "../runCli";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { generateAutoPolicyDecision } from "../../autoPolicy";
import { COMPANY_LAB_COMPANY_IDS } from "../../fixtures";

// ---------------------------------------------------------------------
// 正常系: 出力形式
// ---------------------------------------------------------------------

test("--format json: 標準出力はJSON.parseできる文字列のみ（余計な行を含まない）", () => {
  const { stdout, stderr, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "5", "--format", "json"]);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test("--format csv: 全行の列数が一致する（会社×四半期の1行1レコード）", () => {
  const { stdout, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "6", "--format", "csv"]);
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n");
  const header = lines[0].split(",");
  assert.equal(lines.length, 1 + 6 * 5); // header + 6四半期 × 5社
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, header.length);
  }
});

test("--format summary: 人間可読なテキストを返す", () => {
  const { stdout, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "4", "--format", "summary"]);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("summary"));
  assert.ok(stdout.includes("baseline-v0.1"));
  assert.ok(stdout.includes("本番会社設定"));
});

test("--format省略時はsummary相当のテキストになる", () => {
  const { stdout, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "4"]);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("summary"));
});

test("--company省略時は5社すべてを含む", () => {
  const { stdout } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "1", "--format", "json"]);
  const parsed = JSON.parse(stdout);
  const companyIds = new Set(parsed.history[0].companySummaries.map((s: { companyId: string }) => s.companyId));
  assert.deepEqual(companyIds, new Set(COMPANY_LAB_COMPANY_IDS));
});

test("--company指定時は指定会社のみを含む", () => {
  const { stdout } = runCompanyLabCli(["--scenario", "baseline", "--seed", "s1", "--turns", "1", "--format", "json", "--company", "VAP"]);
  const parsed = JSON.parse(stdout);
  for (const record of parsed.history) {
    assert.equal(record.companySummaries.length, 1);
    assert.equal(record.companySummaries[0].companyId, "VAP");
  }
});

// ---------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------

test("--help: 終了コード0で使用方法を返す", () => {
  const { stdout, stderr, exitCode } = runCompanyLabCli(["--help"]);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.ok(stdout.includes("使い方"));
  assert.ok(stdout.includes("--scenario"));
});

// ---------------------------------------------------------------------
// 8/32ターン完走
// ---------------------------------------------------------------------

test("5社×8ターンが完走する（--format json）", () => {
  const { stdout, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "sweep-8", "--turns", "8", "--format", "json"]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.history.length, 8);
});

test("5社×32ターンが完走する（--format json）", () => {
  const { stdout, exitCode } = runCompanyLabCli(["--scenario", "baseline", "--seed", "sweep-32", "--turns", "32", "--format", "json"]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.history.length, 32);
});

// ---------------------------------------------------------------------
// 画面（統合ランナー）との同一性・再現性
// ---------------------------------------------------------------------

test("CLIのJSON出力（history部分）は、画面と同じ統合ランナーの直接呼び出し結果と完全に一致する", () => {
  const config = { scenarioId: "baseline-v0.1", mode: "canonical" as const, seed: "identity-check", turns: 9 };
  const direct = runCompanyLabWithAutoPolicyForAllCompanies(config, generateAutoPolicyDecision);
  const { stdout } = runCompanyLabCli(["--scenario", "baseline", "--seed", "identity-check", "--turns", "9", "--format", "json"]);
  const cliParsed = JSON.parse(stdout);
  assert.deepEqual(cliParsed.history, JSON.parse(JSON.stringify(direct.history)));
});

test("同一シード・同一設定なら完全に再現可能（バイト単位で同一出力）", () => {
  const args = ["--scenario", "baseline", "--seed", "repro-seed", "--turns", "12", "--format", "json"];
  const run1 = runCompanyLabCli(args);
  const run2 = runCompanyLabCli(args);
  assert.equal(run1.stdout, run2.stdout);
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
  { name: "--scenario省略", argv: ["--seed", "s", "--turns", "5"] },
  { name: "--seed省略", argv: ["--scenario", "baseline", "--turns", "5"] },
  { name: "--turns省略", argv: ["--scenario", "baseline", "--seed", "s"] },
  { name: "未知の引数", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "5", "--bogus", "x"] },
  { name: "不正な会社ID", argv: ["--scenario", "baseline", "--seed", "s", "--turns", "5", "--company", "XX"] },
];

for (const { name, argv } of INVALID_CASES) {
  test(`不正な入力（${name}）は非ゼロ終了コードとエラーメッセージを返す`, () => {
    const { stdout, stderr, exitCode } = runCompanyLabCli(argv);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.length > 0);
    assert.equal(stdout, "");
  });
}
