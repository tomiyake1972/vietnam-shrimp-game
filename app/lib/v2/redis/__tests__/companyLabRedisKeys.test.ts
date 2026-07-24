// ShrimpX V2 — 会社ラボ専用Redisキー生成テスト（Phase 8C-1）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  companyLabAllKeysForLabV2,
  companyLabCurrentStateKeyV2,
  companyLabDraftKeyV2,
  companyLabHistoryEntryKeyV2,
  companyLabHistoryIndexKeyV2,
  companyLabListKeyV2,
  companyLabLockKeyV2,
} from "../companyLabRedisKeys";

test("本番環境のキーはstaging:接頭辞を持たない", () => {
  assert.equal(companyLabListKeyV2("production"), "v2:companyLab:labs");
  assert.equal(companyLabCurrentStateKeyV2("production", "lab-1"), "v2:companyLab:lab-1:current");
  assert.equal(companyLabDraftKeyV2("production", "lab-1"), "v2:companyLab:lab-1:draft");
  assert.equal(companyLabHistoryEntryKeyV2("production", "lab-1", 3), "v2:companyLab:lab-1:history:3");
  assert.equal(companyLabHistoryIndexKeyV2("production", "lab-1"), "v2:companyLab:lab-1:history:index");
  assert.equal(companyLabLockKeyV2("production", "lab-1"), "v2:companyLab:lab-1:lock");
});

test("staging環境のキーはすべてstaging:接頭辞を持つ", () => {
  assert.equal(companyLabListKeyV2("staging"), "staging:v2:companyLab:labs");
  assert.equal(companyLabCurrentStateKeyV2("staging", "lab-1"), "staging:v2:companyLab:lab-1:current");
  assert.equal(companyLabHistoryEntryKeyV2("staging", "lab-1", 3), "staging:v2:companyLab:lab-1:history:3");
});

test("labIdが空文字だとすべてのキー生成関数が例外を投げる", () => {
  assert.throws(() => companyLabCurrentStateKeyV2("production", ""));
  assert.throws(() => companyLabDraftKeyV2("production", ""));
  assert.throws(() => companyLabHistoryEntryKeyV2("production", "", 1));
  assert.throws(() => companyLabHistoryIndexKeyV2("production", ""));
  assert.throws(() => companyLabLockKeyV2("production", ""));
});

test("turnが0以下・非整数だとcompanyLabHistoryEntryKeyV2が例外を投げる", () => {
  assert.throws(() => companyLabHistoryEntryKeyV2("production", "lab-1", 0));
  assert.throws(() => companyLabHistoryEntryKeyV2("production", "lab-1", -1));
  assert.throws(() => companyLabHistoryEntryKeyV2("production", "lab-1", 1.5));
  assert.doesNotThrow(() => companyLabHistoryEntryKeyV2("production", "lab-1", 1));
});

test("companyLabAllKeysForLabV2はcurrent/draft/history:index/lockの4件を返す（history:<turn>は含まない）", () => {
  const keys = companyLabAllKeysForLabV2("production", "lab-1");
  assert.deepEqual(
    [...keys].sort(),
    [companyLabCurrentStateKeyV2("production", "lab-1"), companyLabDraftKeyV2("production", "lab-1"), companyLabHistoryIndexKeyV2("production", "lab-1"), companyLabLockKeyV2("production", "lab-1")].sort()
  );
});
