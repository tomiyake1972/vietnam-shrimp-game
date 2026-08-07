// ShrimpX V2 — Phase SAI-3B-1: CLI引数解析のユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSai3bCliArgs } from "../argParser";
import { Sai3bCliArgumentError } from "../types";

test("parseSai3bCliArgs: --help", () => {
  const args = parseSai3bCliArgs(["--help"]);
  assert.equal(args.help, true);
});

test("parseSai3bCliArgs: 単一の--input --outputを解析できる", () => {
  const args = parseSai3bCliArgs(["--input", "artifacts/sai3a/r1", "--output", "artifacts/sai3b/out.xlsx"]);
  assert.deepEqual(args.inputDirs, ["artifacts/sai3a/r1"]);
  assert.equal(args.outputPath, "artifacts/sai3b/out.xlsx");
});

test("parseSai3bCliArgs: --inputを複数回指定できる（複数run比較）", () => {
  const args = parseSai3bCliArgs([
    "--input",
    "artifacts/sai3a/h80",
    "--input",
    "artifacts/sai3a/h85",
    "--input",
    "artifacts/sai3a/h90",
    "--output",
    "artifacts/sai3b/comparison.xlsx",
  ]);
  assert.equal(args.inputDirs.length, 3);
});

test("parseSai3bCliArgs: --inputが1つもない場合はエラー", () => {
  assert.throws(() => parseSai3bCliArgs(["--output", "out.xlsx"]), Sai3bCliArgumentError);
});

test("parseSai3bCliArgs: --outputがない場合はエラー", () => {
  assert.throws(() => parseSai3bCliArgs(["--input", "in"]), Sai3bCliArgumentError);
});

test("parseSai3bCliArgs: --outputが.xlsx拡張子でない場合はエラー", () => {
  assert.throws(() => parseSai3bCliArgs(["--input", "in", "--output", "out.txt"]), Sai3bCliArgumentError);
});

test("parseSai3bCliArgs: 不明な引数はエラー", () => {
  assert.throws(() => parseSai3bCliArgs(["--unknown", "x"]), Sai3bCliArgumentError);
});

test("parseSai3bCliArgs: 末尾の入力ディレクトリの末尾スラッシュを除去する", () => {
  const args = parseSai3bCliArgs(["--input", "artifacts/sai3a/r1/", "--output", "out.xlsx"]);
  assert.equal(args.inputDirs[0], "artifacts/sai3a/r1");
});
