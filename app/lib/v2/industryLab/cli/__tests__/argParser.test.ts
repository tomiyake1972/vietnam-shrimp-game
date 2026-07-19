import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, buildUsageText } from "../argParser";
import { CliArgumentError } from "../types";

const BASE_ARGS = ["--scenario", "baseline", "--mode", "canonical", "--seed", "demo-001", "--turns", "32", "--format", "summary"];

test("正しい引数一式を解析できる", () => {
  const parsed = parseCliArgs(BASE_ARGS);
  assert.equal(parsed.help, false);
  assert.equal(parsed.scenario, "baseline");
  assert.equal(parsed.mode, "canonical");
  assert.equal(parsed.seed, "demo-001");
  assert.equal(parsed.turns, 32);
  assert.equal(parsed.format, "summary");
  assert.equal(parsed.compareScenario, undefined);
});

test("--mode省略時はcanonicalが既定値になる", () => {
  const parsed = parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "5"]);
  assert.equal(parsed.mode, "canonical");
});

test("--format省略時はsummaryが既定値になる", () => {
  const parsed = parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "5"]);
  assert.equal(parsed.format, "summary");
});

test("--compareを指定すると比較対象シナリオとして解析される", () => {
  const parsed = parseCliArgs([...BASE_ARGS, "--compare", "global-disease-crisis"]);
  assert.equal(parsed.compareScenario, "global-disease-crisis");
});

test("--flag=value 形式も受け付ける", () => {
  const parsed = parseCliArgs(["--scenario=baseline", "--seed=demo-001", "--turns=10"]);
  assert.equal(parsed.scenario, "baseline");
  assert.equal(parsed.seed, "demo-001");
  assert.equal(parsed.turns, 10);
});

test("--help / -h はそれ以外の引数の検証をスキップしてhelp=trueを返す", () => {
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.equal(parseCliArgs(["-h"]).help, true);
  assert.equal(parseCliArgs(["--scenario", "not-a-real-scenario", "--help"]).help, true);
});

test("--scenario が無いとCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--seed", "s", "--turns", "5"]), CliArgumentError);
});

test("--seed が無いとCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--turns", "5"]), CliArgumentError);
});

test("--turns が無いとCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s"]), CliArgumentError);
});

test("存在しないシナリオ名はCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "nope", "--seed", "s", "--turns", "5"]), CliArgumentError);
});

test("不正な--modeはCliArgumentErrorを投げる", () => {
  assert.throws(
    () => parseCliArgs(["--scenario", "baseline", "--mode", "weird", "--seed", "s", "--turns", "5"]),
    CliArgumentError
  );
});

test("不正な--formatはCliArgumentErrorを投げる", () => {
  assert.throws(
    () => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "5", "--format", "xml"]),
    CliArgumentError
  );
});

test("--turnsが整数でなければCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "abc"]), CliArgumentError);
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "3.5"]), CliArgumentError);
});

test("--turnsが0以下ならCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "0"]), CliArgumentError);
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "-1"]), CliArgumentError);
});

test("--compareに存在しないシナリオを指定するとCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs([...BASE_ARGS, "--compare", "nope"]), CliArgumentError);
});

test("未知の引数はCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario", "baseline", "--seed", "s", "--turns", "5", "--bogus", "x"]), CliArgumentError);
});

test("値の無いフラグ末尾はCliArgumentErrorを投げる", () => {
  assert.throws(() => parseCliArgs(["--scenario"]), CliArgumentError);
});

test("buildUsageTextは5シナリオすべての短縮形・正式IDを含む", () => {
  const usage = buildUsageText();
  assert.ok(usage.includes("baseline"));
  assert.ok(usage.includes("baseline-v0.1"));
  assert.ok(usage.includes("--scenario"));
  assert.ok(usage.includes("--format"));
  assert.ok(usage.includes("--compare"));
});
