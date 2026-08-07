// ShrimpX V2 — Phase SAI-3B-1: compareRuns.ts のユニットテスト

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSai3aRun } from "../loadRun";
import { validateComparableRuns } from "../compareRuns";
import { buildFixtureRunFiles } from "./testFixtures";

function loadedRun(runId: string, headcount: number, seeds: readonly string[] = ["s1"], companyIds: readonly string[] = ["BAL"]) {
  const cases = seeds.flatMap((seed) => companyIds.map((companyId) => ({ seed, companyId, quarters: 2, headcount })));
  const files = buildFixtureRunFiles({ runId, headcount, quarters: 2, cases });
  return loadSai3aRun({ runLabel: runId, sourceDir: `/tmp/${runId}`, files });
}

test("validateComparableRuns: 単一runは常にcomparable", () => {
  const result = validateComparableRuns([loadedRun("r80", 80)]);
  assert.equal(result.comparable, true);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.commonSeeds, ["s1"]);
});

test("validateComparableRuns: seed・会社・quarterが一致する複数runはcomparable", () => {
  const runs = [loadedRun("r80", 80), loadedRun("r85", 85), loadedRun("r90", 90)];
  const result = validateComparableRuns(runs);
  assert.equal(result.comparable, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.commonQuarters, 2);
});

test("validateComparableRuns: seed集合が異なる場合は警告つきで共通部分のみ比較可能とする", () => {
  const r80 = loadedRun("r80", 80, ["s1", "s2"]);
  const r85 = loadedRun("r85", 85, ["s1", "s3"]);
  const result = validateComparableRuns([r80, r85]);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.commonSeeds, ["s1"]);
  assert.ok(result.issues.some((i) => /seed集合/.test(i)));
});

test("validateComparableRuns: 共通seedが皆無の場合は比較不可(comparable=false)", () => {
  const r80 = loadedRun("r80", 80, ["s1"]);
  const r85 = loadedRun("r85", 85, ["s2"]);
  const result = validateComparableRuns([r80, r85]);
  assert.equal(result.comparable, false);
  assert.ok(result.issues.length > 0);
});

test("validateComparableRuns: 同一run識別ラベルの重複を検出する", () => {
  const r1 = loadedRun("dup", 80);
  const r2 = loadedRun("dup", 85);
  const result = validateComparableRuns([r1, r2]);
  assert.equal(result.comparable, false);
  assert.ok(result.issues.some((i) => /同一のrun識別ラベル/.test(i)));
});

test("validateComparableRuns: 同一headcountの複数runは警告を出す(比較の意図と異なる可能性)", () => {
  const r1 = loadedRun("a", 80);
  const r2 = loadedRun("b", 80);
  const result = validateComparableRuns([r1, r2]);
  assert.ok(result.issues.some((i) => /同一の営業人員数/.test(i)));
});
