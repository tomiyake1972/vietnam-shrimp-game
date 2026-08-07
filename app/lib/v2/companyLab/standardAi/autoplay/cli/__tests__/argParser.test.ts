// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI 引数解析のテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAutoplayCliArgs } from "../argParser";
import { CliArgumentError } from "../types";

test("parseAutoplayCliArgs: --seed-countとquartersだけで既定値を用いた解析ができる", () => {
  const args = parseAutoplayCliArgs(["--seed-count", "3", "--quarters", "8"]);
  assert.equal(args.help, false);
  assert.deepEqual(args.seeds, ["sai3a-001", "sai3a-002", "sai3a-003"]);
  assert.equal(args.quarters, 8);
  assert.equal(args.scenario, "baseline");
  assert.deepEqual(args.companyIds, ["BAL", "MASS", "JPQ", "VAP", "CONSV"]);
  assert.equal(args.salesForceHeadcountOverride, undefined);
});

test("parseAutoplayCliArgs: --seedsで明示的なseed一覧を指定できる", () => {
  const args = parseAutoplayCliArgs(["--seeds", "a,b,c", "--quarters", "4"]);
  assert.deepEqual(args.seeds, ["a", "b", "c"]);
});

test("parseAutoplayCliArgs: --seed-prefixで自動生成seedのprefixを変更できる", () => {
  const args = parseAutoplayCliArgs(["--seed-count", "2", "--seed-prefix", "h85", "--quarters", "4"]);
  assert.deepEqual(args.seeds, ["h85-001", "h85-002"]);
});

test("parseAutoplayCliArgs: --seedsも--seed-countも無ければCliArgumentError", () => {
  assert.throws(() => parseAutoplayCliArgs(["--quarters", "4"]), CliArgumentError);
});

test("parseAutoplayCliArgs: --companiesで会社を絞り込める。不明な会社IDはCliArgumentError", () => {
  const args = parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "4", "--companies", "BAL,MASS"]);
  assert.deepEqual(args.companyIds, ["BAL", "MASS"]);
  assert.throws(() => parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "4", "--companies", "NOPE"]), CliArgumentError);
});

test("parseAutoplayCliArgs: --headcountで営業人数を上書きできる", () => {
  const args = parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "4", "--headcount", "85"]);
  assert.equal(args.salesForceHeadcountOverride, 85);
});

test("parseAutoplayCliArgs: 不明な--baseline-idはCliArgumentError", () => {
  assert.throws(() => parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "4", "--baseline-id", "no-such-candidate"]), CliArgumentError);
});

test("parseAutoplayCliArgs: --helpを指定すると他の引数を検証せずにhelp:trueを返す", () => {
  const args = parseAutoplayCliArgs(["--help"]);
  assert.equal(args.help, true);
});

test("parseAutoplayCliArgs: --quartersが0以下やの非整数はCliArgumentError", () => {
  assert.throws(() => parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "0"]), CliArgumentError);
  assert.throws(() => parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "abc"]), CliArgumentError);
});

test("parseAutoplayCliArgs: 不明な引数はCliArgumentError", () => {
  assert.throws(() => parseAutoplayCliArgs(["--seed-count", "1", "--quarters", "4", "--bogus", "x"]), CliArgumentError);
});
